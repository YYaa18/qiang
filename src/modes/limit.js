"use strict";

// 限笔共作 —— 每人一共十笔，用完只能看着。
//
// 没有轮次，谁都可以随时画；约束只有一条：笔数有限。
// 于是下笔之前得先想清楚，一条线要顶从前的五条。画完的是一张所有人共同完成的画。
//
// 这个玩法存在的另一个理由：它是规则层抽象的试金石。
// 接龙用到了闸门、可见性、指令、状态存盘；限笔只用闸门和「动作之后」，
// 而且一行核心代码都不该改。如果加它需要动到 src/ 里的别的文件，说明抽象漏了。

const { pushSystem } = require("../wall/chat");
const { register } = require("./index");

const DEFAULT_QUOTA = 10;
const MIN_QUOTA = 1;
const MAX_QUOTA = 200;

function used(room, userId) {
  return (room.mode.used && room.mode.used[userId]) || 0;
}

function left(room, userId) {
  return Math.max(0, room.mode.quota - used(room, userId));
}

function bump(room, userId, d) {
  if (!room.mode.used) room.mode.used = {};
  const n = (room.mode.used[userId] || 0) + d;
  room.mode.used[userId] = Math.max(0, n);
}

// 屋里的人是不是都画完了
function allSpent(room) {
  const people = [...room.users.keys()];
  if (!people.length) return false;
  return people.every((id) => left(room, id) === 0);
}

function clampQuota(n) {
  if (!Number.isFinite(n)) return DEFAULT_QUOTA;
  return Math.max(MIN_QUOTA, Math.min(MAX_QUOTA, Math.round(n)));
}

module.exports = register({
  id: "limit",
  name: "限笔共作",
  hint: "每人只有十笔，用完只能看着——下笔前先想清楚",

  init(room, user, msg, api) {
    room.mode.quota = clampQuota(Number(msg.quota));
    room.mode.used = {};
    api.announce();
  },

  // 结束什么都不用收拾：笔画本来就都是公开的，没藏过东西
  stop(room, user, api) {
    api.end();
  },

  can(room, user, action) {
    if (action !== "draw" && action !== "text") return null;
    if (left(room, user.id) > 0) return null;
    return `你的 ${room.mode.quota} 笔用完了，看着吧`;
  },

  on(room, event, api) {
    // 落定了才算数：画到一半撤回（双指、吸附）不该扣
    if (event.type === "stroke_end" || event.type === "text") {
      bump(room, event.userId, 1);
    } else if (event.type === "undo") {
      bump(room, event.userId, -1); // 反悔一笔就还你一笔，这是修正不是作弊
    } else if (event.type === "redo") {
      bump(room, event.userId, 1);
    } else if (event.type === "join") {
      api.announce(); // 新来的人也有自己的十笔
      return;
    } else {
      return;
    }
    api.announce();
    if (allSpent(room)) pushSystem(room, "笔都用完了，这张画到此为止");
  },

  publicState(room, user) {
    const n = left(room, user.id);
    return {
      label: n > 0 ? `你还剩 ${n} 笔` : "你的笔用完了",
      tone: n > 0 ? "you" : "wait",
      blocked: n === 0,
      why: `你的 ${room.mode.quota} 笔已经用完了`,
      quota: room.mode.quota,
      left: n,
    };
  },

  restore(room) {
    if (!room.mode.quota) room.mode.quota = DEFAULT_QUOTA;
    if (!room.mode.used) room.mode.used = {};
  },
});
