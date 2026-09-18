"use strict";

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data", "rooms");
const PUBLIC_DIR = path.join(__dirname, "public");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PALETTE = ["#C43C3C", "#3B5BDB", "#2F9E44", "#E67700"];
const NEUTRALS = ["#1A1A1A", "#FFFFFF", "#868E96"];
const PEN_WIDTHS = [3, 8, 18];
const ERASER_WIDTHS = [8, 18, 36];
const MAX_USERS = 4;
const GRACE_MS = 10_000;
const CHAT_MAX = 100;
const UNDO_MAX = 50;
const NAME_MAX = 16;
const CANVAS_W = 1600;
const CANVAS_H = 1000;
// 笔画点允许超出纸面的余量：canvas 自己会裁掉，避免拖出纸边时贴边画线
const STROKE_MARGIN = 40;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const saveTimers = new Map();
/** @type {Map<string, number>} */
const lastSaveAt = new Map();

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

function genCode() {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function allocCode() {
  for (let i = 0; i < 2000; i++) {
    const c = genCode();
    if (!rooms.has(c)) return c;
  }
  throw new Error("无法分配房间码");
}

function validUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function validStrokeId(id) {
  return typeof id === "string" && id.length >= 8 && id.length <= 80;
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function validCode(code) {
  return code.length === 4 && [...code].every((c) => CODE_CHARS.includes(c));
}

function cleanName(name) {
  const s = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return s || "朋友";
}

function clipPoint(x, y, margin = 0) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return {
    x: Math.max(-margin, Math.min(CANVAS_W + margin, nx)),
    y: Math.max(-margin, Math.min(CANVAS_H + margin, ny)),
  };
}

function asPoint(p, margin = 0) {
  if (Array.isArray(p) && p.length >= 2) return clipPoint(p[0], p[1], margin);
  if (p && typeof p === "object") return clipPoint(p.x, p.y, margin);
  return null;
}

function allowedColor(user, color) {
  const c = String(color || "").toUpperCase();
  const ok = new Set(
    [user.color, ...NEUTRALS].map((x) => x.toUpperCase())
  );
  return ok.has(c) ? c.replace(/^#/, "#") : null;
}

function normalizeHex(color) {
  const c = String(color || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) return c.toUpperCase();
  return null;
}

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

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

function broadcast(room, obj, exceptId) {
  for (const u of room.users.values()) {
    if (exceptId && u.id === exceptId) continue;
    send(u.ws, obj);
  }
}

function snapshotMsg(room, user) {
  return {
    type: "snapshot",
    code: room.code,
    users: publicUsers(room),
    strokes: room.strokes,
    chat: room.chat,
    locked: room.locked,
    clearDeadline: room.clearDeadline,
    you: youInfo(room, user),
  };
}

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

function serialize(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    hostId: room.hostId,
    locked: room.locked,
    strokes: room.strokes,
    chat: room.chat,
    nextSeq: room.nextSeq,
    colorByUser: room.colorByUser,
    stacks: room.stacks,
    clearDeadline: room.clearDeadline,
  };
}

function saveRoomNow(room) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${room.code}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serialize(room)));
  fs.renameSync(tmp, file);
  lastSaveAt.set(room.code, Date.now());
}

function scheduleSave(room) {
  if (saveTimers.has(room.code)) return;
  const last = lastSaveAt.get(room.code) || 0;
  const wait = Math.max(0, 1000 - (Date.now() - last));
  const t = setTimeout(() => {
    saveTimers.delete(room.code);
    try {
      saveRoomNow(room);
    } catch (err) {
      console.error("save failed", room.code, err);
    }
  }, wait);
  saveTimers.set(room.code, t);
}

function flushAll() {
  for (const [code, t] of saveTimers) {
    clearTimeout(t);
    saveTimers.delete(code);
    const room = rooms.get(code);
    if (room) {
      try {
        saveRoomNow(room);
      } catch (err) {
        console.error("flush failed", code, err);
      }
    }
  }
  for (const room of rooms.values()) {
    try {
      saveRoomNow(room);
    } catch {
      /* ignore */
    }
  }
}

function restoreClearTimer(room) {
  if (!room.clearDeadline) return;
  const remain = room.clearDeadline - Date.now();
  if (remain <= 0) {
    finishClear(room);
    return;
  }
  room.clearTimer = setTimeout(() => finishClear(room), remain);
}

function loadRooms() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return;
  }
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(DATA_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || !raw.code) continue;
      const room = new Room(raw.code, raw.hostId);
      room.createdAt = raw.createdAt || room.createdAt;
      room.locked = !!raw.locked;
      room.strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
      room.chat = Array.isArray(raw.chat) ? raw.chat : [];
      room.nextSeq = Number(raw.nextSeq) || 1;
      room.colorByUser = raw.colorByUser || {};
      room.stacks = raw.stacks || {};
      room.clearDeadline = raw.clearDeadline || null;
      rooms.set(room.code, room);
      restoreClearTimer(room);
    } catch (err) {
      console.error("load room failed", name, err.message);
    }
  }
}

function createRoom(hostId) {
  const code = allocCode();
  const room = new Room(code, hostId);
  if (validUuid(hostId)) {
    room.colorByUser[hostId] = PALETTE[0];
  }
  rooms.set(code, room);
  saveRoomNow(room);
  return room;
}

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
  const user = room.users.get(s.userId);
  if (user) {
    send(user.ws, {
      type: "stacks",
      canUndo: st.undo.length > 0,
      canRedo: st.redo.length > 0,
    });
  }
  scheduleSave(room);
  return s;
}

function handleJoin(ws, msg) {
  const code = normalizeCode(msg.code);
  const clientId = msg.clientId;
  if (!validUuid(clientId)) {
    send(ws, { type: "error", code: "invalid", message: "身份无效" });
    return;
  }
  if (!validCode(code) || !rooms.has(code)) {
    send(ws, { type: "error", code: "not_found", message: "没有这面墙" });
    return;
  }
  const room = rooms.get(code);
  const name = cleanName(msg.name);
  const existing = room.users.get(clientId);

  if (existing) {
    if (existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
      existing.replaced = true;
      send(existing.ws, { type: "replaced", message: "已在别处打开" });
      try {
        existing.ws.close();
      } catch {
        /* ignore */
      }
    }
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    existing.ws = ws;
    existing.name = name;
    existing.kicked = false;
    existing.replaced = false;
    bindSocket(ws, room, existing);
    send(ws, snapshotMsg(room, existing));
    broadcast(room, { type: "presence", users: publicUsers(room) }, existing.id);
    return;
  }

  if (room.users.size >= MAX_USERS) {
    send(ws, { type: "error", code: "full", message: "墙满了" });
    return;
  }

  const color = assignColor(room, clientId);
  room.colorByUser[clientId] = color;
  const user = {
    id: clientId,
    name,
    color,
    ws,
    timer: null,
    kicked: false,
    replaced: false,
  };
  room.users.set(clientId, user);
  bindSocket(ws, room, user);
  send(ws, snapshotMsg(room, user));
  pushSystem(room, `${name}来了`);
  broadcast(room, { type: "presence", users: publicUsers(room) });
  scheduleSave(room);
}

function bindSocket(ws, room, user) {
  ws.roomCode = room.code;
  ws.clientId = user.id;
}

function handleClose(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const user = room.users.get(ws.clientId);
  if (!user) return;
  if (user.ws !== ws) return;
  if (user.kicked || user.replaced) {
    user.ws = null;
    return;
  }
  finishOpenStrokes(room, user.id);
  user.ws = null;
  user.timer = setTimeout(() => {
    if (room.users.get(user.id) !== user) return;
    if (user.ws) return;
    room.users.delete(user.id);
    pushSystem(room, `${user.name}走了`);
    broadcast(room, { type: "presence", users: publicUsers(room) });
    scheduleSave(room);
  }, GRACE_MS);
}

function handleStrokeStart(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  if (!validStrokeId(msg.id)) return;
  if (room.open.has(msg.id) || room.strokes.some((s) => s.id === msg.id)) return;
  const strokeType = msg.strokeType === "eraser" ? "eraser" : "pen";
  const color =
    strokeType === "eraser"
      ? "#000000"
      : allowedColor(user, normalizeHex(msg.color) || msg.color);
  if (strokeType === "pen" && !color) return;
  const width = Number(msg.width);
  const widths = strokeType === "eraser" ? ERASER_WIDTHS : PEN_WIDTHS;
  if (!widths.includes(width)) return;
  const p = asPoint({ x: msg.x, y: msg.y }) || asPoint(msg.point);
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
    const p = asPoint(item, STROKE_MARGIN);
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

function handleTextPlace(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  if (!validStrokeId(msg.id)) return;
  const color = allowedColor(user, normalizeHex(msg.color) || msg.color);
  if (!color) return;
  const p = asPoint({ x: msg.x, y: msg.y });
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
  send(ws, {
    type: "stacks",
    canUndo: st.undo.length > 0,
    canRedo: false,
  });
  scheduleSave(room);
}

function handleUndo(ws) {
  const ctx = ctxOf(ws);
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
  st.redo.push(id);
  broadcast(room, {
    type: "undo",
    id,
    userId: user.id,
    canUndo: st.undo.length > 0,
    canRedo: true,
  });
  scheduleSave(room);
}

function handleRedo(ws) {
  const ctx = ctxOf(ws);
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
  st.undo.push(id);
  broadcast(room, {
    type: "redo",
    id,
    userId: user.id,
    canUndo: true,
    canRedo: st.redo.length > 0,
  });
  scheduleSave(room);
}

function handleCursor(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const p = asPoint({ x: msg.x, y: msg.y });
  if (!p) return;
  broadcast(
    room,
    { type: "cursor", userId: user.id, x: p.x, y: p.y },
    user.id
  );
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

function handleLock(ws, locked) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (user.id !== room.hostId) {
    send(ws, { type: "error", code: "forbidden", message: "只有房主可以这样做" });
    return;
  }
  room.locked = !!locked;
  if (room.locked) finishOpenStrokes(room, null, true);
  broadcast(room, { type: "lock", locked: room.locked });
  pushSystem(room, room.locked ? "墙被锁定了" : "墙解锁了");
  scheduleSave(room);
}

function handleClearStart(ws) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (user.id !== room.hostId) {
    send(ws, { type: "error", code: "forbidden", message: "只有房主可以这样做" });
    return;
  }
  if (room.clearTimer) {
    clearTimeout(room.clearTimer);
    room.clearTimer = null;
  }
  room.clearDeadline = Date.now() + 5000;
  room.clearTimer = setTimeout(() => finishClear(room), 5000);
  broadcast(room, { type: "clear_start", deadline: room.clearDeadline });
  scheduleSave(room);
}

function handleClearCancel(ws) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (user.id !== room.hostId) {
    send(ws, { type: "error", code: "forbidden", message: "只有房主可以这样做" });
    return;
  }
  if (!room.clearDeadline) return;
  if (room.clearTimer) clearTimeout(room.clearTimer);
  room.clearTimer = null;
  room.clearDeadline = null;
  broadcast(room, { type: "clear_cancel" });
  scheduleSave(room);
}

function finishClear(room) {
  if (room.clearTimer) {
    clearTimeout(room.clearTimer);
    room.clearTimer = null;
  }
  room.clearDeadline = null;
  room.strokes = [];
  room.open.clear();
  room.stacks = {};
  broadcast(room, { type: "clear_done" });
  pushSystem(room, "墙被清空了");
  scheduleSave(room);
}

function handleKick(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (user.id !== room.hostId) {
    send(ws, { type: "error", code: "forbidden", message: "只有房主可以这样做" });
    return;
  }
  const targetId = msg.targetId;
  if (!targetId || targetId === user.id) return;
  const target = room.users.get(targetId);
  if (!target) return;
  target.kicked = true;
  if (target.timer) {
    clearTimeout(target.timer);
    target.timer = null;
  }
  finishOpenStrokes(room, target.id);
  send(target.ws, { type: "kicked", message: "你被请离了这面墙" });
  try {
    if (target.ws) target.ws.close();
  } catch {
    /* ignore */
  }
  room.users.delete(target.id);
  pushSystem(room, `${target.name}被请离了`);
  broadcast(room, { type: "presence", users: publicUsers(room) });
  broadcast(room, { type: "kick", targetId });
  scheduleSave(room);
}

function handleRename(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const name = cleanName(msg.name);
  user.name = name;
  broadcast(room, { type: "presence", users: publicUsers(room) });
  scheduleSave(room);
}

function ctxOf(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const user = room.users.get(ws.clientId);
  if (!user || user.ws !== ws) return null;
  return { room, user };
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "join":
      handleJoin(ws, msg);
      break;
    case "stroke_start":
      handleStrokeStart(ws, msg);
      break;
    case "stroke_point":
      handleStrokePoint(ws, msg);
      break;
    case "stroke_end":
      handleStrokeEnd(ws, msg);
      break;
    case "text_place":
      handleTextPlace(ws, msg);
      break;
    case "undo":
      handleUndo(ws);
      break;
    case "redo":
      handleRedo(ws);
      break;
    case "cursor":
      handleCursor(ws, msg);
      break;
    case "chat":
      handleChat(ws, msg);
      break;
    case "lock":
      handleLock(ws, true);
      break;
    case "unlock":
      handleLock(ws, false);
      break;
    case "clear_start":
      handleClearStart(ws);
      break;
    case "clear_cancel":
      handleClearCancel(ws);
      break;
    case "kick":
      handleKick(ws, msg);
      break;
    case "rename":
      handleRename(ws, msg);
      break;
    default:
      break;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 1_000_000) {
        resolve({});
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safePublicFile(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return undefined;
  }
  if (p === "/" || p.startsWith("/w/")) p = "/index.html";
  p = p.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return null;
  return file;
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    if (!validUuid(body.clientId)) {
      json(res, 400, { error: "身份无效" });
      return;
    }
    const room = createRoom(body.clientId);
    json(res, 201, { code: room.code });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  const file = safePublicFile(url.pathname);
  if (file === undefined) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!file) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

loadRooms();

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error("http error", req.url, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      console.error("ws message error", err);
    }
  });
  ws.on("close", () => handleClose(ws));
  ws.on("error", () => handleClose(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 15000);
heartbeat.unref?.();

const persistTick = setInterval(() => {
  for (const room of rooms.values()) scheduleSave(room);
}, 5000);
persistTick.unref?.();

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(persistTick);
  flushAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
  console.log(`qiang listening on ${PORT}`);
});
