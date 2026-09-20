"use strict";

// 客户端发来的每一条消息落到哪个处理函数。
//
// 闸门本身装在各个 handler 的第一行（modes.allow 换掉了原来的 ctxOf），
// 这样「认出是谁」和「玩法答不答应」是同一次查询，不会多出一层。

const presence = require("./wall/presence");
const draw = require("./wall/draw");
const chat = require("./wall/chat");
const clear = require("./wall/clear");
const modes = require("./modes");

// 玩法在这里登记。放在这而不是 modes/index.js 里，是因为玩法文件可以引用 wall/*，
// 而 wall/* 又引用 modes——让 index 去 require 它们就绕回来了。
require("./modes/relay");
require("./modes/limit");
require("./modes/blind");

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

  // 所有玩法共用这一种消息：{type:"mode", cmd:"start"|"pass"|"take"|…}
  // 以后再加玩法，这张表一个字都不用动。
  mode: (ws, msg) => modes.command(ws, msg),
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
