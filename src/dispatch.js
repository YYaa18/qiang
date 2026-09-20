"use strict";

// 客户端发来的每一条消息落到哪个处理函数。
//
// 以后加玩法时，规则层的闸门就装在这里：每个会改变墙的动作先过一道 can()，
// 这样二十个 handler 里不必各塞一个 if。

const presence = require("./wall/presence");
const draw = require("./wall/draw");
const chat = require("./wall/chat");
const clear = require("./wall/clear");

const ROUTES = {
  join: (ws, msg) => presence.handleJoin(ws, msg),
  leave: (ws) => presence.handleLeave(ws),
  kick: (ws, msg) => presence.handleKick(ws, msg),
  rename: (ws, msg) => presence.handleRename(ws, msg),
  lock: (ws) => presence.handleLock(ws, true),
  unlock: (ws) => presence.handleLock(ws, false),
  extend: (ws) => presence.handleExtend(ws),

  stroke_start: (ws, msg) => draw.handleStrokeStart(ws, msg),
  stroke_point: (ws, msg) => draw.handleStrokePoint(ws, msg),
  stroke_end: (ws, msg) => draw.handleStrokeEnd(ws, msg),
  stroke_replace: (ws, msg) => draw.handleStrokeReplace(ws, msg),
  stroke_cancel: (ws, msg) => draw.handleStrokeCancel(ws, msg),
  text_place: (ws, msg) => draw.handleTextPlace(ws, msg),
  undo: (ws) => draw.handleUndo(ws),
  redo: (ws) => draw.handleRedo(ws),

  chat: (ws, msg) => chat.handleChat(ws, msg),
  cursor: (ws, msg) => chat.handleCursor(ws, msg),

  clear_start: (ws) => clear.handleClearStart(ws),
  clear_cancel: (ws) => clear.handleClearCancel(ws),
};

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;
  const route = Object.prototype.hasOwnProperty.call(ROUTES, msg.type) ? ROUTES[msg.type] : null;
  if (route) route(ws, msg);
}

module.exports = { handleMessage, ROUTES };
