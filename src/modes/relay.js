"use strict";

// 接龙 —— 盖住一部分，把笔交出去。
//
// 卷轴按「棒次」切段，一次只有一个人能画，而且只能画自己那一段。
// 别人画的看不见，只能看见上一段最右边露出来的一条窄缝，用来接上。
// 全部画完由房主揭晓，镜头从左滚到右——这是整个玩法的高潮。
//
// 一套机制覆盖四种局面：
//   1 人   画一段留在墙上，等下一个推门进来的人接
//   2 人异步  我画一半盖住，你晚点来补完
//   2 人同步  乒乓式来回接
//   3–4 人   接力长卷
//
// 所以「轮次」是一根**接力棒**，不是固定 N 人的环：棒可以放在墙上没人拿着
// （holder 为 null），谁来了谁接。固定的环在两人局里掉一个人就死锁了。

const { SEG_W, MAX_SEGMENTS } = require("../config");
const { send, broadcast } = require("../net");
const { pushSystem } = require("../wall/chat");
const presence = require("../wall/presence");
const { register } = require("./index");

const PEEK = 90; // 上一段露出这么宽，够接上笔又看不出画的是什么
const MIN_LEG = 400;
const MAX_LEG = SEG_W * 2;

function legs(room) {
  return room.mode.legs || [];
}

function currentLeg(room) {
  const list = legs(room);
  return list.length ? list[list.length - 1] : null;
}

// 一笔横跨的横向范围。文字量不了宽，按每字 22px 从宽估，多算一点没关系。
function xRange(s) {
  if (s.type === "text") {
    const w = [...(s.text || "")].length * 22;
    return [s.x, s.x + w];
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of s.points || []) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
  }
  if (!Number.isFinite(x0)) return [0, 0];
  const pad = (s.width || 0) * 0.8 + 1;
  return [x0 - pad, x1 + pad];
}

function overlaps(range, a, b) {
  return range[1] > a && range[0] < b;
}

// 当前这一段之前的那条窄缝：接棒的人靠它把线接上
function peekZone(room) {
  const list = legs(room);
  if (list.length < 2) return null;
  const prev = list[list.length - 2];
  return [Math.max(prev.x0, prev.x1 - PEEK), prev.x1];
}

function startLeg(room, userId) {
  const list = legs(room);
  const last = list.length ? list[list.length - 1] : null;
  const x0 = last ? last.x1 : 0;
  const leg = { userId, x0, x1: x0 + room.mode.legW, t: Date.now() };
  list.push(leg);
  room.mode.legs = list;
  // 墙得够长，接棒的人才有地方画。玩法自己把墙接长，所以也得自己把这件事说出去，
  // 否则客户端不知道要多铺一段纸。
  const need = Math.ceil(leg.x1 / SEG_W);
  if (need > room.segments) {
    room.segments = Math.min(MAX_SEGMENTS, need);
    broadcast(room, { type: "extend", segments: room.segments });
  }
  return leg;
}

// 每个人看到的玩法状态不一样（我那一段在哪、窄缝在哪），所以一人一条
function announce(room, api) {
  for (const u of room.users.values()) {
    if (u.ws) send(u.ws, { type: "mode", state: publicFor(room, u) });
  }
  api.save();
}

function publicFor(room, user) {
  const m = room.mode;
  const leg = currentLeg(room);
  const mine = leg && leg.userId === user.id;
  return {
    id: "relay",
    revealed: !!m.revealed,
    holder: m.holder,
    holderName: m.holder ? nameOf(room, m.holder) : null,
    legCount: legs(room).length,
    legW: m.legW,
    peek: PEEK,
    // 我这一段画在哪（不是我的棒次就没有）
    myLeg: mine ? { x0: leg.x0, x1: leg.x1 } : null,
    // 窄缝的位置，客户端据此画出遮挡
    peekZone: m.revealed ? null : peekZone(room),
    // 揭晓后整条卷轴都能看
    wallEnd: legs(room).length ? legs(room)[legs(room).length - 1].x1 : m.legW,
  };
}

// 揭晓就是这局的终点：把整条卷轴交还给所有人，然后把玩法摘掉。
// 留着一个 revealed 的玩法状态没有任何用处，只会让墙一直顶着一条横幅，
// 而且会让「藏着笔画时不烘焙」那条规则永远生效，旧笔再也冻结不了。
function finish(room, api) {
  const n = legs(room).length;
  room.mode.revealed = true;
  api.end(); // 先摘掉玩法，下面那一份整墙才是干干净净的
  presence.resend(room);
  pushSystem(room, `接龙揭晓了 · 整条卷轴一共 ${n} 段，都看得见了`);
}

function nameOf(room, id) {
  const u = room.users.get(id);
  return u ? u.name : "某人";
}

module.exports = register({
  id: "relay",

  init(room, user, msg, api) {
    const legW = clampLeg(Number(msg.legW));
    room.mode.legW = legW;
    room.mode.legs = [];
    room.mode.holder = null;
    room.mode.revealed = false;
    startLeg(room, user.id);
    room.mode.holder = user.id;
    pushSystem(room, `接龙开始了，${user.name}先画第一段`);
    announce(room, api);
  },

  // 中途结束也等于揭晓：不然那些藏起来的笔画谁也看不到了
  stop(room, user, api) {
    finish(room, api);
  },

  // ───────────── 闸门 ─────────────

  can(room, user, action) {
    if (room.mode.revealed) {
      // 揭晓之后这面墙就是普通的墙了，随便画
      return null;
    }
    if (action === "draw" || action === "text") {
      if (room.mode.holder !== user.id) {
        return room.mode.holder
          ? `现在轮到${nameOf(room, room.mode.holder)}画`
          : "笔还在墙上，接过来才能画";
      }
      return null;
    }
    if (action === "undo" || action === "redo") {
      // 只能反悔自己这一段里的事
      return room.mode.holder === user.id ? null : "这一段不是你画的";
    }
    if (action === "extend") {
      return "接龙的时候墙会自己接长";
    }
    return null;
  },

  // ───────────── 可见性 ─────────────

  visible(room, user, stroke) {
    if (room.mode.revealed) return true;
    if (stroke.userId === user.id) return true; // 自己画的当然看得见
    const zone = peekZone(room);
    if (!zone) return false;
    return overlaps(xRange(stroke), zone[0], zone[1]);
  },

  publicState(room, user) {
    return publicFor(room, user);
  },

  // ───────────── 玩法自己的指令 ─────────────

  command(room, user, cmd, msg, api) {
    const m = room.mode;

    if (cmd === "pass") {
      if (m.holder !== user.id) return;
      if (m.revealed) return;
      if (legs(room).length >= MAX_SEGMENTS) return;
      m.holder = null; // 棒放回墙上，谁来谁接
      startLeg(room, null);
      pushSystem(room, `${user.name}画完了一段，笔放在墙上了`);
      announce(room, api);
      return;
    }

    if (cmd === "take") {
      if (m.revealed) return;
      if (m.holder) return; // 已经有人拿着了
      const leg = currentLeg(room);
      if (!leg) return;
      leg.userId = user.id;
      m.holder = user.id;
      pushSystem(room, `${user.name}接过了笔`);
      announce(room, api);
      return;
    }

    if (cmd === "reveal") {
      if (user.id !== room.hostId) return;
      if (m.revealed) return;
      finish(room, api);
      return;
    }
  },

  // ───────────── 动作之后 ─────────────

  on(room, event, api) {
    const m = room.mode;
    if (m.revealed) return;

    // 拿着笔的人走了：棒回到墙上，别让这局卡死在一个不在的人身上
    if (event.type === "leave" && m.holder === event.userId) {
      m.holder = null;
      pushSystem(room, "拿笔的人走了，笔放回了墙上");
      announce(room, api);
      return;
    }

    // 有人进来时把玩法状态给他，否则他只看得见一面空墙却不知道为什么
    if (event.type === "join") {
      announce(room, api);
    }
  },

  restore(room) {
    // 接龙没有定时器要重建。棒停在谁手里就停在谁手里——
    // 异步就是这个玩法的常态，一根棒在墙上放一整夜完全正常。
    if (!Array.isArray(room.mode.legs)) room.mode.legs = [];
    if (!room.mode.legW) room.mode.legW = SEG_W;
  },
});

function clampLeg(n) {
  if (!Number.isFinite(n)) return SEG_W;
  return Math.max(MIN_LEG, Math.min(MAX_LEG, Math.round(n)));
}
