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

async function join(port, { code, name, clientId }) {
  const c = new Client(port);
  await c.open();
  c.send({ type: "join", code, name, clientId });
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

function startServer(port, dataDir) {
  const logs = [];
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
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
