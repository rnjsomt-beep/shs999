"use strict";
/* 좀비 디펜스 (view "zd", sheet 재고실사): one shared map per room, up to 4 defenders around one house.
   The server runs the whole simulation; everyone looking at the sheet gets a {t:"zd"} frame every tick.
   Game money (gold) lives only inside a run — it never touches casino chips. */
const MW = 25, MH = 17, HX = 11, HY = 7, HW = 3, HH = 3, HCX = 12, HCY = 8;
const TICK = 100, BUILD_S = 15, FIRST_S = 25, ROUNDS = 50, MAXP = 4, GOLD0 = 2500, HP0 = 2000, LVMAX = 5;
const GUNS = [
  { k: "권총",       dmg: 8,   rate: 2.0, rng: 4,  n: 1,  price: 0 },
  { k: "기관단총",   dmg: 7,   rate: 6.0, rng: 4,  n: 1,  price: 2000 },
  { k: "산탄총",     dmg: 14,  rate: 1.4, rng: 3,  n: 4,  price: 6000 },
  { k: "돌격소총",   dmg: 16,  rate: 5.0, rng: 6,  n: 1,  price: 15000 },
  { k: "저격총",     dmg: 120, rate: 0.8, rng: 11, n: 1,  price: 35000 },
  { k: "경기관총",   dmg: 30,  rate: 9.0, rng: 6,  n: 1,  price: 80000 },
  { k: "화염방사기", dmg: 30,  rate: 6.0, rng: 3,  n: 99, price: 160000 },
  { k: "레일건",     dmg: 500, rate: 1.0, rng: 14, n: 6,  price: 400000 },
];
/* building the same thing on top of an existing one upgrades it (Lv2..5, cost = price × next Lv) */
const BUILDS = [
  { k: "바리게이트", id: "bar", hp: 300,  price: 1500 },
  { k: "철벽",       id: "wal", hp: 1200, price: 6000 },
  { k: "철조망",     id: "wir", hp: 400,  price: 2500 },
  { k: "지뢰",       id: "min", hp: 1,    price: 3000 },
  { k: "기관총터렛", id: "tur", hp: 400,  price: 15000, g: { dmg: 10,  rate: 4,   rng: 5,  n: 1 } },
  { k: "화염터렛",   id: "tur", hp: 600,  price: 40000, g: { dmg: 16,  rate: 5,   rng: 3,  n: 99 } },
  { k: "저격터렛",   id: "tur", hp: 500,  price: 60000, g: { dmg: 160, rate: 0.7, rng: 12, n: 1 } },
  { k: "수리",       id: "fix", hp: 0,    price: 1000 },
];
const REWARD_10 = 10000000, REWARD_END = 100000000;   // casino chips for every 10th round cleared / the 50th
const LVM = lv => 1 + 0.7 * (lv - 1);                       // turret damage / wall hp per level
/* zombie kinds (index = type sent to clients; 4 = boss) */
const ZT = [
  { k: "일반", hp: 30,  sp: 0.6,  atk: 6 , gold: 100 },
  { k: "러너", hp: 20,  sp: 1.25, atk: 4,  gold: 120 },
  { k: "탱커", hp: 170, sp: 0.35, atk: 18, gold: 400 },
  { k: "폭탄", hp: 45,  sp: 0.8,  atk: 0,  gold: 250 },
];
const BOSS = {
  10: { k: "덩치",   hp: 1500,  sp: 0.40, atk: 35 },
  20: { k: "울보",   hp: 4500,  sp: 0.45, atk: 50,  sum: 4 },          // calls runners at 80/60/40/20 % hp
  30: { k: "돌진자", hp: 12000, sp: 0.80, atk: 80, wall: 4 },         // ×4 damage to buildings
  40: { k: "거인",   hp: 40000, sp: 0.35, atk: 150, regen: 0.004 },    // regenerates 0.4 %/s
  50: { k: "군주",   hp: 100000, sp: 0.45, atk: 220, regen: 0.003, sum: 4, armor: 0.6 },
};
/* difficulty: more defenders → more and tougher zombies; it bends upward after R25 and again after R40 */
const nMul = n => ({ cnt: 1 + 0.5 * (n - 1), hp: 1 + 0.2 * (n - 1) });
const hpScale = r => Math.pow(1.07, r - 1) * (r > 25 ? 1 + 0.06 * (r - 25) : 1) * (r > 40 ? 1 + 0.08 * (r - 40) : 1);
const atkScale = r => (1 + 0.05 * r) * (r > 25 ? 1 + 0.03 * (r - 25) : 1);
const waveCount = r => Math.round(6 + 1.5 * r + (r > 25 ? (r - 25) * 1.2 : 0) + (r > 40 ? (r - 40) * 1.5 : 0));
const goldScale = r => 1.5 * (1 + 0.06 * r);
const clearBonus = r => 1000 + 400 * r;
const START_POS = [[12, 6], [10, 8], [14, 8], [12, 10]];

const key = (x, y) => x + "," + y;
const inHouse = (x, y) => x >= HX && x < HX + HW && y >= HY && y < HY + HH;
const houseGap = (x, y) => Math.max(Math.max(HX - x, 0, x - (HX + HW - 1)), Math.max(HY - y, 0, y - (HY + HH - 1)));

function makeZd(api, rand = Math.random) {
  let Z = fresh(), timer = 0, best = { r: 0, names: [] };
  function fresh() { return { phase: "lobby", r: 0, t: 0, hp: HP0, hpMax: HP0, z: [], st: {}, pl: {}, log: [], over: "", n: 1, left: 0, fx: [], fl: [] }; }
  const parts = () => Object.keys(Z.pl);
  function log(s) { Z.log.unshift((Z.r ? "R" + Z.r + "  " : "") + s); if (Z.log.length > 6) Z.log.length = 6; }

  /* ---------- lobby / membership ---------- */
  function join(id) {
    if (Z.pl[id]) return "";
    if (Z.phase === "wave" || Z.phase === "over") return "진행 중: 정비 시간에 참가할 수 있습니다";
    const ids = parts(); if (ids.length >= MAXP) return "정원 " + MAXP + "명 초과";
    const used = new Set(ids.map(i => key(Z.pl[i].x, Z.pl[i].y)));
    const [x, y] = START_POS.find(([a, b]) => !used.has(key(a, b))) || START_POS[0];
    // joining mid-run: start with the average purse so a late friend can still help
    const avg = ids.length ? ids.reduce((a, i) => a + Z.pl[i].gold, 0) / ids.length : GOLD0;
    Z.pl[id] = { x, y, gun: 0, gold: Z.phase === "lobby" ? GOLD0 : Math.floor(avg), kill: 0, cd: 0, tx: null, ready: false, skip: false, mvT: 0, mv: 0 };
    log(id + " 참가");
    return "";
  }
  function leave(id) {
    if (!Z.pl[id]) return;
    delete Z.pl[id];
    for (const st of Object.values(Z.st)) if (st.own === id) st.own = null;
    if (!parts().length) { stop(); Z = fresh(); }
    else { log(id + " 이탈"); lobbyCheck(); }
  }
  function lobbyCheck() {
    if (Z.phase !== "lobby") return;
    const ids = parts();
    if (ids.length && ids.every(i => Z.pl[i].ready)) begin();
  }
  function begin() {
    const ids = parts();
    Z.phase = "build"; Z.r = 1; Z.t = FIRST_S; Z.n = ids.length; Z.hp = Z.hpMax = HP0; Z.z = []; Z.st = {}; Z.log = [];
    ids.forEach((i, k) => Object.assign(Z.pl[i], { x: START_POS[k][0], y: START_POS[k][1], gun: 0, gold: GOLD0, kill: 0, cd: 0, tx: null, ready: false, skip: false }));
    log(ids.length + "명 출동 · 첫 정비 " + FIRST_S + "초 — 바리게이트를 세우세요");
    if (!timer) timer = setInterval(() => { try { step(TICK / 1000); } catch (e) { console.error("zd", e); } push(); }, TICK);
  }
  function stop() { if (timer) clearInterval(timer); timer = 0; }

  /* ---------- waves ---------- */
  function startWave() {
    const r = Z.r, m = nMul(parts().length || 1);
    Z.n = parts().length || 1;
    Z.phase = "wave"; Z.hpMul = hpScale(r) * m.hp; Z.atkMul = atkScale(r);
    Z.left = Math.round(waveCount(r) * m.cnt * (BOSS[r] ? 0.6 : 1)); Z.spawnCd = 1;
    Z.spawnGap = Math.max(0.2, 1.3 - 0.02 * r) / m.cnt;
    for (const p of Object.values(Z.pl)) p.skip = false;
    if (BOSS[r]) { spawn(4); log("⚠ 특이품목 '" + BOSS[r].k + "' 출현!"); api.emit && api.emit({ zd: 1, k: "boss", r, b: BOSS[r].k }); }
    else log(r + "라운드 시작 · " + Z.left + "개체");
  }
  function edge() {
    const e = rand() * 4 | 0, t = rand();
    return [e === 0 ? 0 : e === 1 ? MW - 1 : Math.round(t * (MW - 1)), e === 2 ? 0 : e === 3 ? MH - 1 : Math.round(t * (MH - 1))];
  }
  function spawn(ty, at) {
    const [x, y] = at || edge(), r = Z.r;
    if (ty === 4) {
      const B = BOSS[r], hp = B.hp * nMul(Z.n).hp;
      Z.z.push({ ty, x, y, hp, max: hp, sp: B.sp, atk: B.atk, cd: 0, gold: 3000 * r, last: null, B, sum: B.sum || 0 });
      return;
    }
    const T = ZT[ty], hp = T.hp * Z.hpMul;
    Z.z.push({ ty, x, y, hp, max: hp, sp: T.sp * (r > 30 ? 1.15 : 1), atk: T.atk * Z.atkMul, cd: 0, gold: Math.round(T.gold * goldScale(r)), last: null });
  }
  function pickType() {
    const r = Z.r, q = rand();
    if (r >= 18 && q < 0.1) return 3;
    if (r >= 12 && q < 0.1 + Math.min(0.25, 0.1 + (r - 12) * 0.006)) return 2;
    if (r >= 5 && q < 0.5) return 1;
    return 0;
  }
  const blockedSt = (x, y) => { const st = Z.st[key(x, y)]; return st && st.id !== "wir" && st.id !== "min" ? st : null; };
  const canStand = (x, y, self) => x >= 0 && y >= 0 && x < MW && y < MH && !inHouse(x, y) && !blockedSt(x, y) && !Object.entries(Z.pl).some(([i, p]) => i !== self && p.x === x && p.y === y);
  /* walking: breadth-first search around the house and buildings, returns the first step (or null) */
  function nextStep(x, y, tx, ty, self) {
    const prev = new Int16Array(MW * MH).fill(-1), q = [y * MW + x], goal = ty * MW + tx;
    prev[q[0]] = q[0];
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      if (c === goal) { let s = c; while (prev[s] !== q[0]) s = prev[s]; return [s % MW, s / MW | 0]; }
      const cx = c % MW, cy = c / MW | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, n = ny * MW + nx;
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH || prev[n] >= 0) continue;
        if (n !== goal && !canStand(nx, ny, self)) continue;
        if (n === goal && (inHouse(nx, ny) || blockedSt(nx, ny))) continue;
        prev[n] = c; q.push(n);
      }
    }
    return null;
  }
  const cell = (x, y) => Math.round(y) * MW + Math.round(x);
  function hurt(z, dmg, who) { z.hp -= dmg * (z.B && z.B.armor ? z.B.armor : 1); z.last = who; Z.fx.push(cell(z.x, z.y)); }
  function fire(g, mul, ox, oy, who, dt, o) {
    o.cd -= dt; if (o.cd > 0) return;
    o.cd = 0;
    const tg = [];
    for (const z of Z.z) { if (z.hp <= 0) continue; const d = Math.hypot(z.x - ox, z.y - oy); if (d <= g.rng) tg.push([d, z]); }
    if (!tg.length) return;
    tg.sort((a, b) => a[0] - b[0]);
    o.cd = 1 / g.rate;
    for (let i = 0; i < tg.length && i < g.n; i++) { hurt(tg[i][1], g.dmg * mul, who); if (g.n >= 99) Z.fl.push(cell(tg[i][1].x, tg[i][1].y)); }
  }
  function step(dt) {
    Z.fx = []; Z.fl = [];
    if (Z.phase === "build") {
      Z.t -= dt;
      const ids = parts();
      if (Z.t <= 0 || (ids.length && ids.every(i => Z.pl[i].skip))) startWave();
    } else if (Z.phase !== "wave") return;
    else {
      Z.spawnCd -= dt;
      if (Z.left > 0 && Z.spawnCd <= 0) { spawn(pickType()); Z.left--; Z.spawnCd = Z.spawnGap; }
    }
    /* zombies walk straight at the house; a wall in the way gets chewed on */
    for (const z of Z.z) {
      if (z.hp <= 0) continue;
      const B = z.B;
      if (B && B.regen) z.hp = Math.min(z.max, z.hp + z.max * B.regen * dt);
      if (B && B.sum && z.hp < z.max * z.sum / 5) { z.sum--; for (let i = 0; i < 4 * Z.n; i++) spawn(B.armor ? 2 : 1, [z.x, z.y]); log(B.k + "가 무리를 불렀습니다"); }
      const cx = Math.round(z.x), cy = Math.round(z.y), here = Z.st[key(cx, cy)];
      let sp = z.sp;
      if (here && here.id === "wir") { sp *= 0.5; z.hp -= 8 * (1 + 0.1 * Z.r) * LVM(here.lv) * dt; z.last = here.own; here.hp -= z.atk * 0.3 * dt; }
      if (here && here.id === "min") {
        const dmg = 150 * (1 + 0.15 * Z.r) * LVM(here.lv);
        for (const o of Z.z) if (Math.hypot(o.x - z.x, o.y - z.y) < 1.6) hurt(o, dmg, here.own);
        delete Z.st[key(cx, cy)]; Z.fl.push(cell(cx, cy));
      }
      if (houseGap(cx, cy) <= (B ? 2 : 1)) {
        z.cd -= dt;
        if (z.cd <= 0) { z.cd = 1; if (z.ty === 3) { Z.hp -= 60 * Z.atkMul; z.hp = 0; z.last = null; } else Z.hp -= z.atk; }
        continue;
      }
      const dx = HCX - z.x, dy = HCY - z.y, dist = Math.hypot(dx, dy) || 1;
      const nx = z.x + dx / dist * sp * dt, ny = z.y + dy / dist * sp * dt;
      const bl = blockedSt(Math.round(nx), Math.round(ny));
      if (!bl) { z.x = nx; z.y = ny; continue; }
      z.cd -= dt;
      if (z.cd <= 0) {
        z.cd = 1;
        if (z.ty === 3) { bl.hp -= 250 * Z.atkMul; z.hp = 0; z.last = null; Z.fl.push(cell(nx, ny)); }
        else bl.hp -= z.atk * (B && B.wall ? B.wall : 1);
      }
      // slide along the wall when one axis is still free
      const ax = z.x + Math.sign(dx) * sp * dt, ay = z.y + Math.sign(dy) * sp * dt;
      if (Math.abs(dx) > 0.5 && !blockedSt(Math.round(ax), Math.round(z.y))) z.x = ax;
      else if (Math.abs(dy) > 0.5 && !blockedSt(Math.round(z.x), Math.round(ay))) z.y = ay;
    }
    for (const k of Object.keys(Z.st)) if (Z.st[k].hp <= 0) { log(BUILDS[Z.st[k].b].k + " 파괴됨"); delete Z.st[k]; }
    /* defenders: walk toward a tapped cell, always shoot the nearest zombies in range */
    for (const [id, p] of Object.entries(Z.pl)) {
      p.mv -= dt;
      if (p.tx && p.mv <= 0) {
        const [tx, ty] = p.tx;
        if (tx === p.x && ty === p.y) p.tx = null;
        else {
          const nx = nextStep(p.x, p.y, tx, ty, id);
          if (nx) { p.x = nx[0]; p.y = nx[1]; } else p.tx = null;
          p.mv = 0.14;
        }
      }
      if (Z.phase === "wave") fire(GUNS[p.gun], 1, p.x, p.y, id, dt, p);
    }
    if (Z.phase === "wave") for (const [k, st] of Object.entries(Z.st)) if (st.g) { const [x, y] = k.split(",").map(Number); fire(st.g, LVM(st.lv), x, y, st.own, dt, st); }
    Z.z = Z.z.filter(z => {
      if (z.hp > 0) return true;
      const p = z.last && Z.pl[z.last];
      if (p && z.gold) { p.gold += z.gold; p.kill++; }
      if (z.ty === 4) { log("'" + z.B.k + "' 처치! +" + z.gold.toLocaleString("ko-KR")); api.emit && api.emit({ zd: 1, k: "bossdown", r: Z.r, b: z.B.k, name: z.last }); }
      return false;
    });
    if (Z.hp <= 0) return end(false);
    if (Z.phase === "wave" && !Z.left && !Z.z.length) {
      const bonus = clearBonus(Z.r);
      for (const p of Object.values(Z.pl)) p.gold += bonus;
      log(Z.r + "라운드 클리어 · 전원 +" + bonus.toLocaleString("ko-KR"));
      if (Z.r % 10 === 0) {   // casino reward per 10 rounds cleared (real chips): 1천만, the final 50th → 1억
        const chips = Z.r === ROUNDS ? REWARD_END : REWARD_10;
        api.reward && api.reward(parts(), chips, Z.r);
        log(Z.r + "라운드 달성 보상 · 전원 칩 +" + (chips / 1e4).toLocaleString("ko-KR") + "만");
      }
      if (Z.r >= ROUNDS) return end(true);
      Z.r++; Z.phase = "build"; Z.t = BUILD_S; Z.hp = Math.min(Z.hpMax, Z.hp + 100);
    }
  }
  function end(win) {
    Z.hp = Math.max(0, Z.hp); Z.phase = "over";
    const reached = win ? ROUNDS : Z.r;
    Z.over = win ? "50라운드 방어 성공!" : "본사 함락 — " + Z.r + "라운드";
    log(Z.over);
    if (reached > best.r || (win && best.r === ROUNDS)) best = { r: reached, names: parts(), win };
    api.emit && api.emit({ zd: 1, k: win ? "clear" : "fall", r: reached, names: parts() });
    stop();
  }

  /* ---------- actions ---------- */
  function handle(id, msg) {
    const t = msg.t, p = Z.pl[id], now = Date.now();
    if (t === "zd-join") return p ? (leave(id), "") : join(id);
    if (t === "zd-reset") { if (Z.phase !== "over") return "진행 중에는 초기화할 수 없습니다"; const ids = parts(); stop(); Z = fresh(); ids.forEach(join); Z.log = []; return ""; }
    if (!p) return "먼저 참가하세요";
    if (t === "zd-ready" && Z.phase === "lobby") { p.ready = !p.ready; lobbyCheck(); return ""; }
    if (t === "zd-skip" && Z.phase === "build") { p.skip = !p.skip; return ""; }
    if (Z.phase !== "build" && Z.phase !== "wave") return "";
    if (t === "zd-mv") {
      const dx = Math.sign(Number(msg.dx) || 0), dy = Math.sign(Number(msg.dy) || 0);
      if (now - p.mvT < 80 || (dx && dy)) return "";
      p.mvT = now; p.tx = null;
      if (canStand(p.x + dx, p.y + dy, id)) { p.x += dx; p.y += dy; }
      return "";
    }
    if (t === "zd-go") {
      const x = msg.x, y = msg.y;
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < MW && y < MH && !inHouse(x, y)) p.tx = [x, y];
      return "";
    }
    if (t === "zd-gun") {
      const i = msg.i, g = GUNS[i];
      if (!Number.isInteger(i) || !g || i <= p.gun) return "";
      if (p.gold < g.price) return "자금 부족";
      p.gold -= g.price; p.gun = i; log(id + " " + g.k + " 구매");
      return "";
    }
    if (t === "zd-bd") {
      const b = msg.b, x = msg.x, y = msg.y, B = BUILDS[b];
      if (!Number.isInteger(b) || !B || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MW || y >= MH) return "";
      const k = key(x, y), st = Z.st[k];
      if (B.id === "fix") {
        if (p.gold < B.price) return "자금 부족";
        if (inHouse(x, y)) { if (Z.hp >= Z.hpMax) return "본사 내구 최대"; Z.hp = Math.min(Z.hpMax, Z.hp + 200); }
        else if (st) { const mx = BUILDS[st.b].hp * LVM(st.lv); if (st.hp >= mx) return "내구 최대"; st.hp = Math.min(mx, st.hp + mx * 0.4); }
        else return "수리할 건물을 누르세요";
        p.gold -= B.price; return "";
      }
      if (inHouse(x, y)) return "본사 위에는 지을 수 없습니다";
      if (st) {   // same building again = upgrade
        if (st.b !== b) return "다른 건물이 있습니다";
        if (st.lv >= LVMAX) return "최대 레벨";
        const c = B.price * (st.lv + 1);
        if (p.gold < c) return "자금 부족 (강화 " + c.toLocaleString("ko-KR") + ")";
        p.gold -= c; st.lv++; st.hp = B.hp * LVM(st.lv); log(id + " " + B.k + " Lv" + st.lv);
        return "";
      }
      if (Object.values(Z.pl).some(q => q.x === x && q.y === y)) return "사람이 서 있는 칸입니다";
      if (Z.z.some(z => Math.round(z.x) === x && Math.round(z.y) === y)) return "좀비가 있는 칸입니다";
      if (p.gold < B.price) return "자금 부족";
      p.gold -= B.price;
      Z.st[k] = { b, id: B.id, hp: B.hp, lv: 1, own: id, cd: 0, g: B.g || null };
      return "";
    }
    return "";
  }

  /* ---------- frames ---------- */
  function frame() {
    return { t: "zd", ph: Z.phase, r: Z.r, tm: Math.max(0, Math.ceil(Z.t)), hp: Math.ceil(Z.hp), hpMax: Z.hpMax, n: Z.n, over: Z.over, left: Z.left, best,
      z: Z.z.map(z => [Math.round(z.x * 10), Math.round(z.y * 10), Math.ceil(z.hp), z.ty, z.ty === 4 ? Math.round(z.hp / z.max * 1000) : 0]),
      bk: Z.phase === "wave" && BOSS[Z.r] ? BOSS[Z.r].k : "",
      st: Object.entries(Z.st).map(([k, s]) => { const [x, y] = k.split(",").map(Number); return [x, y, s.b, Math.ceil(s.hp), s.lv, s.own]; }),
      pl: Object.entries(Z.pl).map(([id, p]) => [id, p.x, p.y, p.gun, Math.floor(p.gold), p.kill, p.ready ? 1 : 0, p.skip ? 1 : 0]),
      fx: [...new Set(Z.fx)], fl: [...new Set(Z.fl)], log: Z.log };
  }
  function push(only) {
    const f = JSON.stringify(frame());
    for (const id of only ? [only] : api.viewers()) api.sendRaw(id, f);
  }
  return {
    handle(id, msg) { const e = handle(id, msg); if (e) api.reply(id, e); push(); },
    leave(id) { leave(id); push(); },
    push,
    stop,
    get best() { return best; },
    set best(b) { if (b && Number.isInteger(b.r) && b.r >= 0 && b.r <= ROUNDS) best = { r: b.r, names: Array.isArray(b.names) ? b.names.slice(0, 4).map(String) : [], win: !!b.win }; },
    get active() { return Z.phase !== "lobby"; },
    _Z: () => Z, _step: step, _begin: begin, _join: join,
  };
}
makeZd.C = { REWARD_10, REWARD_END, MW, MH, GUNS, BUILDS, BOSS, ZT, nMul, hpScale, waveCount };
module.exports = makeZd;
