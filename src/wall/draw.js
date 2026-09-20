"use strict";

// 画在墙上的东西：笔画、文字、撤销重做。
//
// 一笔的生命：stroke_start 开一笔（服务端给它一个递增的 seq，决定叠放顺序）→
// stroke_point 追加点 → stroke_end 落定。中途可以 replace（吸附成形状）或 cancel（第二根手指）。

const {
  MAX_POINTS,
  UNDO_MAX,
  PEN_WIDTHS,
  ERASER_WIDTHS,
  BRUSHES,
  SHAPES,
  STROKE_MARGIN,
} = require("../config");
const { send, broadcast } = require("../net");
const { ctxOf, scheduleSave } = require("../store");
const { ensureStack } = require("../room");
const { validStrokeId, normalizeHex, asPoint, withPressure } = require("../protocol");
const { maybeBake, setFrozenHidden, touchJob } = require("../bake");
const modes = require("../modes");

function finishOpenStrokes(room, userId, onlyNonHost) {
  const ids = [];
  for (const s of room.open.values()) {
    if (userId && s.userId !== userId) continue;
    if (onlyNonHost && s.userId === room.hostId) continue;
    ids.push(s.id);
  }
  for (const id of ids) commitStroke(room, id);
}

function commitStroke(room, id) {
  const s = room.open.get(id);
  if (!s) return null;
  room.open.delete(id);
  if (!s.points || s.points.length === 0) {
    s.points = [{ x: 0, y: 0 }];
  }
  room.strokes.push(s);
  const st = ensureStack(room, s.userId);
  st.undo.push(s.id);
  if (st.undo.length > UNDO_MAX) st.undo.shift();
  st.redo = [];
  broadcast(room, { type: "stroke_end", id: s.id, userId: s.userId, stroke: s });
  maybeBake(room);
  const user = room.users.get(s.userId);
  if (user) {
    send(user.ws, {
      type: "stacks",
      canUndo: st.undo.length > 0,
      canRedo: st.redo.length > 0,
    });
  }
  scheduleSave(room);
  modes.after(room, { type: "stroke_end", stroke: s, userId: s.userId });
  return s;
}

function handleStrokeStart(ws, msg) {
  const ctx = modes.allow(ws, "draw", msg);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  if (!validStrokeId(msg.id)) return;
  if (room.open.has(msg.id) || room.strokes.some((s) => s.id === msg.id)) return;
  const strokeType = msg.strokeType === "eraser" ? "eraser" : "pen";
  const color = strokeType === "eraser" ? "#000000" : normalizeHex(msg.color);
  if (strokeType === "pen" && !color) return;
  const width = Number(msg.width);
  const widths = strokeType === "eraser" ? ERASER_WIDTHS : PEN_WIDTHS;
  if (!widths.has(width)) return;
  const p = withPressure(asPoint(room, { x: msg.x, y: msg.y }) || asPoint(room, msg.point), msg);
  if (!p) return;
  finishOpenStrokes(room, user.id);
  const stroke = {
    id: msg.id,
    seq: room.nextSeq++,
    userId: user.id,
    type: strokeType,
    color: strokeType === "eraser" ? "#000000" : color,
    width,
    points: [p],
    hidden: false,
    t: Date.now(),
  };
  // 新版笔画带笔刷（圆珠笔/笔锋/马克笔/铅笔）和形状；没有这两个字段的是旧笔画，照旧画法
  if (strokeType === "pen" && BRUSHES.has(msg.brush)) stroke.brush = msg.brush;
  if (strokeType === "eraser" && msg.brush) stroke.brush = "pen";
  if (SHAPES.has(msg.shape)) stroke.shape = msg.shape;
  room.open.set(stroke.id, stroke);
  const st = ensureStack(room, user.id);
  st.redo = [];
  broadcast(room, { type: "stroke_start", stroke });
  send(ws, {
    type: "stacks",
    canUndo: st.undo.length > 0,
    canRedo: false,
  });
}

function handleStrokePoint(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const s = room.open.get(msg.id);
  if (!s || s.userId !== user.id) return;
  if (room.locked && user.id !== room.hostId) {
    commitStroke(room, s.id);
    return;
  }
  const raw = Array.isArray(msg.points) ? msg.points : [msg];
  const pts = [];
  for (const item of raw) {
    if (s.points.length >= MAX_POINTS) break;
    const p = withPressure(asPoint(room, item, STROKE_MARGIN), item);
    if (p) {
      s.points.push(p);
      pts.push(p);
    }
  }
  if (pts.length) {
    broadcast(room, { type: "stroke_point", id: s.id, userId: s.userId, points: pts });
  }
}

function handleStrokeEnd(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const s = room.open.get(msg.id);
  if (!s || s.userId !== user.id) return;
  commitStroke(room, s.id);
}

// 触屏上第二根手指落下时撤回刚起笔的那一笔：还没落定，直接丢掉
// 画完停住吸附成标准形状（直线/矩形/椭圆）：还没落定的这一笔整条换掉
function handleStrokeReplace(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const s = room.open.get(msg.id);
  if (!s || s.userId !== user.id || !Array.isArray(msg.points)) return;
  const pts = [];
  for (const item of msg.points.slice(0, MAX_POINTS)) {
    const p = withPressure(asPoint(room, item, STROKE_MARGIN), item);
    if (p) pts.push(p);
  }
  if (!pts.length) return;
  s.points = pts;
  if (SHAPES.has(msg.shape)) s.shape = msg.shape;
  else delete s.shape; // 吸附后又继续画：恢复成手画的线
  broadcast(room, { type: "stroke_replace", id: s.id, points: pts, shape: s.shape });
}

function handleStrokeCancel(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const s = room.open.get(msg.id);
  if (!s || s.userId !== user.id) return;
  room.open.delete(msg.id);
  broadcast(room, { type: "stroke_cancel", id: msg.id });
}

function handleTextPlace(ws, msg) {
  const ctx = modes.allow(ws, "text", msg);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  if (!validStrokeId(msg.id)) return;
  // 画笔色任选；身份色（光标、名字）仍按进房顺序分配
  const color = normalizeHex(msg.color);
  if (!color) return;
  const p = asPoint(room, { x: msg.x, y: msg.y });
  if (!p) return;
  const text = String(msg.text || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  const stroke = {
    id: msg.id,
    seq: room.nextSeq++,
    userId: user.id,
    type: "text",
    color,
    width: 22,
    text: text.slice(0, 200),
    x: p.x,
    y: p.y,
    hidden: false,
    t: Date.now(),
  };
  room.strokes.push(stroke);
  const st = ensureStack(room, user.id);
  st.undo.push(stroke.id);
  if (st.undo.length > UNDO_MAX) st.undo.shift();
  st.redo = [];
  broadcast(room, { type: "text_place", stroke });
  maybeBake(room);
  send(ws, {
    type: "stacks",
    canUndo: st.undo.length > 0,
    canRedo: false,
  });
  scheduleSave(room);
  modes.after(room, { type: "text", stroke, userId: user.id });
}

function handleUndo(ws) {
  const ctx = modes.allow(ws, "undo", null);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  const st = ensureStack(room, user.id);
  const id = st.undo.pop();
  if (!id) return;
  const stroke = room.strokes.find((s) => s.id === id);
  if (stroke && stroke.userId === user.id) stroke.hidden = true;
  else setFrozenHidden(room, id, true);
  touchJob(room, id);
  st.redo.push(id);
  broadcast(room, {
    type: "undo",
    id,
    userId: user.id,
    canUndo: st.undo.length > 0,
    canRedo: true,
  });
  scheduleSave(room);
  maybeBake(room);
  modes.after(room, { type: "undo", id, userId: user.id });
}

function handleRedo(ws) {
  const ctx = modes.allow(ws, "redo", null);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  const st = ensureStack(room, user.id);
  const id = st.redo.pop();
  if (!id) return;
  const stroke = room.strokes.find((s) => s.id === id);
  if (stroke && stroke.userId === user.id) stroke.hidden = false;
  else setFrozenHidden(room, id, false);
  touchJob(room, id);
  st.undo.push(id);
  broadcast(room, {
    type: "redo",
    id,
    userId: user.id,
    canUndo: true,
    canRedo: st.redo.length > 0,
  });
  scheduleSave(room);
  maybeBake(room);
  modes.after(room, { type: "redo", id, userId: user.id });
}

module.exports = {
  finishOpenStrokes,
  commitStroke,
  handleStrokeStart,
  handleStrokePoint,
  handleStrokeEnd,
  handleStrokeReplace,
  handleStrokeCancel,
  handleTextPlace,
  handleUndo,
  handleRedo,
};
