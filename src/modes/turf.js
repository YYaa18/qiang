"use strict";

// 涂地战 —— 限时抢地盘，谁涂得多谁赢。
//
// 面积怎么算，是这个玩法唯一的难题。按笔画长度乘粗细去累加是不行的：
// 在同一块地方来回涂，分数会一直涨，这一条就足以毁掉整个玩法。
//
// 所以把墙切成 20px 的格子，**每一格归最后涂它的那个人**。
// 涂在别人上面就抢过来，橡皮擦掉就还原成无主——这正是涂地类游戏的原理，
// 纯整数运算，不需要画布、不需要依赖、也不必信任客户端报上来的数。
//
// 格子只活在内存里（放在 WeakMap 里，不会被写进房间的存盘文件）。
// 进程重启时由 restore 从笔画重算——这也是第一个真正用上「定时器只存 deadline」
// 那条规矩的玩法：倒计时到点自己结束，重启后接着倒。

const { SEG_W, CANVAS_H } = require("../config");
const { pushSystem } = require("../wall/chat");
const { register, apiFor } = require("./index");

const CELL = 20; // 一格多大。再细就是在比谁的手抖得均匀，没意义
const DEFAULT_SECONDS = 180;
const MIN_SECONDS = 5; // 闪电局，也方便测
const MAX_SECONDS = 900;
const TICK_MS = 1000; // 分数最多一秒广播一次，别一笔一条

/** @type {WeakMap<object, {cols:number, rows:number, own:Map<number,string>}>} */
const grids = new WeakMap();
/** @type {WeakMap<object, ReturnType<typeof setTimeout>>} */
const timers = new WeakMap();
/** @type {WeakMap<object, {at:number, pending:boolean}>} */
const ticks = new WeakMap();

function clampSeconds(n) {
  if (!Number.isFinite(n)) return DEFAULT_SECONDS;
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(n)));
}

function makeGrid(room) {
  return {
    cols: Math.ceil((room.segments * SEG_W) / CELL),
    rows: Math.ceil(CANVAS_H / CELL),
    own: new Map(),
  };
}

// 从头把所有笔画走一遍。开局和重启后各用一次，平时靠增量。
function rebuild(room) {
  const g = makeGrid(room);
  grids.set(room, g);
  const list = [...room.strokes].sort((a, b) => a.seq - b.seq);
  for (const s of list) {
    if (s.hidden) continue;
    if (s.seq <= (room.mode.from || 0)) continue; // 开局之前画的不算
    mark(g, s);
  }
  return g;
}

function gridOf(room) {
  return grids.get(room) || rebuild(room);
}

function stamp(g, x0, y0, x1, y1, owner) {
  const c0 = Math.max(0, Math.floor(x0 / CELL));
  const c1 = Math.min(g.cols - 1, Math.floor(x1 / CELL));
  const r0 = Math.max(0, Math.floor(y0 / CELL));
  const r1 = Math.min(g.rows - 1, Math.floor(y1 / CELL));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * g.cols + c;
      if (owner) g.own.set(i, owner);
      else g.own.delete(i); // 橡皮：擦回无主，这是一种战术
    }
  }
}

function mark(g, s) {
  const owner = s.type === "eraser" ? null : s.userId;
  if (s.type === "text") {
    const w = [...(s.text || "")].length * 22;
    stamp(g, s.x, s.y - 18, s.x + w, s.y + 6, owner);
    return;
  }
  const pts = s.points || [];
  const r = Math.max(CELL / 2, (s.width || 8) * 0.6);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1] || a;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      stamp(g, x - r, y - r, x + r, y + r, owner);
    }
  }
}

function board(room) {
  const g = gridOf(room);
  const count = new Map();
  for (const id of g.own.values()) count.set(id, (count.get(id) || 0) + 1);
  const total = g.cols * g.rows || 1;
  const who = room.mode.who || {};
  return [...count.entries()]
    .map(([id, cells]) => ({
      userId: id,
      cells,
      name: (who[id] && who[id].name) || "某人",
      color: (who[id] && who[id].color) || "#888888",
      pct: Math.round((cells / total) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
}

function remember(room, user) {
  if (!room.mode.who) room.mode.who = {};
  room.mode.who[user.id] = { name: user.name, color: user.color };
}

// 到点了（或房主提前收），算分、宣布、把玩法摘掉。画留在墙上。
function finish(room) {
  clearTimeout(timers.get(room));
  timers.delete(room);
  if (!room.mode || room.mode.id !== "turf") return; // 已经收过了
  const rank = board(room);
  const api = apiFor(room);
  grids.delete(room);
  api.end(); // 摘掉玩法，墙回到平常的样子；画留着
  if (!rank.length) {
    pushSystem(room, "涂地战结束了，一块地也没涂");
  } else if (rank.length === 1 || rank[0].pct > rank[1].pct) {
    const rest = rank.slice(1).map((r) => `${r.name} ${r.pct}%`).join("，");
    pushSystem(room, `涂地战结束：${rank[0].name}赢了，涂了 ${rank[0].pct}%${rest ? "；" + rest : ""}`);
  } else {
    const tied = rank.filter((r) => r.pct === rank[0].pct).map((r) => r.name).join("、");
    pushSystem(room, `涂地战结束：${tied}打平，各 ${rank[0].pct}%`);
  }
  api.announce();
}

function arm(room) {
  clearTimeout(timers.get(room));
  const left = (room.mode.endsAt || 0) - Date.now();
  if (left <= 0) {
    finish(room);
    return;
  }
  const t = setTimeout(() => finish(room), left);
  t.unref?.();
  timers.set(room, t);
}

// 分数一秒最多广播一次：四个人一起涂的时候，一笔一条太吵了
function nudge(room, api) {
  const st = ticks.get(room) || { at: 0, pending: false };
  ticks.set(room, st);
  const wait = Math.max(0, st.at + TICK_MS - Date.now());
  if (wait === 0) {
    st.at = Date.now();
    api.announce();
    return;
  }
  if (st.pending) return;
  st.pending = true;
  const t = setTimeout(() => {
    st.pending = false;
    st.at = Date.now();
    if (room.mode && room.mode.id === "turf") api.announce();
  }, wait);
  t.unref?.();
}

module.exports = register({
  id: "turf",
  name: "涂地战",
  hint: "限时抢地盘，涂在别人上面就抢过来，橡皮能擦回无主",

  init(room, user, msg, api) {
    const seconds = clampSeconds(Number(msg.seconds));
    room.mode.endsAt = Date.now() + seconds * 1000;
    room.mode.from = room.nextSeq - 1; // 开局之前画的不算进地盘
    room.mode.who = {};
    for (const u of room.users.values()) remember(room, u);
    rebuild(room);
    arm(room);
    pushSystem(room, `涂地战开始，${Math.round(seconds / 60 * 10) / 10} 分钟，谁涂得多谁赢`);
    api.announce();
  },

  stop(room, user, api) {
    finish(room); // 提前收摊也要算分：不然这局就白涂了
  },

  can(room, user, action) {
    // 场地固定才有得争，接长了就成了各涂各的
    if (action === "extend") return "涂地战的时候场地是定的";
    return null;
  },

  on(room, event, api) {
    if (event.type === "stroke_end" || event.type === "text") {
      const s = event.stroke;
      if (s) {
        const u = room.users.get(event.userId);
        if (u) remember(room, u);
        mark(gridOf(room), s);
      }
      nudge(room, api);
      return;
    }
    // 撤销/重做会改变已经涂过的地，位置关系乱了，整块重算最省心
    if (event.type === "undo" || event.type === "redo") {
      rebuild(room);
      nudge(room, api);
      return;
    }
    if (event.type === "join") {
      const u = room.users.get(event.userId);
      if (u) remember(room, u);
      api.announce();
    }
  },

  publicState(room, user) {
    const rank = board(room);
    const mine = rank.find((r) => r.userId === user.id);
    const head = rank.length
      ? rank.slice(0, 4).map((r) => `${r.name} ${r.pct}%`).join(" · ")
      : "还没人下手";
    return {
      label: head,
      tone: rank.length && rank[0].userId === user.id ? "you" : "wait",
      endsAt: room.mode.endsAt, // 客户端自己倒数，别每秒广播
      scores: rank,
      mine: mine ? mine.pct : 0,
      noExtend: true,
      hostActions:
        room.hostId === user.id
          ? [{ cmd: "finish", label: "提前收摊", confirm: "现在就结束？立刻算分。" }]
          : [],
    };
  },

  command(room, user, cmd) {
    if (cmd !== "finish") return;
    if (user.id !== room.hostId) return;
    finish(room);
  },

  restore(room) {
    // 格子不进存盘文件，重启后从笔画重算；倒计时照 deadline 接着倒
    rebuild(room);
    arm(room);
  },
});
