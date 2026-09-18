"use strict";

// 墙是横向卷轴：若干段横向拼接，每段 SEG_W×CANVAS_H，坐标全局连续
const SEG_W = 1600;
const CANVAS_H = 1000;
const MAX_SEGMENTS = 500; // 与服务端一致：只是防滥用的保险值
const BAKE_SCALE = 2; // 墨迹图按 2 倍分辨率烘焙，Retina 上也清楚
const PAD = 24; // 视图四周留白（屏幕像素）
const EXTEND_GAP = 40; // 纸右缘到「接一段」按钮的距离（画布单位）
const EXTEND_W = 140;
const TEXT_FONT = '22px "PingFang SC","Microsoft YaHei",sans-serif';
const PEN_WIDTHS = [3, 8, 18];
const ERASER_WIDTHS = [8, 18, 36];
const NEUTRALS = ["#1A1A1A", "#FFFFFF", "#868E96"];
// 主色用于色点和笔迹；写成文字时换成更深一档，保证在浅底上可读（对比度 ≥ 4.5）
const TEXT_COLOR = {
  "#C43C3C": "#B03030",
  "#3B5BDB": "#3552C8",
  "#2F9E44": "#1E7032",
  "#E67700": "#945000",
};
// 调色板预设：在暖白纸上都好看的 24 色（名字用于悬浮提示）
const PRESETS = [
  ["#C92A2A", "深红"], ["#E03131", "红"], ["#F76707", "橙"], ["#F59F00", "琥珀"], ["#FCC419", "黄"], ["#A0522D", "赭"],
  ["#2B8A3E", "深绿"], ["#40C057", "绿"], ["#82C91E", "草绿"], ["#0CA678", "青绿"], ["#1098AD", "青"], ["#3BC9DB", "浅青"],
  ["#1864AB", "深蓝"], ["#3B5BDB", "靛"], ["#4DABF7", "天蓝"], ["#7048E8", "紫"], ["#AE3EC9", "品紫"], ["#E64980", "粉"],
  ["#1A1A1A", "墨"], ["#495057", "深灰"], ["#868E96", "灰"], ["#CED4DA", "浅灰"], ["#FFFFFF", "白"], ["#F3D9B1", "米黄"],
];
const LIGHT = new Set(["#FFFFFF", "#CED4DA", "#F3D9B1", "#FCC419", "#3BC9DB"]);
const STORAGE_RECENT = "qiang.recentColors";
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
  seats: $("seats"),
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
  btnPalette: $("btn-palette"),
  palette: $("palette"),
  palGrid: $("pal-grid"),
  palRecent: $("pal-recent"),
  palPicker: $("pal-picker"),
  palHex: $("pal-hex"),
  palCurrent: $("pal-current"),
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
  chatRail: $("chat-rail"),
  unread: $("unread"),
  newMsg: $("new-msg"),
  chatCount: $("chat-count"),
  segLabel: $("seg-label"),
  segTrack: $("seg-track"),
  segView: $("seg-view"),
  scrollNav: $("scroll-nav"),
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
  leave: $("btn-leave"),
  chatMobile: $("btn-chat-mobile"),
  unreadM: $("unread-m"),
  menuCopy: $("menu-copy"),
  tip: $("tip"),
  arrivals: $("arrivals"),
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
  tiles: new Map(), // 段号 → 已建出画布的段（只有屏幕附近几段）
  frozenUpTo: 0, // seq ≤ 这个值的笔已烘焙进各段墨迹图
  segVersions: {}, // 段号 → 墨迹图版本
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
  chatOpen: true,
  unread: 0,
  custom: null, // 最近一次用的自定义色，工具条上留一格方便切回
  knownIds: new Set(), // 已在墙上的人，用来判断谁是新来的
  arrivedAt: new Map(),
};

// crypto.randomUUID 只在 HTTPS / localhost 下可用；用 http://IP 访问时自己拼一个 v4 UUID
function uuid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getClientId() {
  let id = localStorage.getItem(STORAGE_ID);
  if (!id) {
    id = uuid();
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

function textColor(c) {
  return TEXT_COLOR[String(c || "").toUpperCase()] || c || "#1A1A1A";
}

function showLobbyError(text, kind = "error") {
  els.lobbyError.hidden = !text;
  els.lobbyError.className = kind;
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

function makeInkCanvas(i) {
  const c = document.createElement("canvas");
  c.width = Math.round(SEG_W * dpr());
  c.height = Math.round(CANVAS_H * dpr());
  tileTransform(c.getContext("2d"), i);
  return c;
}

// 纸纹理全墙共用一张 1x 的图，作为每段的 CSS 背景；导出时也用它
let paperCanvas = null;
function makePaper() {
  if (paperCanvas) return;
  const c = document.createElement("canvas");
  c.width = SEG_W;
  c.height = CANVAS_H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#F3EDE2";
  ctx.fillRect(0, 0, SEG_W, CANVAS_H);
  const img = ctx.getImageData(0, 0, SEG_W, CANVAS_H);
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
    ctx.moveTo(0, y);
    ctx.lineTo(SEG_W, y);
    ctx.stroke();
  }
  paperCanvas = c;
  c.toBlob((blob) => {
    if (blob) document.documentElement.style.setProperty("--paper-img", `url(${URL.createObjectURL(blob)})`);
  });
}

function resetTiles() {
  els.tiles.innerHTML = "";
  state.tiles = new Map();
}

// 段数变化时调用：更新纸宽，再按视野补建 / 回收画布
function setupTiles() {
  makePaper();
  for (const [i, t] of state.tiles) {
    if (i >= state.segments) {
      t.root.remove();
      state.tiles.delete(i);
    }
  }
  els.wrap.style.width = `${wallW()}px`;
  updateExtendUi();
  syncTiles();
}

function visibleRange() {
  const deskW = els.desk.clientWidth || window.innerWidth;
  const x0 = -state.panX / state.scale;
  const x1 = (deskW - state.panX) / state.scale;
  return [Math.floor(x0 / SEG_W), Math.floor(x1 / SEG_W)];
}

// 画布只给屏幕附近的几段：看得见的 ±1 段建出来，±2 段以外释放（Retina 上每段墨层约 26MB）
function syncTiles() {
  const n = state.segments;
  const [a, z] = visibleRange();
  for (const [i, t] of state.tiles) {
    if (i < a - 2 || i > z + 2 || i >= n) {
      t.root.remove();
      state.tiles.delete(i);
    }
  }
  const fresh = [];
  for (let i = Math.max(0, a - 1); i <= Math.min(n - 1, z + 1); i++) {
    if (state.tiles.has(i)) continue;
    const root = document.createElement("div");
    root.className = "tile" + (i > 0 ? " seam" : "");
    root.style.left = `${i * SEG_W}px`;
    const tile = { i, root, ink: makeInkCanvas(i), live: null, liveUsed: false, base: null, baseV: 0, baseUpTo: 0, loadingV: 0 };
    root.appendChild(tile.ink);
    els.tiles.appendChild(root);
    state.tiles.set(i, tile);
    ensureBase(tile);
    fresh.push(i);
  }
  if (fresh.length) rebuildInk(fresh);
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
    // 过相邻两点的中点画二次曲线，折线变圆滑；首尾仍落在真实的点上
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const end = pts[pts.length - 1];
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

function sortedStrokes() {
  return state.strokes.filter((s) => !s.hidden).sort((a, b) => a.seq - b.seq);
}

// 画出第 i 段：先铺墨迹图（已冻结的笔），再按 seq 叠上之后的矢量笔（ctx 已平移到该段）
function paintSegment(ctx, i, list, base = null, baseUpTo = 0) {
  const lo = i * SEG_W;
  const hi = lo + SEG_W;
  if (base) ctx.drawImage(base, lo, 0, SEG_W, CANVAS_H);
  for (const s of list) {
    if (base && s.seq <= baseUpTo) continue;
    const b = cachedBox(s);
    if (b.x1 < lo || b.x0 > hi) continue;
    drawStroke(ctx, s);
  }
}

// 重建墨层：which 为段号数组，不传则重建所有已建出的段
function rebuildInk(which) {
  const idxs = (which ? [...new Set(which)] : [...state.tiles.keys()]).filter((i) => state.tiles.has(i));
  if (!idxs.length) return;
  const list = sortedStrokes();
  for (const i of idxs) {
    const tile = state.tiles.get(i);
    const off = document.createElement("canvas");
    off.width = tile.ink.width;
    off.height = tile.ink.height;
    const octx = off.getContext("2d");
    tileTransform(octx, i);
    paintSegment(octx, i, list, tile.base, tile.baseUpTo);
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

function segImageUrl(seg, v) {
  return `/api/rooms/${state.code}/seg/${seg}.png?v=${v}`;
}

async function loadSegImage(seg, v) {
  const img = new Image();
  img.src = segImageUrl(seg, v);
  await img.decode();
  return img;
}

// 让这一段用上最新的墨迹图；图是异步加载的，加载完再重画这一段
function ensureBase(tile) {
  const v = state.segVersions[tile.i] || 0;
  if (v === tile.baseV || v === tile.loadingV) return;
  if (!v) {
    tile.base = null;
    tile.baseV = 0;
    tile.baseUpTo = 0;
    return;
  }
  tile.loadingV = v;
  const code = state.code;
  const upTo = state.frozenUpTo;
  loadSegImage(tile.i, v)
    .then((img) => {
      if (state.code !== code || state.tiles.get(tile.i) !== tile || state.segVersions[tile.i] !== v) return;
      tile.base = img;
      tile.baseV = v;
      tile.baseUpTo = upTo;
      tile.loadingV = 0;
      rebuildInk([tile.i]);
      pruneFrozen();
    })
    .catch(() => {
      tile.loadingV = 0;
    });
}

// 眼前各段的新墨迹图都到位后，再丢掉已冻结的矢量笔，避免画面闪一下
function pruneFrozen() {
  for (const t of state.tiles.values()) if (t.loadingV) return;
  state.strokes = state.strokes.filter((s) => s.seq > state.frozenUpTo);
}

// 服务端请本机帮忙烘焙：按同一套代码画好这一段的墨迹图并上传。一次一个，排队做
let bakeQueue = Promise.resolve();
function onBakeTask(task) {
  bakeQueue = bakeQueue.then(() => bakeSegment(task)).catch((err) => console.warn("bake failed", err));
}

async function bakeSegment(task) {
  const c = document.createElement("canvas");
  c.width = SEG_W * BAKE_SCALE;
  c.height = CANVAS_H * BAKE_SCALE;
  const ctx = c.getContext("2d");
  ctx.setTransform(BAKE_SCALE, 0, 0, BAKE_SCALE, -task.seg * SEG_W * BAKE_SCALE, 0);
  if (task.mode === "delta" && task.baseVersion) {
    const base = await loadSegImage(task.seg, task.baseVersion);
    ctx.drawImage(base, task.seg * SEG_W, 0, SEG_W, CANVAS_H);
  }
  for (const s of task.strokes.sort((a, b) => a.seq - b.seq)) drawStroke(ctx, s);
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  await fetch(`/api/rooms/${state.code}/seg/${task.seg}?job=${task.job}`, { method: "POST", body: blob });
}

function redrawLive() {
  const lives = [...state.live.values()].sort((a, b) => a.seq - b.seq);
  if (state.current && !state.live.has(state.current.id)) lives.push(state.current);
  const boxes = lives.map((s) => [s, strokeBox(s)]);
  for (const tile of state.tiles.values()) {
    const lo = tile.i * SEG_W;
    const hi = lo + SEG_W;
    const here = boxes.filter(([, b]) => b.x1 >= lo && b.x0 <= hi).map(([s]) => s);
    if (!here.length && !tile.liveUsed) continue;
    // 活动层用到时才建
    if (!tile.live) {
      tile.live = makeInkCanvas(tile.i);
      tile.root.appendChild(tile.live);
    }
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
  // 最多缩到同时看见约 3 段：再远就要同时建很多段画布，内存吃不消
  const three = r.width / (3 * SEG_W);
  return { min: Math.max(0.05, Math.min(fit, Math.max(whole, three))), max: Math.max(2, fit) };
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
  syncTiles();
  updateNav();
}

// 底栏卷轴导航：格子数 = 段数，框出当前看得见的范围
function updateNav() {
  const n = state.segments;
  if (els.segTrack.childElementCount - 1 !== n) {
    els.segTrack.querySelectorAll(".seg").forEach((el) => el.remove());
    for (let i = 0; i < n; i++) {
      const seg = document.createElement("div");
      seg.className = "seg";
      els.segTrack.insertBefore(seg, els.segView);
    }
  }
  const deskW = els.desk.clientWidth;
  const x0 = Math.max(0, -state.panX / state.scale);
  const x1 = Math.min(wallW(), (deskW - state.panX) / state.scale);
  els.segView.style.left = `${(x0 / wallW()) * 100}%`;
  els.segView.style.width = `${(Math.max(0, x1 - x0) / wallW()) * 100}%`;
  const at = Math.min(n, Math.max(1, Math.floor((x0 + x1) / 2 / SEG_W) + 1));
  els.segLabel.textContent = `第 ${at} / ${n} 段`;
}

function jumpTo(frac) {
  const deskW = els.desk.clientWidth;
  state.panX = deskW / 2 - frac * wallW() * state.scale;
  els.wrap.classList.add("gliding");
  applyView();
  clearTimeout(jumpTo.t);
  jumpTo.t = setTimeout(() => els.wrap.classList.remove("gliding"), 400);
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

// 手指落下后这么久内来了第二根手指，就当作双指手势：这一笔撤回，不发出去
const TOUCH_GRACE_MS = 120;

function startStroke(p, pending = false) {
  if (!canDraw()) return;
  const stroke = {
    id: uuid(),
    seq: 1e12,
    userId: state.you.id,
    type: state.tool === "eraser" ? "eraser" : "pen",
    color: state.tool === "eraser" ? "#000000" : state.color || state.you.color,
    width: currentWidth(),
    points: [p],
    hidden: false,
    t: Date.now(),
    pending,
  };
  state.current = stroke;
  state.drawing = true;
  state.pointBuf = [];
  if (pending) state.pendingTimer = setTimeout(commitPending, TOUCH_GRACE_MS);
  else sendStart(stroke);
  redrawLive();
}

function sendStart(stroke) {
  const [p] = stroke.points;
  send({ type: "stroke_start", id: stroke.id, strokeType: stroke.type, color: stroke.color, width: stroke.width, x: p.x, y: p.y });
}

// 触屏的一笔过了等待期还是单指：正式发出去，把攒下的点一并补上
function commitPending() {
  clearTimeout(state.pendingTimer);
  const s = state.current;
  if (!s || !s.pending) return;
  s.pending = false;
  sendStart(s);
  state.pointBuf = s.points.slice(1);
  flushPoints();
}

function cancelStroke() {
  clearTimeout(state.pendingTimer);
  state.current = null;
  state.drawing = false;
  state.pointBuf = [];
  redrawLive();
}

// 一次事件可能带来多个采样点（getCoalescedEvents）；太近的点丢掉，重绘合并到下一帧
function addPoints(pts) {
  const s = state.current;
  if (!state.drawing || !s) return;
  const minD = 0.75 / state.scale; // 屏幕上不到 0.75 像素的移动不记
  let last = s.points[s.points.length - 1];
  for (const p of pts) {
    if (Math.hypot(p.x - last.x, p.y - last.y) < minD) continue;
    s.points.push(p);
    if (!s.pending) state.pointBuf.push(p);
    last = p;
  }
  if (!s.pending && state.pointBuf.length >= 8) flushPoints();
  scheduleLive();
}

let liveFrame = 0;
function scheduleLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    redrawLive();
  });
}

function flushPoints() {
  if (!state.current || state.current.pending || !state.pointBuf.length) return;
  send({ type: "stroke_point", id: state.current.id, points: state.pointBuf });
  state.pointBuf = [];
}

function endStroke() {
  if (!state.current) {
    state.drawing = false;
    return;
  }
  if (state.current.pending) commitPending(); // 轻点一下也算一笔（一个点）
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
  const id = uuid();
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
  state.knownIds = new Set(state.users.map((u) => u.id));
  state.strokes = snap.strokes || [];
  state.chat = snap.chat || [];
  state.locked = !!snap.locked;
  state.you = snap.you;
  state.canUndo = !!(snap.you && snap.you.canUndo);
  state.canRedo = !!(snap.you && snap.you.canRedo);
  state.live.clear();
  state.current = null;
  state.drawing = false;
  if (state.you && state.you.color && !isHex(state.color)) {
    state.color = state.you.color;
  }
  els.roomCode.textContent = snap.code;
  state.frozenUpTo = Number(snap.frozenUpTo) || 0;
  state.segVersions = snap.segVersions || {};
  for (const t of state.tiles.values()) ensureBase(t);
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

function isHex(c) {
  return /^#[0-9A-F]{6}$/i.test(String(c || ""));
}

function baseColors() {
  return [(state.you && state.you.color) || "#C43C3C", ...NEUTRALS];
}

function swatchButton(c, cls, title, desc) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls + (LIGHT.has(c) ? " light white" : "");
  if (desc) {
    b.dataset.tip = title;
    b.dataset.desc = desc;
  } else {
    b.title = title;
  }
  b.setAttribute("aria-label", title);
  b.style.background = c;
  if (c === String(state.color).toUpperCase()) b.classList.add("active");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    setColor(c);
    if (cls === "pal-sw") closePalette();
  });
  return b;
}

// 工具条：本人主色 + 黑白灰，外加最近一次的自定义色
function renderSwatches() {
  const base = baseColors();
  const names = ["我的颜色", "墨", "白", "灰"];
  const descs = [`${base[0]} · 和你的名字同色`, "#1A1A1A", "#FFFFFF · 涂白，盖住下面的笔迹", "#868E96"];
  els.swatches.innerHTML = "";
  base.forEach((c, i) => els.swatches.appendChild(swatchButton(c, "swatch", names[i], descs[i])));
  if (state.custom && !base.includes(state.custom)) {
    els.swatches.appendChild(swatchButton(state.custom, "swatch", "刚用过的颜色", state.custom));
  }
  if (!els.palette.hidden) renderPalette();
}

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_RECENT) || "[]");
    return Array.isArray(list) ? list.filter(isHex).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberColor(c) {
  if (baseColors().includes(c)) return;
  const list = [c, ...loadRecent().filter((x) => x !== c)].slice(0, 6);
  try {
    localStorage.setItem(STORAGE_RECENT, JSON.stringify(list));
  } catch {
    /* 存不了就算了 */
  }
}

function setColor(c, remember = true) {
  c = String(c).toUpperCase();
  if (!isHex(c)) return;
  state.color = c;
  if (!baseColors().includes(c)) state.custom = c;
  if (remember) rememberColor(c);
  // 拿着橡皮选颜色，就是想画了
  if (state.tool === "eraser") {
    state.tool = "pen";
    renderTools();
  }
  if (!els.textBox.hidden) els.textBox.style.color = c;
  renderSwatches();
}

function renderPalette() {
  els.palGrid.innerHTML = "";
  for (const [c, name] of PRESETS) els.palGrid.appendChild(swatchButton(c, "pal-sw", `${name} ${c}`));
  els.palRecent.innerHTML = "";
  const recent = loadRecent();
  if (!recent.length) {
    const empty = document.createElement("span");
    empty.className = "pal-empty";
    empty.textContent = "还没有，挑一个试试";
    els.palRecent.appendChild(empty);
  }
  for (const c of recent) els.palRecent.appendChild(swatchButton(c, "pal-sw", c));
  els.palCurrent.textContent = state.color || "";
  if (document.activeElement !== els.palPicker) els.palPicker.value = String(state.color || "#1A1A1A").toLowerCase();
  if (document.activeElement !== els.palHex) {
    els.palHex.value = state.color || "";
    els.palHex.classList.remove("bad");
  }
}

function openPalette() {
  hideTip();
  renderPalette();
  els.palette.hidden = false;
  els.btnPalette.classList.add("open");
  const tb = els.toolbar.getBoundingClientRect();
  const btn = els.btnPalette.getBoundingClientRect();
  const h = els.palette.offsetHeight;
  els.palette.style.left = `${tb.right + 8}px`;
  els.palette.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, btn.top - h / 2))}px`;
}

function closePalette() {
  els.palette.hidden = true;
  els.btnPalette.classList.remove("open");
}

function applyHex() {
  let v = els.palHex.value.trim().toUpperCase();
  if (v && !v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9A-F]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const ok = isHex(v);
  els.palHex.classList.toggle("bad", !ok);
  if (ok) setColor(v);
  return ok;
}

function updateLockUi() {
  els.lockBadge.hidden = !state.locked;
  renderTools();
  updateExtendUi();
  applyView();
}

// 不用原生 disabled：禁用的按钮收不到悬停，提示就出不来
function setDisabled(el, off) {
  el.classList.toggle("is-disabled", off);
  el.setAttribute("aria-disabled", String(off));
}

function updateStacks() {
  setDisabled(els.undo, !state.canUndo);
  setDisabled(els.redo, !state.canRedo);
}

// 顶栏四个座位：在场的人是这面墙的主角，空位用虚线占着
function renderRoster() {
  els.seats.innerHTML = "";
  for (const u of state.users) {
    const seat = document.createElement("div");
    const me = state.you && u.id === state.you.id;
    seat.className = "seat" + (me ? " me" : "") + (u.online === false ? " away" : "");
    seat.style.setProperty("--c", u.color);
    if (Date.now() - (state.arrivedAt.get(u.id) || 0) < 1600) seat.classList.add("arrived");
    const dot = document.createElement("span");
    dot.className = "pdot";
    dot.style.background = u.color;
    const who = document.createElement("span");
    who.className = "who";
    who.style.color = textColor(u.color);
    who.textContent = u.name;
    seat.append(dot, who);
    const tags = [];
    if (me) tags.push("我");
    if (u.host) tags.push("房主");
    if (u.online === false) tags.push("离开中");
    if (tags.length) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = tags.join(" · ");
      seat.appendChild(tag);
    }
    if (!me && state.you && state.you.isHost) {
      const k = document.createElement("button");
      k.type = "button";
      k.className = "kick-btn";
      k.textContent = "请离";
      k.title = `请 ${u.name} 离开这面墙`;
      k.addEventListener("click", () => send({ type: "kick", targetId: u.id }));
      seat.appendChild(k);
    }
    els.seats.appendChild(seat);
  }
  for (let i = state.users.length; i < 4; i++) {
    const seat = document.createElement("div");
    seat.className = "seat empty";
    seat.innerHTML = '<span class="pdot"></span><span>空位</span>';
    els.seats.appendChild(seat);
  }
}

const GROUP_GAP = 3 * 60 * 1000; // 同一个人 3 分钟内连续说的话合成一组
const TIME_GAP = 5 * 60 * 1000; // 相隔 5 分钟以上插一条时间分隔

function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dividerLabel(t) {
  const d = new Date(t);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return hhmm(t);
  if (diff === 1) return `昨天 ${hhmm(t)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(t)}`;
}

function nearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60;
}

// 整体重绘聊天记录（最多 100 条，重绘很便宜），分组、合并系统句、插时间分隔
function renderChat(forceBottom) {
  const stick = forceBottom || nearBottom();
  const frag = document.createDocumentFragment();
  let lastT = 0;
  let grp = null;
  let sys = null;
  const hasHuman = state.chat.some((m) => m.userId !== "system");
  if (!hasHuman) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "还没人说话。\n画一笔也算。";
    empty.style.whiteSpace = "pre-line";
    frag.appendChild(empty);
  }
  for (const m of state.chat) {
    if (m.t - lastT >= TIME_GAP) {
      const div = document.createElement("div");
      div.className = "divider";
      div.textContent = dividerLabel(m.t);
      frag.appendChild(div);
      grp = null;
      sys = null;
    }
    if (m.userId === "system") {
      grp = null;
      if (!sys) {
        sys = document.createElement("div");
        sys.className = "sys";
        sys.parts = [];
        frag.appendChild(sys);
      }
      sys.parts.push(`${hhmm(m.t)} ${m.text}`);
      const shown = sys.parts.length > 4 ? sys.parts.slice(-3) : sys.parts;
      sys.textContent = (sys.parts.length > 4 ? "… " : "") + shown.map((x) => x.slice(6)).join(" · ");
      sys.title = sys.parts.join("\n");
    } else {
      sys = null;
      if (!grp || grp.userId !== m.userId || m.t - grp.lastT > GROUP_GAP) {
        grp = document.createElement("div");
        grp.className = "grp" + (state.you && m.userId === state.you.id ? " mine" : "");
        grp.userId = m.userId;
        grp.style.setProperty("--c", m.color || "#8a8276");
        const head = document.createElement("div");
        head.className = "grp-head";
        const nick = document.createElement("span");
        nick.className = "nick";
        nick.style.color = textColor(m.color);
        nick.textContent = m.name || "朋友";
        const time = document.createElement("time");
        time.textContent = hhmm(m.t);
        head.append(nick, time);
        grp.appendChild(head);
        frag.appendChild(grp);
      }
      grp.lastT = m.t;
      const body = document.createElement("p");
      body.className = "body";
      body.textContent = m.text;
      body.title = hhmm(m.t);
      grp.appendChild(body);
    }
    lastT = m.t;
  }
  els.log.replaceChildren(frag);
  if (stick) {
    els.log.scrollTop = els.log.scrollHeight;
    els.newMsg.hidden = true;
  }
}

function onChatMessage(m) {
  state.chat.push(m);
  if (state.chat.length > 100) state.chat.splice(0, state.chat.length - 100);
  const mine = state.you && m.userId === state.you.id;
  const wasNear = nearBottom();
  renderChat(mine);
  if (!wasNear && !mine && m.userId !== "system") els.newMsg.hidden = false;
  if (!state.chatOpen && !mine && m.userId !== "system") {
    state.unread += 1;
    updateUnread();
  }
}

function updateUnread() {
  const text = state.unread > 99 ? "99+" : String(state.unread);
  for (const el of [els.unread, els.unreadM]) {
    el.hidden = state.unread === 0;
    el.textContent = text;
  }
}

function isMobile() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function setChatOpen(open) {
  state.chatOpen = open;
  els.chat.classList.toggle("chat-closed", !open);
  els.chat.classList.toggle("chat-open", open);
  els.chatRail.hidden = open;
  if (open) {
    state.unread = 0;
    updateUnread();
    renderChat(true);
  }
  fitView();
}

// 输入框随内容长高（最多约 5 行），接近 200 字时显示字数
function autosizeChatInput() {
  const el = els.chatInput;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, 120)}px`;
  const n = el.value.length;
  els.chatCount.textContent = n >= 150 ? `${n}/200` : "";
  els.chatCount.classList.toggle("over", n >= 200);
}

// 输入法正在选词时按的回车不算数（中文输入必需）
function isImeEnter(e) {
  return e.isComposing || e.keyCode === 229;
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
    case "presence": {
      const before = state.users;
      state.users = msg.users || [];
      // 名单里第一次出现的人才算「来了」；宽限期内重连的人一直在名单上，不会重复提示
      const fresh = state.users.filter(
        (u) => !state.knownIds.has(u.id) && !(state.you && u.id === state.you.id)
      );
      state.knownIds = new Set(state.users.map((u) => u.id));
      for (const u of fresh) state.arrivedAt.set(u.id, Date.now());
      // 宽限期（10 秒）过后才会从名单里消失，所以刷新页面不会被当成「走了」
      const gone = before.filter((u) => !state.knownIds.has(u.id));
      pruneCursors();
      renderRoster();
      for (const u of fresh) showPresenceToast(u, "来了");
      for (const u of gone) showPresenceToast(u, "走了", true);
      break;
    }
    case "kick": {
      // 服务端先发名单再发 kick：把刚弹出的「走了」改成「被请离了」
      const el = presenceToasts.get(msg.targetId);
      if (el) el.lastChild.textContent = "被请离了";
      break;
    }
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
      if (msg.message) onChatMessage(msg.message);
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
    case "bake":
      onBakeTask(msg);
      break;
    case "baked":
      state.frozenUpTo = msg.upTo;
      Object.assign(state.segVersions, msg.versions || {});
      for (const t of state.tiles.values()) ensureBase(t);
      pruneFrozen();
      break;
    case "clear_done":
      state.frozenUpTo = 0;
      state.segVersions = {};
      for (const t of state.tiles.values()) ensureBase(t);
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
  el.querySelector(".name").style.color = textColor(color);
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

// 精简的进出提示：名字 来了 / 走了，最多叠 3 条，2.5 秒后淡出
const presenceToasts = new Map();

function showPresenceToast(u, text, leave = false) {
  const el = document.createElement("div");
  el.className = "arrival" + (leave ? " leave" : "");
  el.style.setProperty("--c", u.color);
  const name = document.createElement("b");
  name.style.color = textColor(u.color);
  name.textContent = u.name;
  const verb = document.createElement("span");
  verb.textContent = text;
  el.append(name, verb);
  els.arrivals.appendChild(el);
  presenceToasts.set(u.id, el);
  while (els.arrivals.childElementCount > 3) els.arrivals.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => {
      el.remove();
      if (presenceToasts.get(u.id) === el) presenceToasts.delete(u.id);
    }, 320);
  }, 2500);
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
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    closePalette();
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
  } else if (k === "c") {
    if (els.palette.hidden) openPalette();
    else closePalette();
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

// 触屏：单指画，双指平移 + 捏合缩放。用过手写笔后，手指只负责拖动（防手掌误触）
const touches = new Map(); // pointerId → { x, y }
let gesture = null;

function startGesture() {
  const [a, b] = [...touches.values()];
  gesture = {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
    scale: state.scale,
    panX: state.panX,
    panY: state.panY,
  };
}

function updateGesture() {
  const [a, b] = [...touches.values()];
  const r = els.desk.getBoundingClientRect();
  const { min, max } = scaleLimits();
  const scale = Math.max(min, Math.min(max, (gesture.scale * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist));
  // 起手时两指中点下的那一点，跟着两指的新中点走
  const cx = (gesture.mx - r.left - gesture.panX) / gesture.scale;
  const cy = (gesture.my - r.top - gesture.panY) / gesture.scale;
  state.scale = scale;
  state.panX = (a.x + b.x) / 2 - r.left - cx * scale;
  state.panY = (a.y + b.y) / 2 - r.top - cy * scale;
  applyView();
}

// 指针已失效等情况下 setPointerCapture 会抛异常，不能让它打断后面的处理
function capturePointer(e) {
  try {
    els.desk.setPointerCapture(e.pointerId);
  } catch {
    /* 不捕获也能画，只是拖出画布区域后收不到事件 */
  }
}

function startPan(e) {
  state.panning = true;
  state.panStart = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
  els.desk.classList.add("panning", "dragging");
  capturePointer(e);
}

function onPointerDown(e) {
  if (e.target === els.textBox) return;
  if (!els.textBox.hidden) {
    if (els.textBox.value.trim()) commitText();
    else cancelText();
  }
  if (e.pointerType === "pen") state.penSeen = true;
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capturePointer(e);
    if (touches.size >= 2) {
      // 第二根手指到了：还没发出去的那一笔撤回；已经在画的就收笔
      if (state.current && state.current.pending) cancelStroke();
      else if (state.drawing) endStroke();
      state.panning = false;
      startGesture();
      return;
    }
    if (state.penSeen) {
      startPan(e);
      return;
    }
  } else if (e.button === 1 || (e.button === 0 && state.space)) {
    e.preventDefault();
    startPan(e);
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
  startStroke(p, e.pointerType === "touch");
  capturePointer(e);
}

function onPointerMove(e) {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture) {
      if (touches.size >= 2) updateGesture();
      return; // 双指手势结束后，剩下那根手指抬起前什么也不做
    }
  }
  if (state.panning && state.panStart) {
    state.panX = state.panStart.px + (e.clientX - state.panStart.x);
    state.panY = state.panStart.py + (e.clientY - state.panStart.y);
    applyView();
    return;
  }
  const r = els.wrap.getBoundingClientRect();
  const at = (ev) => ({ x: (ev.clientX - r.left) / state.scale, y: (ev.clientY - r.top) / state.scale });
  const p0 = at(e);
  const now = Date.now();
  if (now - state.lastCursor >= 50) {
    state.lastCursor = now;
    const c = clip(p0);
    send({ type: "cursor", x: c.x, y: c.y });
  }
  if (state.drawing) {
    // 浏览器会把一帧内的多次采样合并成一次事件；拿回全部采样点，快速画线和手写笔都更顺
    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    addPoints((evs.length ? evs : [e]).map((ev) => clipStroke(at(ev))));
  }
}

function onPointerUp(e) {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (touches.size === 0) gesture = null;
    else if (gesture) return;
  }
  if (state.panning) {
    state.panning = false;
    els.desk.classList.remove("dragging");
    if (!state.space) els.desk.classList.remove("panning");
  }
  if (!state.drawing) return;
  // 系统打断了触摸（来电、手势导航）时，没发出去的那一笔直接丢掉
  if (e.type === "pointercancel" && state.current && state.current.pending) cancelStroke();
  else endStroke();
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

// 导出整条卷轴；超过浏览器单张图宽度上限（约 32000px）时按比例缩小
const EXPORT_MAX_W = 32000;

async function exportPng() {
  makePaper();
  const k = Math.min(1, EXPORT_MAX_W / wallW());
  const segW = SEG_W * k;
  const H = Math.round(CANVAS_H * k);
  const out = document.createElement("canvas");
  out.width = Math.round(wallW() * k);
  out.height = H;
  const ctx = out.getContext("2d");
  const list = sortedStrokes();
  const ink = document.createElement("canvas");
  ink.width = Math.ceil(segW);
  ink.height = H;
  const ictx = ink.getContext("2d");
  for (let i = 0; i < state.segments; i++) {
    ctx.drawImage(paperCanvas, i * segW, 0, segW, H);
    ictx.setTransform(1, 0, 0, 1, 0, 0);
    ictx.clearRect(0, 0, ink.width, ink.height);
    ictx.setTransform(k, 0, 0, k, -i * segW, 0);
    const v = state.segVersions[i] || 0;
    let base = null;
    if (v) {
      try {
        base = await loadSegImage(i, v); // 逐段加载、用完即丢，不在内存里攒着
      } catch {
        toast("有一段墨迹图没加载出来");
      }
    }
    paintSegment(ictx, i, list, base, state.frozenUpTo);
    ctx.drawImage(ink, i * segW, 0);
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
  if (isMobile() && state.chatOpen) setChatOpen(false); // 手机上聊天默认收起，画布优先
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

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const tip = { shown: null, pending: null, timer: 0, warmUntil: 0 };

function keyLabels(spec) {
  if (!spec) return [];
  if (spec === "[ ]") return ["[", "]"];
  return spec.split("+").map((k) => {
    if (k === "mod") return IS_MAC ? "⌘" : "Ctrl";
    if (k === "shift") return IS_MAC ? "⇧" : "Shift";
    return k;
  });
}

function showTip(target) {
  clearTimeout(tip.timer);
  tip.pending = null;
  tip.shown = target;
  const el = els.tip;
  const row = document.createElement("div");
  row.className = "tip-row";
  const name = document.createElement("span");
  name.className = "tip-name";
  name.textContent = target.dataset.tip;
  row.appendChild(name);
  const keys = keyLabels(target.dataset.key);
  if (keys.length) {
    const box = document.createElement("span");
    box.className = "tip-keys";
    for (const k of keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      box.appendChild(kbd);
    }
    row.appendChild(box);
  }
  el.replaceChildren(row);
  if (target.dataset.desc) {
    const desc = document.createElement("div");
    desc.className = "tip-desc";
    desc.textContent = target.dataset.desc;
    el.appendChild(desc);
  }
  if (target.classList.contains("is-disabled")) {
    const note = document.createElement("div");
    note.className = "tip-note";
    note.textContent = target === els.undo ? "现在没有可撤销的笔" : "现在没有可重做的笔";
    el.appendChild(note);
  }
  el.hidden = false;
  el.style.animation = "none";
  void el.offsetWidth; // 重新播放出现动画
  el.style.animation = "";
  const r = target.getBoundingClientRect();
  const h = el.offsetHeight;
  el.style.left = `${r.right + 10}px`;
  el.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, r.top + r.height / 2 - h / 2))}px`;
}

function hideTip() {
  clearTimeout(tip.timer);
  tip.pending = null;
  if (tip.shown) tip.warmUntil = Date.now() + 400;
  tip.shown = null;
  els.tip.hidden = true;
}

function tipTargetOf(node) {
  const t = node && node.closest ? node.closest("[data-tip]") : null;
  return t && els.toolbar.contains(t) ? t : null;
}

// 第一次悬停等 0.35 秒；提示已经出来时，在按钮间移动立刻切换
function bindTips() {
  els.toolbar.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return; // 手指点按钮不弹提示
    const t = tipTargetOf(e.target);
    if (!t || t === tip.shown || t === tip.pending) return;
    clearTimeout(tip.timer);
    if (tip.shown || Date.now() < tip.warmUntil) {
      showTip(t);
    } else {
      tip.pending = t;
      tip.timer = setTimeout(() => showTip(t), 350);
    }
  });
  els.toolbar.addEventListener("pointerout", (e) => {
    const from = tipTargetOf(e.target);
    const to = tipTargetOf(e.relatedTarget);
    if (from && from !== to) hideTip();
  });
  els.toolbar.addEventListener("pointerdown", hideTip);
  els.toolbar.addEventListener("focusin", (e) => {
    const t = tipTargetOf(e.target);
    if (t && t.matches(":focus-visible")) showTip(t);
  });
  els.toolbar.addEventListener("focusout", hideTip);
  window.addEventListener("blur", hideTip);
}

async function copyLink() {
  const url = `${location.origin}/w/${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("已复制链接");
  } catch {
    // http://IP 访问时没有 clipboard API，退回老办法
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? "已复制链接" : url);
  }
}

// 主动离开：告诉服务端立刻释放座位，回到门口；房间码留在输入框里，想回来点「推门」就行
function leaveWall() {
  const code = state.code;
  send({ type: "leave" });
  goLobby("");
  els.codeInput.value = code || "";
}

function bindUi() {
  els.nick.value = loadName();
  els.create.addEventListener("click", createRoom);
  els.nick.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !isImeEnter(e) && els.codeInput.value.trim()) tryJoinFromForm(e);
  });
  els.joinForm.addEventListener("submit", tryJoinFromForm);
  els.copy.addEventListener("click", copyLink);
  els.menuCopy.addEventListener("click", () => {
    els.menu.hidden = true;
    copyLink();
  });
  els.leave.addEventListener("click", leaveWall);
  els.chatMobile.addEventListener("click", () => setChatOpen(!state.chatOpen));
  els.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.menu.hidden = !els.menu.hidden;
  });
  document.addEventListener("click", () => {
    els.menu.hidden = true;
    closePalette();
  });
  els.btnPalette.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.palette.hidden) openPalette();
    else closePalette();
  });
  els.palette.addEventListener("click", (e) => e.stopPropagation());
  // 拖动取色器时实时预览，松手才记进「最近用过」
  els.palPicker.addEventListener("input", () => setColor(els.palPicker.value, false));
  els.palPicker.addEventListener("change", () => {
    rememberColor(String(els.palPicker.value).toUpperCase());
    renderPalette();
  });
  els.palHex.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !isImeEnter(e)) {
      e.preventDefault();
      if (applyHex()) closePalette();
    }
  });
  els.palHex.addEventListener("input", () => {
    const v = els.palHex.value.trim();
    if (/^#?[0-9A-F]{6}$/i.test(v)) applyHex();
    else els.palHex.classList.remove("bad");
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
  els.undo.addEventListener("click", () => {
    if (state.canUndo) send({ type: "undo" });
  });
  els.redo.addEventListener("click", () => {
    if (state.canRedo) send({ type: "redo" });
  });
  bindTips();
  els.fit.addEventListener("click", fitView);
  els.extend.addEventListener("click", () => send({ type: "extend" }));
  els.scrollNav.addEventListener("click", (e) => {
    const r = els.segTrack.getBoundingClientRect();
    jumpTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  });
  els.chatToggle.addEventListener("click", () => setChatOpen(false));
  els.chatRail.addEventListener("click", () => {
    setChatOpen(true);
    els.chatInput.focus();
  });
  els.newMsg.addEventListener("click", () => renderChat(true));
  els.log.addEventListener("scroll", () => {
    if (nearBottom()) els.newMsg.hidden = true;
  });
  els.chatInput.addEventListener("input", autosizeChatInput);
  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
      e.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text) return;
      send({ type: "chat", text: text.slice(0, 200) });
      els.chatInput.value = "";
      autosizeChatInput();
    }
  });
  els.textBox.addEventListener("keydown", (e) => {
    if (isImeEnter(e)) return;
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
  state.custom = loadRecent()[0] || null;
  const code = pathCode();
  if (code && loadName()) {
    enterWall(code);
  } else if (code) {
    // 第一次通过链接进来：先填昵称，再推门
    showLobby();
    els.codeInput.value = code;
    showLobbyError("先告诉大家怎么称呼你，再推门", "hint");
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
