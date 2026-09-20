"use strict";

// 说话和光标：墙上除了画以外的两种动静。

const crypto = require("crypto");

const { CHAT_MAX, CURSOR_FLUSH_MS } = require("../config");
const { broadcast } = require("../net");
const { ctxOf, scheduleSave } = require("../store");
const { asPoint } = require("../protocol");

// 系统消息（来了、走了、被清空了）也走聊天，这样它们跟着房间一起存盘
function pushSystem(room, text) {
  const msg = {
    id: crypto.randomUUID(),
    userId: "system",
    text,
    t: Date.now(),
  };
  room.chat.push(msg);
  if (room.chat.length > CHAT_MAX) {
    room.chat.splice(0, room.chat.length - CHAT_MAX);
  }
  broadcast(room, { type: "chat", message: msg });
  return msg;
}

function handleChat(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const text = String(msg.text || "").trim();
  if (!text) return;
  const clipped = text.slice(0, 200);
  const message = {
    id: crypto.randomUUID(),
    userId: user.id,
    text: clipped,
    t: Date.now(),
    name: user.name,
    color: user.color,
  };
  room.chat.push(message);
  if (room.chat.length > CHAT_MAX) {
    room.chat.splice(0, room.chat.length - CHAT_MAX);
  }
  broadcast(room, { type: "chat", message });
  scheduleSave(room);
}

function handleCursor(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const p = asPoint(room, { x: msg.x, y: msg.y });
  if (!p) return;
  room.cursors.set(user.id, p);
  if (room.cursorTimer) return;
  room.cursorTimer = setTimeout(() => flushCursors(room), CURSOR_FLUSH_MS);
  room.cursorTimer.unref?.();
}

// 四个人各自 20Hz 地发，就是 80 条消息在天上飞，而这只是装饰。
// 攒一小会儿合成一条群发，客户端自己跳过自己那一份。
function flushCursors(room) {
  room.cursorTimer = null;
  if (!room.cursors.size) return;
  const list = [];
  for (const [userId, p] of room.cursors) {
    if (room.users.has(userId)) list.push({ userId, x: p.x, y: p.y });
  }
  room.cursors.clear();
  if (list.length) broadcast(room, { type: "cursors", list });
}

module.exports = { pushSystem, handleChat, handleCursor, flushCursors };
