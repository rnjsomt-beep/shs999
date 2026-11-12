"use strict";
/* 지뢰찾기 (view "ms", sheet 불량체크): one shared board per room, up to 4 players taking turns.
   On your turn you open one cell (or a number whose flags are all placed, which opens its neighbours).
   A mine knocks you out; missing your turn twice in a row does too. Last one standing wins — or, if the
   board gets cleared, the survivor who opened the most cells. Flags can be placed any time, they're just notes.
   Mines are placed after the first click, away from it. */
const LEVELS = [
  { k: "초급", w: 9,  h: 9,  m: 10 },
  { k: "중급", w: 16, h: 16, m: 40 },
  { k: "고급", w: 30, h: 16, m: 99 },
];
const MAXP = 4, TURN_MS = 30000, AFK_OUT = 2;

function makeMs(api, rand = Math.random) {
  let G = fresh(0), turnT = 0;
  function fresh(lv) {
    const L = LEVELS[lv];
    return { ph: "lobby", lv, w: L.w, h: L.h, m: L.m, mine: null, open: new Int8Array(L.w * L.h).fill(-1), by: new Int8Array(L.w * L.h).fill(-1),
      flag: new Int8Array(L.w * L.h).fill(-1), pl: [], turn: -1, until: 0, t0: 0, t1: 0, left: L.w * L.h - L.m, log: [], win: "" };
  }
  const idx = id => G.pl.findIndex(p => p.id === id);
  const alive = () => G.pl.filter(p => !p.out);
  function log(s) { G.log.unshift(s); if (G.log.length > 6) G.log.length = 6; }
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
  /* ---------- turns ---------- */
  function setTurn(pi) {
    clearTimeout(turnT);
    G.turn = pi; G.until = Date.now() + TURN_MS;
    turnT = setTimeout(timeout, TURN_MS + 100);
  }
  function nextTurn() {
    if (G.ph !== "play") return;
    const n = G.pl.length;
    for (let k = 1; k <= n; k++) { const j = (G.turn + k) % n; if (!G.pl[j].out) return setTurn(j); }
    finish();
  }
  function timeout() {
    if (G.ph !== "play") return;
    const p = G.pl[G.turn];
    if (p) {
      p.miss++;
      if (p.miss >= AFK_OUT) { p.out = "시간초과"; log(p.id + " 시간 초과 " + AFK_OUT + "회 — 탈락"); }
      else log(p.id + " 시간 초과 — 차례 넘김");
    }
    if (!checkEnd()) nextTurn();
    push();
  }
  /* game over when one player is left (of several), nobody is left, or every safe cell is open */
  function checkEnd() {
    const a = alive();
    if (G.left <= 0 || !a.length || (G.pl.length > 1 && a.length === 1)) { finish(); return true; }
    return false;
  }
  function move(p, pi, cells) {
    let gained = 0, boom = false;
    for (const i of cells) { const r = reveal(i, pi); if (r < 0) boom = true; else gained += r; }
    p.cells += gained; G.left -= gained; p.miss = 0;
    if (boom) { p.out = "지뢰"; log(p.id + " 지뢰를 밟아 탈락!"); }
    else if (gained) log(p.id + " +" + gained + "칸");
    if (!checkEnd()) nextTurn();
  }
  function finish() {
    clearTimeout(turnT);
    G.ph = "over"; G.t1 = Date.now(); G.turn = -1;
    const a = alive(), cleared = G.left <= 0;
    // ranking: survivors first (most cells), then the knocked out by how many cells they opened
    const rank = [...G.pl].sort((x, y) => (!!x.out - !!y.out) || (y.cells - x.cells));
    const w = a.length ? rank[0] : null;
    G.win = w ? w.id : "";
    log(w ? "🏆 " + w.id + " 승리" + (cleared ? " (판 완료 · " + w.cells + "칸)" : " (최후 생존)") : "전원 탈락");
    api.emit && api.emit({ ms: 1, k: "done", lv: LEVELS[G.lv].k, win: G.win, rank: rank.map(p => [p.id, p.cells, p.out ? 1 : 0]), sec: Math.round((G.t1 - G.t0) / 1000) });
  }

  function handle(id, msg) {
    const t = msg.t, pi = idx(id), p = G.pl[pi];
    if (t === "ms-join") {
      if (p) { drop(pi); return ""; }
      if (G.ph !== "lobby") return "진행 중: 끝나면 참가할 수 있습니다";
      if (G.pl.length >= MAXP) return "정원 " + MAXP + "명 초과";
      G.pl.push(newP(id)); return "";
    }
    if (t === "ms-reset") {
      if (G.ph === "play" && (!p || !msg.force)) return "";
      clearTimeout(turnT);
      const ids = G.pl.map(q => q.id), lv = Number.isInteger(msg.lv) && LEVELS[msg.lv] ? msg.lv : G.lv;
      G = fresh(lv); G.pl = ids.map(newP); return "";
    }
    if (!p) return "먼저 참가하세요";
    if (t === "ms-lv") { if (G.ph !== "lobby" || !LEVELS[msg.lv]) return ""; const pl = G.pl; G = fresh(msg.lv); G.pl = pl; pl.forEach(q => q.ready = false); return ""; }
    if (t === "ms-ready") {
      if (G.ph !== "lobby") return "";
      p.ready = !p.ready;
      if (G.pl.every(q => q.ready)) {
        // random seat order, the first in it starts
        for (let k = G.pl.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [G.pl[k], G.pl[j]] = [G.pl[j], G.pl[k]]; }
        G.ph = "play"; G.t0 = Date.now(); setTurn(0);
        log(G.pl.length + "명 시작 · " + LEVELS[G.lv].k + " · 순서 " + G.pl.map(q => q.id).join(" → "));
      }
      return "";
    }
    if (G.ph !== "play") return "";
    const i = msg.i;
    if (!Number.isInteger(i) || i < 0 || i >= G.w * G.h) return "";
    if (t === "ms-flag") {
      if (p.out || G.open[i] >= 0) return "";
      if (G.flag[i] === pi) G.flag[i] = -1; else if (G.flag[i] < 0) G.flag[i] = pi; else return "다른 사람 표시입니다";
      return "";
    }
    if (t === "ms-open") {
      if (p.out) return "탈락했습니다 · 관전 중";
      if (G.turn !== pi) return G.pl[G.turn].id + " 님 차례입니다";
      if (G.flag[i] >= 0) return "표시된 칸입니다 (표시를 먼저 지우세요)";
      if (!G.mine) lay(i);
      const v = G.open[i];
      if (v >= 1 && v <= 8) {   // a number: open the rest around it when its flags are all placed
        let f = 0; const todo = [];
        around(i, j => { if (G.flag[j] >= 0 || G.open[j] === 9) f++; else if (G.open[j] < 0) todo.push(j); });
        if (f !== v || !todo.length) return "주변 표시 수가 숫자와 맞아야 합니다";
        move(p, pi, todo); return "";
      }
      if (v >= 0) return "";
      move(p, pi, [i]); return "";
    }
    return "";
  }
  const newP = id => ({ id, cells: 0, out: "", miss: 0, ready: false });
  /* leaving: during a game it counts as dropping out; seat indices shift so cell colours and the turn are remapped */
  function drop(pi) {
    const wasTurn = G.ph === "play" && G.turn === pi;
    G.pl.splice(pi, 1);
    const re = v => v === pi ? -1 : v > pi ? v - 1 : v;
    for (let i = 0; i < G.by.length; i++) { G.by[i] = re(G.by[i]); if (G.flag[i] >= 0) G.flag[i] = re(G.flag[i]); }
    if (!G.pl.length) { clearTimeout(turnT); if (G.ph !== "lobby") G = fresh(G.lv); return; }
    if (G.ph !== "play") return;
    if (G.turn > pi) G.turn--;
    if (checkEnd()) return;
    if (wasTurn) { G.turn = (pi - 1 + G.pl.length) % G.pl.length; nextTurn(); }
  }
  function frame() {
    const over = G.ph === "over", now = Date.now();
    let b = "";
    for (let i = 0; i < G.open.length; i++) {
      const o = G.open[i];
      b += o === 9 ? "*" : o >= 0 ? String(o) : G.flag[i] >= 0 ? (over && G.mine && !G.mine[i] ? "X" : "abcd"[G.flag[i]]) : over && G.mine && G.mine[i] ? "m" : ".";
    }
    return { t: "ms", ph: G.ph, lv: G.lv, w: G.w, h: G.h, m: G.m, left: G.left, b, by: Array.from(G.by, v => v < 0 ? "-" : String(v)).join(""),
      sec: G.t0 ? Math.round(((over ? G.t1 : now) - G.t0) / 1000) : 0, turn: G.turn, tl: G.ph === "play" ? Math.max(0, G.until - now) : 0, win: G.win,
      pl: G.pl.map(q => [q.id, q.cells, q.out, q.miss, q.ready ? 1 : 0]), log: G.log };
  }
  function push(only) { const f = JSON.stringify(frame()); for (const id of only ? [only] : api.viewers()) api.sendRaw(id, f); }
  return {
    handle(id, msg) { const e = handle(id, msg); if (e) api.reply(id, e); push(); },
    leave(id) { const pi = idx(id); if (pi < 0) return; drop(pi); push(); },
    push,
    _G: () => G,
  };
}
makeMs.LEVELS = LEVELS;
module.exports = makeMs;
