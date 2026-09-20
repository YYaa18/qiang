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
const PEN_WIDTHS = [2, 4, 8, 14, 24];
const ERASER_WIDTHS = [8, 14, 24, 36, 56];
const BRUSHES = [
  { id: "ink", name: "笔锋", desc: "起收笔带尖，慢粗快细" },
  { id: "pen", name: "圆珠笔", desc: "粗细均匀" },
  { id: "marker", name: "马克笔", desc: "半透明，叠加处变深" },
  { id: "pencil", name: "铅笔", desc: "带颗粒感" },
];
const BRUSH_ICONS = {
  ink: '<svg viewBox="0 0 24 24"><path d="M12 3l5 9-5 9-5-9z M12 12v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="11" r="1.4" fill="currentColor"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.2L16.8 4.2a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.2 18.8z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  marker: '<svg viewBox="0 0 24 24"><path d="M14 4l6 6-8 8H8v-4z M4 20h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 15l3 3" stroke="currentColor" stroke-width="1.7"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M5 19l1-5L16 4l4 4-10 10z M14.5 5.5l4 4 M5 19l3.5-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
// 防抖：笔尖被一根看不见的「绳子」拖着走，绳长以内的晃动不会带动笔尖（单位：屏幕像素）
const STAB_RADIUS = [0, 7, 16];
const STAB_NAMES = ["关", "轻", "强"];
const SNAP_HOLD_MS = 550; // 画完停住这么久，尝试吸附成标准形状
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
const STORAGE_HISTORY = "qiang.history"; // 去过的墙，只存在本机
const HISTORY_MAX = 30;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const STORAGE_ID = "qiang.clientId";
const STORAGE_NAME = "qiang.name";
// 笔画点允许超出纸面的余量（与服务端一致），canvas 会自然裁掉超出部分
const STROKE_MARGIN = 40;

const $ = (id) => document.getElementById(id);

function readPref(key, fallback, ok) {
  try {
    const v = localStorage.getItem(key);
    return v !== null && ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* 存不了就算了 */
  }
}

const els = {
  lobby: $("lobby"),
  wall: $("wall"),
  nick: $("nick-input"),
  create: $("btn-create"),
  joinForm: $("join-form"),
  codeInput: $("code-input"),
  historyList: $("history"),
  historyToggle: $("history-toggle"),
  lobbyError: $("lobby-error"),
  roomCode: $("room-code"),
  copy: $("btn-copy"),
  seats: $("seats"),
  lockBadge: $("lock-badge"),
  menuBtn: $("btn-menu"),
  menu: $("menu"),
  menuExport: $("menu-export"),
  modeSep: $("mode-sep"),
  modeLabel: $("mode-label"),
  modeMenu: $("mode-menu"),
  modeBar: $("mode-bar"),
  modeText: $("mode-text"),
  modeAct: $("mode-act"),
  modeMask: $("mode-mask"),
  maskLeft: $("mask-left"),
  maskRight: $("mask-right"),
  maskSeam: $("mask-seam"),
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
  penBtn: $("btn-pen"),
  penIcon: $("pen-icon"),
  stabBtn: $("btn-stab"),
  stabLabel: $("stab-label"),
  brushes: $("brushes"),
  brushList: $("brush-list"),
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
  size: 2,
  brush: readPref("qiang.brush", "ink", (v) => BRUSHES.some((b) => b.id === v)),
  stab: Number(readPref("qiang.stab", "1", (v) => ["0", "1", "2"].includes(v))),
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
  mode: null, // 正在玩的玩法：一份显示指令，不是玩法的内部状态
  modeList: [], // 服务端有哪些玩法，菜单照它长出来
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

function toast(text, ms = 1600) {
  els.toast.hidden = false;
  els.toast.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
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

// 把上下文平移到第 i 段，之后直接用全局坐标作画。
// res 必须是这张画布创建时的像素比：浏览器缩放会改变 devicePixelRatio，
// 若用当前值去画旧画布，笔迹会整体缩放、挤到左上角
function tileTransform(ctx, i, res) {
  ctx.setTransform(res, 0, 0, res, -i * SEG_W * res, 0);
}

function makeInkCanvas(i, res) {
  const c = document.createElement("canvas");
  c.width = Math.round(SEG_W * res);
  c.height = Math.round(CANVAS_H * res);
  tileTransform(c.getContext("2d"), i, res);
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
    const res = dpr();
    const tile = { i, res, root, ink: makeInkCanvas(i, res), live: null, liveUsed: false, base: null, baseV: 0, baseUpTo: 0, loadingV: 0 };
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
  const h = (s.width || 0) * 0.8 + 1; // 笔锋最粗处约是标称粗细的 1.5 倍
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
  const raw = s.points || [];
  if (!raw.length) return;
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
  if (!s.brush) {
    // 旧笔画：原来的画法，不动
    ctx.lineWidth = s.width;
    strokeCurve(ctx, raw, s.width);
  } else {
    const geo = strokeGeometry(s);
    const closedShape = s.shape === "rect" || s.shape === "ellipse";
    if (s.type === "eraser" || s.brush === "pen" || (s.brush === "ink" && closedShape)) {
      ctx.lineWidth = s.width;
      strokeCurve(ctx, geo.pts, s.width, s.shape);
    } else if (s.brush === "ink") {
      ctx.fill(geo.ink);
    } else if (s.brush === "marker") {
      // 同一次 stroke() 里自己和自己重叠的地方只上一次色，不会越描越深；不同笔之间叠加才加深
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = s.width * 1.5;
      ctx.lineCap = "square";
      strokeCurve(ctx, geo.pts, s.width * 1.5, s.shape);
    } else if (s.brush === "pencil") {
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = pencilPattern(s.color);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(1.5, s.width * 0.7);
      strokeCurve(ctx, geo.pts, ctx.lineWidth, s.shape);
    }
  }
  ctx.restore();
}

// 等粗描线：一个点画圆点；标准形状用直线段；其余过中点画二次曲线
function strokeCurve(ctx, pts, width, shape) {
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (shape) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    const end = pts[pts.length - 1];
    ctx.lineTo(end.x, end.y);
  }
  ctx.stroke();
}

// ───────────── 笔刷几何：自动修整 + 笔锋 ─────────────
//
// 全部由点算出来、没有随机数：每台设备、导出、冻结的墨迹图画出来都一样。

// 落定的笔不会再变，几何结果缓存起来；正在画的笔按点数判断要不要重算
const geoCache = new WeakMap();
function strokeGeometry(s) {
  const c = geoCache.get(s);
  if (c && c.src === s.points && c.n === s.points.length) return c;
  const src = s.points;
  let pts;
  if (s.shape === "line") pts = withSimPressure(resample(src, Math.max(2, s.width / 2)), s.width); // 两个端点不够收笔锋，先补点
  else if (s.shape) pts = withSimPressure(src, s.width);
  else pts = chaikin(withSimPressure(src, s.width), 2);
  const geo = { src, n: src.length, pts, ink: null };
  if (s.brush === "ink" && !(s.shape === "rect" || s.shape === "ellipse")) geo.ink = inkPath(pts, s.width);
  geoCache.set(s, geo);
  return geo;
}

// 沿折线每隔 step 取一个点
function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = step; t < d; t += step) out.push({ x: a.x + ((b.x - a.x) * t) / d, y: a.y + ((b.y - a.y) * t) / d });
    out.push(b);
  }
  return out;
}

// 自动修整：Chaikin 切角，每轮把折线的角磨圆一次，首尾点不动
function chaikin(pts, rounds) {
  let a = pts;
  for (let k = 0; k < rounds && a.length > 2; k++) {
    const out = [a[0]];
    for (let i = 0; i < a.length - 1; i++) {
      out.push(lerpPoint(a[i], a[i + 1], 0.25), lerpPoint(a[i], a[i + 1], 0.75));
    }
    out.push(a[a.length - 1]);
    a = out;
  }
  return a;
}

function lerpPoint(p, q, t) {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, p: p.p + (q.p - p.p) * t };
}

// 压力：手写笔用真实压力；鼠标和手指按速度模拟——移动得慢压力大（粗），快则压力小（细）
function withSimPressure(pts, size) {
  const real = pts.some((p) => typeof p.p === "number");
  let pr = 0.5;
  return pts.map((p, i) => {
    if (real) {
      if (typeof p.p === "number") pr = p.p;
    } else if (i > 0) {
      const sp = Math.min(1, Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) / size);
      pr = Math.min(1, pr + (1 - sp - pr) * sp * 0.35);
    }
    return { x: p.x, y: p.y, p: pr };
  });
}

// 笔锋：沿线两侧按压力偏移出轮廓，首尾各收一段尖，最后填充成一个形状
function inkPath(pts, size) {
  const path = new Path2D();
  const n = pts.length;
  const dist = [0];
  for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = dist[n - 1];
  if (n < 2 || total < size * 0.3) {
    path.arc(pts[0].x, pts[0].y, size * 0.5, 0, Math.PI * 2);
    return path;
  }
  const taper = Math.min(size * 3, total * 0.3);
  const ease = (t) => 1 - (1 - t) * (1 - t);
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const t = Math.min(ease(Math.min(1, dist[i] / taper)), ease(Math.min(1, (total - dist[i]) / taper)));
    const r = Math.max(0.35, size * (0.5 - 0.5 * (0.5 - pts[i].p)) * t);
    left.push({ x: pts[i].x - dy * r, y: pts[i].y + dx * r });
    right.push({ x: pts[i].x + dy * r, y: pts[i].y - dx * r });
  }
  const trace = (arr, first) => {
    if (first) path.moveTo(arr[0].x, arr[0].y);
    else path.lineTo(arr[0].x, arr[0].y);
    for (let i = 1; i < arr.length - 1; i++) {
      path.quadraticCurveTo(arr[i].x, arr[i].y, (arr[i].x + arr[i + 1].x) / 2, (arr[i].y + arr[i + 1].y) / 2);
    }
    path.lineTo(arr[arr.length - 1].x, arr[arr.length - 1].y);
  };
  trace(left, true);
  trace(right.reverse(), false);
  path.closePath();
  return path;
}

// 铅笔：用固定种子生成的颗粒图案当颜色，每台设备纹理一致；按颜色缓存
const pencilCache = new Map();
function pencilPattern(color) {
  let pat = pencilCache.get(color);
  if (pat) return pat;
  const size = 48;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const hex = color.replace("#", "");
  const [r, gr, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  let seed = 20260919;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = gr;
    img.data[i + 2] = b;
    img.data[i + 3] = rnd() < 0.72 ? 150 + rnd() * 105 : rnd() * 60;
  }
  g.putImageData(img, 0, 0);
  pat = g.createPattern(c, "repeat");
  pencilCache.set(color, pat);
  return pat;
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
    tileTransform(octx, i, tile.res);
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
      tile.live = makeInkCanvas(tile.i, tile.res);
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
  if (modeBlocks()) {
    els.drawingHint.textContent = modeNow().why || "现在还画不了";
    return;
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
  const dr = els.desk.getBoundingClientRect();
  state.lastDesk = { w: dr.width, h: dr.height };
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

// 桌面尺寸变了：以原来屏幕中心下的那一点为准，缩放不变，只平移
function keepView() {
  const r = els.desk.getBoundingClientRect();
  const last = state.lastDesk || { w: r.width, h: r.height };
  const cx = (last.w / 2 - state.panX) / state.scale;
  const cy = (last.h / 2 - state.panY) / state.scale;
  state.panX = r.width / 2 - cx * state.scale;
  state.panY = r.height / 2 - cy * state.scale;
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
  const m = modeNow();
  const blocked =
    (state.locked && !(state.you && state.you.isHost)) || !!(m && m.noExtend);
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
  if (modeBlocks()) return false; // 省下白画的力气；真正的拦截在服务端
  return !!(state.ws && state.ws.readyState === WebSocket.OPEN);
}

// 手指落下后这么久内来了第二根手指，就当作双指手势：这一笔撤回，不发出去
const TOUCH_GRACE_MS = 120;

function startStroke(p, pending = false, opts = {}) {
  if (!canDraw()) return;
  state.brushPos = { x: p.x, y: p.y };
  state.lastRaw = p;
  state.holdAt = null;
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
    brush: state.tool === "eraser" ? "pen" : state.brush,
    shape: opts.shape,
  };
  state.current = stroke;
  state.drawing = true;
  state.pointBuf = [];
  // Shift 直线要等松手才定下来，不设超时；触屏的一笔等 120ms 看有没有第二根手指
  if (pending && !opts.shape) state.pendingTimer = setTimeout(commitPending, TOUCH_GRACE_MS);
  else if (!pending) sendStart(stroke);
  redrawLive();
}

function sendStart(stroke) {
  const [p] = stroke.points;
  send({
    type: "stroke_start",
    id: stroke.id,
    strokeType: stroke.type,
    brush: stroke.brush,
    shape: stroke.shape,
    color: stroke.color,
    width: stroke.width,
    x: p.x,
    y: p.y,
    p: p.p,
  });
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
  clearTimeout(state.snapTimer);
  // 已经发出去的也撤回：服务端丢掉这笔，别人那边的预览也会消失
  if (state.current && !state.current.pending) send({ type: "stroke_cancel", id: state.current.id });
  state.current = null;
  state.drawing = false;
  state.pointBuf = [];
  redrawLive();
}

// 原始采样点进来：Shift 直线只保留首尾；其余先过防抖，再记进这一笔
function onRawPoints(raws) {
  const s = state.current;
  if (!state.drawing || !s || !raws.length) return;
  state.lastRaw = raws[raws.length - 1];
  if (s.snapped) {
    // 吸附后又明显动了：说明只是画到一半停了一下，恢复成手画的线接着画
    const a = state.holdAt;
    const slop = (HOLD_SLOP[state.inputType] || 3) * 2;
    if (!a || Math.hypot(state.lastRaw.x - a.x, state.lastRaw.y - a.y) * state.scale < slop) return;
    unsnap();
  }
  if (s.shape === "line") {
    s.points = [s.points[0], state.lastRaw];
    scheduleLive();
    return;
  }
  armSnap(state.lastRaw);
  addPoints(stabilize(raws));
}

// 拉绳防抖：笔尖离指针超过绳长才被拖动，拖到正好绳长的位置
function stabilize(raws) {
  const R = STAB_RADIUS[state.stab] / state.scale;
  if (!R) return raws;
  const out = [];
  let b = state.brushPos;
  for (const q of raws) {
    const d = Math.hypot(q.x - b.x, q.y - b.y);
    if (d <= R) continue;
    const k = (d - R) / d;
    b = { x: b.x + (q.x - b.x) * k, y: b.y + (q.y - b.y) * k };
    if (typeof q.p === "number") b.p = q.p;
    out.push(b);
  }
  state.brushPos = b;
  return out;
}

// 停住计时：指针在 3 个屏幕像素内不动满 SNAP_HOLD_MS，就试着吸附成形状
// 手指压在屏幕上会自然抖几个像素，「算停住」的范围按输入方式放宽
const HOLD_SLOP = { mouse: 3, pen: 6, touch: 14 };

function armSnap(q) {
  const a = state.holdAt;
  const slop = HOLD_SLOP[state.inputType] || 3;
  if (a && Math.hypot(q.x - a.x, q.y - a.y) * state.scale < slop) return;
  state.holdAt = q;
  clearTimeout(state.snapTimer);
  state.snapTimer = setTimeout(trySnap, SNAP_HOLD_MS);
}

const SHAPE_NAMES = { line: "直线", rect: "矩形", ellipse: "椭圆", circle: "圆" };

function trySnap() {
  const s = state.current;
  if (!state.drawing || !s || s.snapped || s.shape || s.type === "eraser") return;
  const shape = recognizeShape(s.points);
  if (!shape) return;
  s.freehand = s.points;
  s.points = shape.points;
  s.shape = shape.kind;
  s.snapped = true;
  state.pointBuf = [];
  if (!s.pending) send({ type: "stroke_replace", id: s.id, points: s.points, shape: s.shape });
  scheduleLive();
  toast(`已吸附成${SHAPE_NAMES[shape.name]}`, 1200);
}

function unsnap() {
  const s = state.current;
  s.points = s.freehand;
  s.shape = undefined;
  s.snapped = false;
  state.pointBuf = [];
  state.brushPos = s.points[s.points.length - 1];
  if (!s.pending) send({ type: "stroke_replace", id: s.id, points: s.points, shape: null });
  scheduleLive();
}

// 认形状：先看是不是直线；首尾相接的再比椭圆和矩形哪个更贴
function recognizeShape(pts) {
  if (pts.length < 6) return null;
  const a = pts[0];
  const z = pts[pts.length - 1];
  let len = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  pts.forEach((p, i) => {
    if (i) len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  const w = maxX - minX;
  const h = maxY - minY;
  const big = Math.max(w, h);
  if (big * state.scale < 24) return null; // 太小的不认，免得写字时被吸走
  const gap = Math.hypot(z.x - a.x, z.y - a.y);
  if (gap > big * 0.7) {
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, Math.abs((z.x - a.x) * (p.y - a.y) - (z.y - a.y) * (p.x - a.x)) / gap);
    if (dev < Math.max(4 / state.scale, gap * 0.05) && len < gap * 1.15) {
      return { kind: "line", name: "line", points: [{ x: a.x, y: a.y }, { x: z.x, y: z.y }] };
    }
    return null;
  }
  if (gap > big * 0.3 || len < (w + h) * 1.4 || Math.min(w, h) < big * 0.15) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;
  let eErr = 0;
  let rErr = 0;
  for (const p of pts) {
    eErr += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    rErr += Math.min(Math.abs(p.x - minX), Math.abs(p.x - maxX), Math.abs(p.y - minY), Math.abs(p.y - maxY)) / big;
  }
  eErr /= pts.length;
  rErr /= pts.length;
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].every(([x, y]) =>
    pts.some((p) => Math.hypot(p.x - x, p.y - y) < big * 0.18)
  );
  if (corners && rErr < 0.05 && rErr * 2 < eErr) {
    return {
      kind: "rect",
      name: "rect",
      points: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY }],
    };
  }
  if (eErr < 0.13) {
    const round = Math.abs(rx - ry) < Math.max(rx, ry) * 0.12;
    const [ex, ey] = round ? [(rx + ry) / 2, (rx + ry) / 2] : [rx, ry];
    const out = [];
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      out.push({ x: cx + ex * Math.cos(t), y: cy + ey * Math.sin(t) });
    }
    return { kind: "ellipse", name: round ? "circle" : "ellipse", points: out };
  }
  return null;
}

// 一次事件可能带来多个采样点（getCoalescedEvents）；太近的点丢掉，重绘合并到下一帧
function addPoints(pts) {
  const s = state.current;
  if (!state.drawing || !s || s.snapped) return;
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
  clearTimeout(state.snapTimer);
  const cur = state.current;
  if (cur.pending) commitPending(); // 轻点一下也算一笔（一个点）
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
  state.mode = snap.mode || null;
  state.modeList = snap.modes || [];
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
  renderModeBar();
  rememberRoom();
  if (snap.clearDeadline && snap.clearDeadline > Date.now()) {
    startClearUi(snap.clearDeadline);
  } else {
    stopClearUi();
  }
}

// ───────────── 玩法的外壳 ─────────────
//
// 这里不认识任何具体玩法。服务端发来的 state.mode 是一份**显示指令**
// （label / action / drawable …），照着渲染就行；再加第几个玩法，这段都不用动。
//
// 遮挡在这里只是「看起来对」——真正藏起来的笔画根本没发到这台机器上。

function modeNow() {
  return state.mode || null;
}

// 我此刻能不能落笔。只是省下白画的力气，真正的拦截在服务端。
function modeBlocks() {
  const m = modeNow();
  return !!(m && m.blocked);
}

function renderModeBar() {
  const m = modeNow();
  const bar = els.modeBar;

  // 菜单：清单里每个玩法一个入口，正在玩的那个变成「结束」
  renderModeMenu();

  if (!m) {
    bar.hidden = true;
    els.modeMask.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.className = m.tone ? `tone-${m.tone}` : "";
  els.modeText.textContent = m.label || m.name || "";

  if (m.action && m.action.cmd) {
    els.modeAct.hidden = false;
    els.modeAct.textContent = m.action.label || "好";
    els.modeAct.dataset.cmd = m.action.cmd;
  } else {
    els.modeAct.hidden = true;
    delete els.modeAct.dataset.cmd;
  }
  renderModeMask();
}

// 我能画的范围之外盖上斜纹；hint 是玩法想额外标出来的一小块
function renderModeMask() {
  const m = modeNow();
  if (!m || !m.drawable) {
    els.modeMask.hidden = true;
    return;
  }
  els.modeMask.hidden = false;
  const { x0, x1 } = m.drawable;
  const wall = wallW();
  els.maskLeft.hidden = x0 <= 0;
  els.maskLeft.style.left = "0px";
  els.maskLeft.style.width = `${Math.max(0, x0)}px`;
  els.maskRight.hidden = x1 >= wall;
  els.maskRight.style.left = `${x1}px`;
  els.maskRight.style.width = `${Math.max(0, wall - x1)}px`;

  if (m.hint) {
    els.maskSeam.hidden = false;
    els.maskSeam.style.left = `${m.hint[0]}px`;
    els.maskSeam.style.width = `${Math.max(1, m.hint[1] - m.hint[0])}px`;
  } else {
    els.maskSeam.hidden = true;
  }
}

// ⋯ 菜单里那一段「想玩点什么」，整段由服务端的清单长出来
function renderModeMenu() {
  const m = modeNow();
  const host = !!(state.you && state.you.isHost);
  const list = state.modeList || [];
  els.modeMenu.innerHTML = "";
  els.modeMenu.hidden = !host || !list.length;
  els.modeSep.hidden = els.modeMenu.hidden;
  els.modeLabel.hidden = els.modeMenu.hidden;
  if (els.modeMenu.hidden) return;

  if (m) {
    add(els.modeMenu, `结束${m.name || "玩法"}`, () => {
      if (confirm(`结束${m.name || "玩法"}？整面墙会对所有人打开。`)) modeCmd("stop");
    });
    for (const a of m.hostActions || []) {
      add(els.modeMenu, a.label, () => {
        if (!a.confirm || confirm(a.confirm)) modeCmd(a.cmd);
      });
    }
    return;
  }
  for (const item of list) {
    add(els.modeMenu, `开始${item.name}`, () => modeCmd("start", { mode: item.id }), item.hint);
  }

  function add(parent, text, onClick, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener("click", () => {
      els.menu.hidden = true;
      onClick();
    });
    parent.appendChild(b);
  }
}

// 玩法限定了可画范围时，把镜头带过去
function lookAtDrawable() {
  const m = modeNow();
  if (!m || !m.drawable) return;
  const view = els.desk.clientWidth / state.scale;
  const mid = (m.drawable.x0 + m.drawable.x1) / 2;
  state.panX = (mid - view / 2) * state.scale;
  clampPan();
  applyView();
}

function modeCmd(cmd, extra) {
  send({ type: "mode", cmd, ...(extra || {}) });
}

function renderTools() {
  document.documentElement.style.setProperty("--me", (state.you && state.you.color) || "#1A1A1A");
  els.desk.classList.toggle("hand-mode", state.tool === "hand");
  els.toolbar.querySelectorAll(".tool").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === state.tool);
  });
  const brush = BRUSHES.find((b) => b.id === state.brush);
  els.penIcon.innerHTML = BRUSH_ICONS[state.brush];
  els.penBtn.dataset.tip = brush.name;
  els.penBtn.setAttribute("aria-label", `笔：${brush.name}`);
  els.stabLabel.textContent = STAB_NAMES[state.stab];
  els.stabBtn.classList.toggle("off", state.stab === 0);
  els.stabBtn.dataset.desc = `鼠标画线更稳：${STAB_NAMES.map((n, i) => (i === state.stab ? `[${n}]` : n)).join(" / ")}，点击切换`;
  els.toolbar.querySelectorAll(".width-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.size) === state.size);
  });
  const host = !!(state.you && state.you.isHost);
  document.querySelectorAll(".host-only").forEach((el) => {
    el.hidden = !host;
  });
  renderModeBar(); // 玩法那一段菜单自己决定显示什么，得盖过上面那句统一开关
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
  if (state.tool === "eraser" || state.tool === "hand") {
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

function setBrush(id) {
  state.brush = id;
  state.tool = "pen";
  writePref("qiang.brush", id);
  renderTools();
  if (!els.brushes.hidden) renderBrushes();
}

function cycleStab() {
  state.stab = (state.stab + 1) % STAB_RADIUS.length;
  writePref("qiang.stab", state.stab);
  renderTools();
  toast(`防抖：${STAB_NAMES[state.stab]}`, 1000);
}

// 笔刷面板：每种笔刷用当前颜色画一条示例线
function renderBrushes() {
  els.brushList.replaceChildren();
  BRUSHES.forEach((b, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "brush-row" + (b.id === state.brush ? " active" : "");
    const c = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    c.width = 120 * dpr;
    c.height = 34 * dpr;
    c.className = "brush-sample";
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = [];
    for (let x = 10; x <= 110; x += 3) pts.push({ x, y: 17 + Math.sin((x - 10) / 16) * 8 });
    drawStroke(ctx, { type: "pen", brush: b.id, color: state.color || "#1A1A1A", width: 7, points: pts });
    const text = document.createElement("span");
    text.className = "brush-text";
    text.innerHTML = `<b></b><small></small>`;
    text.querySelector("b").textContent = `${b.name}`;
    text.querySelector("small").textContent = b.desc;
    const key = document.createElement("kbd");
    key.textContent = String(i + 1);
    row.append(c, text, key);
    row.addEventListener("click", () => {
      setBrush(b.id);
      closeBrushes();
    });
    els.brushList.appendChild(row);
  });
}

function openBrushes() {
  closePalette();
  hideTip();
  renderBrushes();
  els.brushes.hidden = false;
  const tb = els.toolbar.getBoundingClientRect();
  const btn = els.penBtn.getBoundingClientRect();
  els.brushes.style.left = `${tb.right + 8}px`;
  els.brushes.style.top = `${Math.max(8, Math.min(window.innerHeight - els.brushes.offsetHeight - 8, btn.top - 12))}px`;
}

function closeBrushes() {
  els.brushes.hidden = true;
}

function openPalette() {
  closeBrushes();
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

// 竖屏窄 或 横屏矮，都按手机处理
function isMobile() {
  return window.matchMedia("(max-width: 760px), (max-height: 520px)").matches;
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
  keepView();
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
      weak: isMobile(), // 告诉服务端别挑我去烘焙，手机烘一段会卡一下
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
        if (msg.code === "not_found") forgetRoom(state.code); // 墙已经没了，从去过的列表里拿掉
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
      rememberRoom();
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
    case "stroke_replace": {
      if (state.current && state.current.id === msg.id) break;
      const live = state.live.get(msg.id);
      if (live) {
        live.points = msg.points;
        live.shape = msg.shape;
        redrawLive();
      }
      break;
    }
    case "stroke_cancel":
      state.live.delete(msg.id);
      redrawLive();
      break;
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
      renderModeMask(); // 墙长了，右边那块遮挡要跟着铺过去
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
    case "mode": {
      const had = !!(state.mode && state.mode.drawable);
      state.mode = msg.state || null;
      renderModeBar();
      updateExtendUi();
      updateDrawingHint();
      // 刚轮到我：把镜头带到我能画的那一段
      if (!had && state.mode && state.mode.drawable) lookAtDrawable();
      break;
    }
    case "cursors":
      // 服务端把所有人的光标攒成一条发过来，自己那份由 showCursor 跳过
      for (const c of msg.list || []) showCursor(c);
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
    closeBrushes();
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
  } else if (["1", "2", "3", "4"].includes(k)) {
    setBrush(BRUSHES[Number(k) - 1].id);
  } else if (k === "s") {
    cycleStab();
  } else if (k === "e") {
    state.tool = "eraser";
    renderTools();
  } else if (k === "t") {
    state.tool = "text";
    renderTools();
  } else if (k === "h") {
    state.tool = "hand";
    renderTools();
  } else if (k === "c") {
    if (els.palette.hidden) openPalette();
    else closePalette();
  } else if (k === "[") {
    state.size = Math.max(0, state.size - 1);
    renderTools();
  } else if (k === "]") {
    state.size = Math.min(PEN_WIDTHS.length - 1, state.size + 1);
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

// 触屏设备第一次在墙上落指时，提示一次怎么拖动画布
function maybeShowTouchHint() {
  try {
    if (localStorage.getItem("qiang.touchHint")) return;
    localStorage.setItem("qiang.touchHint", "1");
  } catch {
    return;
  }
  toast("单指画 · 双指拖动缩放 · 画完按住不动吸附成形状 · 再点笔可换笔刷", 5000);
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
  state.inputType = e.pointerType;
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capturePointer(e);
    if (touches.size >= 2) {
      // 第二根手指到了：刚起笔不到 0.4 秒的那一笔当作误触撤回；画了一阵的就收笔
      if (state.current && (state.current.pending || Date.now() - state.current.t < 400)) cancelStroke();
      else if (state.drawing) endStroke();
      state.panning = false;
      startGesture();
      return;
    }
    if (state.penSeen || state.tool === "hand") {
      startPan(e);
      maybeShowTouchHint();
      return;
    }
    maybeShowTouchHint();
  } else if (e.button === 1 || (e.button === 0 && (state.space || state.tool === "hand"))) {
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
  if (e.pointerType === "pen" && e.pressure > 0) p.p = Math.round(e.pressure * 100) / 100;
  // 按住 Shift：画直线，松手才定下来
  const shape = e.shiftKey && state.tool !== "text" ? "line" : undefined;
  startStroke(p, e.pointerType === "touch" || !!shape, { shape });
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
    onRawPoints(
      (evs.length ? evs : [e]).map((ev) => {
        const q = clipStroke(at(ev));
        if (ev.pointerType === "pen" && ev.pressure > 0) q.p = Math.round(ev.pressure * 100) / 100;
        return q;
      })
    );
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
  renderHistory();
  showLobbyError(err || "");
  document.title = "墙";
}

function enterWall(code) {
  state.code = code.toUpperCase();
  // 上一面墙的身份和名单要清掉，否则进一面不存在的墙时会被当成「已在墙里」，停在空墙上
  state.you = null;
  state.users = [];
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

// ───────────── 去过的墙：房间码输入框下的可搜索下拉列表 ─────────────

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || "[]");
    return Array.isArray(list) ? list.filter((h) => h && CODE_RE.test(h.code)) : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* 存不了就算了 */
  }
}

// 进墙成功、名单变化时记一笔：房间码、时间、是不是房主、在这面墙遇到过的人
function rememberRoom() {
  if (!state.code || !state.you) return;
  const list = loadHistory();
  const old = list.find((h) => h.code === state.code);
  const others = state.users.filter((u) => u.id !== state.you.id).map((u) => u.name);
  const people = [...new Set([...others, ...((old && old.people) || [])])].slice(0, 6);
  const entry = { code: state.code, t: Date.now(), host: !!state.you.isHost || !!(old && old.host), people };
  saveHistory([entry, ...list.filter((h) => h.code !== state.code)]);
}

function forgetRoom(code) {
  saveHistory(loadHistory().filter((h) => h.code !== code));
}

function timeAgo(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨天";
  if (d < 7) return `${d} 天前`;
  const date = new Date(t);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const hist = { open: false, items: [], active: -1 };

// 把匹配到的那段包进 <mark>（用文本节点拼，不拼 HTML）
function highlight(el, text, q) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) {
    el.append(text);
    return;
  }
  const mark = document.createElement("mark");
  mark.textContent = text.slice(i, i + q.length);
  el.append(text.slice(0, i), mark, text.slice(i + q.length));
}

function renderHistory() {
  const all = loadHistory();
  els.historyToggle.hidden = all.length === 0;
  const q = els.codeInput.value.trim().toLowerCase();
  hist.items = all.filter((h) => !q || h.code.toLowerCase().includes(q) || h.people.some((p) => p.toLowerCase().includes(q)));
  if (hist.active >= hist.items.length) hist.active = hist.items.length - 1;
  els.historyList.replaceChildren();
  if (!hist.items.length) {
    const li = document.createElement("li");
    li.className = "hist-empty";
    li.textContent = q ? "没有匹配的墙" : "还没去过别的墙";
    els.historyList.appendChild(li);
  }
  hist.items.forEach((h, i) => {
    const li = document.createElement("li");
    li.className = "hist-item" + (i === hist.active ? " active" : "");
    li.id = `hist-${h.code}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === hist.active));
    const code = document.createElement("span");
    code.className = "hist-code";
    highlight(code, h.code, q);
    const meta = document.createElement("span");
    meta.className = "hist-meta";
    const who = document.createElement("span");
    who.className = "hist-people";
    if (h.people.length) {
      h.people.forEach((p, k) => {
        if (k) who.append("、");
        highlight(who, p, q);
      });
    } else {
      who.textContent = "只有我";
    }
    const when = document.createElement("span");
    when.className = "hist-when";
    when.textContent = (h.host ? "房主 · " : "") + timeAgo(h.t);
    meta.append(who, when);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "hist-del";
    del.textContent = "×";
    del.title = "从列表里删掉（不会删墙）";
    del.setAttribute("aria-label", `从列表里删掉 ${h.code}`);
    // 用 pointerdown 挡住失焦，列表才不会在点击前收起
    del.addEventListener("pointerdown", (e) => e.preventDefault());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      forgetRoom(h.code);
      renderHistory();
    });
    li.append(code, meta, del);
    li.addEventListener("pointerdown", (e) => e.preventDefault());
    li.addEventListener("click", () => chooseHistory(h));
    els.historyList.appendChild(li);
  });
  els.codeInput.setAttribute("aria-activedescendant", hist.active >= 0 ? `hist-${hist.items[hist.active].code}` : "");
}

function openHistory() {
  if (!loadHistory().length) return;
  hist.open = true;
  hist.active = -1;
  renderHistory();
  els.historyList.hidden = false;
  els.codeInput.setAttribute("aria-expanded", "true");
}

function closeHistory() {
  hist.open = false;
  hist.active = -1;
  els.historyList.hidden = true;
  els.codeInput.setAttribute("aria-expanded", "false");
}

function chooseHistory(h) {
  els.codeInput.value = h.code;
  closeHistory();
  tryJoinFromForm();
}

function moveActive(d) {
  if (!hist.items.length) return;
  hist.active = (hist.active + d + hist.items.length) % hist.items.length;
  renderHistory();
  const el = els.historyList.children[hist.active];
  if (el) el.scrollIntoView({ block: "nearest" });
}

function bindHistory() {
  renderHistory();
  els.codeInput.addEventListener("focus", openHistory);
  els.codeInput.addEventListener("input", () => {
    if (!hist.open) openHistory();
    else {
      hist.active = -1;
      renderHistory();
    }
  });
  els.codeInput.addEventListener("blur", closeHistory);
  els.codeInput.addEventListener("keydown", (e) => {
    if (isImeEnter(e)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!hist.open) openHistory();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter" && hist.open && hist.active >= 0) {
      e.preventDefault();
      chooseHistory(hist.items[hist.active]);
    } else if (e.key === "Escape") {
      closeHistory();
    }
  });
  els.historyToggle.addEventListener("pointerdown", (e) => e.preventDefault());
  els.historyToggle.addEventListener("click", () => {
    if (hist.open) closeHistory();
    else {
      els.codeInput.focus();
      openHistory();
    }
  });
}

function tryJoinFromForm(e) {
  if (e) e.preventDefault();
  let code = els.codeInput.value.trim().toUpperCase();
  if (!code) {
    showLobbyError("请输入房间码");
    return;
  }
  // 输的不是房间码（比如朋友的名字）：进搜索结果里的第一面墙
  if (!CODE_RE.test(code) && hist.items.length) code = hist.items[0].code;
  closeHistory();
  if (!CODE_RE.test(code)) {
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
  bindHistory();
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
    closeBrushes();
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
  els.modeAct.addEventListener("click", () => {
    const cmd = els.modeAct.dataset.cmd;
    if (cmd) modeCmd(cmd);
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
    btn.addEventListener("click", (e) => {
      // 已经拿着笔时再点一下：打开笔刷面板
      if (btn.dataset.tool === "pen" && state.tool === "pen") {
        e.stopPropagation();
        if (els.brushes.hidden) openBrushes();
        else closeBrushes();
        return;
      }
      state.tool = btn.dataset.tool;
      renderTools();
    });
  });
  els.stabBtn.addEventListener("click", cycleStab);
  els.brushes.addEventListener("click", (e) => e.stopPropagation());
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
  // iOS Safari 自己的双指缩放（gesture* 事件）会抢走画布上的双指手势
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }
  els.desk.addEventListener("pointerdown", onPointerDown);
  els.desk.addEventListener("pointermove", onPointerMove);
  els.desk.addEventListener("pointerup", onPointerUp);
  els.desk.addEventListener("pointercancel", onPointerUp);
  els.desk.addEventListener("wheel", onWheel, { passive: false });
  els.desk.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  // 手机上地址栏收起/展开、弹出键盘都会触发 resize：保持当前缩放和看到的位置，不重新回正
  window.addEventListener("resize", () => {
    if (els.wall.hidden) return;
    // 浏览器缩放（Ctrl/⌘ ±）会改像素比：各段画布按新像素比重建，笔迹保持清晰
    if ([...state.tiles.values()].some((t) => t.res !== dpr())) {
      if (state.drawing) endStroke(); // 只有真要重建画布时才收笔；地址栏伸缩这类 resize 不打断正在画的线
      resetTiles();
    }
    keepView();
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
