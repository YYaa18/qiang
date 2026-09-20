"use strict";

// 玩法的规则层。
//
// 一个玩法就是一个对象，按需实现下面几个方法，全都是可选的：
//
//   can(room, user, action, msg)  动作发生之前的闸门。放行返回 null，
//                                 拒绝返回一句给人看的话（"现在轮到别人画"）
//   on(room, event, api)          动作成功之后，玩法推进自己的状态
//   restore(room)                 房间从盘上读起来时，把自己的定时器重建出来
//   init(room, opts) / stop(room) 开局和收场
//
// 玩法自己的状态放在 room.mode 里（`{ id, ... }`），跟着房间一起存盘，
// 不需要另开存储。定时器只存 deadline 不存句柄，重启后由 restore 重建。
//
// 没开玩法的房间（room.mode 为 null）一律全部放行，行为和没有这一层时一模一样。
//
// 玩法文件由 dispatch.js 统一 require 进来注册，而不是在这里 require——
// 否则 index → 玩法 → draw → index 就绕回来了。

// 这一层在 wall/* 之上，所以不引用它们中的任何一个——wall 里的模块要引 modes。
// 具体的玩法文件不受这条限制，它想用 pushSystem 就自己去 require。
const { send, sendData, broadcast } = require("../net");
const { ctxOf, scheduleSave, onRoomLoaded } = require("../store");

/** 会经过闸门的动作。加新动作时这里和调用处一起改，别让它们各说各话。 */
const ACTIONS = new Set(["draw", "text", "undo", "redo", "chat", "extend", "clear"]);

/** @type {Map<string, object>} */
const registry = new Map();

function register(mode) {
  if (!mode || typeof mode.id !== "string" || !mode.id) {
    throw new Error("玩法必须有 id");
  }
  if (registry.has(mode.id)) throw new Error(`玩法 ${mode.id} 重复注册`);
  registry.set(mode.id, mode);
  return mode;
}

function get(id) {
  return registry.get(id) || null;
}

function list() {
  return [...registry.keys()];
}

// 玩法清单，发给客户端用来长出菜单。客户端不认识任何具体玩法，
// 所以再加第几个玩法，菜单都不用动一行。
function catalog() {
  return [...registry.values()].map((m) => ({
    id: m.id,
    name: m.name || m.id,
    hint: m.hint || "",
  }));
}

/** 这间房此刻在玩什么；没开玩法、或玩法没注册过，都是 null */
function of(room) {
  if (!room || !room.mode || typeof room.mode.id !== "string") return null;
  return registry.get(room.mode.id) || null;
}

// ───────────── 钩子一：闸门 ─────────────

// 返回 null 放行；返回字符串是拒绝的理由。
// 玩法代码出错时按放行处理：宁可让人多画一笔，也不能把整面墙卡死。
function gate(room, user, action, msg) {
  const mode = of(room);
  if (!mode || typeof mode.can !== "function") return null;
  let reason;
  try {
    reason = mode.can(room, user, action, msg);
  } catch (err) {
    console.error("mode can() failed", room.code, room.mode.id, err);
    return null;
  }
  return typeof reason === "string" && reason ? reason : null;
}

// 每个会改变墙的动作的统一入口：认出是谁，再问一遍玩法答不答应。
// handler 里原本就要 ctxOf，所以这不是多出来的一行，是换掉的那一行。
function allow(ws, action, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return null;
  const reason = gate(ctx.room, ctx.user, action, msg);
  if (reason) {
    send(ws, { type: "error", code: "not_allowed", message: reason });
    return null;
  }
  return ctx;
}

// ───────────── 钩子二：动作之后 ─────────────

function apiFor(room) {
  return {
    broadcast: (obj) => broadcast(room, obj),
    save: () => scheduleSave(room),
    // 把最新状态告诉屋里每个人。每人看到的不一样（我能画哪一段、轮没轮到我），
    // 所以一人一条；形状由 publicState 统一拼，玩法不必自己拼，也就不会拼漏。
    announce: () => {
      for (const u of room.users.values()) {
        if (u.ws) send(u.ws, { type: "mode", state: publicState(room, u) });
      }
      scheduleSave(room);
    },
    // 玩法宣告自己结束。墙立刻回到平常的样子，不留痕迹——
    // 默认的墙才是这个产品，玩法只是临时盖在上面的一层。
    end: () => {
      room.mode = null;
      scheduleSave(room);
    },
  };
}

// 玩法在这里推进自己的状态。出错只记一笔，不能连累正在画画的人。
function after(room, event) {
  const mode = of(room);
  if (!mode || typeof mode.on !== "function") return;
  try {
    mode.on(room, event, apiFor(room));
  } catch (err) {
    console.error("mode on() failed", room.code, room.mode.id, err);
  }
}

// ───────────── 钩子三：可见性 ─────────────
//
// 遮挡必须在服务端做。不发给你的笔画，客户端才是真的拿不到——藏在前端等于没藏。
//
// 这里和 gate 的容错方向**故意相反**：gate 出错放行（宁可多画一笔，不能卡死整面墙），
// visible 出错则藏起来。一面暂时空白的墙还能救，泄出去的底牌救不回来。

function hidesStrokes(room) {
  const mode = of(room);
  return !!(mode && typeof mode.visible === "function");
}

function canSee(room, user, stroke) {
  const mode = of(room);
  if (!mode || typeof mode.visible !== "function") return true;
  try {
    return mode.visible(room, user, stroke) !== false;
  } catch (err) {
    console.error("mode visible() failed", room.code, room.mode.id, err);
    return false; // 藏起来
  }
}

function visibleStrokes(room, user, strokes) {
  if (!hidesStrokes(room)) return strokes;
  return strokes.filter((s) => canSee(room, user, s));
}

// 一条和某一笔有关的消息。没有遮挡时就是原来的 broadcast。
// 有遮挡时也只序列化一次——每个人收到的内容是一样的，不同的只是收不收得到。
function broadcastStroke(room, obj, stroke, exceptId) {
  if (!hidesStrokes(room)) {
    broadcast(room, obj, exceptId);
    return;
  }
  const data = JSON.stringify(obj);
  for (const u of room.users.values()) {
    if (exceptId && u.id === exceptId) continue;
    if (!canSee(room, u, stroke)) continue;
    sendData(u.ws, data, false);
  }
}

// ───────────── 玩法自己的指令 ─────────────
//
// 所有玩法共用一种消息 `{type:"mode", cmd:"..."}`，这样加玩法不必动 dispatch。

function command(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const cmd = String(msg.cmd || "");

  // 开局是特例：这时候房间还没有玩法，得先从登记处按名字找
  if (cmd === "start") {
    if (user.id !== room.hostId) {
      send(ws, { type: "error", code: "forbidden", message: "只有房主可以开始玩法" });
      return;
    }
    const mode = registry.get(String(msg.mode || ""));
    if (!mode) {
      send(ws, { type: "error", code: "no_mode", message: "没有这个玩法" });
      return;
    }
    if (room.mode) {
      send(ws, { type: "error", code: "busy", message: "先结束正在玩的" });
      return;
    }
    room.mode = { id: mode.id };
    if (typeof mode.init === "function") mode.init(room, user, msg, apiFor(room));
    scheduleSave(room);
    return;
  }

  const mode = of(room);
  if (!mode) return;

  if (cmd === "stop") {
    if (user.id !== room.hostId) {
      send(ws, { type: "error", code: "forbidden", message: "只有房主可以结束玩法" });
      return;
    }
    if (typeof mode.stop === "function") mode.stop(room, user, apiFor(room));
    room.mode = null;
    scheduleSave(room);
    return;
  }

  if (typeof mode.command !== "function") return;
  try {
    mode.command(room, user, cmd, msg, apiFor(room));
  } catch (err) {
    console.error("mode command() failed", room.code, room.mode.id, err);
  }
}

// 发给客户端的玩法状态。
//
// 这是一份**显示指令**，不是玩法的内部状态：客户端照着 label / action / drawable
// 去渲染，不认识「接龙」「限笔」这些词。玩法自己决定给每个人看多少——
// 别把底牌塞进去，这东西是直接发到浏览器里的。
//
//   label     横幅上那句话
//   tone      圆点的样子：you 轮到你 / wait 等别人 / free 没人拿着
//   action    横幅上的按钮 {cmd, label}，没有就不显示
//   blocked   我此刻能不能落笔（客户端据此省下白画的力气，真正的拦截在服务端）
//   why       画不了时底栏显示的原因
//   drawable  我能画的横向范围 {x0,x1}；范围之外盖上斜纹
//   hint      提示区 {x0,x1}，比如接龙里用来接线的那条窄缝
//   hostActions  只有房主看得见的动作 [{cmd, label, confirm}]
function publicState(room, user) {
  const mode = of(room);
  if (!mode) return null;
  const base = { id: mode.id, name: mode.name || mode.id };
  if (typeof mode.publicState !== "function") return base;
  try {
    return { ...base, ...mode.publicState(room, user) };
  } catch (err) {
    console.error("mode publicState() failed", room.code, room.mode.id, err);
    return base;
  }
}

// 房间从盘上读起来时，让玩法把自己的定时器重建出来（和清空倒计时一个路子）
onRoomLoaded((room) => {
  const mode = of(room);
  if (!mode || typeof mode.restore !== "function") return;
  try {
    mode.restore(room);
  } catch (err) {
    console.error("mode restore() failed", room.code, room.mode.id, err);
  }
});

module.exports = {
  ACTIONS,
  register,
  get,
  list,
  catalog,
  of,
  gate,
  allow,
  after,
  command,
  hidesStrokes,
  canSee,
  visibleStrokes,
  broadcastStroke,
  publicState,
  apiFor,
};
