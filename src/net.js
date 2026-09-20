"use strict";

// 弱网手机会让发送缓冲区一直涨。光标这类丢一帧也看不出来的消息先丢；真堵死了就断开，
// 客户端重连会拿到完整快照——比留着一个补不回来的半残连接好。笔迹消息绝不丢：丢了那一笔
// 在别人屏幕上就永远是错的形状。
const SOFT_BUFFER = 64 * 1024;
const HARD_BUFFER = 2 * 1024 * 1024;
const LOSSY = new Set(["cursors"]);

function sendData(ws, data, lossy) {
  if (!ws || ws.readyState !== 1) return;
  const buffered = ws.bufferedAmount;
  if (buffered > HARD_BUFFER) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    return;
  }
  if (lossy && buffered > SOFT_BUFFER) return;
  try {
    ws.send(data);
  } catch {
    /* ignore */
  }
}

function send(ws, obj) {
  sendData(ws, JSON.stringify(obj), LOSSY.has(obj.type));
}

// 一条消息只序列化一次，再发给每个人
function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  const lossy = LOSSY.has(obj.type);
  for (const u of room.users.values()) {
    if (exceptId && u.id === exceptId) continue;
    sendData(u.ws, data, lossy);
  }
}

module.exports = { send, sendData, broadcast };
