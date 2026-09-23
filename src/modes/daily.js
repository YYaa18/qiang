"use strict";

// 一日一笔 —— 每人每天只能画一笔。
//
// 不是游戏，是一个关于「什么值得被记住」的装置。墙最常见的样子是只有一个人在，
// 这个玩法专门为那种时候做：你今天推门进来，看看别人昨天留下的那一笔，想好了再落自己的。
// 一个月之后，墙上是几十个「那一天」。
//
// 几条规矩，每一条都是为了让「一笔」真的只有一笔：
//
//   - 今天的一笔落定之前可以撤销重来，撤了就还你——那是修正，不是多画。
//   - 昨天以前的笔撤不掉。它已经是墙的一部分了，撤销会让「一天一笔」变成「一天随便改」。
//   - 橡皮和文字也算一笔。用今天这一笔去擦掉点什么，也是一种选择。
//
// 「今天」按 QIANG_TZ 算（默认北京时间），不按服务器本机时区——
// 部署在 UTC 的 VPS 上时，零点不该落在早上八点。
//
// 跨过零点时要告诉在场的人「又能画了」，所以挂一个到下一个零点的定时器。
// 和涂地战一样，定时器不存盘，restore 时重新挂。

const { pushSystem } = require("../wall/chat");
const { register, apiFor } = require("./index");
const store = require("../store");

const TZ = process.env.QIANG_TZ || "Asia/Shanghai";
const DEFAULT_PER_DAY = 1;
const MAX_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {WeakMap<object, ReturnType<typeof setTimeout>>} */
const timers = new WeakMap();

let dayFmt;
try {
  dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
} catch {
  console.error(`QIANG_TZ=${TZ} 不是有效的时区，改用服务器本地时间`);
  dayFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 这一刻在那个时区是哪一天，形如 2026-09-23。测试可以把 now 换掉。 */
function dayOf(t) {
  return dayFmt.format(new Date(t));
}

const clock = { now: () => Date.now() };

function today() {
  return dayOf(clock.now());
}

// 两个日期之间差几天。日期字符串按 UTC 解析，只是拿来做减法，不碰时区。
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

// 离下一个零点还有多久。时区有夏令时的话一天不一定是 24 小时，
// 所以不硬算，往后找到日期变了的那一刻（先按小时跳，再按分钟收）。
function msToNextDay(now) {
  const d = dayOf(now);
  let t = now;
  while (dayOf(t + 60 * 60 * 1000) === d) t += 60 * 60 * 1000;
  while (dayOf(t) === d) t += 60 * 1000;
  return Math.max(1000, t - now);
}

function clampPerDay(n) {
  if (!Number.isFinite(n)) return DEFAULT_PER_DAY;
  return Math.max(1, Math.min(MAX_PER_DAY, Math.round(n)));
}

// 我今天落定的那几笔。不是今天的记录就当作还没画。
function todays(room, userId) {
  const rec = room.mode.spent && room.mode.spent[userId];
  if (!rec || rec.day !== today()) return [];
  return rec.ids;
}

function left(room, userId) {
  return Math.max(0, room.mode.perDay - todays(room, userId).length);
}

function spend(room, userId, id) {
  if (!room.mode.spent) room.mode.spent = {};
  const d = today();
  const rec = room.mode.spent[userId];
  if (!rec || rec.day !== d) room.mode.spent[userId] = { day: d, ids: [id] };
  else if (!rec.ids.includes(id)) rec.ids.push(id);
}

function refund(room, userId, id) {
  const ids = todays(room, userId);
  const i = ids.indexOf(id);
  if (i >= 0) ids.splice(i, 1);
}

// 到零点告诉在场的人又能画了，然后挂下一个零点
function arm(room) {
  clearTimeout(timers.get(room));
  const t = setTimeout(() => {
    timers.delete(room);
    if (!room.mode || room.mode.id !== "daily") return; // 已经收了（结束、清空）
    // 房间闲置被请出内存了：这个对象已经作废，下次读起来 restore 会另挂一个
    if (store.rooms.get(room.code) !== room) return;
    const api = apiFor(room);
    if ([...room.users.values()].some((u) => u.ws)) {
      pushSystem(room, `新的一天，${nth(room)}。每人又有${room.mode.perDay > 1 ? ` ${room.mode.perDay} ` : "一"}笔`);
    }
    api.announce();
    arm(room);
  }, msToNextDay(clock.now()));
  t.unref?.();
  timers.set(room, t);
}

function nth(room) {
  return `第 ${daysBetween(room.mode.since, today()) + 1} 天`;
}

module.exports = register({
  id: "daily",
  name: "一日一笔",
  hint: "每人每天只能画一笔，昨天的笔撤不掉——想好了再落",

  init(room, user, msg, api) {
    room.mode.perDay = clampPerDay(Number(msg.perDay));
    room.mode.since = today();
    room.mode.spent = {};
    arm(room);
    pushSystem(room, "一日一笔开始了：每人每天一笔，零点换日");
    api.announce();
  },

  stop(room, user, api) {
    clearTimeout(timers.get(room));
    timers.delete(room);
    api.end(); // 画都留着；只是从明天起不再限笔
  },

  can(room, user, action) {
    if (action === "draw" || action === "text") {
      if (left(room, user.id) > 0) return null;
      return room.mode.perDay > 1 ? `今天的 ${room.mode.perDay} 笔画完了，明天再来` : "今天这一笔已经画了，明天再来";
    }
    if (action === "undo") {
      // 撤的是栈顶那一笔。只有今天落的才能撤——昨天的已经是墙的一部分了
      const st = room.stacks[user.id];
      const top = st && st.undo.length ? st.undo[st.undo.length - 1] : null;
      if (!top || todays(room, user.id).includes(top)) return null;
      return "之前画的撤不掉了，它已经留在墙上";
    }
    if (action === "redo") {
      return left(room, user.id) > 0 ? null : "今天的笔已经用了，重做不了";
    }
    return null;
  },

  on(room, event, api) {
    if (event.type === "stroke_end") {
      spend(room, event.userId, event.stroke.id);
    } else if (event.type === "text") {
      spend(room, event.userId, event.stroke.id);
    } else if (event.type === "undo") {
      refund(room, event.userId, event.id);
    } else if (event.type === "redo") {
      spend(room, event.userId, event.id);
    } else if (event.type !== "join") {
      return;
    }
    api.announce();
  },

  publicState(room, user) {
    const n = left(room, user.id);
    const per = room.mode.perDay;
    const day = nth(room);
    let label;
    if (n === 0) label = `${day} · 今天画过了，明天再来`;
    else if (per === 1) label = `${day} · 今天这一笔还没落`;
    else label = `${day} · 今天还剩 ${n} 笔`;
    return {
      label,
      tone: n > 0 ? "you" : "wait",
      blocked: n === 0,
      why: per > 1 ? `今天的 ${per} 笔画完了，零点之后再来` : "今天这一笔已经画了，零点之后再来",
      perDay: per,
      left: n,
      day: daysBetween(room.mode.since, today()) + 1,
    };
  },

  restore(room) {
    room.mode.perDay = clampPerDay(Number(room.mode.perDay));
    if (!room.mode.since) room.mode.since = today();
    if (!room.mode.spent) room.mode.spent = {};
    arm(room);
  },

  // 只给测试用：把时钟拨到别的日子
  _clock: clock,
  _msToNextDay: msToNextDay,
});
