"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uuid() {
  return crypto.randomUUID();
}

class Client {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.msgs = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.msgs.push(msg);
      for (const w of this.waiters.slice()) w();
    });
    this.ws.on("close", () => this._resolveClosed());
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  wait(typeOrFn, timeout = 4000) {
    const match =
      typeof typeOrFn === "function"
        ? typeOrFn
        : (m) => m.type === typeOrFn;
    const label = typeof typeOrFn === "function" ? "predicate" : typeOrFn;
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.msgs.findIndex((m) => !m._consumed && match(m));
        if (i >= 0) {
          this.msgs[i]._consumed = true;
          resolve(this.msgs[i]);
          return true;
        }
        return false;
      };
      if (check()) return;
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const seen = this.msgs.map((m) => m.type).join(",");
        reject(new Error(`timeout waiting for ${label} (seen: ${seen})`));
      }, timeout);
      const waiter = () => {
        if (check()) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== waiter);
        }
      };
      this.waiters.push(waiter);
    });
  }

  has(type) {
    return this.msgs.some((m) => m.type === type);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function join(port, { code, name, clientId, weak }) {
  const c = new Client(port);
  await c.open();
  c.send({ type: "join", code, name, clientId, weak });
  return c;
}

async function createRoom(port, clientId) {
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "create failed");
  return data.code;
}

async function waitHealth(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await delay(100);
  }
  throw new Error(`server on ${port} did not become healthy`);
}

function startServer(port, dataDir, extraEnv = {}) {
  const logs = [];
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      // 冻结阈值调小，测试里画几十笔就能触发
      QIANG_LIVE_KEEP: "20",
      QIANG_BAKE_BATCH: "20",
      // 空房间几乎立刻请出内存，好验证「再推门进来还在」
      QIANG_IDLE_EVICT_MS: "120",
      QIANG_SWEEP_MS: "60",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  proc.logs = logs;
  proc.exited = new Promise((resolve) => proc.on("exit", resolve));
  return proc;
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  const code = await Promise.race([
    proc.exited,
    delay(3000).then(() => "timeout"),
  ]);
  if (code === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

// 1×1 透明 PNG：服务端只校验 PNG 文件头
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// 扮演烘焙的客户端：收到 bake 任务就上传一张图，直到收到 baked
async function serveBakes(c, port, code) {
  const tasks = [];
  for (;;) {
    const m = await c.wait((x) => x.type === "bake" || x.type === "baked", 6000);
    if (m.type === "baked") return { baked: m, tasks };
    tasks.push(m);
    const r = await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/seg/${m.seg}?job=${m.job}`, {
      method: "POST",
      body: TINY_PNG,
    });
    assert(r.status === 204, "upload accepted, got " + r.status);
  }
}

function drawStrokes(c, color, n, x) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = uuid();
    ids.push(id);
    c.send({ type: "stroke_start", id, strokeType: "pen", color, width: 8, x: x + i, y: 100 + i });
    c.send({ type: "stroke_point", id, points: [{ x: x + i + 30, y: 120 + i }] });
    c.send({ type: "stroke_end", id });
  }
  return ids;
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`not ok  ${name}`);
    console.log("  " + (err && err.stack ? err.stack : err));
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qiang-e2e-"));
  const port = 18000 + Math.floor(Math.random() * 10000);
  let proc = startServer(port, dataDir);
  const clients = [];
  const track = (c) => {
    clients.push(c);
    return c;
  };

  try {
    await waitHealth(port);

    await test("create and join as host", async () => {
      const id = uuid();
      const code = await createRoom(port, id);
      assert(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code), "bad room code " + code);
      const c = track(await join(port, { code, name: "房主", clientId: id }));
      const snap = await c.wait("snapshot");
      assert(snap.code === code, "snapshot code");
      assert(snap.you.id === id, "you.id");
      assert(snap.you.isHost === true, "is host");
      assert(snap.you.color === "#C43C3C", "host color 朱红");
      assert(snap.locked === false, "not locked");
      assert(Array.isArray(snap.strokes), "strokes array");
    });

    await test("second user joins with different color", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const bId = uuid();
      const b = track(await join(port, { code, name: "乙", clientId: bId }));
      const snap = await b.wait("snapshot");
      assert(snap.you.isHost === false, "guest is not host");
      assert(snap.you.color === "#3B5BDB", "second color 靛");
      assert(snap.users.length === 2, "two users");
    });

    await test("wrong code is rejected", async () => {
      const c = track(await join(port, { code: "ZZZZ", name: "谁", clientId: uuid() }));
      const err = await c.wait("error");
      assert(err.code === "not_found", "not_found");
      assert(err.message === "没有这面墙", "message");
    });

    await test("fifth person is rejected", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const ids = [hostId, uuid(), uuid(), uuid()];
      for (let i = 0; i < 4; i++) {
        const c = track(await join(port, { code, name: "p" + i, clientId: ids[i] }));
        const snap = await c.wait("snapshot");
        assert(snap.you.id === ids[i], "joined " + i);
      }
      const fifth = track(await join(port, { code, name: "老五", clientId: uuid() }));
      const err = await fifth.wait("error");
      assert(err.code === "full", "full");
      assert(err.message === "墙满了", "message 墙满了");
    });

    await test("same clientId replaces old connection without extra seat", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a1 = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a1.wait("snapshot");
      const a2 = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a2.wait("snapshot");
      assert(snap.users.length === 1, "still one seat, got " + snap.users.length);
      const replaced = await a1.wait("replaced");
      assert(replaced.message === "已在别处打开", "replaced message");
      const guest = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const gsnap = await guest.wait("snapshot");
      assert(gsnap.users.length === 2, "guest is second, not third");
    });

    await test("stroke broadcast and increasing seq", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");
      const id1 = uuid();
      a.send({
        type: "stroke_start",
        id: id1,
        strokeType: "pen",
        color: asnap.you.color,
        width: 8,
        x: 10,
        y: 20,
      });
      const start1 = await b.wait("stroke_start");
      assert(start1.stroke.id === id1, "id");
      assert(start1.stroke.seq === 1, "seq 1, got " + start1.stroke.seq);
      assert(start1.stroke.userId === hostId, "userId");
      a.send({ type: "stroke_point", id: id1, points: [{ x: 30, y: 40 }, { x: 50, y: 60 }] });
      const pts = await b.wait((m) => m.type === "stroke_point" && m.id === id1);
      assert(pts.points.length >= 1, "packed points");
      a.send({ type: "stroke_end", id: id1 });
      const end1 = await b.wait((m) => m.type === "stroke_end" && m.id === id1);
      assert(end1.stroke.seq === 1, "end seq");
      assert(end1.stroke.points.length >= 2, "points persisted");

      const id2 = uuid();
      b.send({
        type: "stroke_start",
        id: id2,
        strokeType: "pen",
        color: bsnap.you.color,
        width: 3,
        x: 100,
        y: 100,
      });
      const start2 = await a.wait((m) => m.type === "stroke_start" && m.stroke && m.stroke.id === id2);
      assert(start2.stroke.seq === 2, "seq 2, got " + start2.stroke.seq);
      b.send({ type: "stroke_end", id: id2 });
      await a.wait((m) => m.type === "stroke_end" && m.id === id2);
    });

    await test("malformed URL does not crash the server", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
      assert(r.status === 400, "expected 400, got " + r.status);
      const h = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert(h.ok, "server still healthy");
    });

    await test("stroke points may overshoot the paper only by the margin", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a.wait("snapshot");
      const id = uuid();
      a.send({ type: "stroke_start", id, strokeType: "pen", color: snap.you.color, width: 8, x: 1590, y: 500 });
      a.send({ type: "stroke_point", id, points: [{ x: 1620, y: 500 }, { x: 5000, y: -900 }] });
      a.send({ type: "stroke_end", id });
      const end = await a.wait((m) => m.type === "stroke_end" && m.id === id);
      const [p0, p1, p2] = end.stroke.points;
      assert(p0.x === 1590, "start inside");
      assert(p1.x === 1620, "small overshoot kept, got " + p1.x);
      assert(p2.x === 1640 && p2.y === -40, "far point clamped to margin, got " + JSON.stringify(p2));
      // 坐标只保留 1 位小数
      const r = uuid();
      a.send({ type: "stroke_start", id: r, strokeType: "pen", color: snap.you.color, width: 8, x: 100.456, y: 200.444 });
      a.send({ type: "stroke_end", id: r });
      const re = await a.wait((m) => m.type === "stroke_end" && m.id === r);
      assert(re.stroke.points[0].x === 100.5 && re.stroke.points[0].y === 200.4, "rounded to 0.1, got " + JSON.stringify(re.stroke.points[0]));
    });

    await test("can only undo own strokes", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const bId = uuid();
      const b = track(await join(port, { code, name: "乙", clientId: bId }));
      const bsnap = await b.wait("snapshot");

      const aStroke = uuid();
      a.send({
        type: "stroke_start",
        id: aStroke,
        strokeType: "pen",
        color: asnap.you.color,
        width: 8,
        x: 1,
        y: 1,
      });
      await b.wait("stroke_start");
      a.send({ type: "stroke_end", id: aStroke });
      await b.wait("stroke_end");

      const bStroke = uuid();
      b.send({
        type: "stroke_start",
        id: bStroke,
        strokeType: "pen",
        color: bsnap.you.color,
        width: 8,
        x: 2,
        y: 2,
      });
      await a.wait("stroke_start");
      b.send({ type: "stroke_end", id: bStroke });
      await a.wait("stroke_end");

      a.send({ type: "undo" });
      const undoA = await b.wait((m) => m.type === "undo" && m.id === aStroke);
      assert(undoA.userId === hostId, "undo userId");

      a.send({ type: "undo" });
      await delay(250);
      const extra = b.msgs.filter((m) => m.type === "undo" && m.id === bStroke);
      assert(extra.length === 0, "A cannot undo B's stroke");

      b.send({ type: "undo" });
      const undoB = await a.wait((m) => m.type === "undo" && m.id === bStroke);
      assert(undoB.id === bStroke, "B undoes own stroke");
    });

    await test("clear countdown and cancel", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      await b.wait("snapshot");
      const sid = uuid();
      a.send({
        type: "stroke_start",
        id: sid,
        strokeType: "pen",
        color: asnap.you.color,
        width: 8,
        x: 8,
        y: 8,
      });
      await b.wait("stroke_start");
      a.send({ type: "stroke_end", id: sid });
      await b.wait("stroke_end");

      a.send({ type: "clear_start" });
      const cs = await b.wait("clear_start");
      assert(typeof cs.deadline === "number", "deadline");
      await a.wait("clear_start");
      a.send({ type: "clear_cancel" });
      await b.wait("clear_cancel");
      await a.wait("clear_cancel");
      await delay(5500);
      assert(!b.has("clear_done"), "cancelled clear must not fire");
      assert(!a.has("clear_done"), "host must not see clear_done after cancel");

      a.send({ type: "clear_start" });
      await b.wait("clear_start");
      const done = await b.wait("clear_done", 7000);
      assert(done.type === "clear_done", "clear executed");
      const sys = await b.wait(
        (m) => m.type === "chat" && m.message && m.message.text === "墙被清空了",
        2000
      );
      assert(sys.message.userId === "system", "system message");
    });

    await test("lock blocks non-host drawing", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");
      a.send({ type: "lock" });
      const lock = await b.wait("lock");
      assert(lock.locked === true, "locked");
      b.send({
        type: "stroke_start",
        id: uuid(),
        strokeType: "pen",
        color: bsnap.you.color,
        width: 8,
        x: 3,
        y: 3,
      });
      const err = await b.wait("error");
      assert(err.code === "locked", "locked error");
      b.send({ type: "undo" });
      const err2 = await b.wait("error");
      assert(err2.code === "locked", "undo locked");
      a.send({
        type: "stroke_start",
        id: uuid(),
        strokeType: "pen",
        color: "#C43C3C",
        width: 8,
        x: 4,
        y: 4,
      });
      const start = await b.wait("stroke_start");
      assert(start.stroke.userId === hostId, "host can still draw");
    });

    await test("pen color is free choice, but must be a hex color", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const ok = uuid();
      a.send({ type: "stroke_start", id: ok, strokeType: "pen", color: "#7048e8", width: 8, x: 10, y: 10 });
      const st = await a.wait((m) => m.type === "stroke_start" && m.stroke.id === ok);
      assert(st.stroke.color === "#7048E8", "custom color accepted and normalized, got " + st.stroke.color);
      a.send({ type: "stroke_end", id: ok });
      await a.wait((m) => m.type === "stroke_end" && m.id === ok);
      a.send({ type: "text_place", id: uuid(), color: "#0CA678", text: "青", x: 20, y: 20 });
      const tp = await a.wait("text_place");
      assert(tp.stroke.color === "#0CA678", "custom text color accepted");
      for (const bad of ["red", "#12345", "javascript:alert(1)"]) {
        a.send({ type: "stroke_start", id: uuid(), strokeType: "pen", color: bad, width: 8, x: 10, y: 10 });
      }
      a.send({ type: "chat", text: "sentinel" });
      await a.wait((m) => m.type === "chat" && m.message.text === "sentinel");
      assert(!a.msgs.some((m) => m.type === "stroke_start" && m.stroke.id !== ok), "invalid colors rejected");
    });

    await test("brushes, pen pressure, shapes and replacing a stroke", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      await b.wait("snapshot");
      const id = uuid();
      a.send({ type: "stroke_start", id, strokeType: "pen", brush: "ink", color: snap.you.color, width: 14, x: 10, y: 10, p: 0.42 });
      const st = await b.wait((m) => m.type === "stroke_start" && m.stroke.id === id);
      assert(st.stroke.brush === "ink" && st.stroke.points[0].p === 0.42, "brush and pressure kept");
      a.send({ type: "stroke_point", id, points: [{ x: 50, y: 60, p: 0.9 }, { x: 80, y: 90, p: 7 }, { x: 90, y: 95 }] });
      const pt = await b.wait((m) => m.type === "stroke_point" && m.id === id);
      assert(pt.points[0].p === 0.9 && pt.points[1].p === undefined && pt.points[2].p === undefined, "bad pressure dropped");
      a.send({ type: "stroke_replace", id, shape: "ellipse", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] });
      const rp = await b.wait("stroke_replace");
      assert(rp.shape === "ellipse" && rp.points.length === 3, "replace broadcast");
      a.send({ type: "stroke_end", id });
      const end = await b.wait((m) => m.type === "stroke_end" && m.id === id);
      assert(end.stroke.shape === "ellipse" && end.stroke.points.length === 3, "replaced points land");

      // 吸附后又继续画：换回手画的点，形状清掉
      const id3 = uuid();
      a.send({ type: "stroke_start", id: id3, strokeType: "pen", brush: "ink", color: snap.you.color, width: 8, x: 5, y: 5 });
      a.send({ type: "stroke_replace", id: id3, shape: "line", points: [{ x: 5, y: 5 }, { x: 90, y: 5 }] });
      a.send({ type: "stroke_replace", id: id3, shape: null, points: [{ x: 5, y: 5 }, { x: 40, y: 9 }, { x: 90, y: 5 }] });
      a.send({ type: "stroke_end", id: id3 });
      const end3 = await b.wait((m) => m.type === "stroke_end" && m.id === id3);
      assert(end3.stroke.shape === undefined && end3.stroke.points.length === 3, "unsnap restores freehand");

      const id2 = uuid();
      a.send({ type: "stroke_start", id: id2, strokeType: "pen", brush: "glitter", shape: "star", color: snap.you.color, width: 24, x: 10, y: 10 });
      const st2 = await b.wait((m) => m.type === "stroke_start" && m.stroke.id === id2);
      assert(st2.stroke.brush === undefined && st2.stroke.shape === undefined, "unknown brush/shape ignored");
      a.send({ type: "stroke_start", id: uuid(), strokeType: "pen", brush: "ink", color: snap.you.color, width: 13, x: 10, y: 10 });
      a.send({ type: "chat", text: "w" });
      await a.wait((m) => m.type === "chat" && m.message.text === "w");
      assert(!a.msgs.some((m) => m.type === "stroke_start" && m.stroke.width === 13), "invalid width rejected");
    });

    await test("a stroke can be cancelled before it ends", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      await b.wait("snapshot");
      const id = uuid();
      a.send({ type: "stroke_start", id, strokeType: "pen", color: snap.you.color, width: 8, x: 10, y: 10 });
      a.send({ type: "stroke_point", id, points: [{ x: 20, y: 20 }] });
      a.send({ type: "stroke_cancel", id });
      const c = await b.wait("stroke_cancel");
      assert(c.id === id, "others drop the live stroke");
      a.send({ type: "stroke_end", id }); // 已取消的笔不能再落定
      const c2 = track(await join(port, { code, name: "丙", clientId: uuid() }));
      const s2 = await c2.wait("snapshot");
      assert(!s2.strokes.some((st) => st.id === id), "cancelled stroke never lands");
    });

    await test("leaving frees the seat right away", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      await b.wait("snapshot");
      await a.wait((m) => m.type === "presence" && m.users.length === 2);
      const t0 = Date.now();
      b.send({ type: "leave" });
      const p = await a.wait((m) => m.type === "presence" && m.users.length === 1, 2000);
      assert(p.users[0].id === hostId, "only host remains");
      assert(Date.now() - t0 < 1500, "no 10s grace for an explicit leave");
      await a.wait((m) => m.type === "chat" && m.message.text === "乙走了");
      await b.closed;
    });

    await test("host can kick a guest", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const bId = uuid();
      const b = track(await join(port, { code, name: "乙", clientId: bId }));
      await b.wait("snapshot");
      a.send({ type: "kick", targetId: bId });
      const kicked = await b.wait("kicked");
      assert(kicked.message.includes("请离"), "kicked message");
      const presence = await a.wait(
        (m) => m.type === "presence" && m.users.length === 1 && m.users[0].id === hostId
      );
      assert(presence.users.every((u) => u.id !== bId), "seat released");
    });

    await test("wall extends as a horizontal scroll", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      assert(asnap.segments === 1, "starts with one segment");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");

      // 接长前，点被钳制在第一段（+余量）以内
      const s1 = uuid();
      b.send({ type: "stroke_start", id: s1, strokeType: "pen", color: bsnap.you.color, width: 8, x: 1500, y: 500 });
      b.send({ type: "stroke_point", id: s1, points: [{ x: 2500, y: 500 }] });
      b.send({ type: "stroke_end", id: s1 });
      const e1 = await b.wait((m) => m.type === "stroke_end" && m.id === s1);
      assert(e1.stroke.points[1].x === 1640, "clamped to first segment, got " + e1.stroke.points[1].x);

      b.send({ type: "extend" });
      const ext = await a.wait("extend");
      assert(ext.segments === 2 && ext.userId === bsnap.you.id, "extend broadcast");
      await a.wait((m) => m.type === "chat" && /接长了一段/.test(m.message.text));

      // 接长后可以画在第二段
      const s2 = uuid();
      b.send({ type: "stroke_start", id: s2, strokeType: "pen", color: bsnap.you.color, width: 8, x: 2500, y: 500 });
      b.send({ type: "stroke_point", id: s2, points: [{ x: 3100, y: 500 }] });
      b.send({ type: "stroke_end", id: s2 });
      const e2 = await b.wait((m) => m.type === "stroke_end" && m.id === s2);
      assert(e2.stroke.points[0].x === 2500 && e2.stroke.points[1].x === 3100, "second segment usable");

      // 锁定后访客不能接长，房主可以
      a.send({ type: "lock" });
      await b.wait("lock");
      b.send({ type: "extend" });
      const err = await b.wait("error");
      assert(err.code === "locked", "guest blocked while locked");
      a.send({ type: "extend" });
      const ext3 = await b.wait((m) => m.type === "extend" && m.segments === 3);
      assert(ext3.segments === 3, "host can extend while locked");

      // 不再封顶在 20 段
      for (let i = 3; i < 25; i++) {
        a.send({ type: "extend" });
        await a.wait((m) => m.type === "extend" && m.segments === i + 1);
      }

      // 新进来的人拿到的快照里有段数
      const c = track(await join(port, { code, name: "丙", clientId: uuid() }));
      const csnap = await c.wait("snapshot");
      assert(csnap.segments === 25, "snapshot carries segments");
    });

    await test("old strokes are baked into segment images", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a.wait("snapshot");
      assert(snap.frozenUpTo === 0 && Object.keys(snap.segVersions).length === 0, "nothing frozen yet");
      drawStrokes(a, snap.you.color, 45, 200);
      const { baked, tasks } = await serveBakes(a, port, code);
      assert(tasks.length === 1 && tasks[0].seg === 0 && tasks[0].mode === "delta", "one delta task for segment 0");
      assert(tasks[0].baseVersion === 0, "first bake has no base image");
      assert(tasks[0].strokes.length === 21, "freezes all but the newest 20, got " + tasks[0].strokes.length);
      assert(baked.versions["0"] === 1 && baked.upTo === 21, "baked v1 up to seq 21, got " + JSON.stringify(baked));

      const img = await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/seg/0.png?v=1`);
      assert(img.status === 200 && img.headers.get("content-type") === "image/png", "segment image served");
      const stale = await fetch(`http://127.0.0.1:${port}/api/rooms/${code}/seg/0.png?v=9`);
      assert(stale.status === 404, "unknown version is 404");

      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");
      assert(bsnap.frozenUpTo === 21 && bsnap.segVersions["0"] === 1, "snapshot carries frozen state");
      assert(bsnap.strokes.every((st) => st.seq > 21), "snapshot only carries live strokes");
      assert(bsnap.strokes.length === 24, "live tail only, got " + bsnap.strokes.length);

      const archive = fs.readFileSync(path.join(dataDir, code, "archive-0.jsonl"), "utf8").trim().split("\n");
      assert(archive.length === 21, "vector archive kept on disk, split per segment");
      assert(!fs.existsSync(path.join(dataDir, code, "archive.jsonl")), "no more single growing archive");
      const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `${code}.json`), "utf8"));
      assert(meta.frozenUpTo === 21 && meta.strokes.length === 24, "meta file stays small");
    });

    await test("undoing a frozen stroke re-bakes its segment", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");
      const mine = drawStrokes(a, asnap.you.color, 5, 300);
      await a.wait((m) => m.type === "stroke_end" && m.id === mine[4]);
      drawStrokes(b, bsnap.you.color, 36, 900);
      await serveBakes(a, port, code);

      // 甲的 5 笔都已冻结，但仍能撤销：服务端要求整段重画，且不含被撤销的那一笔
      a.send({ type: "undo" });
      const undo = await b.wait("undo");
      assert(undo.id === mine[4], "undo targets a frozen stroke");
      const full = await serveBakes(a, port, code);
      assert(full.tasks.length === 1 && full.tasks[0].mode === "full", "full re-bake requested");
      const ids = full.tasks[0].strokes.map((st) => st.id);
      assert(!ids.includes(mine[4]) && ids.includes(mine[3]), "undone stroke left out of the re-bake");
      assert(full.baked.versions["0"] === 2, "segment image bumped to v2");

      a.send({ type: "redo" });
      const again = await serveBakes(a, port, code);
      assert(again.tasks[0].strokes.some((st) => st.id === mine[4]), "redo puts it back");
    });

    await test("strokes persist across server restart", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const sid = uuid();
      a.send({
        type: "stroke_start",
        id: sid,
        strokeType: "pen",
        color: asnap.you.color,
        width: 18,
        x: 15,
        y: 25,
      });
      a.send({ type: "stroke_point", id: sid, points: [{ x: 40, y: 50 }] });
      a.send({ type: "stroke_end", id: sid });
      await a.wait((m) => m.type === "stroke_end" && m.id === sid);
      a.send({ type: "chat", text: "还在" });
      await a.wait((m) => m.type === "chat" && m.message && m.message.text === "还在");
      a.send({ type: "extend" });
      await a.wait("extend");

      for (const c of clients) c.close();
      await stopServer(proc);
      proc = startServer(port, dataDir);
      await waitHealth(port);

      const file = path.join(dataDir, `${code}.json`);
      assert(fs.existsSync(file), "room json exists");
      const a2 = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await a2.wait("snapshot");
      assert(snap.you.isHost === true, "host restored");
      const found = snap.strokes.find((s) => s.id === sid);
      assert(found, "stroke restored");
      assert(found.hidden === false, "not hidden");
      assert(found.points && found.points.length >= 2, "points restored");
      assert(snap.chat.some((m) => m.text === "还在"), "chat restored");
      assert(snap.you.canUndo === true, "can undo own stroke after restart");
      assert(snap.segments === 2, "segments restored, got " + snap.segments);
    });

    await test("an empty room leaves memory but is still there when you push the door", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const sid = uuid();
      a.send({
        type: "stroke_start",
        id: sid,
        strokeType: "pen",
        color: asnap.you.color,
        width: 8,
        x: 30,
        y: 40,
      });
      a.send({ type: "stroke_point", id: sid, points: [{ x: 60, y: 80 }] });
      a.send({ type: "stroke_end", id: sid });
      await a.wait((m) => m.type === "stroke_end" && m.id === sid);

      a.send({ type: "leave" });
      await delay(400); // 扫一遍（60ms）+ 空置阈值（120ms），足够被请出内存

      // 直接改盘上的文件：只有真的从内存里出去了，再进来才会看见这句话
      const file = path.join(dataDir, `${code}.json`);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      onDisk.chat.push({ id: uuid(), userId: "system", text: "只在盘上", t: Date.now() });
      fs.writeFileSync(file, JSON.stringify(onDisk));

      const again = track(await join(port, { code, name: "甲", clientId: hostId }));
      const snap = await again.wait("snapshot");
      assert(snap.chat.some((m) => m.text === "只在盘上"), "room really left memory and was read back from disk");
      assert(snap.you.isHost === true, "still the host after the room was evicted");
      assert(snap.strokes.some((s) => s.id === sid), "the stroke came back too");
      assert(snap.you.canUndo === true, "undo stack came back too");

      const ghost = track(new Client(port));
      await ghost.open();
      ghost.send({ type: "join", code: "ZZZZ", name: "无", clientId: uuid() });
      const err = await ghost.wait("error");
      assert(err.code === "not_found", "a code that was never used is still not found");
    });

    await test("many cursor moves come back as one merged message", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      await b.wait("snapshot");
      await a.wait("presence");

      const before = b.msgs.length;
      for (let i = 0; i < 40; i++) a.send({ type: "cursor", x: 100 + i, y: 200 + i });
      await b.wait("cursors");
      await delay(250); // 攒够几个 50ms 的窗口

      const got = b.msgs.slice(before).filter((m) => m.type === "cursors");
      assert(got.length > 0, "cursor updates arrive");
      assert(got.length < 10, "40 moves merged into a handful, got " + got.length);
      const last = got[got.length - 1];
      assert(Array.isArray(last.list) && last.list[0].userId === hostId, "carries whose cursor it is");
      assert(last.list[0].x === 139 && last.list[0].y === 239, "keeps the newest position, not a stale one");
      assert(!b.msgs.some((m) => m.type === "cursor"), "the old one-per-move message is gone");
    });

    await test("a phone is not made the baker while a computer is around", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      // 房主自己在手机上：平时房主优先烘焙，但手机要让位给电脑
      const phone = track(await join(port, { code, name: "手机", clientId: hostId, weak: true }));
      const psnap = await phone.wait("snapshot");
      const pc = track(await join(port, { code, name: "电脑", clientId: uuid(), weak: false }));
      const csnap = await pc.wait("snapshot");

      drawStrokes(phone, psnap.you.color, 45, 300);
      const task = await pc.wait("bake", 6000);
      assert(task.mode === "delta", "the computer was asked to bake");
      assert(!phone.msgs.some((m) => m.type === "bake"), "the phone was never asked");

      // 电脑走了，只剩手机：总比不烘好
      pc.send({ type: "leave" });
      await phone.wait("presence");
      drawStrokes(phone, csnap.you.color, 25, 700);
      const fallback = await phone.wait("bake", 8000);
      assert(fallback.mode, "the phone takes over once it is the only one left");
    });

    await test("the old single archive file is still readable", async () => {
      const hostId = uuid();
      const code = await createRoom(port, hostId);
      const a = track(await join(port, { code, name: "甲", clientId: hostId }));
      const asnap = await a.wait("snapshot");
      const b = track(await join(port, { code, name: "乙", clientId: uuid() }));
      const bsnap = await b.wait("snapshot");
      const mine = drawStrokes(a, asnap.you.color, 5, 300);
      await a.wait((m) => m.type === "stroke_end" && m.id === mine[4]);
      drawStrokes(b, bsnap.you.color, 36, 900);
      await serveBakes(a, port, code);

      // 把按段存档搬回老格式，模拟一个从旧版本升上来的房间
      const dir = path.join(dataDir, code);
      const perSeg = fs.readdirSync(dir).filter((n) => /^archive-\d+\.jsonl$/.test(n));
      assert(perSeg.length > 0, "per-segment archive was written");
      let merged = "";
      for (const n of perSeg) {
        merged += fs.readFileSync(path.join(dir, n), "utf8");
        fs.rmSync(path.join(dir, n));
      }
      fs.writeFileSync(path.join(dir, "archive.jsonl"), merged);

      // 撤销一笔已冻结的笔：只剩老存档也要能整段重画
      a.send({ type: "undo" });
      await b.wait("undo");
      const full = await serveBakes(a, port, code);
      assert(full.tasks[0].mode === "full", "full re-bake requested");
      const ids = full.tasks[0].strokes.map((st) => st.id);
      assert(ids.includes(mine[3]), "strokes read back out of the legacy archive");
      assert(!ids.includes(mine[4]), "the undone stroke stays out");
    });
  } finally {
    for (const c of clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    await stopServer(proc);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
