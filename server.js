// Grand Squeeze Baccarat — the table server.
// Serves the game page and runs the friends tables (table-core.js) over WebSocket at /ws.
// No packages to install: it only uses what comes with Node.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./table-core.js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};
const PRIVATE = new Set(['server.js', 'package.json', 'render.yaml']);   // never served to the browser

/* ---------------- the game files ---------------- */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || PRIVATE.has(rel) || rel.split(path.sep).some(s => s.startsWith('.') || s === 'node_modules')) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // the page and dealer always come fresh, so players get your latest version
    const cache = /\.(html|js|webmanifest)$/.test(file) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
});

/* ---------------- WebSocket (just enough of the protocol for the game) ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 64 * 1024;

function frame(op, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  // what table-core.js talks to: readyState 1 means open, send() takes a string
  const conn = {
    readyState: 1,
    send(str) { if (this.readyState === 1) { try { socket.write(frame(1, Buffer.from(str))); } catch (e) {} } },
  };
  let buf = Buffer.alloc(0), parts = [], alive = true;
  const close = () => {
    if (conn.readyState !== 1) return;
    conn.readyState = 3; clearInterval(beat);
    try { core.leave(conn); } catch (e) { console.error('leave failed', e); }
    socket.destroy();
  };
  // a ping every 25s keeps the connection open through Render's proxy and spots players who vanished
  const beat = setInterval(() => {
    if (!alive) return close();
    alive = false; try { socket.write(frame(9, Buffer.alloc(0))); } catch (e) { close(); }
  }, 25000);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG || !masked) return close();   // browsers always mask; anything huge is not a player
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.slice(off + 4 + len);
      alive = true;
      if (op === 8) { try { socket.write(frame(8, Buffer.alloc(0))); } catch (e) {} return close(); }
      if (op === 9) { try { socket.write(frame(10, data)); } catch (e) {} continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        parts.push(data);
        if (!fin) { if (parts.reduce((a, b) => a + b.length, 0) > MAX_MSG) return close(); continue; }
        const text = Buffer.concat(parts).toString('utf8'); parts = [];
        let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
        if (!msg || typeof msg !== 'object') continue;
        try { core.handle(conn, msg); } catch (e) { console.error('message failed', e); }
      }
    }
  });
  socket.on('close', close);
  socket.on('end', close);
  socket.on('error', close);
});

server.listen(PORT, () => console.log(`Grand Squeeze table server on port ${PORT}`));
