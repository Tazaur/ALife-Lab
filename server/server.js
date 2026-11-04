#!/usr/bin/env node
// ALife Lab sim server: runs the islands on this computer and streams them to any browser on the network.
// No dependencies. Usage: node server/server.js [--port 8787] [--islands N] [--fresh] [--autosave-min 2]
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');
const { Worker } = require('worker_threads');
const CODEC = require('./codec.js');

// ---------- options ----------
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const PORT = +opt('port', 8787);
const FRESH = !!opt('fresh', false);
const AUTOSAVE_MS = Math.max(.25, +opt('autosave-min', 2)) * 60000;
const ROOT = path.resolve(__dirname, '..');
const SAVE_DIR = path.join(__dirname, 'saves'), SAVE_FILE = path.join(SAVE_DIR, 'autosave.json.gz');

// The page and the simulation both come from the built index.html, so the server always matches the page it serves.
const PAGE_FILE = fs.existsSync(path.join(ROOT, 'index.html')) ? path.join(ROOT, 'index.html') : path.join(ROOT, 'dist', 'alife-lab.html');
let page = '', simSource = '';
function loadPage() {
  page = fs.readFileSync(PAGE_FILE, 'utf8');
  const m = page.match(/<script id="simSource" type="text\/plain">\n?([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Could not find the simulation inside ' + PAGE_FILE);
  simSource = m[1].replace(/<\\\/script/g, '</script');
  page = page.replace('<script>', '<script>window.ALIFE_SERVER = true;</script>\n<script>');
}
loadPage();

// ---------- islands (one worker thread each) ----------
const SHIM = `const { parentPort } = require('worker_threads');
const self = { postMessage: (m, t) => parentPort.postMessage(m, t), set onmessage(f) { parentPort.on('message', d => f({ data: d })); } };
// Node drains a MessageChannel that keeps re-posting to itself without ever reading the parent port, so the
// sim's yield-loop would starve incoming messages. setImmediate yields to I/O between slices instead.
class MessageChannel { constructor() { this.port1 = { onmessage: null }; this.port2 = { postMessage: () => setImmediate(() => this.port1.onmessage && this.port1.onmessage({})) }; } }
`;
const islands = [];          // { w, ready, running, pulse, meta, viewing, speed }
let saved = null;            // bundle restored from disk at startup
function spawn(i, restore) {
  const w = new Worker(SHIM + `(function(self, MessageChannel){\n${simSource}\n})(self, MessageChannel);`, { eval: true });
  const isl = { w, ready: false, running: true, pulse: null, meta: null, viewing: false, speed: null, restore };
  w.on('message', m => fromIsland(i, m));
  w.on('error', e => console.error(`island ${name(i)} crashed:`, e));
  islands[i] = isl; return isl;
}
const name = i => 'ABCD'[i] || String(i + 1);
const post = (i, m) => islands[i] && islands[i].w.postMessage(m);
function setCount(n) {
  n = Math.max(1, Math.min(4, n | 0));
  while (islands.length > n) { const isl = islands.pop(); isl.w.terminate(); }
  while (islands.length < n) spawn(islands.length, null);
  for (const c of clients) { if (c.watch >= n) c.watch = -1; }
  updateViews(); hello();
}

// ---------- clients ----------
const clients = new Set();
const pendingSave = [], pendingLib = [];        // per island: queue of clients waiting for a reply
function fromIsland(i, m) {
  const isl = islands[i]; if (!isl) return;
  switch (m.type) {
    case 'ready':
      isl.ready = true;
      post(i, { type: 'init', island: i, view: false });
      if (isl.restore) post(i, { type: 'load', state: isl.restore });
      post(i, { type: 'play', running: isl.running });
      updateViews();
      return;
    case 'pulse': isl.pulse = m; isl.running = m.running; broadcast(i, m); return;
    case 'emigrants': { let to = i; if (islands.length > 1) { to = Math.floor(Math.random() * (islands.length - 1)); if (to >= i) to++; } post(to, { type: 'immigrants', pack: m.pack, from: i }); return; }
    case 'saved':
      if (m.purpose === 'server') return onServerSaved(i, m);
      return reply(pendingSave, i, m);
    case 'libraryPack': return reply(pendingLib, i, m);
    // a selection belongs to whoever asked for it, so one viewer's picks don't open inspectors on the others
    case 'selected': { const c = isl.picker; isl.picker = null; if (c && clients.has(c) && m.id) { c.sel = m.id; send(c, i, m); return; } break; }
    case 'inspect': for (const c of clients) if (c.watch === i && c.sel === m.id) send(c, i, m); return;
    case 'meta': isl.meta = m; break;
  }
  if (m.type === 'frame') { const now = Date.now(); for (const c of clients) if (c.watch === i && now - c.lastFrame >= c.gap && c.sock.writableLength < 1.5e6) { c.lastFrame = now; send(c, i, m); } return; }
  for (const c of clients) if (c.watch === i) send(c, i, m);
}
function reply(queues, i, m) { const q = queues[i] || []; const c = q.shift(); if (c && clients.has(c)) send(c, i, m); }
function broadcast(i, m) { for (const c of clients) send(c, i, m); }
function send(c, isl, m) { wsSend(c.sock, CODEC.encode({ isl, m }), 2); }
function hello(c) {
  const msg = JSON.stringify({ hello: true, islands: islands.length, running: islands.some(x => x.running), host: os.hostname(), autosaveMin: AUTOSAVE_MS / 60000 });
  for (const t of c ? [c] : clients) wsSend(t.sock, Buffer.from(msg), 1);
}
// an island draws (posts frames) only while someone watches it; unwatched islands run flat out
function updateViews() {
  islands.forEach((isl, i) => {
    if (!isl.ready) return;
    const watchers = [...clients].filter(c => c.watch === i), on = watchers.length > 0;
    if (on !== isl.viewing) { isl.viewing = on; post(i, { type: 'view', on }); }
    if (!on) post(i, { type: 'speed', speed: 1, max: true });
  });
}
function fromClient(c, data) {
  let o; try { o = JSON.parse(data); } catch { return; }
  if (o.cmd === 'islands') return setCount(o.n);
  if (o.cmd === 'rate') { c.gap = 1000 / Math.max(2, Math.min(40, +o.fps || 15)); return; }
  const i = o.isl, m = o.m; if (!m || !islands[i]) return;
  switch (m.type) {
    case 'view': {
      const was = c.watch;
      if (m.on) c.watch = i; else if (c.watch === i) c.watch = -1;
      if (m.on && islands[i].viewing) { post(i, { type: 'view', on: true }); }   // re-send meta, frame and stats for the newcomer
      if (was !== c.watch || m.on) updateViews();
      return;
    }
    case 'speed': if (c.watch === i) post(i, m); return;      // only the island this viewer watches follows its speed control
    case 'save': (pendingSave[i] = pendingSave[i] || []).push(c); break;
    case 'library': (pendingLib[i] = pendingLib[i] || []).push(c); break;
    case 'play': islands[i].running = m.running; break;
    case 'select': c.sel = m.id || 0; break;
    case 'pick': islands[i].picker = c; break;
  }
  post(i, m);
}

// ---------- autosave to disk ----------
let saveJob = null;
function saveAll() {
  if (saveJob || !islands.every(x => x.ready)) return;
  saveJob = { states: new Array(islands.length), left: islands.length };
  islands.forEach((_, i) => post(i, { type: 'save', purpose: 'server' }));
}
function onServerSaved(i, m) {
  if (!saveJob) return;
  saveJob.states[i] = JSON.parse(m.state);
  if (--saveJob.left) return;
  const bundle = { version: 'islands1', watched: 0, at: Date.now(), islands: saveJob.states }; saveJob = null;
  const gz = zlib.gzipSync(JSON.stringify(bundle));
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(SAVE_FILE + '.tmp', gz); fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
  console.log(`${new Date().toLocaleTimeString()}  saved ${islands.length} island${islands.length > 1 ? 's' : ''} (${(gz.length / 1048576).toFixed(1)} MB) · ticks ${bundle.islands.map(s => s.ticks).join(' / ')}`);
  if (exiting) process.exit(0);
}
setInterval(saveAll, AUTOSAVE_MS);
let exiting = false;
process.on('SIGINT', () => { if (exiting) process.exit(0); exiting = true; console.log('\nSaving before exit… (Ctrl+C again to quit now)'); saveAll(); setTimeout(() => process.exit(0), 15000); });

// ---------- minimal WebSocket (RFC 6455) ----------
function wsSend(sock, payload, op) {
  if (sock.destroyed) return;
  const n = payload.length; let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  sock.write(head); sock.write(payload);
}
function acceptWs(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const c = { sock, watch: -1, gap: 1000 / 15, lastFrame: 0, addr: req.socket.remoteAddress };
  clients.add(c); console.log(`viewer connected from ${c.addr} (${clients.size} watching)`);
  hello(c); islands.forEach((isl, i) => isl.pulse && send(c, i, isl.pulse));
  let buf = Buffer.alloc(0), frags = [], fragOp = 0;
  sock.on('data', d => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80; let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const mask = masked ? buf.subarray(at, at + 4) : null; if (masked) at += 4;
      if (buf.length < at + len) return;
      const p = Buffer.from(buf.subarray(at, at + len)); buf = buf.subarray(at + len);
      if (mask) for (let k = 0; k < p.length; k++) p[k] ^= mask[k & 3];
      if (op === 8) { wsSend(sock, Buffer.alloc(0), 8); sock.end(); return; }
      if (op === 9) { wsSend(sock, p, 10); continue; }
      if (op === 10) continue;
      if (op !== 0) fragOp = op;
      frags.push(p);
      if (fin) { const all = Buffer.concat(frags); frags = []; if (fragOp === 1) fromClient(c, all.toString('utf8')); }
    }
  });
  const gone = () => { if (!clients.delete(c)) return; console.log(`viewer ${c.addr} left (${clients.size} watching)`); updateViews(); };
  sock.on('close', gone); sock.on('error', gone);
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return; }
  if (url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ islands: islands.map((x, i) => ({ ...(x.pulse || {}), island: name(i), type: undefined })), viewers: clients.size })); return; }
  res.writeHead(404); res.end('Not found');
});
server.on('upgrade', (req, sock) => { if (req.url.startsWith('/ws')) acceptWs(req, sock); else sock.destroy(); });

// ---------- start ----------
let count = +opt('islands', 0);
if (!FRESH && fs.existsSync(SAVE_FILE)) {
  try { saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(SAVE_FILE))); } catch (e) { console.warn('Could not read the autosave, starting fresh:', e.message); }
}
const restore = saved && saved.version === 'islands1' ? saved.islands : [];
if (!count) count = restore.length || Math.max(1, Math.min(4, os.cpus().length - 1));
for (let i = 0; i < count; i++) spawn(i, restore[i] || null);
server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  console.log(`ALife Lab server · ${count} island${count > 1 ? 's' : ''} on ${os.cpus().length} cores${restore.length ? ` · resumed from ${SAVE_FILE}` : ''}`);
  console.log(`  this computer:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  other devices:  http://${ip}:${PORT}`);
  console.log(`Autosaves every ${AUTOSAVE_MS / 60000} min to ${SAVE_FILE}. Ctrl+C saves and stops.`);
});
