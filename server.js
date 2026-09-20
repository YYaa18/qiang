"use strict";

// 墙 —— 一面几个人共用的涂鸦墙。
//
// 这个文件只负责接线：起 http 和 ws、装心跳和清扫、优雅退出。
// 真正的东西都在 src/ 里：
//
//   config    所有常量和环境变量
//   protocol  客户端来的东西一律不可信，校验和归一化都在这
//   room      一间房的形状，以及发给客户端的那几种数据
//   net       发消息（一条只序列化一次，弱网会丢装饰性的消息）
//   store     房间在内存和磁盘之间的进出
//   bake      冻结：旧笔画烘焙成每段一张墨迹图
//   wall/     墙上发生的事：presence 进出 / draw 画 / chat 说话 / clear 清空
//   dispatch  每条消息落到哪个处理函数
//   http      开房、取墨迹图、发静态文件

const http = require("http");
const { WebSocketServer } = require("ws");

const { PORT, HOST, DATA_DIR, SWEEP_MS } = require("./src/config");
const { scanRooms, sweepRooms, flushAll } = require("./src/store");
const { handleMessage } = require("./src/dispatch");
const { handleClose } = require("./src/wall/presence");
const { handleHttp } = require("./src/http");

scanRooms();

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

const sweeper = setInterval(sweepRooms, SWEEP_MS);
sweeper.unref?.();

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
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
