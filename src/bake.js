"use strict";

// ───────────── 冻结：旧笔画烘焙成每段一张墨迹图 ─────────────
//
// 一笔足够旧（不在最新 LIVE_KEEP 笔里）就可以冻结：由一个在线客户端用同一套绘制代码
// 把它画进所在段的墨迹图（透明 PNG）并上传。冻结的是一整段 seq 前缀，所以叠放顺序不变。
// 矢量存档永久留在磁盘上：撤销/重做一笔已冻结的笔时，从存档把受影响的段整段重画。

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const {
  DATA_DIR,
  SEG_W,
  LIVE_KEEP,
  BAKE_BATCH,
  BAKE_TIMEOUT_MS,
  BAKE_RETRY_MS,
  BAKE_RETRY_MAX_MS,
  BAKE_GIVE_UP,
  BAKE_MAX_BYTES,
} = require("./config");
const { send, broadcast } = require("./net");
const { rooms, saveRoomNow } = require("./store");

function roomDir(room) {
  return path.join(DATA_DIR, room.code);
}

// 存档按段分文件：重画某一段时只读那一段，不必翻完整个房间的历史。
// archive.jsonl 是早期的整包存档，只读不写，老房间的数据仍然有效。
function segArchiveFile(room, seg) {
  return path.join(roomDir(room), `archive-${seg}.jsonl`);
}

function legacyArchiveFile(room) {
  return path.join(roomDir(room), "archive.jsonl");
}

function segFile(room, seg, version) {
  return path.join(roomDir(room), `seg-${seg}-${version}.png`);
}

// 笔画横跨哪几段。服务端量不了字宽，文字按每字 22px 从宽估计——多算一段没关系
function segsOf(room, s) {
  let x0;
  let x1;
  if (s.type === "text") {
    x0 = s.x;
    x1 = s.x + [...(s.text || "")].length * 22;
  } else {
    x0 = Infinity;
    x1 = -Infinity;
    for (const p of s.points || []) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
    }
    const h = (s.width || 0) * 0.8 + 1; // 笔锋、马克笔会比标称粗细更宽
    x0 -= h;
    x1 += h;
  }
  const out = [];
  const a = Math.max(0, Math.floor(x0 / SEG_W));
  const z = Math.min(room.segments - 1, Math.floor(x1 / SEG_W));
  for (let i = a; i <= z; i++) out.push(i);
  return out;
}

function stackedIds(room) {
  const ids = new Set();
  for (const st of Object.values(room.stacks)) {
    for (const id of st.undo) ids.add(id);
    for (const id of st.redo) ids.add(id);
  }
  return ids;
}

// 撤销/重做一笔已冻结的笔：记下隐藏状态，所在段排队整段重画
function setFrozenHidden(room, id, hidden) {
  const segs = room.frozenIndex[id];
  if (!segs) return;
  if (hidden) room.hiddenFrozen.add(id);
  else room.hiddenFrozen.delete(id);
  for (const seg of segs) room.dirtyFull.add(seg);
}

// 任务进行中，参与冻结的笔被撤销/重做，或要重画的段又变了：作废重来
function touchJob(room, id) {
  const job = room.job;
  if (!job) return;
  if (job.kind === "delta" && job.ids.has(id)) abortJob(room, "stroke changed");
  else if (job.kind === "full" && (room.frozenIndex[id] || []).some((seg) => job.tasks.has(seg))) {
    abortJob(room, "segment changed");
  }
}

// 烘焙要在客户端把一段画成 2 倍分辨率的 PNG，手机干这活会明显卡一下。
// 有电脑在场就让电脑烘，实在只剩手机了才用手机——总比不烘好。
function pickBaker(room) {
  const online = [...room.users.values()].filter((u) => u.ws && u.ws.readyState === 1);
  if (!online.length) return null;
  const strong = online.filter((u) => !u.weak);
  const pool = strong.length ? strong : online;
  return pool.find((u) => u.id === room.hostId) || pool[0];
}

// 存档只会越来越大，所以一行一行地读，而且必须是异步的：
// 同步读会把整个进程——所有房间——一起卡住。
async function eachArchiveLine(file, onStroke) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let st;
      try {
        st = JSON.parse(line);
      } catch {
        continue; // 半行（崩溃时写到一半）直接跳过
      }
      if (st && st.id) onStroke(st);
    }
  } finally {
    rl.close();
  }
}

// 整段重画要用到的笔：这一段自己的存档，外加老版本整包存档里落在这一段的
async function readSegArchive(room, seg) {
  const out = [];
  const seen = new Set();
  const take = (st) => {
    if (seen.has(st.id)) return;
    if (st.seq > room.frozenUpTo || room.hiddenFrozen.has(st.id)) return;
    seen.add(st.id);
    out.push(st);
  };
  await eachArchiveLine(segArchiveFile(room, seg), take);
  await eachArchiveLine(legacyArchiveFile(room), (st) => {
    if (segsOf(room, st).includes(seg)) take(st);
  });
  out.sort((a, b) => a.seq - b.seq); // 叠放顺序必须按 seq，不能按文件里的先后
  return out;
}

function maybeBake(room) {
  if (room.job || room.loadingFull) return;
  const baker = pickBaker(room);
  if (!baker) return;
  if (room.dirtyFull.size) {
    startFullJob(room, baker).catch((err) => {
      room.loadingFull = false;
      console.error("full bake failed", room.code, err.message);
    });
    return;
  }
  if (room.strokes.length <= LIVE_KEEP + BAKE_BATCH) return;
  const sorted = [...room.strokes].sort((a, b) => a.seq - b.seq);
  let cutoff = sorted[sorted.length - LIVE_KEEP - 1].seq;
  // 还在画的笔 seq 更小的话，冻结线不能越过它，否则它落定后会压在更新的笔上面
  for (const o of room.open.values()) cutoff = Math.min(cutoff, o.seq - 1);
  const frozen = sorted.filter((st) => st.seq <= cutoff);
  if (!frozen.length) return;
  const tasks = new Map();
  for (const st of frozen) {
    for (const seg of segsOf(room, st)) {
      if (!tasks.has(seg)) tasks.set(seg, []);
      tasks.get(seg).push(st);
    }
  }
  startJob(room, baker, "delta", tasks, { cutoff, frozen, ids: new Set(frozen.map((st) => st.id)) });
}

async function startFullJob(room, baker) {
  const segs = [...room.dirtyFull];
  room.dirtyFull.clear();
  const giveBack = () => {
    for (const seg of segs) room.dirtyFull.add(seg);
  };
  const tasks = new Map();
  room.loadingFull = true;
  try {
    for (const seg of segs) tasks.set(seg, await readSegArchive(room, seg));
  } catch (err) {
    console.error("read archive failed", room.code, err.message);
    giveBack();
    return;
  } finally {
    room.loadingFull = false;
  }
  // 读盘要花时间，期间房间可能已经被清空、被请出内存，或者烘焙的人已经走了
  if (rooms.get(room.code) !== room || room.job) {
    giveBack();
    return;
  }
  const still = room.users.get(baker.id);
  if (!still || !still.ws || still.ws.readyState !== 1) {
    giveBack();
    return;
  }
  startJob(room, baker, "full", tasks, { segs });
}

function startJob(room, baker, kind, tasks, extra) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    baker: baker.id,
    tasks,
    files: new Map(),
    timer: setTimeout(() => abortJob(room, "timeout"), BAKE_TIMEOUT_MS),
    ...extra,
  };
  room.job = job;
  for (const [seg, strokes] of tasks) {
    send(baker.ws, {
      type: "bake",
      job: job.id,
      seg,
      mode: kind,
      baseVersion: kind === "delta" ? room.segVersions[seg] || 0 : 0,
      strokes: strokes.map((st) => (st.hidden ? null : st)).filter(Boolean),
    });
  }
}

function abortJob(room, reason) {
  const job = room.job;
  if (!job) return;
  clearTimeout(job.timer);
  for (const file of job.files.values()) fs.rmSync(file, { force: true });
  if (job.kind === "full") for (const seg of job.segs) room.dirtyFull.add(seg);
  room.job = null;
  if (reason === "cleared") return;
  // 烘不出来就往后退一步再试，别一秒一次地空转。连着失败太多次就先搁着，
  // 等有人推门进来（可能是台更合适的机器）再重新开始。
  room.bakeFails += 1;
  if (room.bakeFails > BAKE_GIVE_UP) {
    console.error("bake gave up", room.code, reason);
    return;
  }
  const wait = Math.min(BAKE_RETRY_MS * 2 ** (room.bakeFails - 1), BAKE_RETRY_MAX_MS);
  clearTimeout(room.bakeTimer);
  room.bakeTimer = setTimeout(() => {
    room.bakeTimer = null;
    maybeBake(room);
  }, wait);
  room.bakeTimer.unref?.();
}

// 来了新人就当是新机会：把之前攒的失败次数清零，重新试一次
function retryBake(room) {
  room.bakeFails = 0;
  clearTimeout(room.bakeTimer);
  room.bakeTimer = null;
  maybeBake(room);
}

async function handleBakeUpload(req, res, room, seg, jobId) {
  const job = room.job;
  if (!job || job.id !== jobId || !job.tasks.has(seg) || job.files.has(seg)) {
    res.writeHead(409);
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BAKE_MAX_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!body.subarray(0, 8).equals(PNG_SIG)) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (room.job !== job) {
    // 上传途中任务被作废了
    res.writeHead(409);
    res.end();
    return;
  }
  fs.mkdirSync(roomDir(room), { recursive: true });
  const version = (room.segVersions[seg] || 0) + 1;
  const file = segFile(room, seg, version);
  fs.writeFileSync(`${file}.tmp`, body);
  fs.renameSync(`${file}.tmp`, file);
  job.files.set(seg, file);
  res.writeHead(204);
  res.end();
  if (job.files.size === job.tasks.size) commitJob(room, job);
}

function commitJob(room, job) {
  clearTimeout(job.timer);
  room.job = null;
  const versions = {};
  for (const seg of job.tasks.keys()) {
    const old = room.segVersions[seg] || 0;
    if (old) fs.rmSync(segFile(room, seg, old), { force: true });
    room.segVersions[seg] = old + 1;
    versions[seg] = old + 1;
  }
  if (job.kind === "delta") {
    // 先追加存档，再改元数据：中途崩溃最多在存档里多一份重复的笔，重画时无害
    const stacked = stackedIds(room);
    const bySeg = new Map();
    for (const st of job.frozen) {
      const line = JSON.stringify(st);
      const segs = segsOf(room, st);
      for (const seg of segs) {
        if (!bySeg.has(seg)) bySeg.set(seg, []);
        bySeg.get(seg).push(line);
      }
      if (st.hidden) room.hiddenFrozen.add(st.id);
      if (stacked.has(st.id)) room.frozenIndex[st.id] = segs;
    }
    fs.mkdirSync(roomDir(room), { recursive: true });
    for (const [seg, lines] of bySeg) {
      fs.appendFileSync(segArchiveFile(room, seg), lines.join("\n") + "\n");
    }
    for (const id of Object.keys(room.frozenIndex)) if (!stacked.has(id)) delete room.frozenIndex[id];
    room.strokes = room.strokes.filter((st) => !job.ids.has(st.id));
    room.frozenUpTo = job.cutoff;
  }
  room.bakeFails = 0;
  saveRoomNow(room);
  broadcast(room, { type: "baked", upTo: room.frozenUpTo, versions });
  maybeBake(room);
}

module.exports = {
  roomDir,
  segFile,
  segsOf,
  setFrozenHidden,
  touchJob,
  maybeBake,
  retryBake,
  abortJob,
  handleBakeUpload,
};
