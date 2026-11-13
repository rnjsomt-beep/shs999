"use strict";
/* node server/golf_test.js — checks the GFGEO block is identical in index.html, every course hole is playable,
   and prints putting make-rates (flat-ish vs sloped greens) for perfect strikes aimed straight at the cup. */
const fs = require("fs"), path = require("path");
const G = require("./golf");
const { COURSES, genHole, placePin, rollSim, gfAt, gfSlope, lie } = G;
let bad = 0;
const fail = m => { bad++; console.log("FAIL", m); };

const blk = s => { const a = s.indexOf("/*GFGEO*/"), b = s.indexOf("/*/GFGEO*/"); return a < 0 || b < 0 ? null : s.slice(a, b); };
const sv = blk(fs.readFileSync(path.join(__dirname, "golf.js"), "utf8")), cl = blk(fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8"));
if (!cl) fail("index.html has no GFGEO block"); else if (sv !== cl) fail("GFGEO block differs between golf.js and index.html");

let seed = 7; const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let c = 0; c < COURSES.length; c++) {
  let par = 0;
  for (let i = 0; i < 18; i++) {
    const h = genHole(c, i), tag = COURSES[c].n + " " + (i + 1) + "번";
    par += h.par;
    h.pin = placePin(h, rand);
    if (lie(h, 0, 0) !== "tee") fail(tag + " tee lie " + lie(h, 0, 0));
    if (lie(h, h.pin.x, h.pin.y) !== "green") fail(tag + " pin not on green");
    if (lie(h, h.g.x, h.g.y) !== "green") fail(tag + " green centre is " + lie(h, h.g.x, h.g.y));
    if (Math.abs(h.L - +COURSES[c].h[i].split(" ")[1]) > 2) fail(tag + " length " + h.L);
    // centre line: fairway (or a creek) all the way from the fairway start to the green
    let n = 0, w = 0, o = 0;
    for (let s = Math.max(h.fs, 0) + 6; s < h.L - h.g.rx - 2; s += 4) { const q = gfAt(h, s), l = lie(h, q.x, q.y); n++; if (l === "water") w++; else if (h.par > 3 && l !== "fair" && l !== "bunker") o++; }
    if (h.par > 3 && o > n * .08) fail(tag + ` centre line off fairway ${o}/${n}`);
    if (w > n * (h.par === 3 ? .95 : .2)) fail(tag + ` centre line water ${w}/${n}`);
    // some ground to land on around the green
    let gg = 0; for (let k = 0; k < 400; k++) { const a = rand() * 7, r = rand() * h.g.rx; if (lie(h, h.g.x + Math.cos(a) * r, h.g.y + Math.sin(a) * r) === "green") gg++; }
    if (gg < 150) fail(tag + " tiny green " + gg);
  }
  if (par !== 72) fail(COURSES[c].n + " par " + par);
}

/* putting: perfect strike, aimed straight at the cup, pace = d + .35 with the same spread as golf.js hit() */
const gs = () => (rand() + rand() + rand() - 1.5) * 2;
function trial(h, d, read) {
  const a = rand() * 7, P0 = { x: h.pin.x + Math.cos(a) * d, y: h.pin.y + Math.sin(a) * d };
  if (lie(h, P0.x, P0.y) !== "green") return null;
  let th = Math.atan2(h.pin.y - P0.y, h.pin.x - P0.x), D = d;
  if (read) { // ideal read: search the aim angle / pace that holes it with no error
    const ok = [];
    for (let da = -25; da <= 25; da += .5) for (let k = .8; k <= 1.6; k += .05) if (rollSim(h, P0, th + da * Math.PI / 180, (d + .35) * k, () => .5).holed) ok.push([da, k]);
    const mid = ok.length ? [ok.reduce((s, q) => s + q[0], 0) / ok.length, ok.reduce((s, q) => s + q[1], 0) / ok.length] : null;
    const best = mid && ok.reduce((b, q) => Math.hypot(q[0] - mid[0], (q[1] - mid[1]) * 20) < Math.hypot(b[0] - mid[0], (b[1] - mid[1]) * 20) ? q : b);
    if (!best) return null;
    th += best[0] * Math.PI / 180; D = d * best[1];
  }
  return rollSim(h, P0, th + gs() * .9 * Math.PI / 180, (D + Math.min(.35, D * .12)) * (1 + gs() * (.03 + .002 * d)), rand).holed;
}
const flatH = (() => { const h = genHole(0, 0); h.sl = [0, 0, 0, 0, 0, 5]; h.pin = { x: h.g.x, y: h.g.y }; return h; })();
console.log("putt make-rate (perfect strike)  dist: flat / real greens aimed at cup / real greens ideal read");
for (const d of [2, 3, 5, 8, 10, 15, 20]) {
  const row = [];
  for (const [mode, read] of [["flat", false], ["real", false], ["read", true]]) {
    let n = 0, m = 0;
    for (let k = 0; k < (read ? 120 : 600); k++) {
      const h = mode === "flat" ? flatH : (() => { const c = Math.floor(rand() * 5), h = genHole(c, Math.floor(rand() * 18)); h.pin = placePin(h, rand); return h; })();
      const r = trial(h, d, read); if (r === null) continue; n++; if (r) m++;
    }
    row.push((n ? Math.round(m / n * 100) : "-") + "%");
  }
  console.log(String(d).padStart(4) + "y  " + row.join("  /  "));
}
let mx = 0; for (let c = 0; c < 5; c++) for (let i = 0; i < 18; i++) { const h = genHole(c, i); for (let k = 0; k < 50; k++) { const a = gfSlope(h, h.g.x + (rand() - .5) * h.g.rx * 2, h.g.y + (rand() - .5) * h.g.ry * 2); mx = Math.max(mx, Math.hypot(a[0], a[1])); } }
console.log("max green slope", (mx / 10.7 * 100).toFixed(1) + "%");
console.log(bad ? bad + " FAILURES" : "all ok");
process.exitCode = bad ? 1 : 0;
