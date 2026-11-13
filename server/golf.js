"use strict";
/* 골프 (view "gf", sheet 물류동선): one shared round per room, up to 4 players, top-down course.
   5 fixed 18-hole courses (Korea / Japan / Thailand, modelled on the feel of famous real courses: doglegs,
   creeks, lakes, sea along the coast, island green). Each hole = a bent centre line + green ellipse + hazards;
   the layout is fixed per course, only the pin and the wind change every round.
   The player whose turn it is aims on their own screen (gf-aim, echoed to everyone), starts the swing
   (gf-swing → everyone sees the impact gauge moving) and stops it (gf-hit {e}: where the marker was, -1..1).
   The server works out the shot and sends it as an animation; rolls on the green are simulated step by step
   with the green's slope (rollSim) and sent as a path, so putts break and long putts are hard.
   Real rules: OB = 1 stroke + replay from where it was hit; penalty area (water) = 1 stroke + drop near
   where it last crossed into it, no nearer the hole; driver only from the tee. Double par = pick up.
   The block between the GFGEO markers is copied verbatim into index.html — keep them identical
   (test: node server/golf_test.js checks it). */

/*GFGEO*/
const GF_CL = [
  { k: "DR", n: "드라이버", max: 235, cv: 1.3, sp: .75, z: .8 }, { k: "3W", n: "3번 우드", max: 215, cv: 1.2, sp: .78, z: .85 },
  { k: "5I", n: "5번 아이언", max: 180, cv: 1.05, sp: .8, z: .95 }, { k: "7I", n: "7번 아이언", max: 155, cv: 1, sp: .8, z: 1 },
  { k: "9I", n: "9번 아이언", max: 130, cv: .9, sp: .78, z: 1.05 }, { k: "PW", n: "피칭 웨지", max: 105, cv: .8, sp: .76, z: 1.1 },
  { k: "SW", n: "샌드 웨지", max: 75, cv: .7, sp: .74, z: 1.15 }, { k: "PT", n: "퍼터", max: 45, cv: .6, sp: .6, z: 1.5 },
];
const GF_PT = 7;
/* nearest point of the centre line: d = distance, s = yards along it, e = -1 behind the tee / 1 past the green */
function gfNear(h, x, y) {
  const p = h.pts; let best = 1e18, bs = 0, be = 0, acc = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], ay = p[i][1], dx = p[i + 1][0] - ax, dy = p[i + 1][1] - ay, l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
    let t = ((x - ax) * dx + (y - ay) * dy) / l2, e = 0;
    if (t < 0) { if (i === 0) e = -1; t = 0; } else if (t > 1) { if (i === p.length - 2) e = 1; t = 1; }
    const qx = ax + dx * t - x, qy = ay + dy * t - y, d = qx * qx + qy * qy;
    if (d < best) { best = d; bs = acc + t * l; be = e; }
    acc += l;
  }
  return { d: Math.sqrt(best), s: bs, e: be };
}
function gfInE(o, x, y, k) {
  const dx = x - o.x, dy = y - o.y, c = Math.cos(o.a), s = Math.sin(o.a), u = (dx * c + dy * s) / (o.rx + (k || 0)), v = (dy * c - dx * s) / (o.ry + (k || 0));
  return u * u + v * v < 1;
}
function gfInP(p, x, y) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const gfInW = (h, w, x, y) => w.t === "p" ? gfInP(w.p, x, y) : gfInE(w, x, y) && !(w.t === "r" && gfInE(h.g, x, y, w.k));
function gfLie(h, x, y) {
  const n = gfNear(h, x, y);
  if (n.e < 0 && n.d > 24 || n.e > 0 && n.d > h.g.rx + 30) return "ob";
  for (const w of h.water) if (gfInW(h, w, x, y)) return "water";
  if (n.d > h.ob) return "ob";
  if (gfInE(h.g, x, y)) return "green";
  for (const b of h.bunk) if (gfInE(b, x, y)) return "bunker";
  if (Math.abs(x) < 7 && Math.abs(y) < 7) return "tee";
  if (gfInE(h.g, x, y, 4)) return "fair";
  if (n.d > h.ob - h.wd) return "wood";
  if (h.fs >= 0 && n.s > h.fs && n.d < h.fw * (1 + .18 * Math.sin(n.s / 31 + h.i))) return "fair";
  return "rough";
}
/* green slope: downhill pull in y/s² (÷10.7 = slope as a fraction); gfZ = height for shading */
function gfSlope(h, x, y) {
  const g = h.sl; let ax = g[0], ay = g[1];
  if (g[2]) { const dx = x - g[3], dy = y - g[4], w2 = g[5] * g[5], k = g[2] * Math.exp(-(dx * dx + dy * dy) / (2 * w2)) / w2; ax += dx * k; ay += dy * k; }
  return [ax, ay];
}
function gfZ(h, x, y) {
  const g = h.sl, dx = x - g[3], dy = y - g[4];
  return -(g[0] * (x - h.g.x) + g[1] * (y - h.g.y)) + (g[2] ? g[2] * Math.exp(-(dx * dx + dy * dy) / (2 * g[5] * g[5])) : 0);
}
/* point at s yards along the centre line (extrapolates past both ends) + heading */
function gfAt(h, s) {
  const p = h.pts; let acc = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dy);
    if (s <= acc + l || i === p.length - 2) { const t = (s - acc) / l; return { x: p[i][0] + dx * t, y: p[i][1] + dy * t, hd: Math.atan2(dy, dx) }; }
    acc += l;
  }
}
const gfMin = l => l === "tee" ? 0 : l === "bunker" ? 2 : 1;
/* gauge zones: rough / trees / sand narrow them; putts get narrower the longer they are */
function gfZones(ci, l, d) {
  let z = GF_CL[ci].z * ({ rough: .8, wood: .65, bunker: .62 }[l] || 1);
  if (ci === GF_PT) z *= Math.max(.5, Math.min(1.25, 1.3 - (d || 0) / 30));
  return { P: .07 * z, Gd: Math.min(.3 * z, .55), B: Math.min(.62 * z, .86) };
}
function gfSpeed(ci, l, ws, d) {
  const c = GF_CL[ci];
  if (c.k === "PT") return c.sp * (1 + ws * .03) * (1 + Math.min(d || 0, 30) / 30 * .6);
  return c.sp * (1 + ws * .085) * (l === "bunker" ? 1.1 : l === "wood" ? 1.05 : 1);
}
/*/GFGEO*/

const CL = GF_CL, PT = GF_PT, lie = gfLie, minClub = gfMin;
const MAXP = 4, TURN_MS = 60000, SWING_MS = 20000, HOLE_MS = 9000, D2R = Math.PI / 180;
const LIE_NM = { tee: "티박스", fair: "페어웨이", rough: "러프", wood: "숲", green: "그린", bunker: "벙커", water: "해저드", ob: "OB" };

/* ---- courses: each hole "par yards shape features…"
   shape: S straight · L/R dogleg · LL/RR sharp dogleg · SL/SR double dogleg (first turn left/right)
   features: creek (crossing the fairway) · creekG (in front of the green) · lakeL/lakeR (beside the landing area)
             lakeG (pond by the green) · seaL/seaR (coastline along that side) · seaC (par 3 over the sea)
             island (green surrounded by water) · bk (extra bunkers)
   fw = fairway half width, ob = OB distance from the centre line, wd = tree belt inside OB, sl = green slope scale */
const COURSES = [
  { n: "제주 나인브릿지", s: "한라산 중턱 · 계곡이 페어웨이를 가로지름 · 바람", seed: 101, fw: 16, ob: 52, wd: 12, wind: 11, sl: 1,
    h: ["4 385 R", "5 525 SL creek", "3 165 S creekG", "4 410 L bk", "4 360 S lakeR", "3 195 S bk", "5 545 SR creek", "4 400 R lakeL", "4 430 L creekG",
        "4 390 S creek", "3 175 S lakeG", "5 530 SL lakeR", "4 370 RR bk", "4 415 L creek", "3 150 S creekG", "5 555 SR lakeL", "4 380 L bk", "4 445 R creekG"] },
  { n: "제주 핀크스", s: "산방산·바다 조망 · 해송 숲 · 굴곡 심한 그린", seed: 202, fw: 15, ob: 50, wd: 15, wind: 9, sl: 1.35,
    h: ["4 375 L", "4 405 R bk", "3 180 S lakeG", "5 510 SR", "4 350 LL", "3 155 S bk", "4 420 R lakeL", "5 535 SL creek", "4 395 S lakeG",
        "4 385 R bk", "5 520 SL lakeR", "3 170 S bk", "4 360 RR", "4 410 L creek", "3 200 S lakeG", "4 390 R", "5 545 SR lakeL", "4 430 L lakeG"] },
  { n: "해남 파인비치", s: "남해 바닷가 · 바다 끼고 도는 홀 · 바다 넘기는 파3 · 해풍", seed: 303, fw: 18, ob: 55, wd: 10, wind: 12, sl: 1,
    h: ["4 380 R seaL", "4 400 S bk", "5 520 SL seaR", "3 170 S seaC", "4 365 L", "4 410 R seaL", "3 190 S seaC", "5 540 SR", "4 420 L seaR",
        "4 390 L seaR", "3 160 S bk", "5 530 SR seaL", "4 375 R", "4 405 S seaL", "3 205 S seaC", "4 360 LL seaR", "5 550 SL", "4 435 R seaL"] },
  { n: "일본 가와나 후지", s: "이즈반도 절벽 해안 · 좁은 페어웨이 · 경사 큰 포대그린", seed: 404, fw: 14, ob: 48, wd: 12, wind: 12, sl: 1.4,
    h: ["4 375 R seaR", "4 395 L bk", "3 175 S seaC", "5 515 SR seaR", "4 380 S seaL", "3 160 S bk", "4 420 L seaR", "5 540 SL", "4 405 R seaL",
        "4 395 L", "3 195 S seaC", "4 410 R seaR", "5 525 SL seaL", "4 350 RR seaR", "5 560 SR seaR", "3 165 S seaC", "4 425 L seaL", "4 400 R bk"] },
  { n: "태국 블랙마운틴", s: "후아힌 · 넓은 페어웨이 · 호수와 벙커 가득 · 아일랜드 그린", seed: 505, fw: 20, ob: 60, wd: 10, wind: 6, sl: 1.1,
    h: ["4 390 R lakeL", "4 410 S bk", "3 165 S island", "5 530 SL lakeR", "4 370 L lakeG", "4 420 R creek", "3 185 S lakeG", "5 550 SR lakeL", "4 400 L bk",
        "4 380 S lakeR", "5 525 SR lakeL", "3 150 S island", "4 405 L creek", "4 365 RR lakeG", "3 200 S bk", "4 430 R lakeR", "5 545 SL creekG", "4 410 L lakeG"] },
];

function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const r2 = v => Math.round(v * 100) / 100;
const eR = (e, ang) => { const u = ang - e.a; return 1 / Math.hypot(Math.cos(u) / e.rx, Math.sin(u) / e.ry); };

function genHole(ci, i) {
  const C = COURSES[ci], f = C.h[i].split(" "), par = +f[0], L0 = +f[1], shape = f[2], ft = f.slice(3);
  const R = rng(C.seed * 7919 + i * 977), r = (a, b) => a + R() * (b - a), sd = () => (R() < .5 ? -1 : 1), has = k => ft.includes(k);
  let turns = [];
  if (shape === "S") turns = par === 3 ? [] : [[L0 * r(.5, .62), r(-9, 9)]];
  else if (shape[0] === "S") { const g = shape[1] === "L" ? 1 : -1; turns = [[r(235, 260), g * r(18, 30)], [Math.min(L0 - 95, r(395, 430)), -g * r(22, 36)]]; }
  else { const g = shape[0] === "L" ? 1 : -1; turns = [[Math.min(L0 * .62, r(225, 255)), g * (shape.length === 2 ? r(40, 52) : r(20, 34))]]; }
  let hd = 90 + (par === 3 ? r(-14, 14) : r(-7, 7)), x = 0, y = 0, s = 0;
  const pts = [[0, 0]];
  for (const [ts, dt] of turns.concat([[L0, 0]])) { x += Math.cos(hd * D2R) * (ts - s); y += Math.sin(hd * D2R) * (ts - s); pts.push([r2(x), r2(y)]); s = ts; hd += dt; }
  const h = { cid: ci, i, par, pts, ob: C.ob, wd: C.wd, fw: r2(C.fw * r(.9, 1.1)), fs: par === 3 ? -1 : Math.round(r(45, 70)), bunk: [], water: [] };
  h.L = Math.round(pts.slice(1).reduce((a, p, k) => a + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]), 0));
  const end = gfAt(h, h.L), hdE = end.hd, nrm = a => ({ x: -Math.sin(a), y: Math.cos(a) });   // left-hand normal
  const isl = has("island"), grx = par === 3 ? r(11, 14) : r(13, 17);
  h.g = { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], rx: r2(grx), ry: r2(grx * r(.65, .9)), a: r2(r(0, Math.PI)) };
  const gR = h.g.rx;
  /* green slope: mostly back-to-front (downhill toward the fairway), sometimes a hump or a bowl */
  {
    const da = hdE + Math.PI + r(-1.2, 1.2), m = r(.05, .18) * C.sl;
    let A = R() < .65 ? sd() * r(.4, 1) * C.sl : 0;
    const w = r(3.5, 6), ca = r(0, 7), cr = r(0, .55);
    let tx = Math.cos(da) * m, ty = Math.sin(da) * m;
    const tot = m + .61 * Math.abs(A) / w;
    if (tot > .48) { const k = .48 / tot; tx *= k; ty *= k; A *= k; }
    h.sl = [r2(tx * 1000) / 1000, r2(ty * 1000) / 1000, r2(A), r2(h.g.x + Math.cos(ca) * h.g.rx * cr), r2(h.g.y + Math.sin(ca) * h.g.ry * cr), r2(w)];
  }
  const B = (x, y, rx, ry, a) => h.bunk.push({ x: r2(x), y: r2(y), rx: r2(rx), ry: r2(ry), a: r2(a) });
  /* greenside bunkers */
  if (!isl) {
    const front = hdE + Math.PI, cand = [35, -35, 75, -75, 115, -115, 180].map(d => front + d * D2R);
    for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
    const nb = 2 + (R() < .5 ? 1 : 0) + (has("bk") ? 1 : 0);
    for (let k = 0; k < nb; k++) {
      const a = cand[k], ry = r(2.5, 4), d = eR(h.g, a) + ry + r(1.5, 3);
      B(h.g.x + Math.cos(a) * d, h.g.y + Math.sin(a) * d, r(4.5, 7.5), ry, a + Math.PI / 2);
    }
  }
  /* fairway bunkers at the corner (outside of the dogleg) and further on */
  if (par > 3) {
    const t0 = turns[0], s0 = t0 ? t0[0] : r(220, 250), side = t0 && Math.abs(t0[1]) > 12 ? -Math.sign(t0[1]) : sd();
    const fb = (ss, sg) => { const q = gfAt(h, ss), n = nrm(q.hd), ry = r(4, 6), d = h.fw + ry * .6 + r(0, 3); B(q.x + n.x * sg * d, q.y + n.y * sg * d, r(9, 14), ry, q.hd); };
    fb(s0 + r(-8, 14), side);
    if (has("bk")) { fb(s0 + r(-20, 0), -side); fb(Math.min(h.L - gR - 30, s0 + r(45, 70)), sd()); }
    if (par === 5) fb(Math.min(h.L - gR - 35, (turns[1] ? turns[1][0] : 420) + r(-10, 10)), sd());
  }
  /* water */
  const band = (sc, w, lat) => {   // creek across the hole at sc (wavy), lat = half span
    const q = gfAt(h, sc), dir = { x: Math.cos(q.hd), y: Math.sin(q.hd) }, n = nrm(q.hd), ph = r(0, 7), A = [], Bk = [];
    for (let u = -lat; u <= lat; u += 8) {
      const wob = Math.sin(u / 13 + ph) * 2.5, cx = q.x + n.x * u + dir.x * wob, cy = q.y + n.y * u + dir.y * wob;
      A.push([r2(cx - dir.x * w / 2), r2(cy - dir.y * w / 2)]); Bk.push([r2(cx + dir.x * w / 2), r2(cy + dir.y * w / 2)]);
    }
    h.water.push({ t: "p", p: A.concat(Bk.reverse()) });
  };
  if (has("creek")) band(par === 5 ? r(285, 320) : Math.max(255, r(h.L - 120, h.L - 70)), r(7, 10), h.ob + 30);
  if (has("creekG")) band(h.L - gR - r(7, 11), r(6, 9), h.ob + 30);
  for (const sg of [["lakeL", 1], ["lakeR", -1]]) if (has(sg[0])) {
    const q = gfAt(h, r(195, 240)), n = nrm(q.hd), ry = r(10, 15), d = h.fw + ry + r(1, 4);
    h.water.push({ t: "e", x: r2(q.x + n.x * sg[1] * d), y: r2(q.y + n.y * sg[1] * d), rx: r2(r(22, 34)), ry: r2(ry), a: r2(q.hd) });
  }
  if (has("lakeG")) {
    const sg = sd(), n = nrm(hdE), back = { x: -Math.cos(hdE), y: -Math.sin(hdE) }, ry = r(7, 10), d = gR + ry + r(1, 3);
    h.water.push({ t: "e", x: r2(h.g.x + back.x * gR * .5 + n.x * sg * d), y: r2(h.g.y + back.y * gR * .5 + n.y * sg * d), rx: r2(r(13, 19)), ry: r2(ry), a: r2(hdE + sg * .35) });
  }
  for (const sg of [["seaL", 1], ["seaR", -1]]) if (has(sg[0])) {
    const ov = { x: h.g.x / Math.hypot(h.g.x, h.g.y), y: h.g.y / Math.hypot(h.g.x, h.g.y) }, N = { x: -ov.y * sg[1], y: ov.x * sg[1] };
    const E = [], F = [];
    for (let ss = -30; ss <= h.L + 45; ss += 12) {
      const q = gfAt(h, Math.max(-30, Math.min(h.L + 45, ss))), n = nrm(q.hd);
      const off = ss < 35 ? r(15, 20) : ss > h.L - gR - 12 ? gR + r(6, 11) : h.fw + r(6, 16);
      const ex = q.x + n.x * sg[1] * off, ey = q.y + n.y * sg[1] * off;
      E.push([r2(ex), r2(ey)]); F.push([r2(ex + N.x * 400), r2(ey + N.y * 400)]);
    }
    h.water.push({ t: "p", sea: 1, p: E.concat(F.reverse()) });
  }
  if (has("seaC")) {
    const s1 = r(22, 34), s2 = h.L - gR - r(6, 10), q1 = gfAt(h, s1), q2 = gfAt(h, s2), n = nrm(q1.hd), lat = h.ob + 60, ph = r(0, 7), A = [], Bk = [];
    for (let u = -lat; u <= lat; u += 10) {
      A.push([r2(q1.x + n.x * u + Math.cos(q1.hd) * Math.sin(u / 11 + ph) * 3), r2(q1.y + n.y * u + Math.sin(q1.hd) * Math.sin(u / 11 + ph) * 3)]);
      Bk.push([r2(q2.x + n.x * u - Math.cos(q1.hd) * Math.sin(u / 9 + ph) * 3), r2(q2.y + n.y * u - Math.sin(q1.hd) * Math.sin(u / 9 + ph) * 3)]);
    }
    h.water.push({ t: "p", sea: 1, p: A.concat(Bk.reverse()) });
  }
  if (isl) h.water.push({ t: "r", x: h.g.x, y: h.g.y, rx: r2(h.g.rx + r(10, 14)), ry: r2(h.g.ry + r(9, 13)), a: h.g.a, k: 3 });
  return h;
}
function placePin(h, rand) {
  for (let k = 0; k < 50; k++) {
    const a = rand() * Math.PI * 2, t = Math.sqrt(rand()) * .68, c = Math.cos(h.g.a), s = Math.sin(h.g.a);
    const u = Math.cos(a) * h.g.rx * t, v = Math.sin(a) * h.g.ry * t, x = h.g.x + u * c - v * s, y = h.g.y + u * s + v * c;
    if (gfLie(h, x, y) === "green") return { x: r2(x), y: r2(y) };
  }
  return { x: h.g.x, y: h.g.y };
}
/* ball rolling with friction (by surface) + green slope; stops at bunker / water / OB, drops in the cup when slow enough */
const KG = .9, CUP = .11, SDT = 1 / 60, PSTEP = 4, PR = 1.5;
function rollSim(h, P0, dir, D, rand) {
  let x = P0.x, y = P0.y, v = Math.sqrt(2 * KG * Math.max(0, D)), vx = Math.cos(dir) * v, vy = Math.sin(dir) * v, lip = false, holed = false;
  const path = [[r2(x), r2(y)]];
  for (let n = 0; n < 25 / SDT; n++) {
    const l = gfLie(h, x, y);
    if (l === "water" || l === "ob" || l === "bunker") break;
    const k = l === "green" ? KG : l === "fair" || l === "tee" ? 2.4 : l === "rough" ? 5 : 8;
    if (l === "green") { const a = gfSlope(h, x, y); vx += a[0] * SDT; vy += a[1] * SDT; }
    let sp = Math.hypot(vx, vy);
    const ns = sp - k * SDT;
    if (ns <= 0) break;
    vx *= ns / sp; vy *= ns / sp; sp = ns;
    const nx = x + vx * SDT, ny = y + vy * SDT, sx = nx - x, sy = ny - y, sl2 = sx * sx + sy * sy || 1e-9;
    const tt = Math.max(0, Math.min(1, ((h.pin.x - x) * sx + (h.pin.y - y) * sy) / sl2)), dc = Math.hypot(x + sx * tt - h.pin.x, y + sy * tt - h.pin.y);
    if (dc < CUP) {
      if (sp < 1.3 || dc < .05 && sp < 2.1) { holed = true; x = h.pin.x; y = h.pin.y; path.push([x, y]); break; }
      if (!lip) { lip = true; const a = (rand() < .5 ? -1 : 1) * (.3 + rand() * .5), c = Math.cos(a), s = Math.sin(a); [vx, vy] = [(vx * c - vy * s) * .55, (vx * s + vy * c) * .55]; }
    }
    x = nx; y = ny;
    if (n % PSTEP === PSTEP - 1) path.push([r2(x), r2(y)]);
  }
  const last = path[path.length - 1];
  if (last[0] !== r2(x) || last[1] !== r2(y)) path.push([r2(x), r2(y)]);
  return { end: { x, y }, path, holed, lip };
}

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
  let G = fresh(9, "real", 0), T = 0, seq = 0;
  function fresh(n, ord, c) { return { ph: "lobby", n, ord, c, ci: c, holes: [], hi: 0, wind: { s: 0, a: 0 }, pl: [], cur: "", tee: [], sp: "", aim: null, swAt: 0, swPh: 0, an: null, until: 0, msg: "", log: [] }; }
  const P = () => G.pl.find(p => p.id === G.cur), H = () => G.holes[G.hi];
  const newP = id => ({ id, sc: [], st: 0, pos: { x: 0, y: 0 }, lie: "tee", done: false, ready: false });
  function log(s) { G.log.unshift(s); if (G.log.length > 6) G.log.length = 6; }
  function timer(ms, f) { clearTimeout(T); T = setTimeout(() => { f(); push(); }, ms); }

  function start() {
    G.ph = "play"; G.ci = G.c >= 0 ? G.c : Math.floor(rand() * COURSES.length);
    G.holes = Array.from({ length: G.n }, (_, i) => { const h = genHole(G.ci, i); h.pin = placePin(h, rand); return h; });
    for (let k = G.pl.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [G.pl[k], G.pl[j]] = [G.pl[j], G.pl[k]]; }
    G.pl.forEach(p => { p.sc = Array(G.n).fill(null); });
    G.tee = G.pl.map(p => p.id);
    log(G.pl.length + "명 시작 · " + COURSES[G.ci].n + " · " + G.n + "홀 · " + (G.ord === "real" ? "실제 룰" : "번갈아"));
    startHole(0);
  }
  function startHole(i) {
    G.hi = i; G.an = null;
    G.wind = { s: Math.round(rand() * COURSES[G.ci].wind * 10) / 10, a: r2(rand() * Math.PI * 2) };
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
    let tg = { ...h.pin };
    if (p.lie !== "green" && dist(p.pos, h.pin) > 232) {
      const reach = p.lie === "tee" ? 228 : 210, s0 = gfNear(h, p.pos.x, p.pos.y).s;
      for (let s = s0; s < h.L; s += 2) { const q = gfAt(h, s); if (dist(q, p.pos) >= reach) { tg = q; break; } }
    }
    G.aim = { x: r2(tg.x), y: r2(tg.y), ci: autoClub(p.lie, dist(p.pos, tg)) };
    G.until = Date.now() + TURN_MS;
    timer(TURN_MS, () => { if (G.sp === "aim" || G.sp === "swing") hit(curM()); });
  }
  function curM() {
    const p = P();
    return G.swAt ? Math.sin((Date.now() - G.swAt) / 1000 * Math.PI * 2 / 1.7 * gfSpeed(G.aim.ci, p.lie, G.wind.s, dist(p.pos, G.aim)) + G.swPh) : (rand() * 2 - 1);
  }

  function hit(e) {
    const p = P(), h = H(), ci = G.aim.ci, c = CL[ci], a = Math.abs(e);
    const P0 = { ...p.pos }, T0 = { x: G.aim.x, y: G.aim.y };
    const d = Math.max(dist(P0, T0), .3), th = Math.atan2(T0.y - P0.y, T0.x - P0.x), z = gfZones(ci, p.lie, d);
    const put = c.k === "PT", sg = e < 0 ? 1 : -1;
    const gs = () => (rand() + rand() + rand() - 1.5) * 2;   // sd ≈ 1
    let kind, cv = 0, mul = 1, ht = 1, t = 0;
    if (a <= z.P) kind = "퍼펙트";
    else if (a <= z.Gd) { t = (a - z.P) / (z.Gd - z.P); kind = put ? (e < 0 ? "왼쪽으로 당김" : "오른쪽으로 밀림") : e < 0 ? "드로우" : "페이드"; }
    else if (a <= z.B) { t = (a - z.Gd) / (z.B - z.Gd); kind = put ? (e < 0 ? "왼쪽으로 확 당김" : "오른쪽으로 확 밀림") : e < 0 ? "훅" : "슬라이스"; }
    else kind = "삑!";
    const perf = kind === "퍼펙트", band = perf ? 0 : kind === "삑!" ? 3 : a <= z.Gd ? 1 : 2;
    const R = o => ({ x: r2(o.x), y: r2(o.y) });
    let an;
    if (put) {
      /* putt: aim error in degrees, pace error grows with length; the green's slope does the rest */
      const dErr = band === 0 ? gs() * .9 : band === 1 ? sg * (1.2 + 3.3 * t) + gs() * .9 : band === 2 ? sg * (5 + 6 * t) + gs() : gs() * 5;
      const pace = band === 0 ? 1 + gs() * (.03 + .002 * d) : band === 3 ? .35 + rand() * .4 : 1 + gs() * (band === 1 ? .08 + .003 * d : .15);
      const sim = rollSim(h, P0, th + dErr * D2R, (d + Math.min(.35, d * .12)) * pace, rand);
      an = { P0: R(P0), land: R(P0), ctrl: R(P0), end: R(sim.end), path: sim.path, fly: 0, holed: sim.holed, lip: sim.lip };
      if (sim.lip && !sim.holed) kind += " · 컵 돌고 나옴";
    } else {
      if (perf) cv = (rand() - .5) * .5;
      else if (band === 1) { cv = sg * (1.5 + 5 * t) * c.cv; mul = .985 - .04 * t; }
      else if (band === 2) { cv = sg * (8 + 12 * t) * c.cv; mul = .9 - .08 * t; }
      else { cv = (rand() - .5) * 44; mul = .18 + rand() * .22; ht = .25; }
      cv += gs() * (perf ? .8 : 1.2);
      const sp = 1 + gs() * (perf ? .025 : .04), lm = { rough: .9, wood: .75, bunker: .78 }[p.lie] || 1, dir = th + cv * D2R;
      const carry = Math.min(d, c.max) * mul * lm * sp, wv = G.wind.s * 1.7 * (carry / 150) * ht;
      const wx = Math.cos(G.wind.a) * wv, wy = Math.sin(G.wind.a) * wv;
      const land = { x: P0.x + Math.cos(dir) * carry + wx, y: P0.y + Math.sin(dir) * carry + wy };
      const ctrl = { x: P0.x + Math.cos(th) * carry * .5 + wx * .3, y: P0.y + Math.sin(th) * carry * .5 + wy * .3 };
      const ll = lie(h, land.x, land.y);
      const rk = ({ fair: .08, tee: .08, rough: .025, wood: .01, green: .05 }[ll] || 0) * (c.max >= 150 ? 1 : .5) + (ht < 1 && ll !== "water" && ll !== "ob" ? .15 : 0);
      const ux = land.x - ctrl.x, uy = land.y - ctrl.y, rdir = Math.atan2(uy, ux);
      an = { P0: R(P0), ctrl: R(ctrl), land: R(land), fly: r2(.8 + carry / 260), holed: dist(land, h.pin) < .3, lip: false };
      if (an.holed) an.end = R(h.pin);
      else if (ll === "green") { const sim = rollSim(h, land, rdir, carry * rk, rand); an.end = R(sim.end); an.path = sim.path; an.holed = sim.holed; }
      else {
        let end = { x: land.x + Math.cos(rdir) * carry * rk, y: land.y + Math.sin(rdir) * carry * rk };
        for (let q = 0; q <= 1; q += .05) { const o = { x: land.x + (end.x - land.x) * q, y: land.y + (end.y - land.y) * q }; if (lie(h, o.x, o.y) === "water") { end = o; break; } }
        an.end = R(end);
      }
    }
    an.roll = an.path ? r2(Math.max(.3, (an.path.length - 1) * PSTEP * SDT / PR)) : .45;
    an.pdt = r2(PSTEP * SDT / PR * 1000) / 1000;
    Object.assign(an, { seq: ++seq, by: p.id, P0lie: p.lie, ht, kind, e: r2(e), carry: r2(dist(P0, put ? an.end : an.land)), put, t0: Date.now() });
    if (an.holed) an.end = R(h.pin);
    G.an = an; G.sp = "fly"; G.swAt = 0;
    timer((an.fly + an.roll) * 1000 + 150, finish);
  }
  function pathPts(a) {
    const pts = [];
    if (!a.put) for (let i = 0; i <= 120; i++) { const t = i / 120, u = 1 - t; pts.push({ x: u * u * a.P0.x + 2 * u * t * a.ctrl.x + t * t * a.land.x, y: u * u * a.P0.y + 2 * u * t * a.ctrl.y + t * t * a.land.y }); }
    if (a.path) for (const q of a.path) pts.push({ x: q[0], y: q[1] });
    else for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push({ x: a.land.x + (a.end.x - a.land.x) * t, y: a.land.y + (a.end.y - a.land.y) * t }); }
    return pts;
  }
  function waterDrop(a, h) {
    const pts = pathPts(a);
    let c = null;
    for (let i = pts.length - 1; i >= 0; i--) { const l = lie(h, pts[i].x, pts[i].y); if (l !== "water" && l !== "ob") { c = pts[i]; break; } }
    if (!c) return { ...a.P0 };
    const dl = dist(c, h.pin) || 1, away = { x: (c.x - h.pin.x) / dl, y: (c.y - h.pin.y) / dl };
    /* also try toward the centre line (lateral relief from the sea / a side lake), never nearer the hole */
    const ns = gfNear(h, c.x, c.y), q0 = gfAt(h, ns.s), cl = Math.hypot(q0.x - c.x, q0.y - c.y) || 1, inw = { x: (q0.x - c.x) / cl, y: (q0.y - c.y) / cl };
    for (let k = 1.5; k < 45; k += .5)
      for (const u of [away, inw]) {
        const q = { x: c.x + u.x * k, y: c.y + u.y * k }, l = lie(h, q.x, q.y);
        if (l !== "water" && l !== "ob" && l !== "green" && dist(q, h.pin) >= dl - .5) return { x: r2(q.x), y: r2(q.y) };
      }
    return { ...a.P0 };
  }
  function finish() {
    const a = G.an, p = P(), h = H();
    if (!a || !p) return nextTurn();
    p.st++;
    let msg = `${p.id}: ${a.kind} ${a.put ? a.carry.toFixed(1) : Math.round(a.carry)}y`;
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
    G.msg = "라운드 종료 (" + COURSES[G.ci].n + ") — " + r.map((x, i) => `${i + 1}위 ${x.id} ${x.t}타(${x.t - par === 0 ? "E" : (x.t - par > 0 ? "+" : "") + (x.t - par)})`).join(" · ");
    log(G.msg);
  }
  function drop(id) {
    const i = G.pl.findIndex(p => p.id === id); if (i < 0) return;
    G.pl.splice(i, 1); G.tee = G.tee.filter(x => x !== id);
    if (!G.pl.length) { clearTimeout(T); G = fresh(G.n, G.ord, G.c); return; }
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
      const ids = G.pl.map(q => q.id); G = fresh(G.n, G.ord, G.c); G.pl = ids.map(newP); return "";
    }
    if (!p) return "먼저 참가하세요";
    if (t === "gf-cfg") {
      if (G.ph !== "lobby") return "";
      if ([6, 9, 18].includes(msg.n)) G.n = msg.n;
      if (msg.ord === "real" || msg.ord === "alt") G.ord = msg.ord;
      if (Number.isInteger(msg.c) && msg.c >= -1 && msg.c < COURSES.length) G.c = G.ci = msg.c;
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
      G.aim.x = r2(Math.max(-400, Math.min(400, x))); G.aim.y = r2(Math.max(-60, Math.min(h.L + 80, y)));
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
    return { t: "gf", ph: G.ph, sp: G.sp, n: G.n, ord: G.ord, c: G.c, ci: G.ci, cs: COURSES.map(c => [c.n, c.s]),
      hi: G.hi, holes: G.holes.map(h => ({ par: h.par, L: h.L })), h: G.holes[G.hi] || null, wind: G.wind, cur: G.cur, tee: G.tee, aim: G.aim,
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
Object.assign(makeGf, { CL, lie, genHole, placePin, rollSim, gfAt, gfNear, gfSlope, gfZones, COURSES, scoreName });
module.exports = makeGf;
