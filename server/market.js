"use strict";
/* fake stock market: real names, random prices. Every 2s each price takes a random step that is pulled
   back toward its base price (so nothing drifts far away); the volatile names swing harder and
   sometimes jump ±8%. Everyone on the server sees the same prices. */
const fs = require("fs");

const STOCKS = [
  { k: "NVDA", n: "엔비디아", base: 265000, vol: 0.006 },
  { k: "005930", n: "삼성전자", base: 98000, vol: 0.004 },
  { k: "000660", n: "SK하이닉스", base: 420000, vol: 0.005 },
  { k: "GOOGL", n: "구글", base: 350000, vol: 0.004 },
  { k: "TSLA", n: "테슬라", base: 610000, vol: 0.015, jump: 1 },
  { k: "IONQ", n: "아이온큐", base: 62000, vol: 0.025, jump: 1 },
  { k: "086520", n: "에코프로", base: 91000, vol: 0.02, jump: 1 },
];
const PULL = 0.02, CAP = 0.35, HIST = 150, TICK_MS = 2000;
const unit = s => s.base >= 100000 ? 500 : s.base >= 50000 ? 100 : 50;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const BY = Object.fromEntries(STOCKS.map(s => [s.k, s]));

function price(s) { const u = unit(s); return Math.max(u, Math.round(s.base * Math.exp(s.x) / u) * u); }
function step(s) {
  s.x += -PULL * s.x + s.vol * gauss() + (s.jump && Math.random() < 0.01 ? (Math.random() < 0.5 ? -1 : 1) * 0.08 : 0);
  s.x = Math.max(-CAP, Math.min(CAP, s.x));
  s.px = price(s);
  s.hist.push(s.px); if (s.hist.length > HIST) s.hist.shift();
}
let day = kstDay(), file = null;
function init(path) {
  file = path;
  let saved = null; try { saved = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  for (const s of STOCKS) {
    const o = saved && saved.s && saved.s[s.k];
    s.x = o && Number.isFinite(o.x) ? Math.max(-CAP, Math.min(CAP, o.x)) : (Math.random() - 0.5) * 0.04;
    s.hist = o && Array.isArray(o.hist) ? o.hist.filter(Number.isFinite).slice(-HIST) : [];
    s.px = price(s);
    if (!s.hist.length) { for (let i = 0; i < 60; i++) step(s); }
    s.open = o && Number.isFinite(o.open) && saved.day === day ? o.open : s.px;   // 오늘(한국 날짜) 시작가
  }
}
function save() {
  if (!file) return;
  const o = { day, s: Object.fromEntries(STOCKS.map(s => [s.k, { x: s.x, open: s.open, hist: s.hist }])) };
  try { fs.writeFileSync(file + ".tmp", JSON.stringify(o)); fs.renameSync(file + ".tmp", file); } catch (e) { console.error("market save", e.message); }
}
function tick() {
  const d = kstDay();
  if (d !== day) { day = d; for (const s of STOCKS) s.open = s.px; }
  for (const s of STOCKS) step(s);
}
module.exports = {
  TICK_MS, init, save, tick,
  get: k => BY[k],
  full: () => ({ t: "mk", full: 1, list: STOCKS.map(s => ({ k: s.k, n: s.n, px: s.px, open: s.open, hist: s.hist })) }),
  ticks: () => ({ t: "mk", px: STOCKS.map(s => s.px), open: STOCKS.map(s => s.open) }),
  /* value of a holdings object { code: { q, avg } } at current prices */
  value: stk => { let v = 0; for (const [k, h] of Object.entries(stk || {})) { const s = BY[k]; if (s && h) v += s.px * (h.q || 0); } return v; },
};
