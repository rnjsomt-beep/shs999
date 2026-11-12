"use strict";
/* 골프 (view "gf", sheet 물류동선): one shared round per room, up to 4 players, top-down course.
   The player whose turn it is aims on their own screen (gf-aim, echoed to everyone), starts the swing
   (gf-swing → everyone sees the impact gauge moving) and stops it (gf-hit {e}: where the marker was, -1..1).
   The server works out the shot (curve by impact, wind, roll, penalties) and sends it as an animation.
   Real rules: OB = 1 stroke + replay from where it was hit; penalty area (water) = 1 stroke + drop near
   where it last crossed into it, no nearer the hole; driver only from the tee. Double par = pick up.
   Order: "real" = honour on the tee (lowest score on the last hole first), then farthest from the hole;
   "alt" = simple rotation.
   Course tables / lie() / zones are duplicated in index.html (GF_*) — keep them in sync. */
const PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 5, 4];
const CL = [
  { k: "DR", n: "드라이버",   max: 235, cv: 1.3,  sp: .75, z: .8 },
  { k: "3W", n: "3번 우드",   max: 215, cv: 1.2,  sp: .78, z: .85 },
  { k: "5I", n: "5번 아이언", max: 180, cv: 1.05, sp: .8,  z: .95 },
  { k: "7I", n: "7번 아이언", max: 155, cv: 1,    sp: .8,  z: 1 },
  { k: "9I", n: "9번 아이언", max: 130, cv: .9,   sp: .78, z: 1.05 },
  { k: "PW", n: "피칭 웨지",  max: 105, cv: .8,   sp: .76, z: 1.1 },
  { k: "SW", n: "샌드 웨지",  max: 75,  cv: .7,   sp: .74, z: 1.15 },
  { k: "PT", n: "퍼터",       max: 45,  cv: .6,   sp: .6,  z: 1.5 },
];
const PT = CL.length - 1, MAXP = 4, TURN_MS = 60000, SWING_MS = 20000, HOLE_MS = 9000, D2R = Math.PI / 180;
const LIE_NM = { tee: "티박스", fair: "페어웨이", rough: "러프", green: "그린", bunker: "벙커", water: "해저드", ob: "OB" };

function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const r2 = v => Math.round(v * 100) / 100;
const fxOf = (h, y) => h.amp * Math.sin(Math.PI * h.w * Math.max(0, Math.min(y, h.L)) / h.L);
function genHole(i, seed) {
  const R = rng(seed + i * 977), r = (a, b) => a + R() * (b - a), side = () => (R() < .5 ? -1 : 1);
  const par = PARS[i % 18];
  const L = Math.round(par === 3 ? r(135, 190) : par === 4 ? r(330, 415) : r(480, 540));
  const h = { i, par, L, amp: r2(par === 3 ? r(-10, 10) : r(-38, 38)), w: r2(r(.5, 1.1)) };
  h.gx = r2(fxOf(h, L)); h.gr = r2(par === 3 ? r(13, 16) : r(14, 18));
  h.pin = { x: r2(h.gx + r(-.45, .45) * h.gr), y: r2(L + r(-.45, .45) * h.gr) };
  h.bunk = [];
  const nb = 2 + (R() < .5 ? 1 : 0);
  for (let k = 0; k < nb; k++) { const a = r(-.3, 1.3) * Math.PI + (k * 2.1), d = h.gr + r(4, 7); h.bunk.push({ x: r2(h.gx + Math.cos(a) * d), y: r2(L + Math.sin(a) * d), r: r2(r(5, 8)) }); }
  if (par > 3) { const by = r(215, 255); h.bunk.push({ x: r2(fxOf(h, by) + side() * r(14, 20)), y: r2(by), r: r2(r(7, 10)) }); }
  h.water = [];
  if (R() < .6) {
    if (par === 3 || R() < .5) { const y0 = r(L * .35, L * .55); h.water.push({ t: "band", y0: r2(y0), y1: r2(Math.min(y0 + r(10, 18), L - h.gr - 10)) }); }
    else { const wy = r(170, 250); h.water.push({ t: "pond", x: r2(fxOf(h, wy) + side() * r(30, 38)), y: r2(wy), r: r2(r(14, 20)) }); }
  }
  h.fw = par === 3 ? 0 : r2(r(15, 20));
  return h;
}
function lie(h, x, y) {
  if (y < -22 || y > h.L + 34 || Math.abs(x - fxOf(h, y)) > 62) return "ob";
  for (const w of h.water) if (w.t === "band" ? (y >= w.y0 && y <= w.y1) : Math.hypot(x - w.x, y - w.y) < w.r) return "water";
  const dg = Math.hypot(x - h.gx, y - h.L);
  if (dg < h.gr) return "green";
  for (const b of h.bunk) if (Math.hypot(x - b.x, y - b.y) < b.r) return "bunker";
  if (Math.abs(x) < 7 && y > -7 && y < 7) return "tee";
  if (dg < h.gr + 4) return "fair";
  if (h.fw && y > 55 && y < h.L && Math.abs(x - fxOf(h, y)) < h.fw) return "fair";
  return "rough";
}
const minClub = l => l === "tee" ? 0 : l === "bunker" ? 2 : 1;
function zones(ci, l) { const z = CL[ci].z * (l === "rough" ? .8 : l === "bunker" ? .62 : 1); return { P: .07 * z, Gd: Math.min(.3 * z, .55), B: Math.min(.62 * z, .86) }; }
function gSpeed(ci, l, ws) { const c = CL[ci]; return c.sp * (1 + ws * (c.k === "PT" ? .03 : .085)) * (l === "bunker" ? 1.1 : 1); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function autoClub(l, d) {
  if (l === "green") return PT;
  const mc = minClub(l);
  for (let k = PT - 1; k >= mc; k--) if (CL[k].max >= d * .98) return k;
  return mc;
}
function scoreName(s, par) {
  if (s === 1) return "홀인원";
  const d = s - par;
  return { "-3": "알바트로스", "-2": "이글", "-1": "버디", "0": "파", "1": "보기", "2": "더블보기", "3": "트리플" }[d] || (d > 0 ? "+" + d : "" + d);
}

function makeGf(api, rand = Math.random) {
  let G = fresh(9, "real"), T = 0, seq = 0;
  function fresh(n, ord) { return { ph: "lobby", n, ord, holes: [], hi: 0, wind: { s: 0, a: 0 }, pl: [], cur: "", tee: [], sp: "", aim: null, swAt: 0, swPh: 0, an: null, until: 0, msg: "", log: [] }; }
  const P = () => G.pl.find(p => p.id === G.cur), H = () => G.holes[G.hi];
  const newP = id => ({ id, sc: [], st: 0, pos: { x: 0, y: 0 }, lie: "tee", done: false, ready: false });
  function log(s) { G.log.unshift(s); if (G.log.length > 6) G.log.length = 6; }
  function timer(ms, f) { clearTimeout(T); T = setTimeout(() => { f(); push(); }, ms); }

  function start() {
    const seed = Math.floor(rand() * 1e9);
    G.ph = "play"; G.holes = Array.from({ length: G.n }, (_, i) => genHole(i, seed));
    for (let k = G.pl.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [G.pl[k], G.pl[j]] = [G.pl[j], G.pl[k]]; }
    G.pl.forEach(p => { p.sc = Array(G.n).fill(null); });
    G.tee = G.pl.map(p => p.id);
    log(G.pl.length + "명 시작 · " + G.n + "홀 · " + (G.ord === "real" ? "실제 룰" : "번갈아"));
    startHole(0);
  }
  function startHole(i) {
    G.hi = i; G.an = null;
    G.wind = { s: Math.round(rand() * 90) / 10, a: r2(rand() * Math.PI * 2) };
    G.pl.forEach(p => { p.pos = { x: r2((rand() - .5) * 4), y: 0 }; p.st = 0; p.done = false; p.lie = "tee"; });
    if (i > 0) {
      const sc = id => { const p = G.pl.find(q => q.id === id); return p ? p.sc[i - 1] : 99; };
      G.tee = G.ord === "real" ? [...G.tee].sort((a, b) => sc(a) - sc(b)) : G.tee.slice(1).concat(G.tee[0]);
    }
    G.tee = G.tee.filter(id => G.pl.some(p => p.id === id));
    G.msg = `${i + 1}번 홀 · 파${H().par} · ${H().L}y — 티샷: ${G.tee.join(" → ")}`;
    setTurn(G.tee[0]);
  }
  function setTurn(id) {
    G.cur = id; G.sp = "aim"; G.swAt = 0;
    const p = P(), h = H();
    let tg;
    if (p.lie === "green" || dist(p.pos, h.pin) <= 232) tg = { ...h.pin };
    else {
      tg = { ...h.pin };
      const reach = p.lie === "tee" ? 228 : 210;
      for (let y = p.pos.y; y < h.L; y += 2) { const q = { x: fxOf(h, y), y }; if (dist(q, p.pos) >= reach) { tg = q; break; } }
    }
    G.aim = { x: r2(tg.x), y: r2(tg.y), ci: autoClub(p.lie, dist(p.pos, tg)) };
    G.until = Date.now() + TURN_MS;
    timer(TURN_MS, () => { if (G.sp === "aim" || G.sp === "swing") hit(curM()); });
  }
  function curM() { const p = P(); return G.swAt ? Math.sin((Date.now() - G.swAt) / 1000 * Math.PI * 2 / 1.7 * gSpeed(G.aim.ci, p.lie, G.wind.s) + G.swPh) : (rand() * 2 - 1); }

  function hit(e) {
    const p = P(), h = H(), ci = G.aim.ci, c = CL[ci], a = Math.abs(e), z = zones(ci, p.lie);
    const P0 = { ...p.pos }, T0 = { x: G.aim.x, y: G.aim.y };
    const d = Math.max(dist(P0, T0), .5), th = Math.atan2(T0.y - P0.y, T0.x - P0.x);
    const put = c.k === "PT", sg = e < 0 ? 1 : -1;
    let kind, cv = 0, mul = 1, ht = 1;
    if (a <= z.P) { kind = "퍼펙트"; cv = (rand() - .5) * .5; }
    else if (a <= z.Gd) { const t = (a - z.P) / (z.Gd - z.P); kind = e < 0 ? "드로우" : "페이드"; cv = sg * (1.5 + 5 * t) * c.cv; mul = .985 - .04 * t; }
    else if (a <= z.B) { const t = (a - z.Gd) / (z.B - z.Gd); kind = e < 0 ? "훅" : "슬라이스"; cv = sg * (8 + 12 * t) * c.cv; mul = .9 - .08 * t; }
    else { kind = "삑!"; cv = (rand() - .5) * (put ? 14 : 44); mul = .18 + rand() * .22; ht = .25; }
    if (put && kind !== "퍼펙트" && kind !== "삑!") kind = e < 0 ? "왼쪽으로 당김" : "오른쪽으로 밀림";
    // natural spread even on a perfect strike (sd ≈ 1): aim error in degrees, distance error in %
    const gs = () => (rand() + rand() + rand() - 1.5) * 2, perf = kind === "퍼펙트";
    cv += gs() * (put ? 2.2 : perf ? .8 : 1.2);
    const sp = 1 + gs() * (put ? .05 : perf ? .025 : .04);
    const lm = { rough: .9, bunker: .78 }[p.lie] || 1, dir = th + cv * D2R;
    let land, ctrl, end, fly, roll;
    if (put) {
      const carry = (kind === "퍼펙트" ? d * 1.04 : kind === "삑!" ? d * mul * 1.6 : d * (1 + e * .45)) * sp;
      land = P0; ctrl = P0; end = { x: P0.x + Math.cos(dir) * carry, y: P0.y + Math.sin(dir) * carry };
      fly = 0; roll = .6 + Math.min(carry, 40) / 25;
    } else {
      const carry = Math.min(d, c.max) * mul * lm * sp, wv = G.wind.s * 1.7 * (carry / 150) * ht;
      const wx = Math.cos(G.wind.a) * wv, wy = Math.sin(G.wind.a) * wv;
      land = { x: P0.x + Math.cos(dir) * carry + wx, y: P0.y + Math.sin(dir) * carry + wy };
      ctrl = { x: P0.x + Math.cos(th) * carry * .5 + wx * .3, y: P0.y + Math.sin(th) * carry * .5 + wy * .3 };
      const ll = lie(h, land.x, land.y);
      const rk = ({ fair: .08, tee: .08, rough: .025, green: .05 }[ll] || 0) * (c.max >= 150 ? 1 : .5) + (ht < 1 && ll !== "water" && ll !== "ob" ? .15 : 0);
      const ux = land.x - ctrl.x, uy = land.y - ctrl.y, ul = Math.hypot(ux, uy) || 1;
      end = { x: land.x + ux / ul * carry * rk, y: land.y + uy / ul * carry * rk };
      for (let t = 0; t <= 1; t += .05) { const q = { x: land.x + (end.x - land.x) * t, y: land.y + (end.y - land.y) * t }; if (lie(h, q.x, q.y) === "water") { end = q; break; } }
      fly = .8 + carry / 260; roll = .45;
    }
    const s0 = put ? P0 : land, sx = end.x - s0.x, sy = end.y - s0.y, sl2 = sx * sx + sy * sy || 1;
    const tt = Math.max(0, Math.min(1, ((h.pin.x - s0.x) * sx + (h.pin.y - s0.y) * sy) / sl2));
    const cd = Math.hypot(s0.x + sx * tt - h.pin.x, s0.y + sy * tt - h.pin.y), over = dist(end, h.pin);
    const holed = put ? (cd < .45 && over < 5) || over < .5 : dist(land, h.pin) < .3 || (cd < .15 && over < 2.5);
    if (holed) end = { ...h.pin };
    const R = o => ({ x: r2(o.x), y: r2(o.y) });
    G.an = { seq: ++seq, by: p.id, P0: R(P0), P0lie: p.lie, ctrl: R(ctrl), land: R(land), end: R(end), fly: r2(fly), roll: r2(roll), ht, kind, e: r2(e),
      carry: r2(dist(P0, put ? end : land)), holed, put, t0: Date.now() };
    G.sp = "fly"; G.swAt = 0;
    timer((fly + roll) * 1000, finish);
  }
  function pathPts(a) {
    const pts = [];
    if (!a.put) for (let i = 0; i <= 120; i++) { const t = i / 120, u = 1 - t; pts.push({ x: u * u * a.P0.x + 2 * u * t * a.ctrl.x + t * t * a.land.x, y: u * u * a.P0.y + 2 * u * t * a.ctrl.y + t * t * a.land.y }); }
    for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push({ x: a.land.x + (a.end.x - a.land.x) * t, y: a.land.y + (a.end.y - a.land.y) * t }); }
    return pts;
  }
  function waterDrop(a, h) {
    const pts = pathPts(a);
    let c = null;
    for (let i = pts.length - 1; i >= 0; i--) { const l = lie(h, pts[i].x, pts[i].y); if (l !== "water" && l !== "ob") { c = pts[i]; break; } }
    if (!c) return { ...a.P0 };
    const dx = c.x - h.pin.x, dy = c.y - h.pin.y, dl = Math.hypot(dx, dy) || 1;
    for (let k = 1.5; k < 40; k += .5) {
      const q = { x: c.x + dx / dl * k, y: c.y + dy / dl * k }, l = lie(h, q.x, q.y);
      if (l !== "water" && l !== "ob" && l !== "green") return { x: r2(q.x), y: r2(q.y) };
    }
    return { ...a.P0 };
  }
  function finish() {
    const a = G.an, p = P(), h = H();
    if (!a || !p) return nextTurn();
    p.st++;
    let msg = `${p.id}: ${a.kind} ${Math.round(a.carry)}y`;
    if (a.holed) { p.pos = { ...h.pin }; p.done = true; p.sc[G.hi] = p.st; msg += " — 홀인! " + scoreName(p.st, h.par); }
    else {
      const l = lie(h, a.end.x, a.end.y);
      if (l === "water") { p.st++; p.pos = waterDrop(a, h); p.lie = lie(h, p.pos.x, p.pos.y); msg += ` — 해저드! 1벌타, 들어간 지점 근처 드롭 (다음 ${p.st + 1}타째)`; }
      else if (l === "ob") { p.st++; p.pos = { ...a.P0 }; p.lie = a.P0lie; msg += ` — OB! 1벌타, 친 자리에서 다시 (다음 ${p.st + 1}타째)`; }
      else { p.pos = { ...a.end }; p.lie = l; msg += ` · ${LIE_NM[l]} · 남은 ${l === "green" ? dist(p.pos, h.pin).toFixed(1) : Math.round(dist(p.pos, h.pin))}y`; }
      if (p.st >= h.par * 2) { p.done = true; p.sc[G.hi] = h.par * 2; msg += " — 더블파 픽업"; }
    }
    G.msg = msg; log(msg); G.an = null; G.sp = "wait";
    timer(a.holed || /OB|해저드/.test(msg) ? 1800 : 1100, nextTurn);
  }
  function nextId() {
    const left = G.pl.filter(p => !p.done);
    if (!left.length) return "";
    if (G.ord !== "real") {
      const i = G.pl.findIndex(p => p.id === G.cur);
      for (let k = 1; k <= G.pl.length; k++) { const q = G.pl[(i + k + G.pl.length) % G.pl.length]; if (!q.done) return q.id; }
    }
    const un = G.tee.find(id => { const q = G.pl.find(x => x.id === id); return q && !q.done && q.st === 0; });
    if (un) return un;
    const h = H();
    return left.sort((a, b) => dist(b.pos, h.pin) - dist(a.pos, h.pin))[0].id;
  }
  function nextTurn() {
    if (G.ph !== "play") return;
    const id = nextId();
    if (id) return setTurn(id);
    const h = H();
    G.sp = "hole"; G.cur = ""; G.aim = null;
    G.msg = `${G.hi + 1}번 홀 종료 — ` + G.pl.map(p => `${p.id} ${p.sc[G.hi]}(${scoreName(p.sc[G.hi], h.par)})`).join(" · ");
    log(G.msg);
    if (G.hi === G.n - 1) return over();
    G.until = Date.now() + HOLE_MS;
    timer(HOLE_MS, () => { if (G.sp === "hole") startHole(G.hi + 1); });
  }
  function over() {
    clearTimeout(T);
    G.ph = "over"; G.sp = ""; G.cur = "";
    const par = G.holes.reduce((s, h) => s + h.par, 0);
    const r = G.pl.map(p => ({ id: p.id, t: p.sc.reduce((s, v) => s + (v || 0), 0) })).sort((a, b) => a.t - b.t);
    G.msg = "라운드 종료 — " + r.map((x, i) => `${i + 1}위 ${x.id} ${x.t}타(${x.t - par === 0 ? "E" : (x.t - par > 0 ? "+" : "") + (x.t - par)})`).join(" · ");
    log(G.msg);
  }
  function drop(id) {
    const i = G.pl.findIndex(p => p.id === id); if (i < 0) return;
    G.pl.splice(i, 1); G.tee = G.tee.filter(x => x !== id);
    if (!G.pl.length) { clearTimeout(T); G = fresh(G.n, G.ord); return; }
    if (G.ph === "lobby") return;
    if (G.ph === "play") {
      log(id + " 나감");
      if (G.cur === id) { clearTimeout(T); G.an = null; G.cur = ""; nextTurn(); }
    }
  }

  function handle(id, msg) {
    const t = msg.t, p = G.pl.find(q => q.id === id);
    if (t === "gf-join") {
      if (p) { drop(id); return ""; }
      if (G.ph !== "lobby") return "진행 중: 끝나면 참가할 수 있습니다";
      if (G.pl.length >= MAXP) return "정원 " + MAXP + "명 초과";
      G.pl.push(newP(id)); return "";
    }
    if (t === "gf-reset") {
      if (G.ph === "play" && (!p || !msg.force)) return "";
      clearTimeout(T);
      const ids = G.pl.map(q => q.id); G = fresh(G.n, G.ord); G.pl = ids.map(newP); return "";
    }
    if (!p) return "먼저 참가하세요";
    if (t === "gf-cfg") {
      if (G.ph !== "lobby") return "";
      if ([6, 9, 18].includes(msg.n)) G.n = msg.n;
      if (msg.ord === "real" || msg.ord === "alt") G.ord = msg.ord;
      G.pl.forEach(q => q.ready = false); return "";
    }
    if (t === "gf-ready") {
      if (G.ph !== "lobby") return "";
      p.ready = !p.ready;
      if (G.pl.every(q => q.ready)) start();
      return "";
    }
    if (G.ph !== "play") return "";
    if (t === "gf-next") { if (G.sp === "hole") startHole(G.hi + 1); return ""; }
    if (G.cur !== id) return G.cur ? G.cur + " 님 차례입니다" : "";
    const h = H();
    if (t === "gf-aim") {
      if (G.sp !== "aim") return "";
      const x = Number(msg.x), y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
      G.aim.x = r2(Math.max(-200, Math.min(200, x))); G.aim.y = r2(Math.max(-50, Math.min(h.L + 60, y)));
      const ci = Number.isInteger(msg.ci) ? msg.ci : autoClub(p.lie, dist(p.pos, G.aim));
      G.aim.ci = p.lie === "green" ? PT : Math.max(minClub(p.lie), Math.min(PT, ci));
      return "";
    }
    if (t === "gf-swing") {
      if (G.sp !== "aim") return "";
      G.sp = "swing"; G.swAt = Date.now(); G.swPh = r2(rand() * Math.PI * 2);
      G.until = Date.now() + SWING_MS;
      timer(SWING_MS, () => { if (G.sp === "swing") hit(curM()); });
      return "";
    }
    if (t === "gf-hit") {
      if (G.sp !== "swing") return "";
      const e = Number(msg.e);
      hit(Number.isFinite(e) ? Math.max(-1, Math.min(1, e)) : curM());
      return "";
    }
    return "";
  }
  function frame() {
    const now = Date.now();
    return { t: "gf", ph: G.ph, sp: G.sp, n: G.n, ord: G.ord, hi: G.hi, holes: G.holes, wind: G.wind, cur: G.cur, tee: G.tee, aim: G.aim,
      swAge: G.sp === "swing" ? now - G.swAt : -1, swPh: G.swPh, an: G.an ? { ...G.an, age: now - G.an.t0 } : null,
      tl: G.ph === "play" && G.sp !== "fly" && G.sp !== "wait" ? Math.max(0, G.until - now) : 0,
      pl: G.pl.map(q => ({ id: q.id, sc: q.sc, st: q.st, x: q.pos.x, y: q.pos.y, lie: q.lie, done: q.done ? 1 : 0, ready: q.ready ? 1 : 0 })),
      msg: G.msg, log: G.log };
  }
  function push(only) { const f = JSON.stringify(frame()); for (const id of only ? [only] : api.viewers()) api.sendRaw(id, f); }
  return {
    handle(id, msg) { const e = handle(id, msg); if (e) api.reply(id, e); push(); },
    leave(id) { if (!G.pl.some(p => p.id === id)) return; drop(id); push(); },
    push,
    _G: () => G,
  };
}
makeGf.CL = CL; makeGf.lie = lie; makeGf.genHole = genHole;
module.exports = makeGf;
