'use strict';
/* Máy chủ "Cả nhà Lên Chùa": phục vụ index.html và chuyển vị trí người chơi qua WebSocket.
   Không lưu gì xuống đĩa, không ghi log tên hay địa chỉ IP. Mọi trạng thái mất khi máy chủ tắt. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // bật khi chạy sau proxy của nhà cung cấp hosting
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 500;
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 20;
const ROOM_SIZE = 25; // mỗi "sân chùa" tối đa 25 người, đông hơn thì mở sân mới
const TICK_MS = 100;
const RATE_PER_SEC = 20, RATE_BURST = 40, MAX_STRIKES = 200;
const MAX_BUFFERED = 1024 * 1024;

const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/* ----- Trang web ----- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': INDEX.length });
    res.end(req.method === 'HEAD' ? undefined : INDEX);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Không tìm thấy');
});

/* ----- Phòng và người chơi ----- */
const rooms = new Set();
const ipCount = new Map();
let total = 0;

function findRoom() {
  for (const r of rooms) if (r.clients.size < ROOM_SIZE) return r;
  const r = { clients: new Set(), changed: new Set(), left: [] };
  rooms.add(r);
  return r;
}
// Chỉ giữ đúng các trường cho phép, kẹp giá trị; dữ liệu sai thì bỏ
function cleanPresence(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (typeof m.x !== 'number' || typeof m.z !== 'number' || !Number.isFinite(m.x) || !Number.isFinite(m.z)) return null;
  const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
  const count = v => (Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : 0);
  return {
    n: (typeof m.n === 'string' ? m.n : '').replace(/[\p{C}]/gu, '').trim().slice(0, 18),
    x: Math.round(clampN(m.x, -27.3, 27.3) * 100) / 100,
    z: Math.round(clampN(m.z, -27.3, 46) * 100) / 100,
    r: typeof m.r === 'number' && Number.isFinite(m.r) ? Math.round(clampN(m.r, -100, 100) * 100) / 100 : 0,
    p: m.p === 2 || m.p === 3 || m.p === 5 ? m.p : 0,
    i: count(m.i),
    b: count(m.b),
  };
}
function clientIp(req) {
  if (TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (typeof f === 'string' && f) return f.split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (ALLOWED_ORIGINS.includes(o)) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
function refuse(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  if ((req.url || '').split('?')[0] !== '/ws') return refuse(socket, '404 Not Found');
  if (!originOk(req)) return refuse(socket, '403 Forbidden');
  const ip = clientIp(req);
  if (total >= MAX_CONNECTIONS || (ipCount.get(ip) || 0) >= MAX_PER_IP) return refuse(socket, '503 Service Unavailable');
  wss.handleUpgrade(req, socket, head, ws => onConnect(ws, ip));
});

function onConnect(ws, ip) {
  total++; ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const room = findRoom();
  const c = { ws, ip, room, id: crypto.randomBytes(6).toString('hex'), d: null, tokens: RATE_BURST, at: Date.now(), strikes: 0, alive: true };
  room.clients.add(c);
  const others = [];
  for (const o of room.clients) if (o !== c && o.d) others.push([o.id, o.d]);
  ws.send(JSON.stringify({ t: 'hello', id: c.id, u: others }));

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    c.tokens = Math.min(RATE_BURST, c.tokens + (now - c.at) / 1000 * RATE_PER_SEC); c.at = now;
    if (c.tokens < 1 || isBinary) { if (++c.strikes > MAX_STRIKES) ws.close(1008); return; }
    c.tokens--;
    let msg; try { msg = JSON.parse(data.toString()); } catch (e) { if (++c.strikes > MAX_STRIKES) ws.close(1008); return; }
    const d = cleanPresence(msg);
    if (!d) { if (++c.strikes > MAX_STRIKES) ws.close(1008); return; }
    c.d = d; room.changed.add(c);
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    total--;
    const n = ipCount.get(ip) - 1; if (n > 0) ipCount.set(ip, n); else ipCount.delete(ip);
    room.clients.delete(c); room.changed.delete(c);
    if (c.d) room.left.push(c.id);
    if (room.clients.size === 0) rooms.delete(room);
  });
}

/* ----- Gộp thay đổi và phát cho cả phòng, 10 lần mỗi giây ----- */
setInterval(() => {
  for (const room of rooms) {
    if (!room.changed.size && !room.left.length) continue;
    const u = []; for (const c of room.changed) u.push([c.id, c.d]);
    const payload = JSON.stringify({ t: 's', u, l: room.left });
    room.changed.clear(); room.left = [];
    for (const c of room.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED) { c.ws.terminate(); continue; } // mạng quá chậm, để máy đó tự nối lại
      c.ws.send(payload);
    }
  }
}, TICK_MS);

/* ----- Dọn kết nối chết ----- */
setInterval(() => {
  for (const room of rooms) for (const c of room.clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) { /* đang đóng */ }
  }
}, 30000);

server.listen(PORT, () => console.log(`Cả nhà Lên Chùa đang chạy ở cổng ${PORT}`));
const shutdown = () => { for (const c of wss.clients) c.close(1001); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
