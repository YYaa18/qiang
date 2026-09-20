"use strict";

// 一间房的形状，以及从它派生出来的、发给客户端的那几种数据。
// 这里只碰内存里的对象：不读盘、不发消息。

const { PALETTE } = require("./config");

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.createdAt = Date.now();
    this.hostId = hostId;
    this.locked = false;
    /** @type {Map<string, User>} */
    this.users = new Map();
    /** @type {Stroke[]} */
    this.strokes = [];
    /** @type {ChatMessage[]} */
    this.chat = [];
    this.nextSeq = 1;
    this.segments = 1;
    // 冻结状态：seq ≤ frozenUpTo 的笔都已画进各段的墨迹图，矢量存档在磁盘上
    this.frozenUpTo = 0;
    /** @type {Record<string, number>} 段号 → 墨迹图版本 */
    this.segVersions = {};
    /** @type {Set<string>} 冻结后又被撤销的笔 */
    this.hiddenFrozen = new Set();
    /** @type {Record<string, number[]>} 仍在某人撤销/重做栈里的冻结笔 → 所在段 */
    this.frozenIndex = {};
    /** @type {Set<number>} 需要从存档整段重画的段 */
    this.dirtyFull = new Set();
    this.job = null;
    this.loadingFull = false; // 正在从存档读整段重画所需的笔画
    this.bakeFails = 0; // 连续几次没烘成，用来决定退避多久
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.bakeTimer = null;
    /** @type {Map<string, {x:number,y:number}>} 待发的光标位置 */
    this.cursors = new Map();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.cursorTimer = null;
    this.emptySince = 0; // 最后一个人离开的时刻，用来决定何时从内存请出去
    /** @type {Record<string, string>} */
    this.colorByUser = {};
    /** @type {Record<string, { undo: string[], redo: string[] }>} */
    this.stacks = {};
    /** @type {number|null} */
    this.clearDeadline = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.clearTimer = null;
    /** @type {Map<string, Stroke>} */
    this.open = new Map();
  }
}

/**
 * @typedef {object} User
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {import('ws').WebSocket|null} ws
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {boolean} kicked
 * @property {boolean} replaced
 * @property {boolean=} weak
 */

/**
 * @typedef {object} Stroke
 * @property {string} id
 * @property {number} seq
 * @property {string} userId
 * @property {'pen'|'eraser'|'text'} type
 * @property {string} color
 * @property {number} width
 * @property {{x:number,y:number}[]=} points
 * @property {string=} text
 * @property {number=} x
 * @property {number=} y
 * @property {boolean} hidden
 * @property {number} t
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {string} userId
 * @property {string} text
 * @property {number} t
 * @property {string=} name
 * @property {string=} color
 */

function assignColor(room, clientId) {
  const used = new Set([...room.users.values()].map((u) => u.color.toUpperCase()));
  const prev = room.colorByUser[clientId];
  if (prev && !used.has(prev.toUpperCase())) return prev.toUpperCase();
  for (const c of PALETTE) {
    if (!used.has(c.toUpperCase())) return c;
  }
  return PALETTE[0];
}

function ensureStack(room, userId) {
  if (!room.stacks[userId]) room.stacks[userId] = { undo: [], redo: [] };
  return room.stacks[userId];
}

function publicUsers(room) {
  return [...room.users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    color: u.color,
    host: u.id === room.hostId,
    online: !!(u.ws && u.ws.readyState === 1),
  }));
}

function youInfo(room, user) {
  const st = ensureStack(room, user.id);
  return {
    id: user.id,
    name: user.name,
    color: user.color,
    isHost: room.hostId === user.id,
    canUndo: st.undo.length > 0,
    canRedo: st.redo.length > 0,
  };
}

function snapshotMsg(room, user) {
  return {
    type: "snapshot",
    code: room.code,
    users: publicUsers(room),
    strokes: room.strokes,
    chat: room.chat,
    locked: room.locked,
    segments: room.segments,
    frozenUpTo: room.frozenUpTo,
    segVersions: room.segVersions,
    clearDeadline: room.clearDeadline,
    you: youInfo(room, user),
  };
}

function serialize(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    hostId: room.hostId,
    locked: room.locked,
    strokes: room.strokes,
    chat: room.chat,
    nextSeq: room.nextSeq,
    segments: room.segments,
    frozenUpTo: room.frozenUpTo,
    segVersions: room.segVersions,
    hiddenFrozen: [...room.hiddenFrozen],
    frozenIndex: room.frozenIndex,
    dirtyFull: [...room.dirtyFull],
    colorByUser: room.colorByUser,
    stacks: room.stacks,
    clearDeadline: room.clearDeadline,
  };
}

module.exports = {
  Room,
  assignColor,
  ensureStack,
  publicUsers,
  youInfo,
  snapshotMsg,
  serialize,
};
