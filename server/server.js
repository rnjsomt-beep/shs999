"use strict";
/* shs999 game server: one websocket endpoint, rooms by name (#MAIN …), accounts saved on disk.
   Run: PORT=8099 DATA=./data node server.js   (Caddy in front supplies https/wss) */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const makeRoom = require("./engine");
const market = require("./market");

const PORT = +process.env.PORT || 8099, HOST = process.env.HOST || "127.0.0.1";
const DATA = process.env.DATA || path.join(__dirname, "data");
const START = 1000000, GRACE = 20000, MAXNAME = 8;
fs.mkdirSync(DATA, { recursive: true });
market.init(path.join(DATA, "market.json"));

/* ---------- accounts: name -> { chips, rebuy, peak, st, stk, t } ---------- */
const file = n => path.join(DATA, n);
const load = n => { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch { return null; } };
const ACC = load("accounts.json") || {};
const LEGACY = load("legacy_board.json") || {};   // old offline rankings brought in from players' browsers
/* one name per IP: the first login from an IP fixes its name (after the player confirms). The browser also gets a
   token for that name, so the same phone keeps its name when its IP changes (LTE ↔ wifi) or shares a wifi */
const IPL = load("ips.json") || {};
IPL.ip = IPL.ip || {}; IPL.tok = IPL.tok || {};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const owned = n => Object.values(IPL.ip).includes(n) || Object.values(IPL.tok).includes(n);
function ipOf(req) {
  const x = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  return x.replace(/^::ffff:/, "");
}
function unbind(n) {
  for (const o of [IPL.ip, IPL.tok]) for (const k of Object.keys(o)) if (o[k] === n) delete o[k];
  dirty = true;
}
/* admin only: every name -> the IPs it is fixed to / connected from right now */
const ADMIN = "성호";
function ipList() {
  const o = {}, add = (n, ip) => { if (!ip || n in Object.prototype) return; (o[n] = o[n] || []).includes(ip) || o[n].push(ip); };
  for (const [ip, n] of Object.entries(IPL.ip)) add(n, ip);
  for (const ws of wss.clients) if (ws.name && ws.room) add(ws.name, ws.ip);
  return o;
}
/* withdrawals: a player turns game money into withdrawable money (1억 → 1원). The chips leave the table when the
   request is made; the admin accepts (→ that player's 출금 가능 balance) or rejects (→ chips back). The admin marks
   a balance 지급 완료 once it has actually been paid out. */
const WD_RATE = 1e8;
const WD = load("wd.json") || {};
WD.req = Array.isArray(WD.req) ? WD.req : []; WD.bal = WD.bal || {}; WD.log = Array.isArray(WD.log) ? WD.log : [];
function toAdmin(m) { const w = NAMES.get(ADMIN); if (w) send(w, { t: "err", m }); }
function refreshAll() { for (const r of rooms.values()) if (r.size) r.refresh(); }
function addChips(n, v) {
  for (const r of rooms.values()) if (r.has(n)) return r.addChips(n, v);
  const a = ACC[n]; if (!a) return;
  a.chips += v; a.t = Date.now(); dirty = true; boardAt = 0;
}
function wdReq(n, amt) {
  WD.req.push({ id: crypto.randomBytes(6).toString("hex"), name: n, amt, won: amt / WD_RATE, t: Date.now() });
  dirty = true; toAdmin(n + " 님이 " + (amt / WD_RATE).toLocaleString() + "원 (" + amt.toLocaleString() + ") 출금 신청을 했어요"); refreshAll();
}
const wdPend = n => WD.req.filter(r => r.name === n).length;
function wdAns(rid, ok) {
  const i = WD.req.findIndex(r => r.id === rid); if (i < 0) return;
  const [r] = WD.req.splice(i, 1);
  if (ok) WD.bal[r.name] = (WD.bal[r.name] || 0) + r.won; else addChips(r.name, r.amt);
  WD.log.unshift({ ...r, ok: !!ok, at: Date.now() }); WD.log.length = Math.min(WD.log.length, 100);
  dirty = true;
  const w = NAMES.get(r.name); if (w) send(w, { t: "err", m: "출금 " + r.won.toLocaleString() + "원 " + (ok ? "수락됨 → 출금 가능 금액에 추가" : "거절됨 → 게임머니 반환") });
  refreshAll();
}
function wdPaid(n) {
  if (!WD.bal[n]) return;
  WD.log.unshift({ name: n, won: WD.bal[n], paid: true, at: Date.now() }); WD.log.length = Math.min(WD.log.length, 100);
  delete WD.bal[n]; dirty = true;
  const w = NAMES.get(n); if (w) send(w, { t: "err", m: "출금 가능 금액 지급 완료" });
  refreshAll();
}
const wdView = n => ({ bal: WD.bal[n] || 0, mine: WD.req.filter(r => r.name === n), rate: WD_RATE,
  ...(n === ADMIN ? { all: WD.req, bals: WD.bal, log: WD.log.slice(0, 20) } : {}) });
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  for (const [n, o] of [["accounts.json", ACC], ["legacy_board.json", LEGACY], ["ips.json", IPL], ["wd.json", WD]]) {
    try { fs.writeFileSync(file(n) + ".tmp", JSON.stringify(o)); fs.renameSync(file(n) + ".tmp", file(n)); }
    catch (e) { console.error("save failed", n, e.message); dirty = true; }
  }
}
setInterval(save, 3000);
const badName = n => !n || n.length > MAXNAME || n in Object.prototype;
/* a live player -> its saved account (bets not dealt yet count as balance, so a crash never eats them) */
function saw(p) {
  const pend = Object.values(p.bac || {}).reduce((a, b) => a + b, 0) + Object.values(p.rl || {}).reduce((a, b) => a + b, 0)
    + (p.bj && !p.bj.cards.length ? p.bj.bet : 0) + Object.values(p.to || {}).reduce((a, b) => a + b, 0);
  ACC[p.name] = { chips: p.chips + pend, rebuy: p.rebuy || 0, peak: p.peak, st: p.st, stk: JSON.parse(JSON.stringify(p.stk || {})), lb: JSON.parse(JSON.stringify(p.lb || {})), t: Date.now() };
  dirty = true; boardAt = 0;
}
let boardC = {}, boardAt = 0;
function board() {
  if (Date.now() - boardAt < 1000) return boardC;
  const b = {};
  for (const [n, e] of Object.entries(LEGACY)) if (!ACC[n]) b[n] = e;
  for (const [n, a] of Object.entries(ACC)) b[n] = [a.chips + market.value(a.stk) - START * (a.rebuy || 0), a.t];   // 계좌 = 칩 + 주식 평가 − 충전
  const keep = Object.entries(b).sort((x, y) => y[1][1] - x[1][1]).slice(0, 300);
  boardC = Object.fromEntries(keep); boardAt = Date.now();
  return boardC;
}
function importBoard(src) {
  if (!src || typeof src !== "object") return;
  for (const [n, e] of Object.entries(src).slice(0, 300)) {
    const k = String(n).slice(0, MAXNAME), v = Number(e && e[0]), t = Number(e && e[1]);
    if (badName(k) || ACC[k] || !Number.isFinite(v) || !Number.isFinite(t) || t > Date.now() + 864e5) continue;
    if (!LEGACY[k] || LEGACY[k][1] < t) { LEGACY[k] = [v, t]; dirty = true; boardAt = 0; }
  }
}
/* admin balance: online player right away, otherwise the saved account */
function admSet(n, v) {
  for (const r of rooms.values()) if (r.has(n)) { r.setChips(n, v); return; }
  const a = ACC[n] || { rebuy: 0, peak: v, st: null };
  ACC[n] = { ...a, chips: v, peak: Math.max(a.peak || 0, v), t: Date.now() };
  dirty = true; boardAt = 0;
  for (const r of rooms.values()) if (r.size) r.refresh();
}

/* ---------- rooms ---------- */
const rooms = new Map();   // code -> { room, empty since }
/* each room's game records (rounds, results, logs, chat), kept across empty rooms and restarts */
const ROOMS = load("rooms.json") || {};
let roomsJ = JSON.stringify(ROOMS);
function saveRooms() {
  for (const r of rooms.values()) { try { ROOMS[r.code] = r.dump(); } catch (e) { console.error("room dump", r.code, e); } }
  const j = JSON.stringify(ROOMS); if (j === roomsJ) return;
  try { fs.writeFileSync(file("rooms.json") + ".tmp", j); fs.renameSync(file("rooms.json") + ".tmp", file("rooms.json")); roomsJ = j; }
  catch (e) { console.error("save failed rooms.json", e.message); }
}
setInterval(saveRooms, 5000);
const ctx = { board, saw, admSet, unbind, wdReq, wdAns, wdPaid, wdView, wdPend, WD_RATE, GRACE, stock: k => market.get(k), skValue: market.value };
function roomOf(code) {
  let r = rooms.get(code);
  if (!r) { r = makeRoom(code, ctx); r.code = code; r.emptyAt = 0; try { r.load(ROOMS[code]); } catch (e) { console.error("room load", code, e); } rooms.set(code, r); }
  return r;
}
setInterval(() => {
  const n = Date.now();
  for (const [code, r] of rooms) {
    try { r.tick(); } catch (e) { console.error("tick", code, e); }
    if (r.size) r.emptyAt = 0; else if (!r.emptyAt) r.emptyAt = n; else if (n - r.emptyAt > 600000) { saveRooms(); rooms.delete(code); }
  }
}, 1000);

/* ---------- network ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ rooms: [...rooms.values()].map(r => ({ code: r.code, players: r.size })), accounts: Object.keys(ACC).length }));
  }
  if (req.url === "/ip") {   // lobby: is this IP's name fixed already?
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    const ip = ipOf(req);
    return res.end(JSON.stringify({ name: own(IPL.ip, ip) ? IPL.ip[ip] : null }));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("shs999 server ok");
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const NAMES = new Map();   // name -> socket (one live connection per name)
const send = (ws, m) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch {} };
wss.on("connection", (ws, req) => {
  ws.alive = true; ws.ip = ipOf(req);
  ws.on("pong", () => ws.alive = true);
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    ws.alive = true;
    if (m.t === "ping") return send(ws, { t: "pong" });
    if (m.t === "hello") return hello(ws, m);
    if (!ws.room) return;
    if (m.t === "adm-ips") return ws.name === ADMIN && send(ws, { t: "ips", ips: ipList() });
    if (m.t === "bye") { const r = ws.room; ws.room = null; if (NAMES.get(ws.name) === ws) NAMES.delete(ws.name); return r.remove(ws.name); }   // tab closed on purpose: leave now, no grace
    try { ws.room.handle(ws.name, m); } catch (e) { console.error("handle", ws.name, m.t, e); }
  });
  ws.on("close", () => {
    if (!ws.room) return;
    ws.room.lost(ws.name, ws);
    if (NAMES.get(ws.name) === ws) NAMES.delete(ws.name);
  });
});
function hello(ws, m) {
  if (ws.room) return;
  // name: this browser's token > the name fixed to this IP > what was typed (fixed to the IP once confirmed)
  const tn = typeof m.tok === "string" && own(IPL.tok, m.tok) ? IPL.tok[m.tok] : null, ipn = own(IPL.ip, ws.ip) ? IPL.ip[ws.ip] : null;
  const name = tn || ipn || String(m.name || "").trim().slice(0, MAXNAME);
  if (!name) return send(ws, { t: "full", m: "이름을 입력하세요" });
  if (badName(name)) return send(ws, { t: "full", m: "쓸 수 없는 이름" });
  if (!tn && !ipn) {
    if (owned(name)) return send(ws, { t: "full", m: "다른 사람에게 고정된 이름이에요 · 다른 이름을 쓰세요" });
    if (!m.bind) return send(ws, { t: "bindq", name });   // the client asks "이 IP로 … 고정됩니다" and says hello again with bind
  }
  if (!ipn) { IPL.ip[ws.ip] = name; dirty = true; }
  if (!tn) { const tok = crypto.randomBytes(16).toString("hex"); IPL.tok[tok] = name; dirty = true; send(ws, { t: "tok", tok, name }); }
  const code = (String(m.room || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "MAIN").slice(0, 12);
  // same name somewhere else: that older connection steps aside (usually it's this person's dead tab)
  const old = NAMES.get(name);
  if (old && old !== ws) { send(old, { t: "kick", m: "같은 이름으로 다른 곳에서 접속해 연결을 넘겼어요" }); old.room = null; try { old.close(); } catch {} }
  for (const r of rooms.values()) if (r.code !== code && r.has(name)) r.remove(name);
  const room = roomOf(code);
  // browsers' pre-server saves (m.acct, m.board) are no longer taken: accounts were reset on 11/6 and a
  // deleted name must start from scratch, not come back with an old browser balance

  const err = room.join(ws, name, m, ACC[name]);
  if (err) { send(ws, { t: "full", m: err }); return setTimeout(() => ws.close(), 300); }
  ws.name = name; ws.room = room; NAMES.set(name, ws);
  send(ws, { t: "you", id: name, room: code });
  send(ws, market.full());
}
/* prices move every 2s for everyone; only the numbers go out (clients keep their own chart history) */
setInterval(() => {
  market.tick(); boardAt = 0;
  const m = JSON.stringify(market.ticks());
  for (const ws of wss.clients) if (ws.room && ws.readyState === 1) try { ws.send(m); } catch {}
}, market.TICK_MS);
setInterval(market.save, 30000);
// dead sockets (closed laptop, lost wifi) never say goodbye: ping them and drop the silent ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch {} continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
    send(ws, { t: "ping" });
  }
}, 8000);
server.listen(PORT, HOST, () => console.log("shs999 server on", HOST + ":" + PORT, "data", DATA));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
  for (const r of rooms.values()) { try { r.shutdown(); } catch (e) { console.error("shutdown", e); } for (const p of r.players()) saw(p); }
  dirty = true; save(); saveRooms(); market.save(); process.exit(0);
});
