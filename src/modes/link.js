"use strict";

// 连线谜题 —— 把同色的两个圆点连起来，线不能交叉。
//
// 墙上会多出一段干净的纸，撒着几对彩色圆点。谁都可以连任何一对，一个人也能解完；
// 画过的线就留在墙上，成了后来每一条线的障碍。这是只有共享画布才做得出的谜题。
//
// 在一张没有边的纸上，这种题永远有解——线总能绕过去。难的是先后次序：
// 先把最近的那对拉一条直线，往往就把另一对的路堵死了，只能绕一大圈。
// 所以出题时专挑「直连的话会互相交叉」的摆法，不然就是连连看。
//
// 规矩全在服务端判：
//   - 起笔要落在一个还没连上的圆点上（起笔时就拦，省得白画）
//   - 收笔要落在同色的另一个点上，中途不能穿过别人的线、不能压到别的圆点
//   - 判不过的线退回去（对屋里的人来说就是一次撤销），并告诉画的人为什么
//   - 撤销自己的线就把那一对重新空出来；重做不行——那条线可能已经被后来的线挡住了
//
// 线只按几何判交叉，不算粗细：两条粗线挨得很近、看着叠在一起，只要没真的穿过去就算数。

const { SEG_W, CANVAS_H } = require("../config");
const { pushSystem } = require("../wall/chat");
const presence = require("../wall/presence");
const { placeStroke, retractStroke } = require("../wall/draw");
const { send } = require("../net");
const { register } = require("./index");

const COLORS = ["#C43C3C", "#3B5BDB", "#2F9E44", "#E67700", "#7048E8", "#0C8599"];
const DEFAULT_PAIRS = 5;
const MIN_PAIRS = 3;
const MAX_PAIRS = COLORS.length;

const DOT_W = 36; // 圆点的直径
const HIT = 34; // 起笔、收笔离圆点中心多近算落在点上
const AVOID = DOT_W / 2 + 4; // 线离别的圆点中心至少这么远，否则算压到了
const EDGE = 130; // 圆点离纸边至少这么远，留出绕行的余地
const SPREAD = 190; // 任意两个圆点至少隔这么远
const TRIES = 400;

// ───────────── 几何 ─────────────

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function near(p, dot, r) {
  return dist2(p, dot) <= r * r;
}

// 点到线段的距离平方
function segDist2(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSeg(p, a, b) {
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

// 两条线段有没有公共点（碰到端点、共线重叠都算）
function segsMeet(a, b, c, d) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(a, c, d)) return true;
  if (d2 === 0 && onSeg(b, c, d)) return true;
  if (d3 === 0 && onSeg(c, a, b)) return true;
  if (d4 === 0 && onSeg(d, a, b)) return true;
  return false;
}

// 一条折线有没有穿过另外几条。线可能有几千个点，所以先把已有的线段按格子分桶，
// 新线的每一小段只和它经过的格子里的线段比——不然四五条长线两两比就是几千万次。
const BUCKET = 60;

function crossesAny(pts, others) {
  if (!others.length || pts.length < 2) return false;
  const buckets = new Map();
  const put = (k, seg) => {
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(seg);
  };
  const keysOf = (a, b, fn) => {
    const x0 = Math.floor(Math.min(a.x, b.x) / BUCKET);
    const x1 = Math.floor(Math.max(a.x, b.x) / BUCKET);
    const y0 = Math.floor(Math.min(a.y, b.y) / BUCKET);
    const y1 = Math.floor(Math.max(a.y, b.y) / BUCKET);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(x * 100000 + y);
  };
  for (const line of others) {
    for (let i = 1; i < line.length; i++) {
      const seg = [line[i - 1], line[i]];
      keysOf(seg[0], seg[1], (k) => put(k, seg));
    }
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    let hit = false;
    keysOf(a, b, (k) => {
      if (hit) return;
      for (const [c, d] of buckets.get(k) || []) {
        if (segsMeet(a, b, c, d)) {
          hit = true;
          return;
        }
      }
    });
    if (hit) return true;
  }
  return false;
}

function touchesDot(pts, dot) {
  if (pts.length === 1) return near(pts[0], dot, AVOID);
  for (let i = 1; i < pts.length; i++) {
    if (segDist2(dot, pts[i - 1], pts[i]) <= AVOID * AVOID) return true;
  }
  return false;
}

// ───────────── 出题 ─────────────

// 在 [x0, x0+SEG_W] 这段纸上撒 n 对点。挑「两两直连会交叉得最多」的那一种摆法，
// 交叉数够了就收手——不追求最难，只要不是一眼就能连完。
function generate(n, x0, rand = Math.random) {
  let best = null;
  let bestScore = -1;
  for (let t = 0; t < TRIES; t++) {
    const dots = [];
    let ok = true;
    for (let k = 0; k < n * 2 && ok; k++) {
      let placed = false;
      for (let g = 0; g < 60 && !placed; g++) {
        const p = {
          x: Math.round(x0 + EDGE + rand() * (SEG_W - 2 * EDGE)),
          y: Math.round(EDGE + rand() * (CANVAS_H - 2 * EDGE)),
        };
        if (dots.every((q) => !near(p, q, SPREAD))) {
          dots.push(p);
          placed = true;
        }
      }
      if (!placed) ok = false;
    }
    if (!ok) continue;
    const pairs = [];
    for (let k = 0; k < n; k++) pairs.push({ a: dots[k * 2], b: dots[k * 2 + 1] });
    let score = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (segsMeet(pairs[i].a, pairs[i].b, pairs[j].a, pairs[j].b)) score++;
      }
      // 直线正好压过别的圆点，也算添了一道坎
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (touchesDot([pairs[i].a, pairs[i].b], pairs[j].a) || touchesDot([pairs[i].a, pairs[i].b], pairs[j].b)) score++;
      }
    }
    if (score > bestScore) {
      best = pairs;
      bestScore = score;
    }
    if (bestScore >= n) break;
  }
  return best;
}

// ───────────── 状态 ─────────────

// 这一笔起在哪个点上：{ pair, from, to }；不在任何点上是 null
function dotAt(room, p) {
  for (const pair of room.mode.pairs) {
    if (near(p, pair.a, HIT)) return { pair, from: pair.a, to: pair.b };
    if (near(p, pair.b, HIT)) return { pair, from: pair.b, to: pair.a };
  }
  return null;
}

function doneCount(room) {
  return room.mode.pairs.filter((p) => p.line).length;
}

// 一条刚画完的线算不算数；不算数返回理由
function judge(room, stroke) {
  if (stroke.shape === "rect" || stroke.shape === "ellipse") return "连线只能画线，不能画框";
  const pts = stroke.points || [];
  const start = dotAt(room, pts[0]);
  if (!start) return "要从一个圆点开始画";
  if (start.pair.line) return "这一对刚被别人连上了";
  const end = pts[pts.length - 1];
  if (!near(end, start.to, HIT)) return "要连到同色的另一个点上";

  for (const pair of room.mode.pairs) {
    if (pair === start.pair) continue;
    if (touchesDot(pts, pair.a) || touchesDot(pts, pair.b)) return "线压到了别的圆点";
  }
  // 已连上的线用自己存的那份点：墙上的笔多了会冻结成墨迹图，room.strokes 里就找不到它了
  const others = room.mode.pairs.filter((p) => p !== start.pair && p.line).map((p) => p.pts);
  if (crossesAny(pts, others)) return "和别的线交叉了";
  return null;
}

function elapsed(room) {
  const s = Math.max(1, Math.round((Date.now() - room.mode.startedAt) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

module.exports = register({
  id: "link",
  name: "连线谜题",
  hint: "把同色的两个点连起来，线不能交叉——先连哪一对，是这道题的全部",

  init(room, user, msg, api) {
    const n = Math.max(MIN_PAIRS, Math.min(MAX_PAIRS, Math.round(Number(msg.pairs)) || DEFAULT_PAIRS));
    const seg = presence.freshPaper(room, user.id);
    const x0 = seg * SEG_W;
    const layout = generate(n, x0);
    if (!layout) {
      // 撒不下这么多点——不该发生（间距是按六对算的），真发生了也别开出一道坏题
      api.end();
      send(user.ws, { type: "error", code: "not_allowed", message: "这道题没出成，再试一次" });
      return;
    }
    room.mode.seg = seg;
    room.mode.startedAt = Date.now();
    room.mode.pairs = layout.map((p, i) => ({ color: COLORS[i], a: p.a, b: p.b, line: null }));
    // 圆点就是墙上的墨迹：之后冻结、导出、进展厅都带着它们
    for (const pair of room.mode.pairs) {
      for (const d of [pair.a, pair.b]) {
        placeStroke(room, { color: pair.color, width: DOT_W, points: [{ x: d.x, y: d.y }] });
      }
    }
    pushSystem(room, `连线谜题：${n} 对点，把同色的连起来，线不能交叉`);
    api.announce();
  },

  stop(room, user, api) {
    api.end(); // 点和线都留在墙上
  },

  can(room, user, action, msg) {
    if (action === "text") return "连线谜题里不写字";
    if (action === "redo") return "重做不了——那条线可能已经被挡住了，重新画一条吧";
    if (action !== "draw") return null;
    if (msg && msg.strokeType === "eraser") return "连线谜题里不用橡皮，想重来就撤销";
    const raw = msg && msg.point ? msg.point : msg || {};
    const p = { x: Number(Array.isArray(raw) ? raw[0] : raw.x), y: Number(Array.isArray(raw) ? raw[1] : raw.y) };
    const at = dotAt(room, p);
    if (!at) return "要从一个圆点开始画";
    if (at.pair.line) return "这一对已经连好了";
    return null;
  },

  on(room, event, api) {
    if (event.type === "stroke_end") {
      const s = event.stroke;
      const why = judge(room, s);
      if (why) {
        retractStroke(room, s.id);
        const u = room.users.get(s.userId);
        if (u) send(u.ws, { type: "error", code: "not_allowed", message: why });
        return;
      }
      const pair = dotAt(room, s.points[0]).pair;
      pair.line = s.id;
      pair.pts = s.points;
      if (doneCount(room) === room.mode.pairs.length) {
        pushSystem(room, `连线谜题解开了：${room.mode.pairs.length} 对全部连上，用了 ${elapsed(room)}`);
        api.end();
      }
      api.announce();
      return;
    }
    if (event.type === "undo") {
      const pair = room.mode.pairs.find((p) => p.line === event.id);
      if (pair) {
        pair.line = null;
        pair.pts = null;
        api.announce();
      }
      return;
    }
    if (event.type === "join") api.announce();
  },

  publicState(room) {
    const n = room.mode.pairs.length;
    const done = doneCount(room);
    const x0 = room.mode.seg * SEG_W;
    return {
      label: `连好了 ${done} / ${n} 对 · 线不能交叉`,
      tone: "you",
      blocked: false,
      drawable: { x0, x1: x0 + SEG_W },
      done,
      total: n,
    };
  },

  // 只给测试用
  _generate: generate,
  _crossesAny: crossesAny,
});
