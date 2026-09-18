"use strict";

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
// VPS 上放在 Caddy 后面时设成 127.0.0.1，不把端口直接暴露到公网
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data", "rooms");
const PUBLIC_DIR = path.join(__dirname, "public");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PALETTE = ["#C43C3C", "#3B5BDB", "#2F9E44", "#E67700"];
const PEN_WIDTHS = [3, 8, 18];
const ERASER_WIDTHS = [8, 18, 36];
const MAX_USERS = 4;
const GRACE_MS = 10_000;
const CHAT_MAX = 100;
const UNDO_MAX = 50;
const NAME_MAX = 16;
// 墙是横向卷轴：由若干段拼成，每段 SEG_W×CANVAS_H，坐标全局连续
const SEG_W = 1600;
const CANVAS_H = 1000;
// 卷轴可以一直接长；这里只是防滥用的保险值（导出时超长会按比例缩小）
const MAX_SEGMENTS = 500;
// 冻结：只保留最新的 LIVE_KEEP 笔为矢量；多出 BAKE_BATCH 笔时，把更早的笔烘焙进每段的墨迹图
const LIVE_KEEP = Number(process.env.QIANG_LIVE_KEEP) || 150;
const BAKE_BATCH = Number(process.env.QIANG_BAKE_BATCH) || 200;
const BAKE_TIMEOUT_MS = 30_000;
const BAKE_MAX_BYTES = 30 * 1024 * 1024;
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

function wallWidth(room) {
  return room.segments * SEG_W;
}

function clipPoint(room, x, y, margin = 0) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  // 坐标保留 1 位小数：肉眼无差别，存储和传输体积减半
  return {
    x: Math.round(Math.max(-margin, Math.min(wallWidth(room) + margin, nx)) * 10) / 10,
    y: Math.round(Math.max(-margin, Math.min(CANVAS_H + margin, ny)) * 10) / 10,
  };
}

function asPoint(room, p, margin = 0) {
  if (Array.isArray(p) && p.length >= 2) return clipPoint(room, p[0], p[1], margin);
  if (p && typeof p === "object") return clipPoint(room, p.x, p.y, margin);
  return null;
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
    segments: room.segments,
    frozenUpTo: room.frozenUpTo,
    segVersions: room.segVersions,
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
      room.segments = Math.min(MAX_SEGMENTS, Math.max(1, Math.floor(Number(raw.segments)) || 1));
      room.colorByUser = raw.colorByUser || {};
      room.stacks = raw.stacks || {};
      room.clearDeadline = raw.clearDeadline || null;
      room.frozenUpTo = Number(raw.frozenUpTo) || 0;
      room.segVersions = raw.segVersions || {};
      room.hiddenFrozen = new Set(raw.hiddenFrozen || []);
      room.frozenIndex = raw.frozenIndex || {};
      room.dirtyFull = new Set(raw.dirtyFull || []);
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
  return s;
}

// ───────────── 冻结：旧笔画烘焙成每段一张墨迹图 ─────────────
//
// 一笔足够旧（不在最新 LIVE_KEEP 笔里）就可以冻结：由一个在线客户端用同一套绘制代码
// 把它画进所在段的墨迹图（透明 PNG）并上传。冻结的是一整段 seq 前缀，所以叠放顺序不变。
// 矢量存档永久留在磁盘上：撤销/重做一笔已冻结的笔时，从存档把受影响的段整段重画。

function roomDir(room) {
  return path.join(DATA_DIR, room.code);
}

function archiveFile(room) {
  return path.join(roomDir(room), "archive.jsonl");
}

function segFile(room, seg, version) {
  return path.join(roomDir(room), `seg-${seg}-${version}.png`);
}

// 笔画横跨哪几段。服务端量不了字宽，文字按每字 22px 从宽估计——多算一段没关系
function segsOf(room, s) {
  let x0;
  let x1;
  if (s.type === "text") {
    x0 = s.x;
    x1 = s.x + [...(s.text || "")].length * 22;
  } else {
    x0 = Infinity;
    x1 = -Infinity;
    for (const p of s.points || []) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
    }
    const h = (s.width || 0) / 2 + 1;
    x0 -= h;
    x1 += h;
  }
  const out = [];
  const a = Math.max(0, Math.floor(x0 / SEG_W));
  const z = Math.min(room.segments - 1, Math.floor(x1 / SEG_W));
  for (let i = a; i <= z; i++) out.push(i);
  return out;
}

function stackedIds(room) {
  const ids = new Set();
  for (const st of Object.values(room.stacks)) {
    for (const id of st.undo) ids.add(id);
    for (const id of st.redo) ids.add(id);
  }
  return ids;
}

// 撤销/重做一笔已冻结的笔：记下隐藏状态，所在段排队整段重画
function setFrozenHidden(room, id, hidden) {
  const segs = room.frozenIndex[id];
  if (!segs) return;
  if (hidden) room.hiddenFrozen.add(id);
  else room.hiddenFrozen.delete(id);
  for (const seg of segs) room.dirtyFull.add(seg);
}

// 任务进行中，参与冻结的笔被撤销/重做，或要重画的段又变了：作废重来
function touchJob(room, id) {
  const job = room.job;
  if (!job) return;
  if (job.kind === "delta" && job.ids.has(id)) abortJob(room, "stroke changed");
  else if (job.kind === "full" && (room.frozenIndex[id] || []).some((seg) => job.tasks.has(seg))) {
    abortJob(room, "segment changed");
  }
}

function pickBaker(room) {
  const online = [...room.users.values()].filter((u) => u.ws && u.ws.readyState === 1);
  return online.find((u) => u.id === room.hostId) || online[0] || null;
}

function readArchive(room) {
  let raw;
  try {
    raw = fs.readFileSync(archiveFile(room), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 半行（崩溃时写到一半）直接跳过 */
    }
  }
  return out;
}

function maybeBake(room) {
  if (room.job) return;
  const baker = pickBaker(room);
  if (!baker) return;
  if (room.dirtyFull.size) {
    startFullJob(room, baker);
    return;
  }
  if (room.strokes.length <= LIVE_KEEP + BAKE_BATCH) return;
  const sorted = [...room.strokes].sort((a, b) => a.seq - b.seq);
  let cutoff = sorted[sorted.length - LIVE_KEEP - 1].seq;
  // 还在画的笔 seq 更小的话，冻结线不能越过它，否则它落定后会压在更新的笔上面
  for (const o of room.open.values()) cutoff = Math.min(cutoff, o.seq - 1);
  const frozen = sorted.filter((st) => st.seq <= cutoff);
  if (!frozen.length) return;
  const tasks = new Map();
  for (const st of frozen) {
    for (const seg of segsOf(room, st)) {
      if (!tasks.has(seg)) tasks.set(seg, []);
      tasks.get(seg).push(st);
    }
  }
  startJob(room, baker, "delta", tasks, { cutoff, frozen, ids: new Set(frozen.map((st) => st.id)) });
}

function startFullJob(room, baker) {
  const segs = [...room.dirtyFull];
  room.dirtyFull.clear();
  const tasks = new Map(segs.map((seg) => [seg, []]));
  for (const st of readArchive(room)) {
    if (st.seq > room.frozenUpTo || room.hiddenFrozen.has(st.id)) continue;
    for (const seg of segsOf(room, st)) if (tasks.has(seg)) tasks.get(seg).push(st);
  }
  startJob(room, baker, "full", tasks, { segs });
}

function startJob(room, baker, kind, tasks, extra) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    baker: baker.id,
    tasks,
    files: new Map(),
    timer: setTimeout(() => abortJob(room, "timeout"), BAKE_TIMEOUT_MS),
    ...extra,
  };
  room.job = job;
  for (const [seg, strokes] of tasks) {
    send(baker.ws, {
      type: "bake",
      job: job.id,
      seg,
      mode: kind,
      baseVersion: kind === "delta" ? room.segVersions[seg] || 0 : 0,
      strokes: strokes.map((st) => (st.hidden ? null : st)).filter(Boolean),
    });
  }
}

function abortJob(room, reason) {
  const job = room.job;
  if (!job) return;
  clearTimeout(job.timer);
  for (const file of job.files.values()) fs.rmSync(file, { force: true });
  if (job.kind === "full") for (const seg of job.segs) room.dirtyFull.add(seg);
  room.job = null;
  if (reason !== "cleared") setTimeout(() => maybeBake(room), 1000).unref?.();
}

async function handleBakeUpload(req, res, room, seg, jobId) {
  const job = room.job;
  if (!job || job.id !== jobId || !job.tasks.has(seg) || job.files.has(seg)) {
    res.writeHead(409);
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BAKE_MAX_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!body.subarray(0, 8).equals(PNG_SIG)) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (room.job !== job) {
    // 上传途中任务被作废了
    res.writeHead(409);
    res.end();
    return;
  }
  fs.mkdirSync(roomDir(room), { recursive: true });
  const version = (room.segVersions[seg] || 0) + 1;
  const file = segFile(room, seg, version);
  fs.writeFileSync(`${file}.tmp`, body);
  fs.renameSync(`${file}.tmp`, file);
  job.files.set(seg, file);
  res.writeHead(204);
  res.end();
  if (job.files.size === job.tasks.size) commitJob(room, job);
}

function commitJob(room, job) {
  clearTimeout(job.timer);
  room.job = null;
  const versions = {};
  for (const seg of job.tasks.keys()) {
    const old = room.segVersions[seg] || 0;
    if (old) fs.rmSync(segFile(room, seg, old), { force: true });
    room.segVersions[seg] = old + 1;
    versions[seg] = old + 1;
  }
  if (job.kind === "delta") {
    // 先追加存档，再改元数据：中途崩溃最多在存档里多一份重复的笔，重画时无害
    const stacked = stackedIds(room);
    const lines = [];
    for (const st of job.frozen) {
      lines.push(JSON.stringify(st));
      if (st.hidden) room.hiddenFrozen.add(st.id);
      if (stacked.has(st.id)) room.frozenIndex[st.id] = segsOf(room, st);
    }
    fs.appendFileSync(archiveFile(room), lines.join("\n") + "\n");
    for (const id of Object.keys(room.frozenIndex)) if (!stacked.has(id)) delete room.frozenIndex[id];
    room.strokes = room.strokes.filter((st) => !job.ids.has(st.id));
    room.frozenUpTo = job.cutoff;
  }
  saveRoomNow(room);
  broadcast(room, { type: "baked", upTo: room.frozenUpTo, versions });
  maybeBake(room);
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
  maybeBake(room);
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
  if (room.job && room.job.baker === user.id) abortJob(room, "baker left");
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
      : normalizeHex(msg.color);
  if (strokeType === "pen" && !color) return;
  const width = Number(msg.width);
  const widths = strokeType === "eraser" ? ERASER_WIDTHS : PEN_WIDTHS;
  if (!widths.includes(width)) return;
  const p = asPoint(room, { x: msg.x, y: msg.y }) || asPoint(room, msg.point);
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
    const p = asPoint(room, item, STROKE_MARGIN);
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
}

function handleCursor(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  const p = asPoint(room, { x: msg.x, y: msg.y });
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

function handleExtend(ws) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  if (room.locked && user.id !== room.hostId) {
    send(ws, { type: "error", code: "locked", message: "墙已锁定" });
    return;
  }
  if (room.segments >= MAX_SEGMENTS) {
    send(ws, { type: "error", code: "max_length", message: "墙已经够长了" });
    return;
  }
  room.segments += 1;
  broadcast(room, { type: "extend", segments: room.segments, userId: user.id });
  pushSystem(room, `${user.name}把墙接长了一段`);
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
  abortJob(room, "cleared");
  room.frozenUpTo = 0;
  room.segVersions = {};
  room.hiddenFrozen = new Set();
  room.frozenIndex = {};
  room.dirtyFull = new Set();
  fs.rmSync(roomDir(room), { recursive: true, force: true });
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
    case "extend":
      handleExtend(ws);
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

  // /api/rooms/CODE/seg/N.png?v=V 取墨迹图；POST /api/rooms/CODE/seg/N?job=J 上传烘焙结果
  const segMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/seg\/(\d+)(\.png)?$/);
  if (segMatch) {
    const room = rooms.get(segMatch[1]);
    const seg = Number(segMatch[2]);
    if (!room || seg >= room.segments) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "POST" && !segMatch[3]) {
      await handleBakeUpload(req, res, room, seg, url.searchParams.get("job"));
      return;
    }
    const version = Number(url.searchParams.get("v"));
    if (req.method === "GET" && segMatch[3] && version && room.segVersions[seg] === version) {
      const file = segFile(room, seg, version);
      fs.stat(file, (err, st) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        // 每个版本的图永不改变，可以放心长缓存
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": st.size,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(file).pipe(res);
      });
      return;
    }
    res.writeHead(404);
    res.end();
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
// 只压缩大消息（进墙时的整墙快照），笔迹点这类小消息不压，省 CPU
const wss = new WebSocketServer({ server, perMessageDeflate: { threshold: 8 * 1024 } });

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


function shutdown() {
  clearInterval(heartbeat);
  flushAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`qiang listening on ${HOST}:${PORT}, data in ${DATA_DIR}`);
});
