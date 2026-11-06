"use strict";
/* game engine for one room — moved here from the browser host (index.html) so the server is the only
   source of truth: nobody is "the host", leaving never resets anyone, hidden cards stay on the server.
   Player id = player name (one connection per name), so a reconnect picks the same seat back up. */
const { webcrypto } = require("crypto");
const crypto = globalThis.crypto || webcrypto;
const SPIN_MS = 3200;
const EMO = ["🤡", "😜", "🫵", "🤣", "😭", "💸", "🥱", "👋"];

module.exports = function makeRoom(code, ctx) {
const ADM_NAMES = ["성호", "관리성호"], isAdm = n => ADM_NAMES.includes(n);
const EVT_NAME = "성호", EVT_MS = 10000, EVT_MAX = 50000000, EVT_BILLS = [10000, 50000, 100000, 300000, 500000, 1000000, 3000000];
const START = 1000000, MAX = 10, AMTS = [10000, 50000, 100000, 500000, 1000000, 10000000], NROWS = 44;
/* event alerts: tune these to change what counts as "special" */
const EV_ALLIN_MIN = 100000;   // all-in win only announced when the stake was at least this
const EV_BIG = 2000000;        // net win >= this → "대박"
const EV_JACKPOT = 10000000;   // net win >= this → "잭팟"
const EV_SPECIAL_MIN = 100000; // stake needed for tie / straight-up / blackjack call-outs
const GNAME = { bac: "바카라", rl: "룰렛", bj: "블랙잭", hd: "홀덤", sk: "주식", pk: "빠칭코", sl: "슬롯", to: "토토" };
const SK_FEE = 0.001;   // 주식 매수·매도 수수료 0.1%
const SB = 5000, BB = 10000, TURN_MS = 30000, NEXT_MS = 5000;
const GAMES = ["bac", "rl", "bj", "hd", "to"];
const VIEWS = {
  bac:   [34, 62, 30, 40, 40, 44, 50, 62, 66, 52],
  rl:    [30, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 34],
  bj:    [52, 56, 38, 38, 38, 38, 38, 36, 50, 56],
  hd:    [58, 64, 38, 38, 38, 38, 42, 50, 62, 58],
  pk: [40, ...Array(19).fill(19)],
  sl: [24, ...Array(5).fill([20, 20, 20, 3]).flat()],
  to: [36, ...Array(21).fill(16)],
  decoy: [44, 62, 70, 34, 44, 50, 50, 66],
  ch: [34, 34, 34, 34, 34, 34, 34, 34, 34],
  om: [26, ...Array(15).fill(24)],
  c4: [34, ...Array(7).fill(42)],
  tw: [26, ...Array(21).fill(18)],
  rd: [26, ...Array(14).fill(48)],
  sk: [64],
  rk: [34, 70, 84, 96, 116, 84],
  cfg: [84, 96, 110, 260],
};
const fmt = n => Math.round(n).toLocaleString("ko-KR");
const man = n => n >= 10000 && n % 10000 === 0 ? n / 10000 + "만" : fmt(n);
/* ---------- cards: 0–51, rank = n%13+1, suit = n/13 ---------- */
const rnd = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; };
const draw = () => rnd() % 52;
const rank = c => c % 13 + 1;
const SUIT = ["♠", "♥", "♦", "♣"], RK = [, "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const label = c => c < 0 ? "??" : RK[rank(c)] + SUIT[Math.floor(c / 13)];
const isRed = c => { const s = Math.floor(c / 13); return c >= 0 && (s === 1 || s === 2); };

/* baccarat */
const bv = c => (rank(c) >= 10 ? 0 : rank(c));
const btot = cs => cs.reduce((s, c) => s + bv(c), 0) % 10;
function bacPlay() {
  const P = [draw(), draw()], B = [draw(), draw()];
  let p = btot(P), b = btot(B);
  if (p < 8 && b < 8) {
    let xv = null;
    if (p <= 5) { const x = draw(); P.push(x); xv = bv(x); }
    let d;
    if (xv === null) d = b <= 5;
    else if (b <= 2) d = true;
    else if (b === 3) d = xv !== 8;
    else if (b === 4) d = xv >= 2 && xv <= 7;
    else if (b === 5) d = xv >= 4 && xv <= 7;
    else if (b === 6) d = xv === 6 || xv === 7;
    else d = false;
    if (d) B.push(draw());
    p = btot(P); b = btot(B);
  }
  return { P, B, p, b, w: p > b ? "P" : b > p ? "B" : "T" };
}
function bacPay(bet, w) {
  if (w === "P") return bet.p * 2;
  if (w === "B") return Math.floor(bet.b * 1.95);
  return bet.t * 9 + bet.p + bet.b;
}
const W = { P: ["P", "in"], B: ["B", "out"], T: ["T", "hold"] };

/* roulette (single zero) */
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const RL_KEYS = new Set(["red","black","odd","even","low","high","d1","d2","d3","c1","c2","c3"]);
for (let i = 0; i <= 36; i++) RL_KEYS.add("n" + i);
const RL_NAME = { red: "RED", black: "BLK", odd: "홀", even: "짝", low: "1-18", high: "19-36", d1: "1~12", d2: "13~24", d3: "25~36", c1: "열1", c2: "열2", c3: "열3" };
const rlName = k => RL_NAME[k] || k.slice(1);
const rlCls = n => n === 0 ? "hold" : REDS.has(n) ? "red" : "";
function rlMult(k, n) {
  if (k[0] === "n") return +k.slice(1) === n ? 36 : 0;
  if (n === 0) return 0;
  switch (k) {
    case "red": return REDS.has(n) ? 2 : 0;
    case "black": return REDS.has(n) ? 0 : 2;
    case "odd": return n % 2 ? 2 : 0;
    case "even": return n % 2 ? 0 : 2;
    case "low": return n <= 18 ? 2 : 0;
    case "high": return n >= 19 ? 2 : 0;
    case "d1": return n <= 12 ? 3 : 0;
    case "d2": return n >= 13 && n <= 24 ? 3 : 0;
    case "d3": return n >= 25 ? 3 : 0;
    case "c1": return n % 3 === 1 ? 3 : 0;
    case "c2": return n % 3 === 2 ? 3 : 0;
    case "c3": return n % 3 === 0 ? 3 : 0;
  }
  return 0;
}

/* blackjack */
function hv(cs) {
  let s = 0, ace = false;
  for (const c of cs) { if (c < 0) continue; const r = Math.min(rank(c), 10); s += r; if (r === 1) ace = true; }
  return ace && s + 10 <= 21 ? s + 10 : s;
}
const isBJ = cs => cs.length === 2 && hv(cs) === 21;

/* hold'em hand evaluation: score = [category, ...tiebreakers], compared left to right */
const HNAME = ["하이카드", "원페어", "투페어", "트리플", "스트레이트", "플러시", "풀하우스", "포카드", "스트레이트플러시"];
function eval5(cs) {
  const v = cs.map(c => (c % 13 === 0 ? 14 : c % 13 + 1)).sort((a, b) => b - a);
  const fl = cs.every(c => Math.floor(c / 13) === Math.floor(cs[0] / 13));
  const cnt = {}; v.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  const g = Object.entries(cnt).map(([x, n]) => [n, +x]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const uq = [...new Set(v)];
  let st = 0;
  if (uq.length === 5) { if (uq[0] - uq[4] === 4) st = uq[0]; else if (uq.join() === "14,5,4,3,2") st = 5; }
  if (st && fl) return [8, st];
  if (g[0][0] === 4) return [7, g[0][1], g[1][1]];
  if (g[0][0] === 3 && g[1][0] === 2) return [6, g[0][1], g[1][1]];
  if (fl) return [5, ...v];
  if (st) return [4, st];
  if (g[0][0] === 3) return [3, ...g.map(x => x[1])];
  if (g[0][0] === 2 && g[1][0] === 2) return [2, ...g.map(x => x[1])];
  if (g[0][0] === 2) return [1, ...g.map(x => x[1])];
  return [0, ...v];
}
function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
const COMBOS = {};
function combos(n) {
  if (COMBOS[n]) return COMBOS[n];
  const out = [];
  const go = (start, pick) => { if (pick.length === 5) { out.push(pick.slice()); return; } for (let i = start; i < n; i++) { pick.push(i); go(i + 1, pick); pick.pop(); } };
  go(0, []);
  return COMBOS[n] = out;
}
function bestHand(cs) {
  let best = null;
  for (const k of combos(cs.length)) { const s = eval5(k.map(i => cs[i])); if (!best || cmp(s, best) > 0) best = s; }
  return best;
}
function handName(cs) {
  if (cs.length >= 5) return HNAME[bestHand(cs)[0]];
  return cs.length === 2 && rank(cs[0]) === rank(cs[1]) ? "원페어" : "하이카드";
}
/* Monte Carlo win share for my two cards vs `opp` random hands */
const eqCache = new Map();
function equity(mine, board, opp, iters = 500) {
  const key = mine.join() + "|" + board.join() + "|" + opp;
  if (eqCache.has(key)) return eqCache.get(key);
  const known = new Set([...mine, ...board]);
  const rest = [...Array(52).keys()].filter(c => !known.has(c));
  let score = 0;
  for (let it = 0; it < iters; it++) {
    const need = 5 - board.length + opp * 2;
    for (let i = 0; i < need; i++) { const j = i + rnd() % (rest.length - i); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const b = board.concat(rest.slice(0, 5 - board.length));
    const me = bestHand(mine.concat(b));
    let ties = 1, lost = false;
    for (let o = 0; o < opp; o++) {
      const k = 5 - board.length + o * 2;
      const c = cmp(bestHand([rest[k], rest[k + 1]].concat(b)), me);
      if (c > 0) { lost = true; break; }
      if (c === 0) ties++;
    }
    if (!lost) score += 1 / ties;
  }
  const eq = score / iters;
  if (eqCache.size > 50) eqCache.clear();
  eqCache.set(key, eq);
  return eq;
}

const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const empty = () => ({ p: 0, b: 0, t: 0 });

/* ---------- pachinko: one machine, 5 seats (H.pk[i] = seat i) all shooting into the same pin field. A shot = 10 balls through an 8-row pin field
   (each pin: left/right) into 9 pockets; the middle pocket is START → 3-digit reel.
   RTP ≈ 99% with most balls paying something: pockets 2·(10 + 8·2 + 28·1 + 56·0.6)/256 + 70/256 · reel(777 ×100, other triple ×30, pair ×0.8) */
const PK_N = 5, PK_BALLS = 10, PK_AMTS = [1000, 10000, 100000, 1000000], PK_BIN = [10, 2, 1, 0.6, -1, 0.6, 1, 2, 10], PK_GAP = 1200;
function pkShot(amt) {
  const balls = [];
  for (let i = 0; i < PK_BALLS; i++) {
    const r = rnd(), path = []; let k = 0;
    for (let j = 0; j < 8; j++) { const b = (r >> j) & 1; path.push(b); k += b; }
    const ball = { path, bin: k, win: 0 };
    if (PK_BIN[k] >= 0) ball.win = Math.floor(amt * PK_BIN[k]);
    else {
      const d = [1 + rnd() % 7, 1 + rnd() % 7, 1 + rnd() % 7]; ball.reel = d;
      const m = d[0] === d[1] && d[1] === d[2] ? (d[0] === 7 ? 100 : 30) : d[0] === d[1] || d[1] === d[2] || d[0] === d[2] ? 0.8 : 0;
      ball.win = Math.floor(amt * m);
    }
    balls.push(ball);
  }
  return balls;
}
const pkSeat = id => H.pk.findIndex(m => m.id === id);
function pkLeave(id) { for (const m of H.pk) if (m.id === id) m.id = null; for (const m of H.sl) if (m.id === id) m.id = null; }

/* ---------- slots: 5 machines side by side, one player each, 3 reels, middle row pays.
   Reel strip weights 🍒8 🍋7 🍊6 🔔5 ⭐3 💎2 7️⃣1 (/32 each reel); three of a kind ×5/10/15/25/80/250/1000,
   exactly two 🍒 ×2, exactly one 🍒 ×0.4 → RTP ≈ 98.5%, something comes back on ~60% of spins */
const SL_N = 5, SL_W = [8, 7, 6, 5, 3, 2, 1], SL_PAY = [5, 10, 15, 25, 80, 250, 1000], SL_AMTS = [1000, 10000, 100000, 1000000], SL_GAP = 900;
const slSym = () => { let r = rnd() % 32; for (let k = 0; k < SL_W.length; k++) { if (r < SL_W[k]) return k; r -= SL_W[k]; } return 0; };
function slSpin(amt) {
  const reels = [0, 1, 2].map(() => [slSym(), slSym(), slSym()]), mid = reels.map(r => r[1]);
  const cherries = mid.filter(k => k === 0).length;
  const m = mid[0] === mid[1] && mid[1] === mid[2] ? SL_PAY[mid[0]] : cherries === 2 ? 2 : cherries === 1 ? 0.4 : 0;
  return { reels, mult: m, win: Math.floor(amt * m) };
}

/* ---------- sports toto: next match is known (teams + odds) while betting; everyone on the sheet
   ready → the match is simulated here (ball frames for the pitch animation) and every bet settles */
// strength 71–82 (was 66–88: the favourite won ~80% at 1.1x, the underdog almost never) — same order, half the gap
const TO_TEAMS = [["한강 FC", 79], ["낙동 유나이티드", 77], ["태백 레인저스", 75], ["제주 웨이브", 74], ["금강 타이거즈", 78], ["소백 이글스", 72],
  ["영산 드래곤즈", 76], ["동해 샤크스", 74], ["서해 마린스", 71], ["지리 울브스", 81], ["설악 베어스", 73], ["백두 스톰", 82]];
/* team table: name -> [win, draw, loss, goals for, goals against], every match since records began */
function toTm(home, away, hg, ag) {
  for (const [t, f, a] of [[home, hg, ag], [away, ag, hg]]) {
    const r = H.to.tm[t] || (H.to.tm[t] = [0, 0, 0, 0, 0]);
    r[f > a ? 0 : f === a ? 1 : 2]++; r[3] += f; r[4] += a;
  }
}
const TO_KEYS = ["h", "d", "a", "un", "ov"], TO_MS = 8000, TO_MARGIN = 0.92;
const poi = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function toNext(n) {
  const i = rnd() % TO_TEAMS.length; let j = rnd() % (TO_TEAMS.length - 1); if (j >= i) j++;
  const [hn, hr] = TO_TEAMS[i], [an, ar] = TO_TEAMS[j], f = ((hr + (rnd() % 9) - 4) - (ar + (rnd() % 9) - 4)) / 20;
  const lh = 1.35 * Math.exp(f / 2) * 1.12, la = 1.35 * Math.exp(-f / 2) / 1.12;
  let ph = 0, pd = 0, pu = 0;
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) { const q = poi(lh, x) * poi(la, y); if (x > y) ph += q; else if (x === y) pd += q; if (x + y <= 2) pu += q; }
  const od = p => Math.max(1.05, Math.floor(TO_MARGIN / p * 100) / 100);
  return { n, home: hn, away: an, lh, la, odds: { h: od(ph), d: od(pd), a: od(1 - ph - pd), un: od(pu), ov: od(1 - pu) } };
}
/* frames = [x 0–20, y 0–10, side with the ball 0 home/1 away, kind 0 play/1 attack/2 goal/3 shot wide], 2 per minute */
function toSim(M) {
  const mins = 90 + rnd() % 5, goals = [], fr = [];
  for (let m = 1; m <= mins; m++) for (const [s, l] of [[0, M.lh], [1, M.la]]) if (rnd() / 4294967296 < l / 90 && !goals.some(g => g.m === m)) goals.push({ m, s });
  let x = 10, y = 5, p = rnd() & 1;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  for (let m = 1; m <= mins; m++) {
    const g = goals.find(e => e.m === m);
    for (let h = 0; h < 2; h++) {
      if (g) {
        // build-up, then the ball in the net, then kick-off for the other side
        p = g.s;
        if (h === 0) { x = p ? 3 : 17; y = clamp(y, 3, 7); fr.push([x, y, p, 1]); }
        else { fr.push([p ? 0 : 20, 5, p, 2]); x = 10; y = 5; p = 1 - g.s; }
        continue;
      }
      if (rnd() % 100 < 14) p = 1 - p;
      const dir = p ? -1 : 1;
      x = clamp(x + dir * ((rnd() % 4) - 1), 1, 19); y = clamp(y + (rnd() % 3) - 1, 1, 9);
      if ((p === 0 && x >= 19) || (p === 1 && x <= 1)) { fr.push([x, y, p, 3]); x = p ? 3 : 17; y = 5; p = 1 - p; continue; }  // shot wide → goal kick
      fr.push([x, y, p, 0]);
    }
  }
  return { goals, fr, mins };
}
function runTo() {
  const M = H.to.next, sim = toSim(M), hg = sim.goals.filter(g => !g.s).length, ag = sim.goals.length - hg;
  const hit = { h: hg > ag, d: hg === ag, a: hg < ag, un: hg + ag <= 2, ov: hg + ag > 2 };
  for (const q of H.players.values()) {
    const s = sum(q.to); if (!s) continue;
    let ret = 0; for (const [k, a] of Object.entries(q.to)) if (hit[k]) ret += Math.floor(a * M.odds[k]);
    const allin = q.chips === 0 && !sum(q.bac) && !sum(q.rl) && !q.bj.bet;
    q.chips += ret; q.lastNet = ret - s; rec(q, "to", s, ret);
    announce(q, "to", s, ret, allin, ret >= s * 4 && s >= EV_SPECIAL_MIN ? "고배당 적중" : "", TO_MS + 300);
    q.lb = { ...q.lb, to: { ...q.to } }; q.to = {};
  }
  H.to.last = { ...M, ...sim, hg, ag };
  H.to.hist = [{ n: M.n, home: M.home, away: M.away, hg, ag }, ...H.to.hist].slice(0, 9);   // 8 rows on the sheet + the match being shown
  toTm(M.home, M.away, hg, ag);
  H.to.until = Date.now() + TO_MS;
  H.to.next = toNext(M.n + 1);
  setTimeout(broadcast, TO_MS + 50);
}

function newPlayer(name) {
  return { name, chips: START, lastNet: 0, bac: empty(), rl: {}, bj: { bet: 0, cards: [], done: false, res: "" }, ready: { bac: false, rl: false, bj: false, hd: false, to: false }, spec: {}, to: {}, hdSeat: false, rebuy: 0, rdReady: false, vw: "bac",
    peak: START, st: { bac: { n: 0, w: 0, l: 0, net: 0 }, rl: { n: 0, w: 0, l: 0, net: 0 }, bj: { n: 0, w: 0, l: 0, net: 0, push: 0, bj: 0, bust: 0 }, hd: { n: 0, w: 0, l: 0, net: 0, sd: 0 }, sk: { n: 0, w: 0, l: 0, net: 0 }, pk: { n: 0, w: 0, l: 0, net: 0 }, sl: { n: 0, w: 0, l: 0, net: 0 }, to: { n: 0, w: 0, l: 0, net: 0 } }, stk: {} };
}
function rec(q, g, s, ret, res) {
  const t = q.st[g];
  t.n++; t.net += ret - s;
  if (ret > s) t.w++; else if (ret < s) t.l++; else if (g === "bj") t.push++;
  if (res === "BJ 승") t.bj++;
  if (res === "버스트") t.bust++;
  q.peak = Math.max(q.peak, q.chips);
}
function snapshot(forId) {
  const hide = H.bj.phase === "play";
  return { t: "state", code, chat: H.chat, mg: H.mg, rdGo: H.rdGo || 0, skLog: H.skLog || [],
    bac: H.bac, rl: H.rl, pk: H.pk, sl: H.sl, to: { next: H.to.next, last: H.to.last, hist: H.to.hist, tm: H.to.tm, live: Math.max(0, H.to.until - Date.now()) },
    bj: { phase: H.bj.phase, n: H.bj.n, ds: H.bj.ds, dealer: hide ? [H.bj.dealer[0], -1] : H.bj.dealer },
    hd: hdView(forId),
    board: ctx.board(), adm: {}, wd: ctx.wdView(forId), players: [...H.players].map(([id, p]) => ({ id, ...p, off: !conns.has(id) })) };
}
/* random defense: everyone ready → bump rdGo, each client starts its own run on seeing it */
function rdReadyCheck() {
  const ps = [...H.players.values()].filter(q => q.vw === "rd");
  if (!ps.length || !ps.every(q => q.rdReady)) return;
  for (const q of ps) { q.rdReady = false; q.rd = null; }
  H.rdGo = (H.rdGo || 0) + 1;
}
function take(id, p, a) { if (p.chips < a) { reply(id, "잔액 부족: 가용 " + fmt(p.chips)); return false; } p.chips -= a; return true; }
/* chip amounts, or any amount from the %/slider picker (1,000 steps) */
const validBet = m => m.all === true || (Number.isInteger(m.amt) && m.amt >= 1000 && m.amt <= 1e13 && m.amt % 1000 === 0);
/* returns the amount actually put on the table (0 = refused); all:true = whole balance */
function stake(id, p, msg) {
  if (msg.all === true) { const a = p.chips; if (a <= 0) { reply(id, "잔액 부족: 가용 0"); return 0; } p.chips = 0; return a; }
  return take(id, p, msg.amt) ? msg.amt : 0;
}

/* called once per settled stake; only wins that are all-in / huge / special get announced */
function announce(q, g, stake, ret, allin, special, delay) {
  const net = ret - stake;
  if (net <= 0) return;
  const tags = [];
  if (allin && stake >= EV_ALLIN_MIN) tags.push("올인 성공");
  if (net >= EV_JACKPOT) tags.push("잭팟"); else if (net >= EV_BIG) tags.push("대박");
  if (special) tags.push(special);
  if (!tags.length) return;
  const kind = net >= EV_JACKPOT ? "jackpot" : net >= EV_BIG ? "big" : tags[0] === "올인 성공" ? "allin" : "special";
  emit({ name: q.name, g: GNAME[g], tags, net, kind }, delay);
}
function hostHandle(id, msg) {
  const p = H.players.get(id);
  if (p && msg.t === "chat") {
    const m = String(msg.m || "").trim().slice(0, 60), n = Date.now();
    if (!m || n - (p.ct || 0) < 400) return;
    p.ct = n; H.chat.push({ n: p.name, m, e: msg.e === true && EMO.includes(m), t: n, k: ++H.cs });
    if (H.chat.length > 40) H.chat.shift();
    broadcast(); return;
  }
  if (p && msg.t === "rd") {
    const d = msg.d || {}, ni = (v, hi) => Math.max(0, Math.min(hi, Math.floor(Number(v)) || 0));
    if (Array.isArray(d.sl) && d.sl.length === 60 && Array.isArray(d.en) && Array.isArray(d.up)) {
      p.rd = { sl: d.sl.map(v => Number.isInteger(v) && v >= -1 && v < 24 ? v : -1), up: [0, 1, 2, 3, 4, 5].map(i => ni(d.up[i], 12)), gold: ni(d.gold, 1e9), stage: ni(d.stage, 50), t: Math.max(0, Number(d.t) || 0), clock: Math.max(0, Number(d.clock) || 0), run: !!d.run, over: d.over === "lose" || d.over === "clear" ? d.over : "", msg: String(d.msg || "").slice(0, 40), en: d.en.slice(0, 100).map(a => [Math.max(0, Number(a && a[0]) || 0), ni(a && a[1], 2), Math.max(0, Math.min(10, Number(a && a[2]) || 0))]), bi: Number.isInteger(d.bi) && d.bi >= 0 && d.bi < 5 ? d.bi : -1, bh: Math.max(0, Math.min(1, Number(d.bh) || 0)), bt: Math.max(0, Math.min(999, Number(d.bt) || 0)) };
      if (!H.rdT) H.rdT = setTimeout(() => { H.rdT = 0; broadcast(); }, 900);
    }
    return;
  }
  if (p && msg.t === "rd-ev") {
    const e = msg.e || {}, n = Date.now(), ni = (v, hi) => Math.max(0, Math.min(hi, Math.floor(Number(v)) || 0)), ev = { rd: 1, name: p.name, k: e.k };
    if (e.k === "gb" && Number.isInteger(e.g) && RD_GB[e.g]) { if (n - (p.rt || 0) < 250) return; p.rt = n; Object.assign(ev, { g: e.g, a: ni(e.a, 1e9), win: e.win === true }); }
    else if (e.k === "un" && (e.t === 4 || e.t === 5) && Number.isInteger(e.u) && e.u >= 0 && e.u < 4) Object.assign(ev, { t: e.t, u: e.u, via: e.via ? 1 : 0 });
    else if (e.k === "die") Object.assign(ev, { s: ni(e.s, 50), b: Number.isInteger(e.b) && e.b >= 0 && e.b < 5 ? e.b : -1 });
    else if (e.k !== "clear") return;
    emit(ev); return;
  }
  if (p && msg.t === "rd-ready") { p.rdReady = !p.rdReady; rdReadyCheck(); broadcast(); return; }
  if (p && String(msg.t).startsWith("g-")) { mgHandle(id, msg); return; }
  if (!p) return;
  /* spectators watch a game without betting; the round no longer waits for them to be ready */
  const BET_G = { "bac-add": "bac", "rl-add": "rl", "bj-add": "bj", "bj-double": "bj", "to-add": "to", "hd-seat": "hd", "rebet": msg.g };
  if (BET_G[msg.t] && p.spec && p.spec[BET_G[msg.t]]) { reply(id, "관전 중: 관전 해제 후 참여"); return; }
  if (msg.t === "spec" && GAMES.includes(msg.g)) {
    const g = msg.g;
    p.spec = p.spec || {};
    if (!p.spec[g]) {
      if (g === "bj" && p.bj.bet && H.bj.phase !== "bet") { reply(id, "진행 중인 판이 끝나고 관전"); return; }
      if (g === "to" && sum(p.to) && H.to.until > Date.now()) { reply(id, "경기가 끝나고 관전"); return; }
      // bets not dealt yet go back to the balance
      if (g === "bac") { p.chips += sum(p.bac); p.bac = empty(); }
      else if (g === "rl") { p.chips += sum(p.rl); p.rl = {}; }
      else if (g === "to") { p.chips += sum(p.to); p.to = {}; }
      else if (g === "bj" && H.bj.phase === "bet") { p.chips += p.bj.bet; p.bj.bet = 0; }
      else if (g === "hd") p.hdSeat = false;
      p.spec[g] = true;
    } else delete p.spec[g];
    p.ready[g] = false;
    checkReady(); broadcast(); return;
  }
  if (msg.t === "view") { if (!VIEWS[msg.v] || p.vw === msg.v) return; if (GAMES.includes(p.vw)) p.ready[p.vw] = false; if (p.vw === "pk" || p.vw === "sl") pkLeave(id); p.vw = msg.v; }
  else if (msg.t === "ready" && GAMES.includes(msg.g)) {
    if (msg.g === "bj" && H.bj.phase !== "bet") return;
    if (msg.g === "hd" && (H.hd.running || H.hd.phase !== "idle")) return;
    if (msg.g === "to" && H.to.until > Date.now()) return;
    if (p.spec && p.spec[msg.g]) return;
    p.ready[msg.g] = !p.ready[msg.g];
  }
  else if (msg.t === "bac-add" && ["p", "b", "t"].includes(msg.k) && validBet(msg)) {
    const a = stake(id, p, msg); if (!a) return;
    p.bac[msg.k] += a; p.ready.bac = false;
  } else if (msg.t === "bac-clear") {
    p.chips += sum(p.bac); p.bac = empty(); p.ready.bac = false;
  } else if (msg.t === "rl-add" && RL_KEYS.has(msg.k) && validBet(msg)) {
    const a = stake(id, p, msg); if (!a) return;
    p.rl[msg.k] = (p.rl[msg.k] || 0) + a; p.ready.rl = false;
  } else if (msg.t === "rl-clear") {
    p.chips += sum(p.rl); p.rl = {}; p.ready.rl = false;
  } else if (msg.t === "bj-add" && validBet(msg)) {
    if (H.bj.phase !== "bet") return;
    const a = stake(id, p, msg); if (!a) return;
    p.bj.bet += a; p.ready.bj = false;
  } else if (msg.t === "bj-clear") {
    if (H.bj.phase !== "bet") return;
    p.chips += p.bj.bet; p.bj.bet = 0; p.ready.bj = false;
  } else if (msg.t === "bj-hit" || msg.t === "bj-stand" || msg.t === "bj-double") {
    const h = p.bj;
    if (H.bj.phase !== "play" || !h.cards.length || h.done) return;
    if (msg.t === "bj-hit") { h.cards.push(draw()); }
    else if (msg.t === "bj-stand") { h.done = true; h.res = "스탠드"; }
    else {
      if (h.cards.length !== 2) return;
      if (!take(id, p, h.bet)) return;
      h.bet *= 2; h.cards.push(draw()); h.done = true; h.res = "더블";
    }
    const v = hv(h.cards);
    if (v > 21) { h.done = true; h.res = "버스트"; }
    else if (v === 21) { h.done = true; if (h.res !== "더블") h.res = "21"; }
    bjMaybeFinish();
  } else if (msg.t === "hd" && ["fold", "call", "raise", "allin"].includes(msg.a)) {
    if (!hdAct(id, msg.a, Number.isInteger(msg.amt) && msg.amt > 0 && msg.amt <= 1e13 ? msg.amt : 0)) return;
  } else if (msg.t === "hd-seat") {
    if (!H.hd.running) return;
    p.hdSeat = !p.hdSeat;
  } else if (msg.t === "evt-go") {
    const n = Date.now();
    if (!isAdm(p.name) || (p.evt && n < p.evt.end)) return;
    p.evt = { end: n + EVT_MS + 1500, got: 0 };
    return;
  } else if (msg.t === "evt-grab") {
    const e = p.evt, n = Date.now();
    if (!isAdm(p.name) || !e || n > e.end) return;
    const a = Math.min(Math.floor(Number(msg.amt)) || 0, EVT_BILLS[EVT_BILLS.length - 1], EVT_MAX - e.got);
    if (a <= 0) return;
    e.got += a; p.chips += a; p.peak = Math.max(p.peak, p.chips);
  } else if (msg.t === "adm-set") {
    const n = String(msg.name || "").slice(0, 8), v = Math.floor(Number(msg.chips));
    if (!isAdm(p.name) || !n || n === "__proto__" || !Number.isFinite(v) || v < 0 || v > 1e13) return;
    ctx.admSet(n, v);
  } else if (msg.t === "wd-req") {   // game money → withdrawal request (whole 억 only), held until the admin answers
    const a = Math.floor(Number(msg.amt));
    if (!(a >= ctx.WD_RATE) || a % ctx.WD_RATE || a > 1e13) { reply(id, "출금은 1억 단위 (1억 = 1원)"); return; }
    if (a > p.chips) { reply(id, "잔액 부족: 가용 " + fmt(p.chips)); return; }
    if (ctx.wdPend(p.name) >= 5) { reply(id, "대기 중인 출금 신청이 5건이에요"); return; }
    p.chips -= a; ctx.wdReq(p.name, a); reply(id, (a / ctx.WD_RATE).toLocaleString() + "원 출금 신청 완료 · 승인 대기");
  } else if (msg.t === "wd-ans" || msg.t === "wd-paid") {
    if (!isAdm(p.name)) return;
    if (msg.t === "wd-ans") ctx.wdAns(String(msg.id || ""), !!msg.ok); else ctx.wdPaid(String(msg.name || "").slice(0, 8));
    return;
  } else if (msg.t === "adm-unbind") {   // free a name fixed to an IP (wrong name, shared wifi): next login picks again
    const n = String(msg.name || "").slice(0, 8);
    if (!isAdm(p.name) || !n) return;
    ctx.unbind(n); reply(id, n + " IP 고정 해제");
  } else if (msg.t === "to-add" && TO_KEYS.includes(msg.k) && validBet(msg)) {
    if (H.to.until > Date.now()) { reply(id, "경기 중: 끝나면 다음 경기에 베팅"); return; }
    const a = stake(id, p, msg); if (!a) return;
    p.to[msg.k] = (p.to[msg.k] || 0) + a; p.ready.to = false;
  } else if (msg.t === "to-clear") {
    if (H.to.until > Date.now()) return;
    p.chips += sum(p.to); p.to = {}; p.ready.to = false;
  } else if ((msg.t === "pk-sit" || msg.t === "sl-sit") && Number.isInteger(msg.i) && msg.i >= 0 && msg.i < PK_N) {
    const g = msg.t.slice(0, 2), m = H[g][msg.i];
    if (m.id === id) m.id = null;
    else if (!m.id && p.vw === g) { pkLeave(id); m.id = id; }
    else return;
  } else if (msg.t === "sl-spin" && SL_AMTS.includes(msg.amt)) {
    const i = H.sl.findIndex(m => m.id === id), n = Date.now();
    if (i < 0 || n - (p.slT || 0) < SL_GAP) return;
    if (!take(id, p, msg.amt)) return;
    p.slT = n;
    const M = H.sl[i], r = slSpin(msg.amt);
    p.chips += r.win; p.lastNet = r.win - msg.amt; rec(p, "sl", msg.amt, r.win);
    M.last = { n: ++M.n, by: p.name, amt: msg.amt, ...r, net: r.win - msg.amt }; M.tot += r.win - msg.amt; M.shots++;
    if (r.mult >= 80) { M.big++; announce(p, "sl", msg.amt, r.win, false, ["🍒", "🍋", "🍊", "🔔", "⭐", "💎", "7️⃣"][r.reels[0][1]].repeat(3) + " 당첨", 1300); }
  } else if (msg.t === "pk-fire" && PK_AMTS.includes(msg.amt)) {
    const i = pkSeat(id), n = Date.now();
    if (i < 0 || n - (p.pkT || 0) < PK_GAP) return;
    if (!take(id, p, msg.amt * PK_BALLS)) return;
    p.pkT = n;
    const M = H.pk[i], balls = pkShot(msg.amt), s = msg.amt * PK_BALLS, ret = balls.reduce((a, b) => a + b.win, 0);
    p.chips += ret; p.lastNet = ret - s; rec(p, "pk", s, ret);
    M.last = { n: ++M.n, by: p.name, amt: msg.amt, balls, net: ret - s }; M.tot += ret - s; M.shots++;
    const jack = balls.find(b => b.reel && b.reel[0] === b.reel[1] && b.reel[1] === b.reel[2]);
    if (jack) { M.big++; announce(p, "pk", s, ret, false, jack.reel.join("") + " 당첨", 2600); }
  } else if (msg.t === "rebet" && ["bac", "rl", "bj", "to"].includes(msg.g)) {
    /* same stakes as this player's previous round of that game */
    const L = p.lb && p.lb[msg.g];
    if (!L) return;
    if (msg.g === "bj" && H.bj.phase !== "bet") return;
    if (msg.g === "to" && H.to.until > Date.now()) return;
    const tot = msg.g === "bj" ? L : sum(L);
    if (!(tot > 0) || !take(id, p, tot)) return;
    if (msg.g === "bac") for (const k of ["p", "b", "t"]) p.bac[k] += L[k] || 0;
    else if (msg.g === "rl") for (const [k, a] of Object.entries(L)) { if (RL_KEYS.has(k)) p.rl[k] = (p.rl[k] || 0) + a; }
    else if (msg.g === "to") for (const [k, a] of Object.entries(L)) { if (TO_KEYS.includes(k)) p.to[k] = (p.to[k] || 0) + a; }
    else p.bj.bet += L;
    p.ready[msg.g] = false;
  } else if (msg.t === "sk-buy") {
    /* buy as many shares as the amount covers (fee included) at the current price */
    const st = ctx.stock(msg.k), a = Math.floor(Number(msg.amt));
    if (!st || !(a >= 1000)) return;
    if (a > p.chips) { reply(id, "잔액 부족: 가용 " + fmt(p.chips)); return; }
    const q = Math.floor(a / (st.px * (1 + SK_FEE)));
    if (q < 1) { reply(id, st.n + " 1주 = " + fmt(Math.ceil(st.px * (1 + SK_FEE))) + " 필요"); return; }
    const cost = Math.ceil(st.px * q * (1 + SK_FEE));
    p.chips -= cost;
    const h = p.stk[st.k] || { q: 0, avg: 0 };
    h.avg = (h.avg * h.q + cost) / (h.q + q); h.q += q; p.stk[st.k] = h;   // 평단 = 수수료 포함 매입가
    skLog({ n: p.name, k: st.k, s: "b", q, px: st.px });
  } else if (msg.t === "sk-sell") {
    /* sell q shares of one stock only (never everything at once) */
    const st = ctx.stock(msg.k), h = p.stk[msg.k];
    if (!st || !h) return;
    const q = Math.min(h.q, Math.floor(Number(msg.q)));
    if (!(q >= 1)) return;
    const got = Math.floor(st.px * q * (1 - SK_FEE)), cost = Math.round(h.avg * q), pl = got - cost;
    p.chips += got; h.q -= q; if (!h.q) delete p.stk[st.k];
    const t = p.st.sk || (p.st.sk = { n: 0, w: 0, l: 0, net: 0 });
    t.n++; t.net += pl; if (pl > 0) t.w++; else if (pl < 0) t.l++;
    p.peak = Math.max(p.peak, p.chips); p.lastNet = pl;
    announce(p, "sk", cost, got, false, "");
    skLog({ n: p.name, k: st.k, s: "s", q, px: st.px, pl, r: cost ? pl / cost : 0 });
  } else if (msg.t === "refill") {
    const h = H.hd.phase === "play" && H.hd.hands[id];
    if (!broke(p, h)) return;
    p.chips += START; p.lastNet = 0; p.rebuy++;
  } else return;
  checkReady();
  broadcast();
}

/* refill only when broke: can't cover the smallest bet, nothing on any table, not alive in a hold'em hand */
const broke = (p, hdHand) => p.chips < AMTS[0] && !sum(p.to || {}) && !sum(p.bac) && !sum(p.rl) && !p.bj.bet && !(hdHand && !hdHand.folded) && !Object.keys(p.stk || {}).length;
function checkReady() {
  if (!H.players.size) return;
  for (const g of GAMES) {
    /* baccarat: only players on the baccarat sheet need to be ready */
    /* each game is its own room: only the players looking at that game's sheet need to be ready */
    const ps = [...H.players.values()].filter(q => q.vw === g && !(q.spec && q.spec[g]));
    if (!ps.length || !ps.every(q => q.ready[g])) continue;
    for (const q of ps) q.ready[g] = false;
    if (g === "bac") runBac(); else if (g === "rl") runRl(); else if (g === "bj") runBj(); else if (g === "to") runTo(); else hdStart();
  }
  hdTick();
}
function runBac() {
  const r = { n: ++H.bac.n, ...bacPlay() };
  for (const q of H.players.values()) {
    const s = sum(q.bac); if (!s || q.vw !== "bac") continue;
    const allin = q.chips === 0 && !sum(q.rl) && !q.bj.bet;
    const ret = bacPay(q.bac, r.w); q.chips += ret; q.lastNet = ret - s; rec(q, "bac", s, ret);
    announce(q, "bac", s, ret, allin, r.w === "T" && q.bac.t >= EV_SPECIAL_MIN ? "타이 적중" : "");
    q.lb = { ...q.lb, bac: { ...q.bac } };
    q.bac = empty();
  }
  H.bac.rounds = [r, ...H.bac.rounds].slice(0, 100);
}
function runRl() {
  const n = rnd() % 37;
  H.rl.n++;
  for (const q of H.players.values()) {
    const s = sum(q.rl); if (!s || q.vw !== "rl") continue;
    q.lb = { ...q.lb, rl: { ...q.rl } };
    const allin = q.chips === 0 && !sum(q.bac) && !q.bj.bet;
    let ret = 0, hit = 0;
    for (const [k, a] of Object.entries(q.rl)) { const m = rlMult(k, n); ret += a * m; if (k[0] === "n" && m) hit = Math.max(hit, a); }
    q.chips += ret; q.lastNet = ret - s; rec(q, "rl", s, ret);
    announce(q, "rl", s, ret, allin, hit >= EV_SPECIAL_MIN ? "스트레이트 적중" : "", SPIN_MS + 300);
    q.rl = {};
  }
  H.rl.hist = [n, ...H.rl.hist].slice(0, 300);
}
function runBj() {
  const seats = [...H.players.values()].filter(q => q.bj.bet > 0 && q.vw === "bj");
  for (const q of seats) q.lb = { ...q.lb, bj: q.bj.bet };
  for (const q of H.players.values()) { q.bj.cards = []; q.bj.done = false; q.bj.res = ""; }
  if (!seats.length) { H.bj.dealer = []; return; }
  H.bj.n++;
  H.bj.dealer = [draw(), draw()];
  for (const q of seats) {
    q.bj.cards = [draw(), draw()];
    if (isBJ(q.bj.cards)) { q.bj.done = true; q.bj.res = "BJ"; }
  }
  H.bj.phase = "play";
  if (isBJ(H.bj.dealer)) { for (const q of seats) q.bj.done = true; }
  bjMaybeFinish();
}
function bjMaybeFinish() {
  if (H.bj.phase !== "play") return;
  const seats = [...H.players.values()].filter(q => q.bj.cards.length);
  if (seats.some(q => !q.bj.done)) return;
  const d = H.bj.dealer;
  const live = seats.some(q => hv(q.bj.cards) <= 21 && !isBJ(q.bj.cards));
  if (live && !isBJ(d)) while (hv(d) < 17) d.push(draw());
  const dv = hv(d), dbj = isBJ(d);
  const ds = H.bj.ds, key = dbj ? "BJ" : dv > 21 ? "버스트" : dv >= 17 ? String(dv) : "기타";
  ds.n++; ds.dist[key] = (ds.dist[key] || 0) + 1;
  if (dv > 21) ds.bust++; else ds.sum += dv;
  for (const q of seats) {
    const h = q.bj, pv = hv(h.cards), pbj = isBJ(h.cards);
    let ret, res;
    if (pv > 21) { ret = 0; res = "버스트"; }
    else if (pbj && dbj) { ret = h.bet; res = "무"; }
    else if (pbj) { ret = Math.floor(h.bet * 2.5); res = "BJ 승"; }
    else if (dbj) { ret = 0; res = "패"; }
    else if (dv > 21 || pv > dv) { ret = h.bet * 2; res = "승"; }
    else if (pv === dv) { ret = h.bet; res = "무"; }
    else { ret = 0; res = "패"; }
    const allin = q.chips === 0 && !sum(q.bac) && !sum(q.rl);
    q.chips += ret; q.lastNet = ret - h.bet; rec(q, "bj", h.bet, ret, res);
    announce(q, "bj", h.bet, ret, allin, res === "BJ 승" && h.bet >= EV_SPECIAL_MIN ? "블랙잭" : "");
    h.res = res; h.bet = 0;
  }
  H.bj.phase = "bet";
}

/* ---------- hold'em engine (host only) ---------- */
function hdFresh() {
  return { phase: "idle", running: false, wait: false, nextAt: 0, n: 0, btnIdx: -1, btn: null, sb: null, bb: null, board: [], deck: [], order: [], hands: {},
    curBet: 0, minRaise: BB, toAct: null, deadline: 0, street: 0, last: null, log: [] };
}
function shuffled() {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = rnd() % (i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
/* table session: everyone ready once → hands keep dealing until fewer than 2 are seated */
function hdStart() {
  H.hd.running = true; H.hd.nextAt = 0;
  for (const q of H.players.values()) q.hdSeat = q.vw === "hd" && !(q.spec && q.spec.hd);
  runHd();
}
function hdStop() {
  const D = H.hd;
  D.running = false; D.wait = false; D.nextAt = 0;
  for (const q of H.players.values()) { q.hdSeat = false; q.ready.hd = false; }
  for (const id of H.players.keys()) reply(id, "검토: 착석 인원 2명 미만 → 테이블 종료");
}
function hdTick() {
  const D = H.hd;
  if (!D.running || D.phase !== "idle") return;
  if ([...H.players.values()].filter(q => q.hdSeat).length < 2) return hdStop();
  if (D.wait || (D.nextAt && Date.now() >= D.nextAt)) runHd();
}
function runHd() {
  const D = H.hd;
  if (D.phase !== "idle") return;
  const ids = [...H.players].filter(([, p]) => p.hdSeat && p.chips > 0).map(([id]) => id);
  if (ids.length < 2) { D.wait = true; D.nextAt = 0; return; }
  D.wait = false; D.nextAt = 0;
  D.n++; D.phase = "play"; D.deck = shuffled(); D.board = []; D.street = 0; D.order = ids; D.hands = {}; D.last = null;
  for (const id of ids) D.hands[id] = { cards: [D.deck.pop(), D.deck.pop()], bet: 0, total: 0, folded: false, allin: false, acted: false };
  D.btnIdx = (D.btnIdx + 1) % ids.length; D.btn = ids[D.btnIdx];
  const at = i => ids[(D.btnIdx + i) % ids.length];
  D.sb = ids.length === 2 ? at(0) : at(1);
  D.bb = ids.length === 2 ? at(1) : at(2);
  hdPut(D.sb, SB); hdPut(D.bb, BB);
  D.curBet = BB; D.minRaise = BB;
  hdNext(D.bb);
}
function hdPut(id, amt) {
  const p = H.players.get(id), h = H.hd.hands[id];
  const a = Math.max(0, Math.min(amt, p ? p.chips : 0));
  if (p) p.chips -= a;
  h.bet += a; h.total += a;
  if (!p || p.chips === 0) h.allin = true;
}
function hdNext(from) {
  const D = H.hd;
  const live = D.order.filter(id => !D.hands[id].folded);
  if (live.length === 1) return hdEnd({ [live[0]]: D.order.reduce((s, id) => s + D.hands[id].total, 0) }, null, null);
  const k = D.order.length, start = D.order.indexOf(from);
  for (let i = 1; i <= k; i++) {
    const id = D.order[(start + i) % k], h = D.hands[id];
    if (h.folded || h.allin) continue;
    if (!h.acted || h.bet < D.curBet) { D.toAct = id; D.deadline = Date.now() + TURN_MS; return; }
  }
  hdStreet();
}
function hdStreet() {
  const D = H.hd;
  for (const id of D.order) { D.hands[id].bet = 0; D.hands[id].acted = false; }
  D.curBet = 0; D.minRaise = BB; D.street++;
  if (D.street === 1) D.board.push(D.deck.pop(), D.deck.pop(), D.deck.pop());
  else if (D.street <= 3) D.board.push(D.deck.pop());
  if (D.street >= 4) return hdShowdown();
  const canAct = D.order.filter(id => !D.hands[id].folded && !D.hands[id].allin);
  if (canAct.length <= 1) return hdStreet();
  hdNext(D.btn);
}
function hdAct(id, a, amt) {
  const D = H.hd;
  if (D.phase !== "play" || D.toAct !== id) return false;
  const h = D.hands[id], p = H.players.get(id), toCall = D.curBet - h.bet;
  if (a === "fold") h.folded = true;
  else if (a === "call") hdPut(id, toCall);
  else {
    const before = D.curBet;
    hdPut(id, a === "allin" ? p.chips : toCall + Math.max(amt, D.minRaise));
    if (h.bet > before) {
      const by = h.bet - before;
      if (by >= D.minRaise) D.minRaise = by;
      D.curBet = h.bet;
      for (const o of D.order) if (o !== id) D.hands[o].acted = false;
    }
  }
  h.acted = true;
  hdNext(id);
  return true;
}
function hdShowdown() {
  const D = H.hd;
  while (D.board.length < 5) D.board.push(D.deck.pop());
  const live = D.order.filter(id => !D.hands[id].folded);
  const score = {};
  for (const id of live) score[id] = bestHand(D.hands[id].cards.concat(D.board));
  // side pots: split contributions into levels; each level goes to the best live hand that paid into it
  const won = {};
  const levels = [...new Set(D.order.map(id => D.hands[id].total).filter(x => x > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const lv of levels) {
    let pot = 0;
    for (const id of D.order) pot += Math.min(D.hands[id].total, lv) - Math.min(D.hands[id].total, prev);
    prev = lv;
    if (!pot) continue;
    let elig = live.filter(id => D.hands[id].total >= lv);
    if (!elig.length) elig = live;
    const top = elig.reduce((m, id) => cmp(score[id], score[m]) > 0 ? id : m, elig[0]);
    const ws = elig.filter(id => cmp(score[id], score[top]) === 0);
    const share = Math.floor(pot / ws.length);
    let rem = pot - share * ws.length;
    for (const w of ws) { won[w] = (won[w] || 0) + share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }
  }
  hdEnd(won, live, score);
}
function hdEnd(won, shown, score) {
  const D = H.hd;
  const names = Object.fromEntries(D.order.map(id => [id, (H.players.get(id) || {}).name || "(퇴장)"]));
  for (const id of D.order) {
    const p = H.players.get(id), w = won[id] || 0, t = D.hands[id].total;
    if (!p) continue;
    p.chips += w; p.lastNet = w - t;
    const st = p.st.hd; st.n++; st.net += w - t;
    if (w > t) st.w++; else if (w < t) st.l++;
    if (shown && w > 0) st.sd++;
    p.peak = Math.max(p.peak, p.chips);
    const sc = score && score[id];
    announce(p, "hd", t, w, D.hands[id].allin, sc && sc[0] >= 7 ? HNAME[sc[0]] + " 완성" : "");
  }
  const pot = D.order.reduce((s, id) => s + D.hands[id].total, 0);
  const winners = Object.keys(won).filter(id => won[id] > 0);
  const hand = shown ? Object.fromEntries(shown.map(id => [id, HNAME[score[id][0]]])) : {};
  D.last = { shown: shown || [], won, hand, pot };
  D.log = [{ n: D.n, win: winners.map(id => names[id]).join(", "), hand: shown ? hand[winners[0]] : "폴드승", pot }, ...D.log].slice(0, 10);
  D.phase = "idle"; D.toAct = null;
  if (D.running) D.nextAt = Date.now() + NEXT_MS;
}
function hdLeave(id) {
  const D = H.hd;
  if (D.phase !== "play" || !D.hands[id]) return;
  D.hands[id].folded = true;
  const live = D.order.filter(x => !D.hands[x].folded);
  if (D.toAct === id || live.length === 1) hdNext(id);
}
function hdView(forId) {
  const D = H.hd;
  const reveal = new Set(D.phase === "idle" && D.last ? D.last.shown : []);
  return { phase: D.phase, running: D.running, wait: D.wait, next: D.nextAt ? Math.max(0, D.nextAt - Date.now()) : 0, n: D.n, btn: D.btn, sb: D.sb, bb: D.bb, board: D.board, street: D.street,
    curBet: D.curBet, minRaise: D.minRaise, toAct: D.toAct, left: Math.max(0, D.deadline - Date.now()),
    pot: D.order.reduce((s, id) => s + (D.hands[id] ? D.hands[id].total : 0), 0), last: D.last, log: D.log,
    hands: D.order.filter(id => D.hands[id]).map(id => {
      const h = D.hands[id];
      return { id, cards: id === forId || reveal.has(id) ? h.cards : h.cards.map(() => -1),
        bet: h.bet, total: h.total, folded: h.folded, allin: h.allin };
    }) };
}
function hdTimer() {
  const D = H.hd;
  if (D.running && D.phase === "idle" && D.nextAt && Date.now() >= D.nextAt) { hdTick(); broadcast(); return; }
  if (D.phase !== "play" || !D.toAct || Date.now() < D.deadline) return;
  const h = D.hands[D.toAct];
  hdAct(D.toAct, h.bet >= D.curBet ? "call" : "fold", 0);
  broadcast();
}

const RD_GB = [[2, 45, "홀짝"], [5, 18, "주사위"], [20, 4, "잭팟"]];  // gold gamble: [payout ×, win %, name]
function mgNew(g, seats) {
  return { seats: seats || [null, null], turn: 0, res: "", win: -1, last: -1,
    b: g === "ch" ? [..."rnbqkbnrpppppppp", ...Array(32).fill(""), ..."PPPPPPPPRNBQKBNR"] : g === "tw" ? [{ x: 6, w: 9 }] : Array(g === "om" ? 225 : 42).fill(0) };
}
function mgLeave(id) { for (const G of Object.values(H.mg)) G.seats = G.seats.map(x => x === id ? null : x); }
/* chess: legal moves incl. check rules; auto-queen; no castling / en passant */
const chMoves = (b, i) => {
  const p = b[i], w = p < "a", t = p.toLowerCase(), r = i >> 3, c = i & 7, o = [];
  const add = (R, C) => { if (R < 0 || R > 7 || C < 0 || C > 7) return false; const q = b[R * 8 + C]; if (q && (q < "a") === w) return false; o.push(R * 8 + C); return !q; };
  if (t === "p") {
    const d = w ? -1 : 1, R = r + d;
    if (R >= 0 && R < 8) {
      if (!b[R * 8 + c]) { o.push(R * 8 + c); if (r === (w ? 6 : 1) && !b[(r + 2 * d) * 8 + c]) o.push((r + 2 * d) * 8 + c); }
      for (const dc of [-1, 1]) { const C = c + dc; if (C >= 0 && C < 8) { const q = b[R * 8 + C]; if (q && (q < "a") !== w) o.push(R * 8 + C); } }
    }
  } else if (t === "n") [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]].forEach(([a, d]) => add(r + a, c + d));
  else if (t === "k") { for (let a = -1; a < 2; a++) for (let d = -1; d < 2; d++) if (a || d) add(r + a, c + d); }
  else {
    const D = []; if (t !== "b") D.push([1, 0], [-1, 0], [0, 1], [0, -1]); if (t !== "r") D.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
    D.forEach(([a, d]) => { for (let k = 1; add(r + a * k, c + d * k); k++); });
  }
  return o;
};
const chInCheck = (b, w) => { const k = b.indexOf(w ? "K" : "k"); return b.some((p, i) => p && (p < "a") !== w && chMoves(b, i).includes(k)); };
const chApply = (b, f, t) => { const n = b.slice(), p = n[f]; n[t] = p === "P" && t < 8 ? "Q" : p === "p" && t > 55 ? "q" : p; n[f] = ""; return n; };
const chLegal = (b, i) => chMoves(b, i).filter(t => !chInCheck(chApply(b, i, t), b[i] < "a"));
const chAny = (b, w) => b.some((p, i) => p && (p < "a") === w && chLegal(b, i).length);
/* n-in-a-row test around index i on a W-wide, Hh-high board */
const inRow = (b, i, s, n, W, Hh) => [[1, 0], [0, 1], [1, 1], [1, -1]].some(([a, d]) => {
  let k = 1;
  for (const sg of [1, -1]) for (let j = 1; ; j++) {
    const x = i % W + a * j * sg, y = (i / W | 0) + d * j * sg;
    if (x < 0 || y < 0 || x >= W || y >= Hh || b[y * W + x] !== s) break; k++;
  }
  return k >= n;
});
function mgHandle(id, msg) {
  const g = msg.g, G = H.mg[g]; if (!G) return;
  if (msg.t === "g-sit") { const s = msg.s === 1 ? 1 : 0; if (G.seats[s] === id) G.seats[s] = null; else if (!G.seats[s] && !G.seats.includes(id)) G.seats[s] = id; }
  else if (msg.t === "g-new") { if (G.seats.includes(id)) H.mg[g] = mgNew(g, G.seats); }
  else if (msg.t === "g-mv" && !G.res) {
    const s = G.seats.indexOf(id); if (s < 0 || s !== G.turn || G.seats.includes(null)) return;
    let ok = false;
    if (g === "ch") {
      const f = msg.f, t = msg.to, p = G.b[f];
      if (Number.isInteger(f) && Number.isInteger(t) && f >= 0 && f < 64 && p && (p < "a") === (s === 0) && chLegal(G.b, f).includes(t)) {
        G.b = chApply(G.b, f, t); ok = true; G.last = t;
        if (!chAny(G.b, s === 1)) { G.res = chInCheck(G.b, s === 1) ? "w" : "d"; G.win = s; }
      }
    } else if (g === "om") {
      const i = msg.i;
      if (Number.isInteger(i) && i >= 0 && i < 225 && !G.b[i]) {
        G.b[i] = s + 1; ok = true; G.last = i;
        if (inRow(G.b, i, s + 1, 5, 15, 15)) { G.res = "w"; G.win = s; } else if (!G.b.includes(0)) G.res = "d";
      }
    } else if (g === "tw") {
      const top = G.b[G.b.length - 1], x = Math.max(0, Math.min(21 - top.w, Math.round(Number(msg.x) || 0)));
      const ol = Math.max(top.x, x), w = Math.min(top.x + top.w, x + top.w) - ol;
      ok = true;
      if (w <= 0) G.res = "e"; else G.b.push({ x: w === top.w ? top.x : ol, w });
    } else {
      const c = msg.c;
      if (Number.isInteger(c) && c >= 0 && c < 7) {
        for (let y = 5; y >= 0; y--) if (!G.b[y * 7 + c]) {
          G.b[y * 7 + c] = s + 1; ok = true; G.last = y * 7 + c;
          if (inRow(G.b, G.last, s + 1, 4, 7, 6)) { G.res = "w"; G.win = s; } else if (!G.b.includes(0)) G.res = "d";
          break;
        }
      }
    }
    if (!ok) return;
    G.turn = 1 - s;
  } else return;
  broadcast();
}
const acct = p => p.chips + ctx.skValue(p.stk) - START * (p.rebuy || 0);
function boardMerge(dst, src) {
  if (!src || typeof src !== "object") return dst;
  for (const [n, e] of Object.entries(src).slice(0, 300)) {
    const k = String(n).slice(0, 8), v = Number(e && e[0]), t = Number(e && e[1]);
    if (!k || k === "__proto__" || !Number.isFinite(v) || !Number.isFinite(t)) continue;
    if (!dst[k] || dst[k][1] < t) dst[k] = [v, t];
  }
  const keep = new Set(Object.entries(dst).sort((a, b) => b[1][1] - a[1][1]).slice(0, 300).map(e => e[0]));
  for (const k of Object.keys(dst)) if (!keep.has(k)) delete dst[k];
  return dst;
}
function restore(p, a) {
  if (!a || typeof a !== "object") return;
  const c = Number(a.chips), r = Number(a.rebuy), pk = Number(a.peak);
  if (Number.isFinite(c) && c >= 0 && c <= 1e13) p.chips = Math.floor(c);
  if (Number.isInteger(r) && r >= 0 && r <= 1e6) p.rebuy = r;
  if (Number.isFinite(Number(a.admT))) p.admT = Number(a.admT);
  p.peak = Math.max(p.chips, Number.isFinite(pk) && pk <= 1e13 ? pk : 0);
  if (a.stk && typeof a.stk === "object") for (const [k, h] of Object.entries(a.stk)) {
    const q = Math.floor(Number(h && h.q)), av = Number(h && h.avg);
    if (ctx.stock(k) && q > 0 && q <= 1e9 && av > 0 && av <= 1e9) p.stk[k] = { q, avg: av };
  }
  // last round's stakes per game (이전 배팅), so the rebet button survives a refresh
  if (a.lb && typeof a.lb === "object") {
    const ok = v => Number.isInteger(v) && v > 0 && v <= 1e13, L = {};
    for (const g of ["bac", "rl", "to"]) {
      const o = a.lb[g]; if (!o || typeof o !== "object") continue;
      const keys = g === "bac" ? ["p", "b", "t"] : g === "rl" ? [...RL_KEYS] : TO_KEYS, m = {};
      for (const k of keys) if (ok(o[k])) m[k] = o[k];
      if (Object.keys(m).length) L[g] = m;
    }
    if (ok(a.lb.bj)) L.bj = a.lb.bj;
    if (Object.keys(L).length) p.lb = L;
  }
  if (a.st && typeof a.st === "object") for (const g of Object.keys(p.st)) for (const k of Object.keys(p.st[g])) {
    const v = Number(a.st[g] && a.st[g][k]);
    if (Number.isFinite(v) && Math.abs(v) <= 1e13) p.st[g][k] = v;
  }
}

let H = fresh();
const conns = new Map();   // player id(name) -> socket
function fresh() { return { players: new Map(), bac: { rounds: [], n: 0 }, rl: { hist: [], n: 0 }, bj: { phase: "bet", dealer: [], n: 0, ds: { n: 0, bust: 0, sum: 0, dist: {} } }, hd: hdFresh(), chat: [], cs: 0, mg: { ch: mgNew("ch"), om: mgNew("om"), c4: mgNew("c4"), tw: mgNew("tw") },
  pk: Array.from({ length: PK_N }, () => ({ id: null, n: 0, last: null, tot: 0, shots: 0, big: 0 })),
  sl: Array.from({ length: SL_N }, () => ({ id: null, n: 0, last: null, tot: 0, shots: 0, big: 0 })), to: { next: toNext(1), last: null, hist: [], tm: {}, until: 0 } }; }
const out = (ws, m) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch {} };
let bT = 0;
function broadcast() {
  // many actions can land in the same instant (e.g. a round settling): send one state for all of them
  if (bT) return;
  bT = setImmediate(() => {
    bT = 0;
    for (const p of H.players.values()) ctx.saw(p);
    for (const [id, ws] of conns) out(ws, snapshot(id));
  });
}
function reply(id, m) { const ws = conns.get(id); if (ws) out(ws, { t: "err", m }); }
function emit(ev, delay) {
  const m = { t: "event", ...ev, delay: delay || 0 };
  for (const ws of conns.values()) out(ws, m);
}
/* bets still lying on the table (not dealt yet) go back to the balance */
function refund(p) {
  p.chips += sum(p.bac) + sum(p.rl) + sum(p.to || {}) + (H.bj.phase === "bet" ? p.bj.bet : 0);
  p.bac = empty(); p.rl = {}; p.to = {}; if (H.bj.phase === "bet") p.bj.bet = 0;
}
function skLog(e) { e.t = Date.now(); (H.skLog = H.skLog || []).unshift(e); if (H.skLog.length > 30) H.skLog.length = 30; }
function remove(id) {
  const q = H.players.get(id);
  if (!q) return;
  conns.delete(id);
  refund(q);
  H.players.delete(id);
  ctx.saw(q, true);
  mgLeave(id); pkLeave(id); hdLeave(id); bjMaybeFinish(); checkReady(); rdReadyCheck(); broadcast();
  emit({ sys: 1, k: "leave", name: q.name });
}
/* game records that outlive the players: saved by the server (data/rooms.json) and put back when the
   room is made again (everyone left, or a restart). Each list keeps only as many rows as its sheet has. */
function dump() {
  const seat = m => ({ n: m.n, tot: m.tot, shots: m.shots, big: m.big, last: m.last });
  return { bac: H.bac, rl: H.rl, bj: { n: H.bj.n, ds: H.bj.ds }, hd: { n: H.hd.n, log: H.hd.log }, chat: H.chat, cs: H.cs, skLog: H.skLog || [],
    to: { hist: H.to.hist, last: H.to.last, n: H.to.next.n, tm: H.to.tm }, pk: H.pk.map(seat), sl: H.sl.map(seat) };
}
function load(d) {
  if (!d || typeof d !== "object") return;
  const arr = (a, n) => Array.isArray(a) ? a.slice(0, n) : [], num = v => Number.isFinite(v) && v >= 0 ? v : 0;
  if (d.bac) { H.bac.rounds = arr(d.bac.rounds, 100); H.bac.n = num(d.bac.n); }
  if (d.rl) { H.rl.hist = arr(d.rl.hist, 300); H.rl.n = num(d.rl.n); }
  if (d.bj) { H.bj.n = num(d.bj.n); if (d.bj.ds && typeof d.bj.ds === "object") H.bj.ds = d.bj.ds; }
  if (d.hd) { H.hd.n = num(d.hd.n); H.hd.log = arr(d.hd.log, 10); }
  H.chat = arr(d.chat, 40); H.cs = num(d.cs); H.skLog = arr(d.skLog, 30);
  if (d.to) { H.to.hist = arr(d.to.hist, 9); H.to.last = d.to.last || null; if (d.to.n > 1) H.to.next = toNext(num(d.to.n));
    // team table: the saved one, or (first load after it was added) rebuilt from the recent matches still on the sheet
    if (d.to.tm && typeof d.to.tm === "object") { for (const [t, r] of Object.entries(d.to.tm)) if (TO_TEAMS.some(x => x[0] === t) && Array.isArray(r)) H.to.tm[t] = [0, 1, 2, 3, 4].map(i => num(r[i])); }
    else for (const h of [...H.to.hist].reverse()) toTm(h.home, h.away, num(h.hg), num(h.ag)); }
  for (const g of ["pk", "sl"]) arr(d[g], PK_N).forEach((m, i) => { if (m) Object.assign(H[g][i], { n: num(m.n), tot: Number(m.tot) || 0, shots: num(m.shots), big: num(m.big), last: m.last || null }); });
}
return {
  dump, load,
  get size() { return H.players.size; },
  has: id => H.players.has(id),
  players: () => [...H.players.values()],
  /* returns an error text, or "" when in */
  join(ws, name, msg, acc) {
    const back = H.players.get(name);
    if (!back && H.players.size >= MAX) return "인원 초과: 최대 " + MAX + "명";
    conns.set(name, ws);
    if (back) { back.off = 0; if (VIEWS[msg.v]) back.vw = msg.v; broadcast(); return ""; }
    const np = newPlayer(name);
    restore(np, acc);
    if (VIEWS[msg.v]) np.vw = msg.v;
    H.players.set(name, np);
    emit({ sys: 1, k: "join", name, v: acct(np) });
    for (const q of H.players.values()) q.ready = { bac: false, rl: false, bj: false, hd: false, to: false };
    checkReady(); broadcast();
    return "";
  },
  /* connection gone: keep the seat a little while so a refresh / network blip resumes the same game */
  lost(name, ws) {
    if (conns.get(name) !== ws) return;
    conns.delete(name);
    const q = H.players.get(name); if (q) q.off = Date.now();
    broadcast();
  },
  remove,
  handle(name, msg) { if (conns.has(name)) hostHandle(name, msg); },
  tick() {
    hdTimer();
    const n = Date.now();
    for (const [id, q] of H.players) if (q.off && n - q.off > ctx.GRACE) remove(id);
  },
  addChips(name, v) { const q = H.players.get(name); if (!q) return false; q.chips += v; q.peak = Math.max(q.peak, q.chips); broadcast(); return true; },
  setChips(name, v) { const q = H.players.get(name); if (!q) return false; q.chips = v; q.peak = Math.max(q.peak, v); q.lastNet = 0; broadcast(); return true; },
  refund,
  refresh: broadcast,
  /* server going down: hands still being played are void, everyone gets their stake back */
  shutdown() {
    const D = H.hd;
    if (D.phase === "play") for (const id of D.order) { const q = H.players.get(id), h = D.hands[id]; if (q && h) q.chips += h.total; }
    if (H.bj.phase === "play") for (const q of H.players.values()) if (q.bj.cards.length) { q.chips += q.bj.bet; q.bj.bet = 0; }
    for (const q of H.players.values()) refund(q);
  },
};
};
