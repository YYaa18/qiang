"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  // VPS 上放在 Caddy 后面时设成 127.0.0.1，不把端口直接暴露到公网
  HOST: process.env.HOST || "0.0.0.0",
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, "data", "rooms"),
  PUBLIC_DIR: path.join(ROOT, "public"),

  CODE_CHARS: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  PALETTE: ["#C43C3C", "#3B5BDB", "#2F9E44", "#E67700"],
  // 5 档粗细；3、18 是旧版的档位，没刷新的旧页面还会发过来
  PEN_WIDTHS: new Set([2, 4, 8, 14, 24, 3, 18]),
  ERASER_WIDTHS: new Set([8, 14, 24, 36, 56, 18]),
  BRUSHES: new Set(["pen", "ink", "marker", "pencil"]),
  SHAPES: new Set(["line", "rect", "ellipse"]),
  MAX_POINTS: 5000,
  MAX_USERS: 4,
  GRACE_MS: 10_000,
  CHAT_MAX: 100,
  UNDO_MAX: 50,
  NAME_MAX: 16,
  IDLE_EVICT_MS: Number(process.env.QIANG_IDLE_EVICT_MS) || 10 * 60 * 1000, // 空了这么久就从内存里请出去
  SWEEP_MS: Number(process.env.QIANG_SWEEP_MS) || 60 * 1000,

  // 墙是横向卷轴：由若干段拼成，每段 SEG_W×CANVAS_H，坐标全局连续
  SEG_W: 1600,
  CANVAS_H: 1000,
  // 卷轴可以一直接长；这里只是防滥用的保险值（导出时超长会按比例缩小）
  MAX_SEGMENTS: 500,

  // 冻结：只保留最新的 LIVE_KEEP 笔为矢量；多出 BAKE_BATCH 笔时，把更早的笔烘焙进每段的墨迹图
  LIVE_KEEP: Number(process.env.QIANG_LIVE_KEEP) || 150,
  BAKE_BATCH: Number(process.env.QIANG_BAKE_BATCH) || 200,
  BAKE_TIMEOUT_MS: 30_000,
  BAKE_RETRY_MS: 1000,
  BAKE_RETRY_MAX_MS: 60_000,
  BAKE_GIVE_UP: 6,
  BAKE_MAX_BYTES: 30 * 1024 * 1024,

  CURSOR_FLUSH_MS: 50, // 约 20Hz，肉眼看不出和实时的差别

  // 笔画点允许超出纸面的余量：canvas 自己会裁掉，避免拖出纸边时贴边画线
  STROKE_MARGIN: 40,
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,

  MIME: {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
  },
};
