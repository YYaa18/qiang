"use strict";

// 风化墙 —— 墨迹会慢慢褪去，有人来描一遍才留得住。
//
// 不是游戏，是一个关于「什么值得被记住」的装置：没人理会的角落淡成一层影子，
// 反复有人描的地方一直是新的。过一个月再看，墙上浓淡的分布就是大家在意过什么。
//
// 难点在冻结：旧笔画早就烘焙成每段一张墨迹图，已经没有「这一笔多老了」可问。
// 所以不给笔记年龄，给**墙**记年龄——墙切成 50px 的格子，每格记最后一次有人在这儿落笔的时刻。
// 客户端把格子的年龄画成一张很小的透明度图（每段 32×20 像素），当作墨层的遮罩放大铺上去，
// 放大时自然插值成柔和的渐变。遮罩不管底下是矢量还是墨迹图，冻结了照样褪。
//
// 描摹就是在上面再画：一笔经过的格子全部回到「刚刚」。格子是按区域算的，
// 所以描一条线会顺带救回它周围一小圈——救的是一块地方，不是某一笔。
//
// 褪到底也不会没：留一层很淡的影子，不然后来的人想描都不知道描哪儿。
//
// 风化墙里没有橡皮——时间会替你擦。（另一个原因：有人用橡皮时，客户端的活动层里
// 放着一份没有遮罩的墨层副本，褪掉的墨迹会整段闪回来。）
//
// 玩法结束，遮罩撤掉，墨迹全部回到原来的样子：风化只是盖在墙上的一层，不改墙本身。
//
// 格子的年龄跟着房间存盘（room.mode.segs），每段一个字符串，每格两个字符，记的是
// 「开局后第几个时间单位被碰过」。以天计的褪色用小时做单位；几分钟褪完的演示档用秒。
// 两个字符只记得到 4095 个单位，快满时把起点往后挪、所有格子一起减掉（rebase）——
// 被减到 0 的格子本来就早褪到底了，看上去什么都不变。
//
// 发给客户端的是一份通用的 `fade` 显示指令，客户端不认识「风化」这个词。
// 落笔后的刷新客户端按同样的规则自己算（笔画消息里有它需要的一切），
// 所以服务端不必每一笔都广播整张年龄表；只在开局、接长、进门时给一份权威的。

const { SEG_W, CANVAS_H } = require("../config");
const { pushSystem } = require("../wall/chat");
const { register } = require("./index");

const CELL = 50;
const COLS = SEG_W / CELL; // 32
const ROWS = CANVAS_H / CELL; // 20
const HOUR = 60 * 60 * 1000;
const SECOND = 1000;
const PAD = 8; // 一笔除了自己的粗细，再往外多救这么一圈

const DAY_CHOICES = [1, 3, 7, 30];
const DEFAULT_DAYS = 7;
// 演示档：当面给朋友看「褪了、描一下又回来了」，等不了一天
const DEMO_SECONDS = 3 * 60;
const HOLD = 0.1; // 前 10% 的时间一点不褪：刚画的总得先好好看两天
const FLOOR = 0.08; // 褪到底剩下的影子

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_U = 64 * 64 - 1;

const clock = { now: () => Date.now() };

function encode(cells) {
  let s = "";
  for (const h of cells) s += B64[h >> 6] + B64[h & 63];
  return s;
}

function decode(str) {
  const cells = new Array(COLS * ROWS).fill(0);
  for (let i = 0; i < cells.length && i * 2 + 1 < str.length; i++) {
    cells[i] = (B64.indexOf(str[i * 2]) << 6) | B64.indexOf(str[i * 2 + 1]);
  }
  return cells;
}

// 这局的时间单位和褪到底要多少个单位
function unitOf(m) {
  return m.demo ? SECOND : HOUR;
}

function spanOf(m) {
  return m.demo ? DEMO_SECONDS : m.days * 24;
}

function unitsNow(room) {
  return Math.max(0, Math.min(MAX_U, Math.floor((clock.now() - room.mode.t0) / unitOf(room.mode))));
}

// 快记不下了：起点往后挪一半的量程，所有格子一起减。挪掉的那段比褪到底的时长还长
// （量程一半是 2047 个单位，最长的 30 天也才 720 小时），所以被减到 0 的格子本来就只剩影子了。
// 返回有没有挪过——挪过就得给每个人重发一份。
function rebase(room) {
  const m = room.mode;
  const now = Math.floor((clock.now() - m.t0) / unitOf(m));
  if (now < MAX_U - 16) return false;
  const shift = now - Math.floor(MAX_U / 2);
  m.t0 += shift * unitOf(m);
  for (const k of Object.keys(m.segs)) {
    m.segs[k] = encode(decode(m.segs[k]).map((u) => Math.max(0, u - shift)));
  }
  return true;
}

function freshSeg(room) {
  return encode(new Array(COLS * ROWS).fill(unitsNow(room)));
}

// 每一段都得有一份；缺的（新接出来的、旧存档里没有的）按「刚刚」补上
function fillSegs(room) {
  if (!room.mode.segs) room.mode.segs = {};
  for (let i = 0; i < room.segments; i++) {
    if (typeof room.mode.segs[i] !== "string") room.mode.segs[i] = freshSeg(room);
  }
}

// 一笔经过的格子：沿线每隔不到半格取一个点，把点周围 r 以内碰到的格子都算上。
// 客户端 touchFade() 是同一条规则的抄本——改这里要一起改。
function cellsOf(stroke) {
  const out = new Set();
  const mark = (x, y, r) => {
    const c0 = Math.floor((x - r) / CELL);
    const c1 = Math.floor((x + r) / CELL);
    const r0 = Math.max(0, Math.floor((y - r) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((y + r) / CELL));
    for (let c = c0; c <= c1; c++) {
      if (c < 0) continue;
      for (let row = r0; row <= r1; row++) out.add(c * ROWS + row);
    }
  };
  if (stroke.type === "text") {
    // 服务端量不了字宽，按一个字 28px 估；客户端也用同样的估法，两边才对得上
    const w = String(stroke.text || "").length * 28;
    for (let x = stroke.x; x <= stroke.x + w; x += CELL / 2) mark(x, stroke.y + 16, 20);
    return out;
  }
  const pts = stroke.points || [];
  const r = (stroke.width || 0) / 2 + PAD;
  const step = Math.max(4, Math.min(CELL / 2, r));
  if (pts.length) mark(pts[0].x, pts[0].y, r);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k <= n; k++) mark(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, r);
  }
  return out;
}

// 把这一笔经过的格子都记成「刚刚」
function touch(room, stroke) {
  const h = unitsNow(room);
  const bySeg = new Map();
  for (const key of cellsOf(stroke)) {
    const col = Math.floor(key / ROWS);
    const row = key % ROWS;
    const seg = Math.floor(col / COLS);
    if (seg >= room.segments) continue;
    if (!bySeg.has(seg)) bySeg.set(seg, []);
    bySeg.get(seg).push((col % COLS) * ROWS + row);
  }
  for (const [seg, idxs] of bySeg) {
    const cells = decode(room.mode.segs[seg] || freshSeg(room));
    for (const i of idxs) cells[i] = h;
    room.mode.segs[seg] = encode(cells);
  }
}

module.exports = register({
  id: "weather",
  name: "风化墙",
  hint: "墨迹会慢慢褪成影子，有人再描一遍才留得住",
  // 菜单照着它一档一条地长出来
  variants: [
    { label: "3 分钟演示", opts: { demo: true } },
    { label: "1 天", opts: { days: 1 } },
    { label: "7 天", opts: { days: 7 } },
    { label: "30 天", opts: { days: 30 } },
  ],

  init(room, user, msg, api) {
    room.mode.t0 = clock.now();
    room.mode.demo = msg.demo === true;
    room.mode.days = DAY_CHOICES.includes(Number(msg.days)) ? Number(msg.days) : DEFAULT_DAYS;
    room.mode.segs = {};
    fillSegs(room);
    pushSystem(
      room,
      room.mode.demo
        ? "风化墙演示：墨迹 3 分钟褪成影子，描一遍就回来"
        : `风化墙开始了：墨迹 ${room.mode.days} 天褪成影子，想留住的就描一遍`
    );
    api.announce();
  },

  stop(room, user, api) {
    api.end(); // 遮罩撤掉，墨迹全部回来
  },

  can(room, user, action, msg) {
    if (action === "draw" && msg && msg.strokeType === "eraser") return "风化墙里没有橡皮——时间会替你擦";
    return null;
  },

  on(room, event, api) {
    if (event.type === "stroke_end" || event.type === "text") {
      const moved = rebase(room);
      touch(room, event.stroke);
      if (moved) api.announce(); // 起点挪了，每个人手里那份都得换
      else api.save();
    } else if (event.type === "extend") {
      fillSegs(room);
      api.announce();
    }
  },

  publicState(room) {
    const how = room.mode.demo ? "3 分钟" : `${room.mode.days} 天`;
    return {
      label: `风化墙 · ${how}褪成影子，描一遍就回来`,
      tone: "free",
      noEraser: true,
      fade: {
        t0: room.mode.t0,
        cell: CELL,
        unit: unitOf(room.mode), // 一个时间单位多少毫秒
        span: spanOf(room.mode), // 多少个单位褪到底
        hold: HOLD,
        floor: FLOOR,
        pad: PAD,
        segs: room.mode.segs,
      },
    };
  },

  restore(room) {
    if (!room.mode.t0) room.mode.t0 = clock.now();
    if (!DAY_CHOICES.includes(room.mode.days)) room.mode.days = DEFAULT_DAYS;
    fillSegs(room);
  },

  // 只给测试用
  _clock: clock,
  _decode: decode,
  _cellsOf: cellsOf,
  _rebase: rebase,
  MAX_U,
  COLS,
  ROWS,
});
