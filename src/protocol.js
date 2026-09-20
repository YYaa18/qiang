"use strict";

// 来自客户端的东西一律当作不可信：这里是校验和归一化的唯一入口。

const { CODE_CHARS, UUID_RE, NAME_MAX, SEG_W, CANVAS_H } = require("./config");

function genCode() {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function validUuid(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function validStrokeId(id) {
  return typeof id === "string" && id.length >= 8 && id.length <= 80;
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function validCode(code) {
  return code.length === 4 && [...code].every((c) => CODE_CHARS.includes(c));
}

function cleanName(name) {
  const s = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return s || "朋友";
}

function wallWidth(room) {
  return room.segments * SEG_W;
}

function clipPoint(room, x, y, margin = 0) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  // 坐标保留 1 位小数：肉眼无差别，存储和传输体积减半
  return {
    x: Math.round(Math.max(-margin, Math.min(wallWidth(room) + margin, nx)) * 10) / 10,
    y: Math.round(Math.max(-margin, Math.min(CANVAS_H + margin, ny)) * 10) / 10,
  };
}

// 手写笔的压力（0～1，两位小数）跟着点走；鼠标和手指没有压力，不带
function withPressure(pt, raw) {
  const pr = raw && Number(raw.p);
  if (pt && Number.isFinite(pr) && pr >= 0 && pr <= 1) pt.p = Math.round(pr * 100) / 100;
  return pt;
}

function asPoint(room, p, margin = 0) {
  if (Array.isArray(p) && p.length >= 2) return clipPoint(room, p[0], p[1], margin);
  if (p && typeof p === "object") return clipPoint(room, p.x, p.y, margin);
  return null;
}

function normalizeHex(color) {
  const c = String(color || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) return c.toUpperCase();
  return null;
}

module.exports = {
  genCode,
  validUuid,
  validStrokeId,
  normalizeCode,
  validCode,
  cleanName,
  wallWidth,
  clipPoint,
  withPressure,
  asPoint,
  normalizeHex,
};
