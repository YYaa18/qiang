"use strict";

// 清空一面墙：房主按下之后有 5 秒反悔时间。
//
// 倒计时只存 deadline 不存 setTimeout 句柄，所以进程重启、或房间从盘上重新读起来时，
// 要把它重建出来——这就是 onRoomLoaded 的用处。以后玩法的计时器照这个做。

const fs = require("fs");

const { send, broadcast } = require("../net");
const { ctxOf, scheduleSave, onRoomLoaded } = require("../store");
const { abortJob, roomDir } = require("../bake");
const { pushSystem } = require("./chat");
const modes = require("../modes");

const CLEAR_DELAY_MS = 5000;

function handleClearStart(ws) {
  const ctx = modes.allow(ws, "clear", null);
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
  room.clearDeadline = Date.now() + CLEAR_DELAY_MS;
  room.clearTimer = setTimeout(() => finishClear(room), CLEAR_DELAY_MS);
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
  room.mode = null; // 清空就是回到一面新的墙，正在玩的也一并结束
  fs.rmSync(roomDir(room), { recursive: true, force: true });
  broadcast(room, { type: "clear_done" });
  pushSystem(room, "墙被清空了");
  scheduleSave(room);
  modes.after(room, { type: "clear" });
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

onRoomLoaded(restoreClearTimer);

module.exports = { handleClearStart, handleClearCancel, finishClear, restoreClearTimer };
