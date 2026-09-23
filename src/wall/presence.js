"use strict";

// 谁在这面墙上：进来、离开、被请走、改名，以及房主能做的锁定和接长。
//
// 身份就是客户端自己生成的 clientId，没有登录。断线有 10 秒宽限期（刷新和地铁里用得着），
// 主动点「离开」则立刻腾出座位。

const { MAX_USERS, GRACE_MS, MAX_SEGMENTS, SEG_W } = require("../config");
const { send, broadcast } = require("../net");
const { getRoom, rooms, scheduleSave, ctxOf } = require("../store");
const { assignColor, publicUsers, snapshotMsg } = require("../room");
const { normalizeCode, validCode, validUuid, cleanName } = require("../protocol");
const { abortJob, retryBake } = require("../bake");
const { finishOpenStrokes } = require("./draw");
const { pushSystem } = require("./chat");
const modes = require("../modes");

function bindSocket(ws, room, user) {
  ws.roomCode = room.code;
  ws.clientId = user.id;
}

// 进墙时拿到的整墙。玩法可以藏起一部分笔画，也可以往里塞自己的状态——
// 遮挡在这里生效，客户端拿不到就是真的没有。
function snapshotFor(room, user) {
  const snap = snapshotMsg(room, user);
  snap.strokes = modes.visibleStrokes(room, user, snap.strokes);
  snap.mode = modes.publicState(room, user);
  snap.modes = modes.catalog(); // 菜单照着这个长出来
  return snap;
}

// 让屋里每个人重新拿一份整墙。揭晓的时候用：之前藏着的笔画到这一刻才发得出去。
// 给屋里每个人重发一份整墙。extra 并进这一份快照里——
// 比如 { reveal: "接龙" }：客户端据此在拿到揭晓后的墙之后打开展厅。
// 只挂在这一次重发上，之后进门的人拿到的是普通快照，不会被突然拉进展厅。
function resend(room, extra) {
  for (const u of room.users.values()) {
    if (u.ws) send(u.ws, extra ? { ...snapshotFor(room, u), ...extra } : snapshotFor(room, u));
  }
}

function handleJoin(ws, msg) {
  const code = normalizeCode(msg.code);
  const clientId = msg.clientId;
  if (!validUuid(clientId)) {
    send(ws, { type: "error", code: "invalid", message: "身份无效" });
    return;
  }
  const room = validCode(code) ? getRoom(code) : null;
  if (!room) {
    send(ws, { type: "error", code: "not_found", message: "没有这面墙" });
    return;
  }
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
    existing.weak = !!msg.weak; // 同一个人可能换了台机器回来
    bindSocket(ws, room, existing);
    send(ws, snapshotFor(room, existing));
    broadcast(room, { type: "presence", users: publicUsers(room) }, existing.id);
    retryBake(room);
    modes.after(room, { type: "join", userId: existing.id, rejoin: true });
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
    weak: !!msg.weak, // 手机／平板：尽量不让它去烘焙
  };
  room.users.set(clientId, user);
  bindSocket(ws, room, user);
  send(ws, snapshotFor(room, user));
  pushSystem(room, `${name}来了`);
  broadcast(room, { type: "presence", users: publicUsers(room) });
  scheduleSave(room);
  retryBake(room);
  modes.after(room, { type: "join", userId: user.id, rejoin: false });
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
    modes.after(room, { type: "leave", userId: user.id });
  }, GRACE_MS);
}

// 主动离开：立刻释放座位并提示，不等 10 秒宽限期（宽限期是给刷新和断网用的）
function handleLeave(ws) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  finishOpenStrokes(room, user.id);
  if (room.job && room.job.baker === user.id) abortJob(room, "baker left");
  if (user.timer) clearTimeout(user.timer);
  user.ws = null;
  room.users.delete(user.id);
  pushSystem(room, `${user.name}走了`);
  broadcast(room, { type: "presence", users: publicUsers(room) });
  scheduleSave(room);
  modes.after(room, { type: "leave", userId: user.id });
  try {
    ws.close();
  } catch {
    /* ignore */
  }
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
  modes.after(room, { type: "leave", userId: targetId, kicked: true });
}

function handleRename(ws, msg) {
  const ctx = ctxOf(ws);
  if (!ctx) return;
  const { room, user } = ctx;
  user.name = cleanName(msg.name);
  broadcast(room, { type: "presence", users: publicUsers(room) });
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
  const ctx = modes.allow(ws, "extend", null);
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
  growWall(room, user.id);
  pushSystem(room, `${user.name}把墙接长了一段`);
}

// 给玩法一段干净的纸，返回段号：最后一段本来就空着就直接用，不白白接长；否则接一段新的。
// 接满了（MAX_SEGMENTS）就只能用最后一段。
function freshPaper(room, userId) {
  const last = room.segments - 1;
  const lo = last * SEG_W;
  const blank =
    !(room.segVersions && room.segVersions[last]) &&
    !room.strokes.some((s) => !s.hidden && (s.points || [{ x: s.x }]).some((p) => p.x >= lo - 40));
  if (blank || room.segments >= MAX_SEGMENTS) return last;
  growWall(room, userId);
  return room.segments - 1;
}

// 墙向右接一段。玩法也用它（连线谜题要一段干净的纸），所以不管闸门和锁——那是调用方的事
function growWall(room, userId) {
  room.segments += 1;
  broadcast(room, { type: "extend", segments: room.segments, userId });
  scheduleSave(room);
  modes.after(room, { type: "extend", segments: room.segments, userId });
}

module.exports = {
  resend,
  handleJoin,
  handleClose,
  handleLeave,
  handleKick,
  handleRename,
  handleLock,
  handleExtend,
  growWall,
  freshPaper,
};
