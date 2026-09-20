# 架构与性能设计

配套文档：[MODES.md](MODES.md) —— 这份文档要支撑的玩法。

---

## 现状

| 文件 | 行数 | 形态 |
|---|---|---|
| `server.js` | 1459 | 常量 → `Room` 类 → 约 60 个平铺函数 → 一个 switch → http |
| `public/app.js` | 2908 | 常量 → `els` → `state` → 渲染 → 输入 → 聊天 → 网络 → 门厅 |

现在还读得动。但**玩法的本质是"在每个动作前后插一道判断"**，平铺结构应对它的唯一办法是往二十个 handler 里各塞几个 `if (room.mode)`。第一个玩法能塞进去，第二个就开始互相打架，第三个就没人敢动了。

所以：先改结构，再写玩法。而且要守住现在的三个优点——**不引入构建步骤、不引入框架、不引入数据库**。

---

## 一、先修性能问题　✅ 已完成

这些和玩法无关，都是现在就存在的，越早修越好。全部已落地，测试 24 项全过
（新增四项：房间被请出内存后仍能推门进来、老版本整包存档仍可读、光标合并、手机不当烘焙机）。

### 1. `broadcast` 重复序列化　✅　🟡 便宜的白捡

```js
function broadcast(room, obj, exceptId) {
  for (const u of room.users.values()) {
    if (exceptId && u.id === exceptId) continue;
    send(u.ws, obj);          // ← send 里各做一次 JSON.stringify
  }
}
```

同一个对象被序列化 N 次。4 人画线高峰期，三分之二是白做的。

**改**：`broadcast` 先 `JSON.stringify` 一次，把字符串发给所有人。改动不到十行。

### 2. 房间只进不出　✅　🔴 公网服务器迟早出事

`loadRooms()` 在启动时把 `data/rooms` 下的**每一个**房间读进内存，`rooms` Map 此后从不驱逐。一台长期在线的公网服务器，房间数只会单调增长，直到把内存吃完。

**改**：
- 启动时只扫文件名建立码表，不读内容；
- 首次 `join` 时才真正读盘；
- 最后一人离开、存盘完成后 N 分钟（比如 10 分钟），从内存移除。

`clearTimer` 这类挂在房间上的定时器要跟着一起清，别让被驱逐的房间被 timer 拽回来。

### 3. `readArchive` 是同步全量读　✅　🔴 定时炸弹

```js
raw = fs.readFileSync(archiveFile(room), "utf8");   // 整个文件一次读完
for (const line of raw.split("\n")) { ... }
```

`deploy/README.md` 里自己写着"`archive.jsonl` 会一直增长……大约每晚增加几 MB"。一年后它是 GB 级的，而这是**同步**读——一次"撤销一笔已冻结的笔"会把整个进程卡住几秒，**所有房间一起卡**。

**改**：
- 按段分文件：`archive-<seg>.jsonl`。重画哪一段只读哪一段，数据量降一到两个数量级；
- 读取改成流式异步（`readline` over `createReadStream`），不再一次性 split 出几百万个字符串。

### 4. 没有背压保护　✅　🟡 弱网会涨内存

`send()` 只检查 `readyState`，不看 `bufferedAmount`。手机弱网时发送缓冲区会无限增长。

**改**：两级阈值。缓冲超过 64KB 就丢 `cursor`——下一帧光标就补上了，看不出来。缓冲超过 2MB 说明这条连接已经补不回来了，直接 `terminate()`，客户端重连时会拿到完整快照，自己就治好了。

原本打算把 `stroke_point` 也归为可丢弃，实现时否掉了：丢一批点，那一笔在对方屏幕上就**永远**是错的形状，而且没有任何机制会纠正它。省内存不能拿画错来换。

### 5. 顺带　✅ 已完成

- **cursor 没有合并**　✅：服务端收到即转发，4 人 × 20Hz ≈ 80 条/秒的纯装饰流量。已改成服务端按 20Hz 把所有人的光标合成一条 `cursors` 群发。上行仍是每人一条——有 4 倍扇出问题的只是下行。
- **烘焙失败没有退避**　✅：`abortJob` 里固定 `setTimeout(maybeBake, 1000)`，没有退避也没有放弃计数。

  > 订正：之前这里写的是"永久的每秒重试循环"，说大了。查了 `abortJob` 的调用点，失败主要来自 30 秒超时，所以实际是约 31 秒一轮。但问题依然成立——一台烘不动的手机会被永远地、一轮接一轮地反复指派同一件做不到的事。现在改成指数退避（1s 起，封顶 60s），连续 6 次就搁置，等有人推门进来再重新开始。

- **手机独自烘焙**　✅：客户端在 `join` 时上报 `weak`，`pickBaker` 优先挑非手机；只剩手机时仍然用它——烘得卡也比不烘强。

客户端这边目前没有明显问题：点已经是 8 个一批发送，`rebuildInk` 有 `LIVE_KEEP` 封顶，分段虚拟化也在。导出 32000px 在手机上仍可能崩，但那是另一件事。

---

## 二、服务端拆分

纯搬运，不改逻辑，24 个 e2e 测试兜底。

```
server.js              只剩接线：http / ws / 启动 / 优雅退出      ~150 行
src/
  room.js              Room 类、serialize / restore
  store.js             存盘、惰性加载、驱逐
  protocol.js          校验与归一化（validCode / asPoint / normalizeHex …）
  net.js               send / broadcast / 预序列化 / 背压
  bake.js              冻结、任务、存档
  wall/
    draw.js            stroke_* / text_place / undo / redo
    presence.js        join / leave / kick / lock / extend / clear / rename
    chat.js            chat / cursor
  modes/
    index.js           注册表
    relay.js           接龙 / 补全
```

---

## 三、规则层：两个钩子，不是二十个 if

核心只需要两个插入点。

```js
// 每个会改变墙的动作，进来先过一道闸
function gate(room, user, action, msg) {
  const mode = modes.get(room.mode?.id);
  if (!mode?.can) return null;                 // 没开玩法 = 全放行
  return mode.can(room, user, action, msg);    // null 放行；字符串 = 拒绝理由
}

// 动作成功之后，玩法有机会推进自己的状态
function after(room, event, ctx) {
  modes.get(room.mode?.id)?.on?.(room, event, ctx);
}
```

一个玩法就是一个对象：

```js
// src/modes/relay.js —— 接龙 / 补全
module.exports = {
  id: "relay",
  minUsers: 1,                       // 异步也能玩
  init(room, opts) { /* 划分段、设初始持棒人 */ },

  can(room, user, action) {
    if (action !== "draw") return null;
    if (room.mode.holder && room.mode.holder !== user.id) return "现在轮到别人画";
    return null;
  },

  // 可见性过滤：纯函数，服务端在发 snapshot 和广播时过一遍
  visible(room, user, stroke) {
    return inOwnSegment(room, user, stroke) || inPeekZone(room, stroke);
  },

  on(room, ev, ctx) {
    if (ev.type === "stroke_end") ctx.bumpQuota(...);
    if (ev.type === "handoff")    ctx.setDeadline(...);
  },
};
```

三条铁律：

1. **可见性必须在服务端执行。** 不发给你的笔画，客户端才真的拿不到。藏在前端等于没藏——F12 一开就看见了。这对"盖住交接"和"卧底的词"都是硬要求。
2. **轮次是接力棒，不是环。**
   ```js
   room.mode.holder   = userId | null   // 棒在谁手里；null = 棒放在墙上等人来拿
   room.mode.queue    = [userId, ...]   // 意向顺序，不在线的自动跳过
   room.mode.deadline = ts | null       // 到点自动传棒
   ```
   固定 N 人的环，在两人局里掉一个人就死锁了。接力棒让 2 人来回、4 人接力、1 人留棒给明天变成同一套状态。
3. **所有定时器只存 deadline，不存句柄。** 进程重启后照 `restoreClearTimer` 的做法重建。玩法状态跟着 `serialize(room)` 一起落盘——加一个 `mode` 字段即可，不需要新的存储。

倒计时**不要每秒广播**。发 deadline，客户端自己倒数（`clear` 已经是这么做的，照抄）。

---

## 四、客户端拆分

改成浏览器原生 ES modules（`<script type="module">`），不需要打包器：

```
public/
  app.js                 只负责启动和接线
  core/   state.js  net.js  view.js
  draw/   render.js  brush.js  input.js  shape.js
  ui/     toolbar.js  chat.js  roster.js  lobby.js  palette.js
  modes/  relay.js  ...
```

玩法代码只能通过两个口子接触主程序：

- **读**：`state` 的只读快照
- **写**：一个 `#mode-layer` 覆盖层 + 一个事件总线

绝不允许玩法代码直接去改工具栏 DOM。否则装上第二个玩法的那天，它们就会互相拆台。

代价是多几个 HTTP 请求。真嫌慢，最后加一个二十行的 concat 脚本就行——那仍然不是"构建系统"。

---

## 五、顺序

1. ~~四处性能修复（1–4）~~ ✅ 已完成
2. ~~第 5 节那几处顺带的（光标合并、烘焙退避、手机不当烘焙机）~~ ✅ 已完成
3. 服务端拆分——纯搬运，测试兜底
4. 规则层两个钩子——此时还没有任何玩法，`gate` 永远返回 null，行为完全不变
5. 写第一个玩法 `relay.js`
6. 客户端拆分——可以推迟到第二个玩法出现时再做

每一步都能单独提交、单独部署、单独回滚。
