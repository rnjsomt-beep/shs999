"use strict";
/* shs999 game server: one websocket endpoint, rooms by name (#MAIN …), accounts saved on disk.
   Run: PORT=8099 DATA=./data node server.js   (Caddy in front supplies https/wss) */
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const makeRoom = require("./engine");

const PORT = +process.env.PORT || 8099, HOST = process.env.HOST || "127.0.0.1";
const DATA = process.env.DATA || path.join(__dirname, "data");
const START = 1000000, GRACE = 20000, MAXNAME = 8;
fs.mkdirSync(DATA, { recursive: true });

/* ---------- accounts: name -> { chips, rebuy, peak, st, t } ---------- */
const file = n => path.join(DATA, n);
const load = n => { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch { return null; } };
const ACC = load("accounts.json") || {};
const LEGACY = load("legacy_board.json") || {};   // old offline rankings brought in from players' browsers
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  for (const [n, o] of [["accounts.json", ACC], ["legacy_board.json", LEGACY]]) {
    try { fs.writeFileSync(file(n) + ".tmp", JSON.stringify(o)); fs.renameSync(file(n) + ".tmp", file(n)); }
    catch (e) { console.error("save failed", n, e.message); dirty = true; }
  }
}
setInterval(save, 3000);
const badName = n => !n || n.length > MAXNAME || n in Object.prototype;
/* a live player -> its saved account (bets not dealt yet count as balance, so a crash never eats them) */
function saw(p) {
  const pend = Object.values(p.bac || {}).reduce((a, b) => a + b, 0) + Object.values(p.rl || {}).reduce((a, b) => a + b, 0)
    + (p.bj && !p.bj.cards.length ? p.bj.bet : 0);
  ACC[p.name] = { chips: p.chips + pend, rebuy: p.rebuy || 0, peak: p.peak, st: p.st, t: Date.now() };
  dirty = true; boardAt = 0;
}
let boardC = {}, boardAt = 0;
function board() {
  if (Date.now() - boardAt < 1000) return boardC;
  const b = {};
  for (const [n, e] of Object.entries(LEGACY)) if (!ACC[n]) b[n] = e;
  for (const [n, a] of Object.entries(ACC)) b[n] = [a.chips - START * (a.rebuy || 0), a.t];
  const keep = Object.entries(b).sort((x, y) => y[1][1] - x[1][1]).slice(0, 60);
  boardC = Object.fromEntries(keep); boardAt = Date.now();
  return boardC;
}
function importBoard(src) {
  if (!src || typeof src !== "object") return;
  for (const [n, e] of Object.entries(src).slice(0, 200)) {
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
const ctx = { board, saw, admSet, GRACE };
function roomOf(code) {
  let r = rooms.get(code);
  if (!r) { r = makeRoom(code, ctx); r.code = code; r.emptyAt = 0; rooms.set(code, r); }
  return r;
}
setInterval(() => {
  const n = Date.now();
  for (const [code, r] of rooms) {
    try { r.tick(); } catch (e) { console.error("tick", code, e); }
    if (r.size) r.emptyAt = 0; else if (!r.emptyAt) r.emptyAt = n; else if (n - r.emptyAt > 600000) rooms.delete(code);
  }
}, 1000);

/* ---------- network ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ rooms: [...rooms.values()].map(r => ({ code: r.code, players: r.size })), accounts: Object.keys(ACC).length }));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("shs999 server ok");
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const NAMES = new Map();   // name -> socket (one live connection per name)
const send = (ws, m) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch {} };
wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => ws.alive = true);
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    ws.alive = true;
    if (m.t === "ping") return send(ws, { t: "pong" });
    if (m.t === "hello") return hello(ws, m);
    if (!ws.room) return;
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
  const name = String(m.name || "").trim().slice(0, MAXNAME) || "담당";
  if (badName(name)) return send(ws, { t: "full", m: "쓸 수 없는 이름" });
  const code = (String(m.room || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "MAIN").slice(0, 12);
  // same name somewhere else: that older connection steps aside (usually it's this person's dead tab)
  const old = NAMES.get(name);
  if (old && old !== ws) { send(old, { t: "kick", m: "같은 이름으로 다른 곳에서 접속해 연결을 넘겼어요" }); old.room = null; try { old.close(); } catch {} }
  for (const r of rooms.values()) if (r.code !== code && r.has(name)) r.remove(name);
  const room = roomOf(code);
  if (!ACC[name] && !room.has(name) && m.acct && typeof m.acct === "object") {
    ACC[name] = { chips: m.acct.chips, rebuy: m.acct.rebuy, peak: m.acct.peak, st: m.acct.st, t: Date.now() };   // first visit: bring the browser's saved account
    dirty = true;
  }
  importBoard(m.board);
  const err = room.join(ws, name, m, ACC[name]);
  if (err) { send(ws, { t: "full", m: err }); return setTimeout(() => ws.close(), 300); }
  ws.name = name; ws.room = room; NAMES.set(name, ws);
  send(ws, { t: "you", id: name, room: code });
}
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
  for (const r of rooms.values()) for (const p of r.players()) { r.refund(p); saw(p); }
  dirty = true; save(); process.exit(0);
});
