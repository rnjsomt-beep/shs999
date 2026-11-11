"use strict";
/* 지뢰찾기 (view "ms", sheet 불량체크): one shared board per room, up to 4 players open it at the same time.
   Every safe cell you reveal (flood fill included) is a point; stepping on a mine costs points and freezes you;
   flags are scored when the board is done (right +3, wrong −3). Mines are placed after the first click, away from it. */
const LEVELS = [
  { k: "초급", w: 9,  h: 9,  m: 10 },
  { k: "중급", w: 16, h: 16, m: 40 },
  { k: "고급", w: 30, h: 16, m: 99 },
];
const MAXP = 4, BOOM = 10, FREEZE = 3000, FLAG_OK = 3, FLAG_BAD = 3;

function makeMs(api, rand = Math.random) {
  let G = fresh(0);
  function fresh(lv) {
    const L = LEVELS[lv];
    return { ph: "lobby", lv, w: L.w, h: L.h, m: L.m, mine: null, open: new Int8Array(L.w * L.h).fill(-1), by: new Int8Array(L.w * L.h).fill(-1),
      flag: new Int8Array(L.w * L.h).fill(-1), pl: [], t0: 0, t1: 0, left: L.w * L.h - L.m, log: [] };
  }
  const P = id => G.pl.find(p => p.id === id);
  const idx = id => G.pl.findIndex(p => p.id === id);
  function log(s) { G.log.unshift(s); if (G.log.length > 5) G.log.length = 5; }
  function around(i, f) {
    const x = i % G.w, y = i / G.w | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < G.w && ny < G.h) f(ny * G.w + nx);
    }
  }
  function lay(first) {
    const n = G.w * G.h, safe = new Set([first]); around(first, j => safe.add(j));
    const cand = []; for (let i = 0; i < n; i++) if (!safe.has(i)) cand.push(i);
    G.mine = new Uint8Array(n);
    for (let k = 0; k < G.m; k++) { const j = k + Math.floor(rand() * (cand.length - k)); [cand[k], cand[j]] = [cand[j], cand[k]]; G.mine[cand[k]] = 1; }
  }
  const count = i => { let c = 0; around(i, j => c += G.mine[j]); return c; };
  /* reveal one cell for player pi; returns how many safe cells got opened, or -1 for a mine */
  function reveal(i, pi) {
    if (G.open[i] >= 0 || G.flag[i] >= 0) return 0;
    if (G.mine[i]) { G.open[i] = 9; G.by[i] = pi; return -1; }
    let n = 0; const st = [i];
    while (st.length) {
      const c = st.pop();
      if (G.open[c] >= 0 || G.mine[c]) continue;
      if (G.flag[c] >= 0) G.flag[c] = -1;            // a wrong flag in the way of a flood is simply cleared
      G.open[c] = count(c); G.by[c] = pi; n++;
      if (G.open[c] === 0) around(c, j => { if (G.open[j] < 0) st.push(j); });
    }
    return n;
  }
  function hit(p, pi, cells) {
    let gained = 0, boom = 0;
    for (const i of cells) { const r = reveal(i, pi); if (r < 0) boom++; else gained += r; }
    p.score += gained; p.cells += gained; G.left -= gained;
    if (boom) { p.score -= BOOM * boom; p.booms += boom; p.frozen = Date.now() + FREEZE; log(p.id + " 지뢰 밟음 −" + BOOM * boom); }
    if (G.left <= 0) finish();
  }
  function finish() {
    G.ph = "over"; G.t1 = Date.now();
    for (let i = 0; i < G.flag.length; i++) {
      const f = G.flag[i]; if (f < 0 || !G.pl[f]) continue;
      if (G.mine[i]) { G.pl[f].score += FLAG_OK; G.pl[f].fok++; } else G.pl[f].score -= FLAG_BAD;
    }
    const rank = [...G.pl].sort((a, b) => b.score - a.score);
    log("완료! 1위 " + (rank[0] ? rank[0].id + " " + rank[0].score + "점" : ""));
    api.emit && api.emit({ ms: 1, k: "done", lv: LEVELS[G.lv].k, rank: rank.map(p => [p.id, p.score]), sec: Math.round((G.t1 - G.t0) / 1000) });
  }

  function handle(id, msg) {
    const t = msg.t, p = P(id), pi = idx(id), now = Date.now();
    if (t === "ms-join") {
      if (p) { G.pl.splice(pi, 1); fixOwners(pi); if (!G.pl.length && G.ph !== "lobby") G = fresh(G.lv); return ""; }
      if (G.ph !== "lobby") return "진행 중: 끝나면 참가할 수 있습니다";
      if (G.pl.length >= MAXP) return "정원 " + MAXP + "명 초과";
      G.pl.push(newP(id)); return "";
    }
    if (t === "ms-reset") {
      if (G.ph === "play" && G.pl.length && !p) return "진행 중에는 참가자만 초기화할 수 있습니다";
      if (G.ph === "play" && !msg.force) return "";
      const ids = G.pl.map(q => q.id), lv = Number.isInteger(msg.lv) && LEVELS[msg.lv] ? msg.lv : G.lv;
      G = fresh(lv); G.pl = ids.map(newP); return "";
    }
    if (!p) return "먼저 참가하세요";
    if (t === "ms-lv") { if (G.ph !== "lobby" || !LEVELS[msg.lv]) return ""; const pl = G.pl; G = fresh(msg.lv); G.pl = pl; pl.forEach(q => q.ready = false); return ""; }
    if (t === "ms-ready") {
      if (G.ph !== "lobby") return "";
      p.ready = !p.ready;
      if (G.pl.every(q => q.ready)) { G.ph = "play"; G.t0 = now; log(G.pl.length + "명 시작 · " + LEVELS[G.lv].k); }
      return "";
    }
    if (G.ph !== "play") return "";
    const i = msg.i;
    if (!Number.isInteger(i) || i < 0 || i >= G.w * G.h) return "";
    if (t === "ms-flag") {
      if (G.open[i] >= 0) return "";
      if (G.flag[i] === pi) G.flag[i] = -1; else if (G.flag[i] < 0) G.flag[i] = pi; else return "다른 사람 표시입니다";
      return "";
    }
    if (p.frozen > now) return "";
    if (t === "ms-open") {
      if (!G.mine) lay(i);
      if (G.open[i] >= 0 && G.open[i] < 9) return chord(p, pi, i);
      hit(p, pi, [i]); return "";
    }
    if (t === "ms-chord") return chord(p, pi, i);
    return "";
  }
  /* click on a number whose flags are all placed → open the rest around it */
  function chord(p, pi, i) {
    const v = G.open[i]; if (v < 1 || v > 8) return "";
    let f = 0; const todo = [];
    around(i, j => { if (G.flag[j] >= 0 || G.open[j] === 9) f++; else if (G.open[j] < 0) todo.push(j); });
    if (f === v && todo.length) hit(p, pi, todo);
    return "";
  }
  const newP = id => ({ id, score: 0, cells: 0, booms: 0, fok: 0, frozen: 0, ready: false });
  /* a player left: their opened cells / flags keep their colour slot only if still valid */
  function fixOwners(gone) {
    const re = v => v === gone ? -1 : v > gone ? v - 1 : v;
    for (let i = 0; i < G.by.length; i++) { G.by[i] = re(G.by[i]); if (G.flag[i] >= 0) G.flag[i] = re(G.flag[i]); }
  }
  function frame() {
    const over = G.ph === "over", now = Date.now();
    let b = "";
    for (let i = 0; i < G.open.length; i++) {
      const o = G.open[i];
      b += o === 9 ? "*" : o >= 0 ? String(o) : G.flag[i] >= 0 ? (over && G.mine && !G.mine[i] ? "X" : "abcd"[G.flag[i]]) : over && G.mine && G.mine[i] ? "m" : ".";
    }
    return { t: "ms", ph: G.ph, lv: G.lv, w: G.w, h: G.h, m: G.m, left: G.left, b, by: Array.from(G.by, v => v < 0 ? "-" : String(v)).join(""),
      sec: G.t0 ? Math.round(((over ? G.t1 : now) - G.t0) / 1000) : 0,
      pl: G.pl.map(q => [q.id, q.score, q.cells, q.booms, Math.max(0, q.frozen - now), q.ready ? 1 : 0, q.fok]), log: G.log };
  }
  function push(only) { const f = JSON.stringify(frame()); for (const id of only ? [only] : api.viewers()) api.sendRaw(id, f); }
  return {
    handle(id, msg) { const e = handle(id, msg); if (e) api.reply(id, e); push(); },
    leave(id) { const pi = idx(id); if (pi < 0) return; G.pl.splice(pi, 1); fixOwners(pi); if (!G.pl.length && G.ph !== "lobby") G = fresh(G.lv); push(); },
    push,
    _G: () => G,
  };
}
makeMs.LEVELS = LEVELS;
module.exports = makeMs;
