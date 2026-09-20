"use strict";

// HTTP 这边只有三件事：开房、取／传墨迹图、发静态文件。

const fs = require("fs");
const path = require("path");

const { PUBLIC_DIR, MIME } = require("./config");
const { rooms, createRoom } = require("./store");
const { handleBakeUpload, segFile } = require("./bake");
const { validUuid } = require("./protocol");

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
    // 这里只用内存里的房间：取墨迹图的一定是连着的人，房间必然在内存里。
    // 用 getRoom 的话，随便猜房间码的请求就能把一屋子房间拽进内存。
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

module.exports = { handleHttp };
