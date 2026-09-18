# 墙

朋友之间的常驻涂鸦墙。不用注册，四个人，电脑浏览器打开就能画。

需求见 `docs/PRD-v0.2.txt`。

## 启动

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

默认监听 `3000`。浏览器打开 http://localhost:3000

- `PORT`：端口，默认 `3000`
- `DATA_DIR`：房间 JSON 目录，默认 `data/rooms`

## 测试

```bash
npm test
```

测试会在随机端口拉起服务器，用 WebSocket 客户端覆盖创建/加入、满员、顶替连接、笔画与 seq、撤销、清空、锁定、踢人、持久化，结束后关掉进程。

## 目录

```
server.js          HTTP + WebSocket 服务
public/            门口页与墙页（原生 HTML/CSS/JS）
data/rooms/        每个房间一个 JSON，进程重启后恢复
test/e2e.js        端到端协议测试
docs/              PRD 与开发任务
```

房间链接形如 `/w/CODE`。画布 1600×1000，最多 4 人同时在线。
