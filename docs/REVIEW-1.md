# 验收问题单 #1

> 状态：6 项及「其他」均已修复（2026-09-18，由 Claude 接手）。新增测试「malformed URL does not crash the server」「stroke points may overshoot the paper only by the margin」，`npm test` 13/13 通过；第 2–5 项已在浏览器实测通过。

`npm test` 11 项全部通过。以下问题来自代码审查和浏览器实测，测试没有覆盖到。按顺序修，修完后 `npm test` 必须仍然全过，并为 1、3 补充测试。

## 1. 【严重】格式错误的 URL 会让服务进程崩溃

- 复现：`curl "localhost:3000/%E0%A4%A"` → 进程退出，所有人断线。
- 原因：`server.js` `safePublicFile()` 里 `decodeURIComponent` 抛出 URIError，`handleHttp` 是 async 函数，异常变成未处理的 Promise rejection，Node 直接退出。
- 要求：解码失败返回 400；`handleHttp` 整体 try/catch，任何异常返回 500 而不是让进程退出。
- 测试：在 `test/e2e.js` 加一项：请求错误 URL 后服务仍能正常响应 `/api/health`。

## 2. 【严重】文字工具无法输入

- 复现：选「字」工具，单击纸面 → 文字框出现，但焦点立即回到 body。接着打字不会进入文字框，反而触发快捷键（输入 e 切到橡皮、t 切到文字），回车也无效。
- 原因：`public/app.js` `onPointerDown` → `placeText()` 里调用 `els.textBox.focus()`，随后浏览器对 mousedown 的默认处理（点在不可聚焦的 canvas 上）把焦点移走了。
- 要求：文字工具分支里对 pointerdown 调用 `e.preventDefault()`，并在 `requestAnimationFrame`/`setTimeout(0)` 里再 focus，确保点击后可以直接打字。修完手动验证：选字工具 → 单击纸面 → 直接输入 → Enter 落字，其他人能看到。

## 3. 【PRD 4.2】第一次通过链接进入时不问昵称

- 复现：新浏览器打开 `/w/CODE`，直接以「朋友」进入。四个朋友都点链接的话，名单上是四个「朋友」。
- 要求：打开 `/w/CODE` 时，若本地没有保存过昵称，先显示门口页：房间码预填、昵称输入框获得焦点、主按钮变为「推门」（或提示「先告诉大家怎么称呼你」）。填好后进入。本地已有昵称则仍直接进入。
- 自测：清空 localStorage 后打开链接。

## 4. 离开的人光标残留

- 复现：B 关闭页面，10 秒后 A 收到「B 走了」，但 B 的光标（半透明）永久留在墙上。
- 要求：收到 `presence` 时，移除不在 `users` 列表里的光标元素，并清理对应的 idle 定时器。被踢时同理。

## 5. 回门口再进墙后，底栏误显示「重连中」

- 原因：`connect()` 的 close 监听没有判断是不是当前 socket。旧 socket 迟到的 close 事件会把状态改成「重连中」。
- 要求：close 回调里 `if (ws !== state.ws) return;`。

## 6. 拖出纸边时画出一条贴边的线

- 复现：按住鼠标从纸内拖到纸外，再沿纸外移动 → 纸的边缘出现一条沿边的线。
- 原因：客户端 `clip()` 和服务端 `clipPoint()` 把点钳制到边界上。
- 要求：笔画点允许超出纸面一小段余量（例如 ±40 画布像素，前后端一致）。canvas 本身只有 1600×1000，超出部分自然被裁掉，不会贴边画线。光标和文字位置仍钳制在纸内。

## 其他

- 删除 `data/rooms/XP66.json`（开发时手动测试留下的空房间）。
- `finishClear()` 里有一个空的 `for` 循环，删除。
- 完成后输出：每一项怎么修的、新增了哪些测试、`npm test` 结果。
