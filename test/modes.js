"use strict";

// 规则层的单元测试：直接在进程里调 gate / after，不起服务器。
//
// e2e 那 25 项证明的是「没开玩法时一切照旧」；这里证明的是闸门本身真的管用。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qiang-modes-"));
process.env.DATA_DIR = dataDir;

const modes = require("../src/modes");
const store = require("../src/store");
const { Room } = require("../src/room");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`not ok  ${name}`);
    console.log(`  ${err.message}`);
  }
}

// 玩法出错时走的是「放行并记一笔」，测试里把那一笔吞掉，别弄脏输出
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

function roomWith(modeId) {
  const room = new Room("TEST", "host-1");
  room.mode = modeId ? { id: modeId } : null;
  return room;
}

const user = { id: "u1", name: "甲" };

// ───────────── 没开玩法 ─────────────

test("no mode means everything passes", () => {
  const room = roomWith(null);
  for (const action of modes.ACTIONS) {
    assert.strictEqual(modes.gate(room, user, action, {}), null, `${action} 应当放行`);
  }
  assert.doesNotThrow(() => modes.after(room, { type: "stroke_end" }));
});

test("a mode id nobody registered is ignored, not a crash", () => {
  const room = roomWith("nonexistent");
  assert.strictEqual(modes.gate(room, user, "draw", {}), null);
  assert.strictEqual(modes.of(room), null);
  assert.doesNotThrow(() => modes.after(room, { type: "draw" }));
});

// ───────────── 闸门 ─────────────

const seen = [];
modes.register({
  id: "test-turns",
  can(room, who, action) {
    seen.push(action);
    if (action !== "draw") return null;
    if (room.mode.holder && room.mode.holder !== who.id) return "现在轮到别人画";
    return null;
  },
  on(room, event, api) {
    room.mode.lastEvent = event.type;
    room.mode.gotApi = typeof api.broadcast === "function" && typeof api.save === "function";
  },
  restore(room) {
    room.mode.restored = true;
  },
});

test("can() blocks an action and hands back the reason", () => {
  const room = roomWith("test-turns");
  room.mode.holder = "someone-else";
  assert.strictEqual(modes.gate(room, user, "draw", {}), "现在轮到别人画");
});

test("can() lets through the one holding the baton", () => {
  const room = roomWith("test-turns");
  room.mode.holder = user.id;
  assert.strictEqual(modes.gate(room, user, "draw", {}), null);
});

test("a mode only gates the actions it cares about", () => {
  const room = roomWith("test-turns");
  room.mode.holder = "someone-else";
  assert.strictEqual(modes.gate(room, user, "chat", {}), null, "说话不该被挡");
  assert.strictEqual(modes.gate(room, user, "undo", {}), null);
  assert.strictEqual(modes.gate(room, user, "draw", {}), "现在轮到别人画");
});

test("a can() that throws fails open", () => {
  modes.register({
    id: "test-broken-can",
    can() {
      throw new Error("玩法写错了");
    },
  });
  const room = roomWith("test-broken-can");
  // 宁可让人多画一笔，也不能因为玩法有 bug 就把整面墙卡死
  assert.strictEqual(quietly(() => modes.gate(room, user, "draw", {})), null);
});

test("anything that is not a non-empty string means pass", () => {
  modes.register({
    id: "test-odd-returns",
    can(room) {
      return room.mode.reply;
    },
  });
  const room = roomWith("test-odd-returns");
  for (const reply of [undefined, null, false, true, 0, 1, "", {}]) {
    room.mode.reply = reply;
    assert.strictEqual(modes.gate(room, user, "draw", {}), null, `${JSON.stringify(reply)} 应当放行`);
  }
  room.mode.reply = "不行";
  assert.strictEqual(modes.gate(room, user, "draw", {}), "不行");
});

// ───────────── 动作之后 ─────────────

test("after() hands the event and a small api to the mode", () => {
  const room = roomWith("test-turns");
  modes.after(room, { type: "stroke_end", userId: user.id });
  assert.strictEqual(room.mode.lastEvent, "stroke_end");
  assert.strictEqual(room.mode.gotApi, true);
});

test("an on() that throws does not reach the person drawing", () => {
  modes.register({
    id: "test-broken-on",
    on() {
      throw new Error("玩法写错了");
    },
  });
  const room = roomWith("test-broken-on");
  assert.doesNotThrow(() => quietly(() => modes.after(room, { type: "stroke_end" })));
});

// ───────────── 登记 ─────────────

test("a mode needs an id, and cannot be registered twice", () => {
  assert.throws(() => modes.register({}), /id/);
  assert.throws(() => modes.register({ id: "test-turns" }), /重复/);
});

// ───────────── 状态跟着房间走 ─────────────

test("mode state is saved with the room and read back", () => {
  const room = store.createRoom("11111111-1111-4111-8111-111111111111");
  room.mode = { id: "test-turns", holder: "u9", deadline: 123 };
  store.saveRoomNow(room);
  store.rooms.delete(room.code);

  const back = store.getRoom(room.code);
  assert.ok(back, "房间读回来了");
  assert.strictEqual(back.mode.id, "test-turns");
  assert.strictEqual(back.mode.holder, "u9");
  assert.strictEqual(back.mode.deadline, 123);
});

test("loading a room lets the mode rebuild its timers", () => {
  const room = store.createRoom("22222222-2222-4222-8222-222222222222");
  room.mode = { id: "test-turns" };
  store.saveRoomNow(room);
  store.rooms.delete(room.code);

  const back = store.getRoom(room.code);
  // 定时器只存 deadline 不存句柄，所以房间一读回来就得有人把它重建出来
  assert.strictEqual(back.mode.restored, true, "restore() 应当被调用");
});

test("a saved mode that is missing an id is dropped, not trusted", () => {
  const room = store.createRoom("33333333-3333-4333-8333-333333333333");
  store.saveRoomNow(room);
  const file = path.join(dataDir, `${room.code}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.mode = { holder: "u9" }; // 没有 id
  fs.writeFileSync(file, JSON.stringify(raw));
  store.rooms.delete(room.code);

  const back = store.getRoom(room.code);
  assert.strictEqual(back.mode, null);
});

// ───────────── 闸门真的装在路上了吗 ─────────────
//
// 上面那些只证明 gate() 自己对。这里直接调 handler，证明它们确实去问了闸门——
// 否则规则层写得再对，也只是摆在旁边没接上。

const draw = require("../src/wall/draw");
const chat = require("../src/wall/chat");

function wiredRoom(modeId) {
  const room = store.createRoom("44444444-4444-4444-8444-444444444444");
  room.mode = modeId ? { id: modeId, holder: "someone-else" } : null;
  const sent = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (d) => sent.push(JSON.parse(d)),
    roomCode: room.code,
    clientId: "u1",
  };
  room.users.set("u1", { id: "u1", name: "甲", color: "#C43C3C", ws, timer: null });
  return { room, ws, sent };
}

const penMsg = () => ({
  id: "0123456789abcdef",
  strokeType: "pen",
  color: "#C43C3C",
  width: 8,
  x: 10,
  y: 20,
});

test("a blocked draw never becomes a stroke, and says why", () => {
  const { room, ws, sent } = wiredRoom("test-turns");
  draw.handleStrokeStart(ws, penMsg());
  assert.strictEqual(room.open.size, 0, "没有开出一笔");
  assert.strictEqual(room.strokes.length, 0);
  const err = sent.find((m) => m.type === "error");
  assert.ok(err, "该收到一条错误");
  assert.strictEqual(err.code, "not_allowed");
  assert.strictEqual(err.message, "现在轮到别人画", "理由就是玩法给的那句话");
});

test("the same draw goes through once the baton is yours", () => {
  const { room, ws } = wiredRoom("test-turns");
  room.mode.holder = "u1";
  draw.handleStrokeStart(ws, penMsg());
  assert.strictEqual(room.open.size, 1, "笔开出来了");
});

test("and goes through when no mode is on at all", () => {
  const { room, ws } = wiredRoom(null);
  draw.handleStrokeStart(ws, penMsg());
  assert.strictEqual(room.open.size, 1);
});

test("undo and chat are wired to the gate too", () => {
  modes.register({
    id: "test-blocks-all",
    can: () => "全都不行",
  });
  const { room, ws, sent } = wiredRoom("test-blocks-all");
  room.stacks.u1 = { undo: ["some-stroke"], redo: [] };
  draw.handleUndo(ws);
  assert.deepStrictEqual(room.stacks.u1.undo, ["some-stroke"], "撤销没有发生");

  const before = room.chat.length;
  chat.handleChat(ws, { text: "喂" });
  assert.strictEqual(room.chat.length, before, "话没说出去");

  assert.strictEqual(sent.filter((m) => m.type === "error").length, 2, "两次都给了理由");
});

// ───────────── 一日一笔 ─────────────
//
// 跨天没法真的等一天，所以把玩法的时钟拨过去。

const daily = require("../src/modes/daily");

const DAY = 24 * 60 * 60 * 1000;
let fakeNow = Date.parse("2026-09-23T10:00:00+08:00");
daily._clock.now = () => fakeNow;

function dailyRoom() {
  const w = wiredRoom(null);
  w.room.mode = { id: "daily" };
  daily.init(w.room, { id: "u1" }, {}, modes.apiFor(w.room));
  return w;
}

let strokeNo = 0;
function oneStroke(ws) {
  const id = `daily-stroke-${String(++strokeNo).padStart(4, "0")}`;
  draw.handleStrokeStart(ws, { ...penMsg(), id });
  draw.handleStrokeEnd(ws, { id });
  return id;
}

const lastState = (sent) => sent.filter((m) => m.type === "mode").pop().state;

test("daily: one stroke today, the second is refused", () => {
  const { room, ws, sent } = dailyRoom();
  assert.strictEqual(lastState(sent).label, "第 1 天 · 今天这一笔还没落");
  oneStroke(ws);
  assert.strictEqual(room.strokes.length, 1);
  assert.strictEqual(lastState(sent).blocked, true);
  sent.length = 0;
  draw.handleStrokeStart(ws, { ...penMsg(), id: "daily-too-many-000" });
  assert.strictEqual(room.open.size, 0, "第二笔没有开出来");
  assert.match(sent.find((m) => m.type === "error").message, /明天再来/);
});

test("daily: undoing today's stroke gives it back", () => {
  const { room, ws, sent } = dailyRoom();
  oneStroke(ws);
  draw.handleUndo(ws);
  assert.strictEqual(lastState(sent).left, 1, "撤了就还你");
  const again = oneStroke(ws);
  assert.ok(room.strokes.some((s) => s.id === again && !s.hidden), "还回来的那一笔能画");
});

test("daily: redo cannot sneak in a second stroke", () => {
  const { room, ws, sent } = dailyRoom();
  oneStroke(ws);
  draw.handleUndo(ws);
  oneStroke(ws); // 用掉还回来的额度
  sent.length = 0;
  draw.handleRedo(ws);
  assert.ok(sent.some((m) => m.type === "error"), "重做被拦下了");
  assert.strictEqual(room.strokes.filter((s) => !s.hidden).length, 1);
});

test("daily: a new day brings a new stroke, and yesterday's cannot be undone", () => {
  const { room, ws, sent } = dailyRoom();
  const yesterday = oneStroke(ws);
  fakeNow += DAY;
  modes.apiFor(room).announce();
  assert.strictEqual(lastState(sent).label, "第 2 天 · 今天这一笔还没落");

  sent.length = 0;
  draw.handleUndo(ws);
  assert.match(sent.find((m) => m.type === "error").message, /撤不掉/);
  assert.ok(room.strokes.some((s) => s.id === yesterday && !s.hidden), "昨天那笔还在墙上");

  oneStroke(ws);
  assert.strictEqual(lastState(sent).left, 0);
  fakeNow -= DAY;
});

test("daily: midnight is found in the configured zone, not the server's", () => {
  // 北京时间 23:30 → 离零点半小时，不管服务器在哪个时区
  const t = Date.parse("2026-09-23T23:30:00+08:00");
  assert.strictEqual(daily._msToNextDay(t), 30 * 60 * 1000);
});

test("daily: stopping lifts the limit and leaves the drawing", () => {
  const { room, ws } = dailyRoom();
  oneStroke(ws);
  modes.command(ws, { cmd: "stop" }); // ws 不是房主：不该停
  assert.strictEqual(room.mode && room.mode.id, "daily");
  room.hostId = "u1";
  modes.command(ws, { cmd: "stop" });
  assert.strictEqual(room.mode, null);
  oneStroke(ws);
  assert.strictEqual(room.strokes.length, 2, "玩法收了就随便画");
});

fs.rmSync(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
