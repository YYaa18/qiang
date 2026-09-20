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
const { send, broadcast } = require("../net");
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

module.exports = { ACTIONS, register, get, list, of, gate, allow, after };
