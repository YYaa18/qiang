"use strict";

// 墙是横向卷轴：若干段横向拼接，每段 SEG_W×CANVAS_H，坐标全局连续
const SEG_W = 1600;
const CANVAS_H = 1000;
const MAX_SEGMENTS = 20;
const PAD = 24; // 视图四周留白（屏幕像素）
const EXTEND_GAP = 40; // 纸右缘到「接一段」按钮的距离（画布单位）
const EXTEND_W = 140;
const TEXT_FONT = '22px "PingFang SC","Microsoft YaHei",sans-serif';
const PEN_WIDTHS = [3, 8, 18];
const ERASER_WIDTHS = [8, 18, 36];
const NEUTRALS = ["#1A1A1A", "#FFFFFF", "#868E96"];
const STORAGE_ID = "qiang.clientId";
const STORAGE_NAME = "qiang.name";
// 笔画点允许超出纸面的余量（与服务端一致），canvas 会自然裁掉超出部分
const STROKE_MARGIN = 40;

const $ = (id) => document.getElementById(id);

const els = {
  lobby: $("lobby"),
  wall: $("wall"),
  nick: $("nick-input"),
  create: $("btn-create"),
  joinForm: $("join-form"),
  codeInput: $("code-input"),
  lobbyError: $("lobby-error"),
  roomCode: $("room-code"),
  copy: $("btn-copy"),
  presenceCount: $("presence-count"),
  lockBadge: $("lock-badge"),
  menuBtn: $("btn-menu"),
  menu: $("menu"),
  menuExport: $("menu-export"),
  menuLock: $("menu-lock"),
  menuClear: $("menu-clear"),
  menuRename: $("menu-rename"),
  kickHint: $("kick-hint"),
  toolbar: $("toolbar"),
  swatches: $("swatches"),
  undo: $("btn-undo"),
  redo: $("btn-redo"),
  fit: $("btn-fit"),
  desk: $("desk"),
  wrap: $("paper-wrap"),
  tiles: $("tiles"),
  extend: $("btn-extend"),
  cursors: $("cursors"),
  textBox: $("text-box"),
  chat: $("chat"),
  chatToggle: $("chat-toggle"),
  roster: $("roster"),
  log: $("log"),
  chatInput: $("chat-input"),
  conn: $("conn"),
  drawingHint: $("drawing-hint"),
  clearOverlay: $("clear-overlay"),
  clearCount: $("clear-count"),
  clearCancel: $("btn-clear-cancel"),
  overlay: $("overlay"),
  overlayText: $("overlay-text"),
  overlayBack: $("overlay-back"),
  toast: $("toast"),
};

const state = {
  clientId: null,
  name: "",
  code: null,
  you: null,
  users: [],
  strokes: [],
  live: new Map(),
  chat: [],
  locked: false,
  canUndo: false,
  canRedo: false,
  tool: "pen",
  size: 1,
  color: null,
  scale: 1,
  segments: 1,
  tiles: [],
  panX: 0,
  panY: 0,
  space: false,
  panning: false,
  drawing: false,
  current: null,
  pointBuf: [],
  ws: null,
  allowReconnect: true,
  reconnectTimer: null,
  cursorTimer: 0,
  lastCursor: 0,
  othersCursors: new Map(),
  clearDeadline: null,
  clearTick: null,
  replaced: false,
};

function getClientId() {
  let id = localStorage.getItem(STORAGE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_ID, id);
  }
  return id;
}

function loadName() {
  return localStorage.getItem(STORAGE_NAME) || "";
}

function saveName(name) {
  localStorage.setItem(STORAGE_NAME, name);
}

function pathCode() {
  const m = location.pathname.match(/^\/w\/([A-Za-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

function showLobbyError(text) {
  els.lobbyError.hidden = !text;
  els.lobbyError.textContent = text || "";
}

function toast(text) {
  els.toast.hidden = false;
  els.toast.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, 1600);
}

function showOverlay(text) {
  els.overlay.hidden = false;
  els.overlayText.textContent = text;
}

function hideOverlay() {
  els.overlay.hidden = true;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function wallW() {
  return state.segments * SEG_W;
}

function dpr() {
  return Math.max(1, window.devicePixelRatio || 1);
}

// 把上下文平移到第 i 段，之后直接用全局坐标作画
function tileTransform(ctx, i) {
  const r = dpr();
  ctx.setTransform(r, 0, 0, r, -i * SEG_W * r, 0);
}

function makeTileCanvas(i) {
  const c = document.createElement("canvas");
  c.width = Math.round(SEG_W * dpr());
  c.height = Math.round(CANVAS_H * dpr());
  tileTransform(c.getContext("2d"), i);
  return c;
}

function resetTiles() {
  els.tiles.innerHTML = "";
  state.tiles = [];
}

// 每段一组 canvas（纸 / 墨 / 正在画的笔），避开单张 canvas 的尺寸上限
function setupTiles() {
  while (state.tiles.length > state.segments) state.tiles.pop().root.remove();
  for (let i = state.tiles.length; i < state.segments; i++) {
    const root = document.createElement("div");
    root.className = "tile";
    root.style.left = `${i * SEG_W}px`;
    const tile = {
      i,
      root,
      paper: makeTileCanvas(i),
      ink: makeTileCanvas(i),
      live: makeTileCanvas(i),
      liveUsed: false,
    };
    root.append(tile.paper, tile.ink, tile.live);
    els.tiles.appendChild(root);
    state.tiles.push(tile);
    drawPaper(tile);
  }
  els.wrap.style.width = `${wallW()}px`;
  updateExtendUi();
}

function drawPaper(tile) {
  const ctx = tile.paper.getContext("2d");
  const x0 = tile.i * SEG_W;
  ctx.fillStyle = "#F3EDE2";
  ctx.fillRect(x0, 0, SEG_W, CANVAS_H);
  const img = ctx.getImageData(0, 0, tile.paper.width, tile.paper.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.9));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.7));
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "rgba(80,60,40,0.06)";
  ctx.lineWidth = 1;
  for (let y = 40; y < CANVAS_H; y += 47) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + SEG_W, y);
    ctx.stroke();
  }
  if (tile.i > 0) {
    // 段与段的接缝，像卷轴的粘接处
    ctx.save();
    ctx.strokeStyle = "rgba(80,60,40,0.16)";
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0);
    ctx.lineTo(x0 + 0.5, CANVAS_H);
    ctx.stroke();
    ctx.restore();
  }
}

const measureCtx = document.createElement("canvas").getContext("2d");

// 笔画的横向范围（画布单位），用来判断它落在哪几段
function strokeBox(s) {
  if (s.type === "text") {
    measureCtx.font = TEXT_FONT;
    return { x0: s.x, x1: s.x + measureCtx.measureText(s.text || "").width };
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of s.points || []) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
  }
  const h = (s.width || 0) / 2 + 1;
  return { x0: x0 - h, x1: x1 + h };
}

// 已落定的笔画不再变化，范围可以缓存
const boxCache = new WeakMap();
function cachedBox(s) {
  let b = boxCache.get(s);
  if (!b) {
    b = strokeBox(s);
    boxCache.set(s, b);
  }
  return b;
}

function tilesOf(s) {
  if (!s) return [];
  const b = strokeBox(s);
  const out = [];
  const a = Math.max(0, Math.floor(b.x0 / SEG_W));
  const z = Math.min(state.segments - 1, Math.floor(b.x1 / SEG_W));
  for (let i = a; i <= z; i++) out.push(i);
  return out;
}

function drawStroke(ctx, s) {
  if (!s || s.hidden) return;
  if (s.type === "text") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, wallW(), CANVAS_H);
    ctx.clip();
    ctx.fillStyle = s.color;
    ctx.font = TEXT_FONT;
    ctx.textBaseline = "top";
    ctx.fillText(s.text || "", s.x, s.y);
    ctx.restore();
    return;
  }
  const pts = s.points || [];
  if (!pts.length) return;
  ctx.save();
  if (s.type === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.fillStyle = "rgba(0,0,0,1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = s.width;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

// 重建墨层：which 为段号数组，不传则重建全部段。每段按 seq 从小到大重画落在该段的笔
function rebuildInk(which) {
  const idxs = which ? [...new Set(which)] : state.tiles.map((t) => t.i);
  if (!idxs.length) return;
  const list = state.strokes.filter((s) => !s.hidden).sort((a, b) => a.seq - b.seq);
  for (const i of idxs) {
    const tile = state.tiles[i];
    if (!tile) continue;
    const off = document.createElement("canvas");
    off.width = tile.ink.width;
    off.height = tile.ink.height;
    const octx = off.getContext("2d");
    tileTransform(octx, i);
    const lo = i * SEG_W;
    const hi = lo + SEG_W;
    for (const s of list) {
      const b = cachedBox(s);
      if (b.x1 < lo || b.x0 > hi) continue;
      drawStroke(octx, s);
    }
    const ctx = tile.ink.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }
  // 有人正在用橡皮时，活动层里存着墨层的副本，需要跟着刷新
  if (state.live.size || state.current) redrawLive();
}

function redrawLive() {
  const lives = [...state.live.values()].sort((a, b) => a.seq - b.seq);
  if (state.current && !state.live.has(state.current.id)) lives.push(state.current);
  const boxes = lives.map((s) => [s, strokeBox(s)]);
  for (const tile of state.tiles) {
    const lo = tile.i * SEG_W;
    const hi = lo + SEG_W;
    const here = boxes.filter(([, b]) => b.x1 >= lo && b.x0 <= hi).map(([s]) => s);
    if (!here.length && !tile.liveUsed) continue;
    const ctx = tile.live.getContext("2d");
    const erasing = here.some((s) => s.type === "eraser");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, tile.live.width, tile.live.height);
    // 橡皮要在墨上真擦：把墨层复制到活动层上擦，期间隐藏墨层
    if (erasing) ctx.drawImage(tile.ink, 0, 0);
    ctx.restore();
    tile.ink.style.visibility = erasing ? "hidden" : "";
    for (const s of here) drawStroke(ctx, s);
    tile.liveUsed = here.length > 0;
  }
  updateDrawingHint();
}

function updateDrawingHint() {
  const ids = new Set();
  for (const s of state.live.values()) ids.add(s.userId);
  if (state.current) ids.add(state.you && state.you.id);
  const names = [];
  for (const id of ids) {
    if (!id || (state.you && id === state.you.id)) continue;
    const u = state.users.find((x) => x.id === id);
    if (u) names.push(u.name);
  }
  els.drawingHint.textContent = names.length ? `${names.join("、")}落笔中` : "";
}

function heightFitScale() {
  const r = els.desk.getBoundingClientRect();
  return Math.max(0.05, (r.height - PAD * 2) / CANVAS_H);
}

// 纸 + 末端「接一段」按钮的总宽（画布单位）
function contentW() {
  return wallW() + (els.extend.hidden ? 0 : EXTEND_GAP + EXTEND_W);
}

// 最小可以缩到整条卷轴都看得见，最大 200%
function scaleLimits() {
  const r = els.desk.getBoundingClientRect();
  const fit = heightFitScale();
  const whole = (r.width - PAD * 2) / contentW();
  return { min: Math.max(0.05, Math.min(fit, whole)), max: Math.max(2, fit) };
}

function clampPan() {
  const r = els.desk.getBoundingClientRect();
  const w = contentW() * state.scale;
  const h = CANVAS_H * state.scale;
  if (w + PAD * 2 <= r.width) state.panX = (r.width - w) / 2;
  else state.panX = Math.min(PAD, Math.max(r.width - PAD - w, state.panX));
  if (h + PAD * 2 <= r.height) state.panY = (r.height - h) / 2;
  else state.panY = Math.min(PAD, Math.max(r.height - PAD - h, state.panY));
}

function applyView() {
  const { min, max } = scaleLimits();
  state.scale = Math.max(min, Math.min(max, state.scale));
  clampPan();
  els.wrap.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
}

// 进墙：纸的高度铺满屏幕，从卷轴最左端开始
function resetView() {
  state.scale = heightFitScale();
  state.panX = PAD;
  applyView();
}

// 回正：高度铺满，横向保持正在看的位置
function fitView() {
  const r = els.desk.getBoundingClientRect();
  const cx = (r.width / 2 - state.panX) / state.scale;
  state.scale = heightFitScale();
  state.panX = r.width / 2 - cx * state.scale;
  applyView();
}

// 自己接长后滑到卷轴末端
function glideToEnd() {
  const r = els.desk.getBoundingClientRect();
  state.panX = r.width - PAD - contentW() * state.scale;
  els.wrap.classList.add("gliding");
  applyView();
  clearTimeout(glideToEnd.t);
  glideToEnd.t = setTimeout(() => els.wrap.classList.remove("gliding"), 400);
}

function updateExtendUi() {
  const blocked = state.locked && !(state.you && state.you.isHost);
  els.extend.hidden = state.segments >= MAX_SEGMENTS || blocked;
  els.extend.style.left = `${wallW() + EXTEND_GAP}px`;
}

function toCanvas(e) {
  const r = els.wrap.getBoundingClientRect();
  if (!state.scale) return null;
  return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
}

function clip(p) {
  return {
    x: Math.max(0, Math.min(wallW(), p.x)),
    y: Math.max(0, Math.min(CANVAS_H, p.y)),
  };
}

function clipStroke(p) {
  return {
    x: Math.max(-STROKE_MARGIN, Math.min(wallW() + STROKE_MARGIN, p.x)),
    y: Math.max(-STROKE_MARGIN, Math.min(CANVAS_H + STROKE_MARGIN, p.y)),
  };
}

function insidePaper(p) {
  return p.x >= 0 && p.x <= wallW() && p.y >= 0 && p.y <= CANVAS_H;
}

function currentWidth() {
  return state.tool === "eraser" ? ERASER_WIDTHS[state.size] : PEN_WIDTHS[state.size];
}

function canDraw() {
  if (!state.you) return false;
  if (state.locked && !state.you.isHost) return false;
  return !!(state.ws && state.ws.readyState === WebSocket.OPEN);
}

function startStroke(p) {
  if (!canDraw()) return;
  const id = crypto.randomUUID();
  const stroke = {
    id,
    seq: 1e12,
    userId: state.you.id,
    type: state.tool === "eraser" ? "eraser" : "pen",
    color: state.tool === "eraser" ? "#000000" : state.color || state.you.color,
    width: currentWidth(),
    points: [p],
    hidden: false,
    t: Date.now(),
  };
  state.current = stroke;
  state.drawing = true;
  state.pointBuf = [];
  send({
    type: "stroke_start",
    id,
    strokeType: stroke.type,
    color: stroke.color,
    width: stroke.width,
    x: p.x,
    y: p.y,
  });
  redrawLive();
}

function moveStroke(p) {
  if (!state.drawing || !state.current) return;
  state.current.points.push(p);
  state.pointBuf.push(p);
  if (state.pointBuf.length >= 8) flushPoints();
  redrawLive();
}

function flushPoints() {
  if (!state.current || !state.pointBuf.length) return;
  send({ type: "stroke_point", id: state.current.id, points: state.pointBuf });
  state.pointBuf = [];
}

function endStroke() {
  if (!state.current) {
    state.drawing = false;
    return;
  }
  flushPoints();
  send({ type: "stroke_end", id: state.current.id });
  const done = state.current;
  state.current = null;
  state.drawing = false;
  if (!state.strokes.some((s) => s.id === done.id)) {
    state.strokes.push(done);
    rebuildInk(tilesOf(done));
  }
  redrawLive();
}

function cancelText() {
  els.textBox.hidden = true;
  els.textBox.value = "";
}

function commitText() {
  const text = els.textBox.value.replace(/\s+/g, " ").trim();
  const x = Number(els.textBox.dataset.x);
  const y = Number(els.textBox.dataset.y);
  cancelText();
  if (!text || !canDraw()) return;
  const id = crypto.randomUUID();
  const stroke = {
    id,
    seq: Date.now(),
    userId: state.you.id,
    type: "text",
    color: state.color,
    width: 22,
    text,
    x,
    y,
    hidden: false,
    t: Date.now(),
  };
  send({ type: "text_place", id, color: state.color, text, x, y });
  if (!state.strokes.some((s) => s.id === id)) {
    state.strokes.push(stroke);
    rebuildInk(tilesOf(stroke));
  }
}

function placeText(p) {
  if (!canDraw()) return;
  els.textBox.hidden = false;
  els.textBox.style.left = `${p.x}px`;
  els.textBox.style.top = `${p.y}px`;
  els.textBox.style.color = state.color;
  els.textBox.dataset.x = String(p.x);
  els.textBox.dataset.y = String(p.y);
  els.textBox.value = "";
  // pointerdown 之后浏览器处理 mousedown 会把焦点移回 body，所以延后聚焦
  setTimeout(() => els.textBox.focus(), 0);
}

function upsertStroke(stroke) {
  const i = state.strokes.findIndex((s) => s.id === stroke.id);
  if (i >= 0) state.strokes[i] = stroke;
  else state.strokes.push(stroke);
}

function applySnapshot(snap) {
  state.code = snap.code;
  state.users = snap.users || [];
  state.strokes = snap.strokes || [];
  state.chat = snap.chat || [];
  state.locked = !!snap.locked;
  state.you = snap.you;
  state.canUndo = !!(snap.you && snap.you.canUndo);
  state.canRedo = !!(snap.you && snap.you.canRedo);
  state.live.clear();
  state.current = null;
  state.drawing = false;
  if (state.you && state.you.color) {
    const allowed = new Set(
      [state.you.color, ...NEUTRALS].map((c) => c.toUpperCase())
    );
    if (!state.color || !allowed.has(String(state.color).toUpperCase())) {
      state.color = state.you.color;
    }
  }
  els.roomCode.textContent = snap.code;
  state.segments = Math.min(MAX_SEGMENTS, Math.max(1, Number(snap.segments) || 1));
  setupTiles();
  rebuildInk();
  redrawLive();
  renderChat(true);
  renderRoster();
  renderSwatches();
  renderTools();
  updateLockUi();
  updateStacks();
  if (snap.clearDeadline && snap.clearDeadline > Date.now()) {
    startClearUi(snap.clearDeadline);
  } else {
    stopClearUi();
  }
}

function renderTools() {
  document.documentElement.style.setProperty("--me", (state.you && state.you.color) || "#1A1A1A");
  els.toolbar.querySelectorAll(".tool").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === state.tool);
  });
  els.toolbar.querySelectorAll(".width-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.size) === state.size);
  });
  const host = !!(state.you && state.you.isHost);
  document.querySelectorAll(".host-only").forEach((el) => {
    el.hidden = !host;
  });
  els.menuLock.textContent = state.locked ? "解锁画布" : "锁定画布";
}

function renderSwatches() {
  const main = (state.you && state.you.color) || "#C43C3C";
  const colors = [main, ...NEUTRALS];
  els.swatches.innerHTML = "";
  for (const c of colors) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === "#FFFFFF" ? " white" : "");
    b.title = c;
    b.style.background = c;
    if (c.toUpperCase() === String(state.color).toUpperCase()) b.classList.add("active");
    b.addEventListener("click", () => {
      state.color = c;
      renderSwatches();
    });
    els.swatches.appendChild(b);
  }
}

function updateLockUi() {
  els.lockBadge.hidden = !state.locked;
  renderTools();
  updateExtendUi();
  applyView();
}

function updateStacks() {
  els.undo.disabled = !state.canUndo;
  els.redo.disabled = !state.canRedo;
}

function renderRoster() {
  els.roster.innerHTML = "";
  const n = state.users.length;
  els.presenceCount.textContent = `在场 ${n}/4`;
  for (const u of state.users) {
    const row = document.createElement("div");
    row.className = "person";
    const dot = document.createElement("span");
    dot.className = "pdot";
    dot.style.background = u.color;
    const name = document.createElement("span");
    name.textContent = u.name;
    row.appendChild(dot);
    row.appendChild(name);
    if (state.you && u.id === state.you.id) {
      const me = document.createElement("span");
      me.className = "me";
      me.textContent = "我";
      row.appendChild(me);
    } else if (state.you && state.you.isHost) {
      const k = document.createElement("button");
      k.type = "button";
      k.className = "kick-btn";
      k.textContent = "请离";
      k.addEventListener("click", () => send({ type: "kick", targetId: u.id }));
      row.appendChild(k);
    }
    els.roster.appendChild(row);
  }
}

function renderChat(full) {
  if (full) els.log.innerHTML = "";
  const start = full ? 0 : Math.max(0, els.log.childElementCount);
  const list = full ? state.chat : state.chat.slice(start);
  if (full) {
    for (const m of state.chat) appendMsg(m);
    els.log.scrollTop = els.log.scrollHeight;
    return;
  }
  for (const m of list) appendMsg(m);
}

function appendMsg(m) {
  const el = document.createElement("div");
  el.className = m.userId === "system" ? "msg sys" : "msg";
  if (m.userId !== "system") {
    const nick = document.createElement("span");
    nick.className = "nick";
    nick.style.color = m.color || "#1A1A1A";
    nick.textContent = m.name || "朋友";
    el.appendChild(nick);
  }
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = m.text;
  el.appendChild(body);
  els.log.appendChild(el);
  els.log.scrollTop = els.log.scrollHeight;
}

function setConn(text, kind) {
  els.conn.textContent = text;
  els.conn.className = kind || "";
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  setConn("连接中…", "");
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.addEventListener("open", () => {
    setConn("已连接", "ok");
    send({
      type: "join",
      code: state.code,
      name: state.name,
      clientId: state.clientId,
    });
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  ws.addEventListener("close", () => {
    if (ws !== state.ws || state.replaced) return;
    setConn("重连中", "bad");
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    /* close handler reconnects */
  });
}

function scheduleReconnect() {
  if (!state.allowReconnect || state.replaced) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => connect(), 800);
}

function onMessage(msg) {
  switch (msg.type) {
    case "snapshot":
      applySnapshot(msg);
      break;
    case "error":
      if (!els.wall.hidden && state.you) {
        toast(msg.message || "出错了");
      } else {
        goLobby(msg.message || "进不去");
      }
      break;
    case "replaced":
      state.replaced = true;
      state.allowReconnect = false;
      showOverlay(msg.message || "已在别处打开");
      break;
    case "kicked":
      state.allowReconnect = false;
      goLobby(msg.message || "你被请离了这面墙");
      break;
    case "presence":
      state.users = msg.users || [];
      pruneCursors();
      renderRoster();
      break;
    case "stroke_start": {
      const s = msg.stroke;
      if (!s) break;
      if (state.you && s.userId === state.you.id) {
        if (state.current && state.current.id === s.id) state.current.seq = s.seq;
        break;
      }
      state.live.set(s.id, s);
      redrawLive();
      break;
    }
    case "stroke_point": {
      const live = state.live.get(msg.id);
      if (live && msg.points) live.points.push(...msg.points);
      redrawLive();
      break;
    }
    case "stroke_end": {
      state.live.delete(msg.id);
      if (msg.stroke) upsertStroke(msg.stroke);
      if (state.current && state.current.id === msg.id) {
        state.current = null;
        state.drawing = false;
      }
      rebuildInk(tilesOf(msg.stroke));
      redrawLive();
      break;
    }
    case "text_place":
      if (msg.stroke) upsertStroke(msg.stroke);
      rebuildInk(tilesOf(msg.stroke));
      break;
    case "extend": {
      const before = state.segments;
      state.segments = Math.min(MAX_SEGMENTS, Math.max(1, Number(msg.segments) || 1));
      setupTiles();
      // 超出旧纸边的那点余量笔迹，现在落到了新段上
      const added = [];
      for (let i = before; i < state.segments; i++) added.push(i);
      rebuildInk(added);
      if (state.you && msg.userId === state.you.id) glideToEnd();
      else applyView();
      break;
    }
    case "undo": {
      const s = state.strokes.find((x) => x.id === msg.id);
      if (s) s.hidden = true;
      if (state.you && msg.userId === state.you.id) {
        state.canUndo = !!msg.canUndo;
        state.canRedo = !!msg.canRedo;
        updateStacks();
      }
      rebuildInk(tilesOf(s));
      break;
    }
    case "redo": {
      const s = state.strokes.find((x) => x.id === msg.id);
      if (s) s.hidden = false;
      if (state.you && msg.userId === state.you.id) {
        state.canUndo = !!msg.canUndo;
        state.canRedo = !!msg.canRedo;
        updateStacks();
      }
      rebuildInk(tilesOf(s));
      break;
    }
    case "stacks":
      if (typeof msg.canUndo === "boolean") state.canUndo = msg.canUndo;
      if (typeof msg.canRedo === "boolean") state.canRedo = msg.canRedo;
      updateStacks();
      break;
    case "cursor":
      showCursor(msg);
      break;
    case "chat":
      if (msg.message) {
        state.chat.push(msg.message);
        if (state.chat.length > 100) state.chat.splice(0, state.chat.length - 100);
        appendMsg(msg.message);
      }
      break;
    case "lock":
      state.locked = !!msg.locked;
      if (state.locked && state.you && !state.you.isHost) {
        if (state.drawing) endStroke();
        cancelText();
      }
      updateLockUi();
      break;
    case "clear_start":
      startClearUi(msg.deadline);
      break;
    case "clear_cancel":
      stopClearUi();
      break;
    case "clear_done":
      state.strokes = [];
      state.live.clear();
      state.current = null;
      state.canUndo = false;
      state.canRedo = false;
      stopClearUi();
      rebuildInk();
      redrawLive();
      updateStacks();
      break;
    default:
      break;
  }
}

function showCursor(msg) {
  if (state.you && msg.userId === state.you.id) return;
  const u = state.users.find((x) => x.id === msg.userId);
  let el = els.cursors.querySelector(`[data-id="${msg.userId}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = "cursor";
    el.dataset.id = msg.userId;
    el.innerHTML = `<div class="dotc"></div><div class="name"></div>`;
    els.cursors.appendChild(el);
  }
  const color = (u && u.color) || "#1A1A1A";
  el.querySelector(".dotc").style.background = color;
  el.querySelector(".name").textContent = (u && u.name) || "";
  el.querySelector(".name").style.color = color;
  el.style.left = `${msg.x}px`;
  el.style.top = `${msg.y}px`;
  el.classList.remove("idle");
  const prev = state.othersCursors.get(msg.userId);
  if (prev && prev.idleTimer) clearTimeout(prev.idleTimer);
  const idleTimer = setTimeout(() => el.classList.add("idle"), 3000);
  state.othersCursors.set(msg.userId, { idleTimer });
}

function pruneCursors() {
  const present = new Set(state.users.map((u) => u.id));
  for (const el of els.cursors.querySelectorAll(".cursor")) {
    const id = el.dataset.id;
    if (present.has(id)) continue;
    const c = state.othersCursors.get(id);
    if (c && c.idleTimer) clearTimeout(c.idleTimer);
    state.othersCursors.delete(id);
    el.remove();
  }
}

function startClearUi(deadline) {
  state.clearDeadline = deadline;
  els.clearOverlay.hidden = false;
  tickClear();
  clearInterval(state.clearTick);
  state.clearTick = setInterval(tickClear, 200);
}

function tickClear() {
  if (!state.clearDeadline) return;
  const remain = Math.max(0, Math.ceil((state.clearDeadline - Date.now()) / 1000));
  els.clearCount.textContent = String(remain);
}

function stopClearUi() {
  state.clearDeadline = null;
  clearInterval(state.clearTick);
  els.clearOverlay.hidden = true;
}

function inputFocused() {
  const a = document.activeElement;
  return a === els.chatInput || a === els.textBox || a === els.nick || a === els.codeInput;
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    cancelText();
    state.space = false;
    els.desk.classList.remove("panning", "dragging");
    els.menu.hidden = true;
    return;
  }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && (e.key === "z" || e.key === "Z")) {
    if (inputFocused()) return;
    e.preventDefault();
    if (e.shiftKey) send({ type: "redo" });
    else send({ type: "undo" });
    return;
  }
  if (meta && (e.key === "y" || e.key === "Y")) {
    if (inputFocused()) return;
    e.preventDefault();
    send({ type: "redo" });
    return;
  }
  if (inputFocused()) return;
  if (e.code === "Space") {
    e.preventDefault();
    state.space = true;
    els.desk.classList.add("panning");
    return;
  }
  const k = e.key.toLowerCase();
  if (k === "b" || k === "p") {
    state.tool = "pen";
    renderTools();
  } else if (k === "e") {
    state.tool = "eraser";
    renderTools();
  } else if (k === "t") {
    state.tool = "text";
    renderTools();
  } else if (k === "[") {
    state.size = Math.max(0, state.size - 1);
    renderTools();
  } else if (k === "]") {
    state.size = Math.min(2, state.size + 1);
    renderTools();
  }
}

function onKeyUp(e) {
  if (e.code === "Space") {
    state.space = false;
    if (!state.panning) els.desk.classList.remove("panning", "dragging");
  }
}

function onPointerDown(e) {
  if (e.target === els.textBox) return;
  if (!els.textBox.hidden) {
    if (els.textBox.value.trim()) commitText();
    else cancelText();
  }
  if (e.button === 1 || (e.button === 0 && state.space)) {
    e.preventDefault();
    state.panning = true;
    state.panStart = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    els.desk.classList.add("panning", "dragging");
    els.desk.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const p0 = toCanvas(e);
  if (!p0 || !insidePaper(p0)) return;
  const p = clip(p0);
  if (state.tool === "text") {
    e.preventDefault();
    placeText(p);
    return;
  }
  startStroke(p);
  els.desk.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (state.panning && state.panStart) {
    state.panX = state.panStart.px + (e.clientX - state.panStart.x);
    state.panY = state.panStart.py + (e.clientY - state.panStart.y);
    applyView();
    return;
  }
  const p0 = toCanvas(e);
  if (!p0) return;
  const now = Date.now();
  if (now - state.lastCursor >= 50) {
    state.lastCursor = now;
    const c = clip(p0);
    send({ type: "cursor", x: c.x, y: c.y });
  }
  if (state.drawing) moveStroke(clipStroke(p0));
}

function onPointerUp(e) {
  if (state.panning) {
    state.panning = false;
    els.desk.classList.remove("dragging");
    if (!state.space) els.desk.classList.remove("panning");
  }
  if (state.drawing) endStroke();
}

function onWheel(e) {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? els.desk.clientHeight : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd + 滚轮、触控板双指捏合：以鼠标为中心缩放
    const r = els.desk.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const cx = (mx - state.panX) / state.scale;
    const cy = (my - state.panY) / state.scale;
    const { min, max } = scaleLimits();
    state.scale = Math.max(min, Math.min(max, state.scale * Math.exp(-dy * 0.0015)));
    state.panX = mx - cx * state.scale;
    state.panY = my - cy * state.scale;
    applyView();
    return;
  }
  // 普通滚轮沿卷轴横向走；触控板双指滑动按手指方向平移
  let px = dx;
  let py = dy;
  const fitsV = CANVAS_H * state.scale + PAD * 2 <= els.desk.clientHeight;
  if (px === 0 && (e.shiftKey || fitsV)) {
    px = py;
    py = 0;
  }
  state.panX -= px;
  state.panY -= py;
  applyView();
}

async function exportPng() {
  const out = document.createElement("canvas");
  out.width = wallW();
  out.height = CANVAS_H;
  const ctx = out.getContext("2d");
  for (const t of state.tiles) {
    ctx.drawImage(t.paper, t.i * SEG_W, 0, SEG_W, CANVAS_H);
    ctx.drawImage(t.ink, t.i * SEG_W, 0, SEG_W, CANVAS_H);
  }
  const a = document.createElement("a");
  const t = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  a.download = `墙-${state.code || "WALL"}-${stamp}.png`;
  // 长卷轴的 PNG 可能有几十 MB，用 Blob 而不是 data URL
  out.toBlob((blob) => {
    if (!blob) {
      toast("导出失败");
      return;
    }
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, "image/png");
}

function showLobby() {
  els.wall.hidden = true;
  els.lobby.hidden = false;
  state.allowReconnect = false;
}

function goLobby(err) {
  state.allowReconnect = false;
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* ignore */
    }
  }
  history.replaceState(null, "", "/");
  els.wall.hidden = true;
  els.lobby.hidden = false;
  hideOverlay();
  showLobbyError(err || "");
  document.title = "墙";
}

function enterWall(code) {
  state.code = code.toUpperCase();
  state.allowReconnect = true;
  state.replaced = false;
  state.name = (els.nick.value || loadName() || "朋友").trim().slice(0, 16);
  saveName(state.name);
  els.lobby.hidden = true;
  els.wall.hidden = false;
  hideOverlay();
  document.title = `墙 ${state.code}`;
  resetTiles();
  state.segments = 1;
  setupTiles();
  resetView();
  renderTools();
  connect();
}

async function createRoom() {
  showLobbyError("");
  state.clientId = getClientId();
  state.name = (els.nick.value || "朋友").trim().slice(0, 16) || "朋友";
  saveName(state.name);
  els.nick.value = state.name;
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: state.clientId }),
    });
    const data = await res.json();
    if (!res.ok || !data.code) {
      showLobbyError(data.error || "砌墙失败");
      return;
    }
    history.pushState(null, "", `/w/${data.code}`);
    enterWall(data.code);
  } catch {
    showLobbyError("砌墙失败，请检查网络");
  }
}

function tryJoinFromForm(e) {
  if (e) e.preventDefault();
  const code = els.codeInput.value.trim().toUpperCase();
  if (!code) {
    showLobbyError("请输入房间码");
    return;
  }
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)) {
    showLobbyError("没有这面墙");
    return;
  }
  showLobbyError("");
  if (location.pathname !== `/w/${code}`) history.pushState(null, "", `/w/${code}`);
  enterWall(code);
}

function bindUi() {
  els.nick.value = loadName();
  els.create.addEventListener("click", createRoom);
  els.nick.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && els.codeInput.value.trim()) tryJoinFromForm(e);
  });
  els.joinForm.addEventListener("submit", tryJoinFromForm);
  els.copy.addEventListener("click", async () => {
    const url = `${location.origin}/w/${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("已复制链接");
    } catch {
      toast(url);
    }
  });
  els.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.menu.hidden = !els.menu.hidden;
  });
  document.addEventListener("click", () => {
    els.menu.hidden = true;
  });
  els.menu.addEventListener("click", (e) => e.stopPropagation());
  els.menuExport.addEventListener("click", () => {
    els.menu.hidden = true;
    exportPng();
  });
  els.menuLock.addEventListener("click", () => {
    els.menu.hidden = true;
    send({ type: state.locked ? "unlock" : "lock" });
  });
  els.menuClear.addEventListener("click", () => {
    els.menu.hidden = true;
    send({ type: "clear_start" });
  });
  els.menuRename.addEventListener("click", () => {
    els.menu.hidden = true;
    const n = prompt("怎么称呼你", state.name || "");
    if (n == null) return;
    state.name = n.trim().slice(0, 16) || "朋友";
    saveName(state.name);
    els.nick.value = state.name;
    send({ type: "rename", name: state.name });
  });
  els.clearCancel.addEventListener("click", () => send({ type: "clear_cancel" }));
  els.overlayBack.addEventListener("click", () => goLobby(""));
  els.toolbar.querySelectorAll(".tool").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tool = btn.dataset.tool;
      renderTools();
    });
  });
  els.toolbar.querySelectorAll(".width-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.size = Number(btn.dataset.size);
      renderTools();
    });
  });
  els.undo.addEventListener("click", () => send({ type: "undo" }));
  els.redo.addEventListener("click", () => send({ type: "redo" }));
  els.fit.addEventListener("click", fitView);
  els.extend.addEventListener("click", () => send({ type: "extend" }));
  els.chatToggle.addEventListener("click", () => {
    els.chat.classList.toggle("chat-closed");
    els.chat.classList.toggle("chat-open");
    els.chatToggle.textContent = els.chat.classList.contains("chat-closed") ? "›" : "‹";
    els.chatToggle.title = els.chat.classList.contains("chat-closed") ? "打开聊天" : "折叠聊天";
    fitView();
  });
  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text) return;
      send({ type: "chat", text: text.slice(0, 200) });
      els.chatInput.value = "";
    }
  });
  els.textBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitText();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelText();
    }
  });
  els.desk.addEventListener("pointerdown", onPointerDown);
  els.desk.addEventListener("pointermove", onPointerMove);
  els.desk.addEventListener("pointerup", onPointerUp);
  els.desk.addEventListener("pointercancel", onPointerUp);
  els.desk.addEventListener("wheel", onWheel, { passive: false });
  els.desk.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", () => {
    if (!els.wall.hidden) fitView();
  });
  window.addEventListener("popstate", boot);
}

function boot() {
  state.clientId = getClientId();
  els.nick.value = loadName();
  const code = pathCode();
  if (code && loadName()) {
    enterWall(code);
  } else if (code) {
    // 第一次通过链接进来：先填昵称，再推门
    showLobby();
    els.codeInput.value = code;
    showLobbyError("先告诉大家怎么称呼你，再推门");
    els.nick.focus();
  } else {
    els.wall.hidden = true;
    els.lobby.hidden = false;
    state.allowReconnect = false;
    if (state.ws) {
      try {
        state.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

bindUi();
boot();
