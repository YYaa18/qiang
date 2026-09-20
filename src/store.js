"use strict";

// 房间在内存和磁盘之间的进出。
//
// 房间不常驻内存：启动时只认房间码，有人推门才把那一间读起来，空置一阵就请出去。
// 一台长期在线的服务器上房间只会越来越多，全读进内存迟早撑爆。

const fs = require("fs");
const path = require("path");

const { DATA_DIR, MAX_SEGMENTS, PALETTE, IDLE_EVICT_MS } = require("./config");
const { Room, serialize } = require("./room");
const { genCode, validUuid } = require("./protocol");

/** @type {Map<string, Room>} 此刻在内存里的房间 */
const rooms = new Map();
/** @type {Set<string>} 磁盘上有哪些房间码；不代表它此刻在内存里 */
const knownCodes = new Set();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const saveTimers = new Map();
/** @type {Map<string, number>} */
const lastSaveAt = new Map();

// 房间从盘上读起来之后要做的事，比如把「清空倒计时」这样的定时器重建出来。
// 定时器只存 deadline 不存句柄，所以重建必须有人来做——而 store 不该认识那些功能。
const loadHooks = [];
function onRoomLoaded(fn) {
  loadHooks.push(fn);
}

function allocCode() {
  for (let i = 0; i < 2000; i++) {
    const c = genCode();
    if (!rooms.has(c) && !knownCodes.has(c)) return c;
  }
  throw new Error("无法分配房间码");
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

function scanRooms() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return;
  }
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name.endsWith(".json")) knownCodes.add(name.slice(0, -5));
  }
}

function loadRoom(code) {
  const file = path.join(DATA_DIR, `${code}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("load room failed", code, err.message);
    return null;
  }
  if (!raw || raw.code !== code) return null;
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
  room.mode = raw.mode && typeof raw.mode.id === "string" ? raw.mode : null;
  rooms.set(room.code, room);
  for (const fn of loadHooks) fn(room);
  return room;
}

function getRoom(code) {
  const live = rooms.get(code);
  if (live) return live;
  if (!knownCodes.has(code)) return null;
  return loadRoom(code);
}

function createRoom(hostId) {
  const code = allocCode();
  const room = new Room(code, hostId);
  if (validUuid(hostId)) {
    room.colorByUser[hostId] = PALETTE[0];
  }
  rooms.set(code, room);
  knownCodes.add(code);
  saveRoomNow(room);
  return room;
}

// 人走空一段时间的房间从内存里请出去。存盘失败就先留着，宁可占内存也不能丢画。
function evictRoom(room) {
  const t = saveTimers.get(room.code);
  if (t) {
    clearTimeout(t);
    saveTimers.delete(room.code);
  }
  clearTimeout(room.bakeTimer);
  clearTimeout(room.cursorTimer);
  room.bakeTimer = null;
  room.cursorTimer = null;
  try {
    saveRoomNow(room);
  } catch (err) {
    console.error("evict save failed", room.code, err.message);
    return;
  }
  rooms.delete(room.code);
  lastSaveAt.delete(room.code); // 否则这张表会替房间继续占着地方
}

function sweepRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 还有人、还在烘焙、还在倒计时清空：都不能动
    if (room.users.size > 0 || room.job || room.loadingFull || room.clearTimer) {
      room.emptySince = 0;
      continue;
    }
    if (!room.emptySince) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince >= IDLE_EVICT_MS) evictRoom(room);
  }
}

// 一条连接对应哪间房的哪个人。连接没绑定、房间已不在内存、或这个人已经换了连接，都返回 null
function ctxOf(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const user = room.users.get(ws.clientId);
  if (!user || user.ws !== ws) return null;
  return { room, user };
}

module.exports = {
  rooms,
  knownCodes,
  onRoomLoaded,
  saveRoomNow,
  scheduleSave,
  flushAll,
  scanRooms,
  loadRoom,
  getRoom,
  createRoom,
  evictRoom,
  sweepRooms,
  ctxOf,
};
