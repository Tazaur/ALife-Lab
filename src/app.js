'use strict';
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

/* ================= palette (mirrors CSS tokens for canvas use) ================= */
const C = {
  ink: '#0a1110', fg: '#e7efe9', muted: '#93a8a0', dim: '#62776f', accent: '#f3c96b', good: '#7ed6b0', bad: '#f2836f', warn: '#f0b35a',
  food: '#8fd67a', tree: '#c49a6c', stone: '#aab0bf', house: '#f0c87e', store: '#7fd8ea', wall: '#c9b3e6', fire: '#f08a4b', storm: '#8aa4ff', beast: '#e05a4e',
};
const BCOL = [C.house, C.store, C.wall, C.fire];
const hueFill = Array.from({ length: 360 }, (_, h) => `hsl(${h} 72% 66%)`);

/* ================= simulation worker ================= */
let meta = null, W = 960, H = 600;
// Islands: each world runs in its own worker. The watched island streams frames; the others run unseen.
let sims = [], usingWorker = true, watched = 0, turbo = false;
// Watching another device: #watch-CODE in the address joins a host over WebRTC; a page served by server/server.js joins that server.
const PEER_WATCH = ((location.hash.match(/^#watch-([a-z0-9]{4,10})$/i) || [])[1] || '').toUpperCase() || null;
const REMOTE = !!window.ALIFE_SERVER || !!PEER_WATCH;
const ISLAND = i => 'ABCD'[i] || String(i + 1);
const cores = navigator.hardwareConcurrency || 2;
const prefIslands = (() => { try { const v = JSON.parse(localStorage.getItem('alife.ui') || '{}').islands; return v; } catch { return null; } })();
let islandCount = clamp(prefIslands || Math.min(3, Math.max(2, cores - 1)), 1, 4);
const pulses = [];

/* ---------- hub: the island workers and everyone watching them ----------
   This page is always one viewer. While hosting, devices connected over WebRTC are viewers too.
   An island draws only while someone watches it; unwatched islands run flat out. */
const simUrl = REMOTE ? '' : URL.createObjectURL(new Blob([$('simSource').textContent], { type: 'text/javascript' }));
const workers = [], isl = [], viewers = new Set(), replyQ = { saved: [], libraryPack: [] };
const me = { local: true, watch: 0, speed: null };
viewers.add(me);
function spawnIsland(i) {
  let w;
  try { w = new Worker(simUrl); w.onmessage = e => fromIsland(i, e.data); w.onerror = e => console.warn('Worker error', e); }
  catch (err) {
    if (i > 0) throw err;
    usingWorker = false;
    const fake = { onmessage: null, postMessage: m => queueMicrotask(() => fromIsland(0, m)) };
    new Function('self', $('simSource').textContent)(fake);
    w = { postMessage: m => fake.onmessage && fake.onmessage({ data: m }), terminate() { } };
  }
  workers[i] = w; isl[i] = { ready: false, viewing: false };
  sims[i] = { postMessage: m => fromViewer(me, i, m), terminate() { } };
}
function deliver(v, i, m) { if (v.local) onSim(m, i); else peerSendTo(v, { isl: i, m }); }
function fromIsland(i, m) {
  const st = isl[i], w = workers[i]; if (!st || !w) return;
  switch (m.type) {
    case 'ready':
      st.ready = true;
      w.postMessage({ type: 'init', island: i, view: false, settings: currentSettings() });
      w.postMessage({ type: 'play', running });
      hubViews(); if (i === watched) syncIslands();
      return;
    case 'emigrants': { let to = i; if (workers.length > 1) { to = Math.floor(Math.random() * (workers.length - 1)); if (to >= i) to++; } workers[to].postMessage({ type: 'immigrants', pack: m.pack, from: i }); return; }
    case 'pulse': for (const v of viewers) deliver(v, i, m); return;
    case 'saved': case 'libraryPack': { const v = (replyQ[m.type][i] || []).shift(); if (v && viewers.has(v)) deliver(v, i, m); return; }
    // a selection belongs to whoever asked for it, so one viewer's picks don't open inspectors on the others
    case 'selected': { const v = st.picker; st.picker = null; if (v && viewers.has(v) && m.id) { v.sel = m.id; deliver(v, i, m); return; } break; }
    case 'inspect': { const now = performance.now(); for (const v of viewers) if (v.watch === i && v.sel === m.id && (v.local || CODEC.due(v, 'tInsp', 600, now))) deliver(v, i, m); return; }
  }
  const now = performance.now();
  for (const v of viewers) {
    if (v.watch !== i) continue;
    if (!v.local) {
      if (m.type === 'frame') { if (now - v.lastFrame < v.gap || peerBacklog(v) > 1.5e6) continue; v.lastFrame = now; deliver(v, i, CODEC.cull(m, v, now)); continue; }
      if (m.type === 'stats' && !CODEC.due(v, 'tStats', 1500, now)) continue;
    }
    deliver(v, i, m);
  }
}
function fromViewer(v, i, m) {
  const w = workers[i], st = isl[i]; if (!w) return;
  switch (m.type) {
    case 'init': return;
    case 'view': { const was = v.watch; if (m.on) v.watch = i; else if (v.watch === i) v.watch = -1; if (v.watch !== was) v.tIf = v.tBf = 0; if (m.on && st.viewing && was !== i) w.postMessage(m); hubViews(); return; }
    case 'speed': if (v.watch === i) { v.speed = m; w.postMessage(m); } return;
    case 'select': v.sel = m.id || 0; break;
    case 'pick': st.picker = v; break;
    case 'save': (replyQ.saved[i] = replyQ.saved[i] || []).push(v); break;
    case 'library': (replyQ.libraryPack[i] = replyQ.libraryPack[i] || []).push(v); break;
  }
  w.postMessage(m);
}
function hubViews() {
  workers.forEach((w, i) => {
    const st = isl[i]; if (!st || !st.ready) return;
    const ws = [...viewers].filter(v => v.watch === i), on = ws.length > 0;
    if (on !== st.viewing) { st.viewing = on; w.postMessage({ type: 'view', on }); const sp = ws.find(v => v.speed); if (on && sp) w.postMessage(sp.speed); }
    if (!on) w.postMessage({ type: 'speed', speed: 1, max: true });
  });
}

/* ---------- WebRTC transport (PeerJS's free broker only introduces the devices; data flows directly between them) ---------- */
const PEERJS = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', QRJS = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const loaded = {};
const loadScript = src => loaded[src] || (loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); }; document.head.append(s); }));
const peerId = code => 'alifelab-' + code.toLowerCase();
const CHUNK = 60000;   // data channels cap a message near 256 KB, so big messages (terrain, saves) go in pieces
let chunkSeq = 0;
function sendChunked(conn, u8) {
  if (u8.length <= CHUNK) { const out = new Uint8Array(u8.length + 1); out.set(u8, 1); conn.send(out); return; }
  const id = ++chunkSeq, total = Math.ceil(u8.length / CHUNK);
  for (let k = 0; k < total; k++) { const part = u8.subarray(k * CHUNK, (k + 1) * CHUNK), out = new Uint8Array(part.length + 9), dv = new DataView(out.buffer); out[0] = 1; dv.setUint32(1, id); dv.setUint16(5, k); dv.setUint16(7, total); out.set(part, 9); conn.send(out); }
}
function reassembler(cb) {
  const parts = new Map();
  return d => {
    const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    netBytes += u8.length;
    if (u8[0] === 0) return cb(CODEC.decode(u8.subarray(1)));
    const dv = new DataView(u8.buffer, u8.byteOffset), id = dv.getUint32(1), k = dv.getUint16(5), total = dv.getUint16(7);
    let p = parts.get(id); if (!p) parts.set(id, p = { n: 0, a: new Array(total) });
    p.a[k] = u8.slice(9);
    if (++p.n < total) return;
    parts.delete(id); let len = 0; for (const x of p.a) len += x.length;
    const all = new Uint8Array(len); let o = 0; for (const x of p.a) { all.set(x, o); o += x.length; }
    cb(CODEC.decode(all));
  };
}
const peerSendTo = (v, o) => { try { if (v.conn.open) sendChunked(v.conn, CODEC.encode(o)); } catch (e) { console.warn(e); } };
const peerBacklog = v => (v.conn.dataChannel && v.conn.dataChannel.bufferedAmount) || 0;

/* hosting: other devices watch and steer this device's islands */
let peer = null, hostState = 'off';
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const watchLink = () => location.origin + location.pathname + '#watch-' + ui.hostCode;
async function startHosting(retry = 0) {
  if (REMOTE) return;
  ui.hostCode = ui.hostCode || randomCode(); ui.hosting = true; saveUi();
  hostState = 'starting'; renderHost();
  try { await loadScript(PEERJS); } catch { hostState = 'off'; ui.hosting = false; saveUi(); renderHost(); toast('Could not load the connection library. Check the internet connection.', 'death'); return; }
  if (peer) peer.destroy();
  peer = new Peer(peerId(ui.hostCode), { debug: 0 });
  peer.on('open', () => { hostState = 'on'; renderHost(); });
  peer.on('connection', conn => conn.on('open', () => addPeerViewer(conn)));
  peer.on('disconnected', () => { if (hostState === 'on' && !peer.destroyed) peer.reconnect(); });
  peer.on('error', e => {
    // after a reload the broker can hold the old registration for a little while
    if (e.type === 'unavailable-id' && retry < 8) { hostState = 'starting'; renderHost(); setTimeout(() => ui.hosting && startHosting(retry + 1), 4000); return; }
    if (e.type === 'unavailable-id') { ui.hostCode = randomCode(); saveUi(); startHosting(); return; }
    if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') { hostState = 'starting'; renderHost(); setTimeout(() => ui.hosting && startHosting(retry), 5000); return; }
    console.warn('peer', e.type, e);
  });
}
function stopHosting() {
  ui.hosting = false; saveUi(); hostState = 'off';
  for (const v of [...viewers]) if (!v.local) { v.conn.close(); viewers.delete(v); }
  if (peer) { peer.destroy(); peer = null; }
  hubViews(); renderHost();
}
function addPeerViewer(conn) {
  const v = { local: false, watch: -1, speed: null, gap: 1000 / 15, lastFrame: 0, conn };
  viewers.add(v);
  conn.on('data', reassembler(o => {
    if (o.cmd === 'rate') { v.gap = 1000 / clamp(+o.fps || 15, 2, 40); return; }
    if (o.cmd === 'islands') { setIslandCount(o.n); return; }
    if (o.cmd === 'cam') { v.rect = o.r; v.sel = o.sel || 0; v.scent = !!o.scent; return; }
    if (o.m) fromViewer(v, o.isl, o.m);
  }));
  const gone = () => { if (!viewers.delete(v)) return; hubViews(); renderHost(); toast('A viewer disconnected', 'info'); };
  conn.on('close', gone); conn.on('error', gone);
  peerSendTo(v, hostHello());
  pulses.forEach((p, i) => p && peerSendTo(v, { isl: i, m: p }));
  renderHost(); toast('A device is now watching', 'birth');
}
const hostHello = () => ({ hello: true, islands: workers.length, running, host: `host ${ui.hostCode}` });
function helloPeers() { for (const v of viewers) if (!v.local) peerSendTo(v, hostHello()); }

/* ---------- remote viewing: islands run on another device and this page only draws ----------
   Frames are queued and played back at an even pace a little behind real time, so network hiccups don't stutter. */
let outbox = [], ws = null, rconn = null, rpeer = null, remoteHost = '', netState = 'connecting', frameQ = [], lastSched = 0, lastArrive = 0, arriveMean = 66, netBytes = 0, netRate = 0;
const BUFFER_MS = { low: 60, normal: 250, smooth: 800 };
const remoteProxy = i => ({ postMessage: m => remoteSend({ isl: i, m }), terminate() { } });
function remoteSend(o) {
  if (PEER_WATCH) { if (rconn && rconn.open) sendChunked(rconn, CODEC.encode(o)); else outbox.push(o); }
  else if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}
function onRemote(o) {
  if (o.hello) return onHello(o);
  const { isl: i, m } = o;
  if (m.type === 'frame') { if (i === watched) queueFrame(m); return; }
  onSim(m, i);
}
function lostRemote(why) {
  if (netState === 'lost') return;
  netState = 'lost'; updateNetNote(); toast(why || 'Lost the connection. Reconnecting…', 'death');
  setTimeout(connect, PEER_WATCH ? 3000 : 2000);
}
async function connect() {
  if (PEER_WATCH) {
    try { await loadScript(PEERJS); } catch { lostRemote('Could not load the connection library. Retrying…'); return; }
    if (rpeer) rpeer.destroy(); outbox = [];
    rpeer = new Peer({ debug: 0 });
    rpeer.on('open', () => {
      rconn = rpeer.connect(peerId(PEER_WATCH), { serialization: 'raw', reliable: true });
      rconn.on('open', () => { const q = outbox; outbox = []; remoteSend({ cmd: 'rate', fps: ui.netFps }); for (const o of q) remoteSend(o); });
      rconn.on('data', reassembler(onRemote));
      rconn.on('close', () => lostRemote('The host closed the connection. Reconnecting…'));
      rconn.on('error', () => lostRemote());
    });
    rpeer.on('error', e => lostRemote(e.type === 'peer-unavailable' ? `No host with code ${PEER_WATCH} is online. Retrying…` : undefined));
    return;
  }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => remoteSend({ cmd: 'rate', fps: ui.netFps });
  ws.onmessage = e => {
    if (typeof e.data === 'string') { const h = JSON.parse(e.data); if (h.hello) onHello(h); return; }
    netBytes += e.data.byteLength; onRemote(CODEC.decode(e.data));
  };
  ws.onclose = () => lostRemote('Lost the sim server. Reconnecting…');
}
function onHello(h) {
  const back = netState === 'lost'; netState = 'connected'; remoteHost = h.host;
  while (sims.length > h.islands) sims.pop();
  while (sims.length < h.islands) sims.push(remoteProxy(sims.length));
  pulses.length = sims.length; islandCount = sims.length;
  if (watched >= sims.length) watchIsland(0);
  if (h.running !== running) { running = h.running; paintPlay(); }
  frameQ = []; lastSched = 0;
  syncIslands(); renderIslands(); updateCoreNote(); updateNetNote();
  if (back) toast(`Reconnected to ${h.host}`, 'info');
}
function queueFrame(m) {
  const now = performance.now(), minD = BUFFER_MS[ui.netBuf] || 250;
  if (lastArrive) arriveMean += (clamp(now - lastArrive, 5, 1000) - arriveMean) * .08;
  lastArrive = now;
  // play frames evenly spaced; after a stall the burst is spread out, and the backlog slowly shrinks back to the minimum delay
  let s = Math.max(lastSched + arriveMean * .97, now + minD);
  s = Math.min(s, now + minD + 2500);
  lastSched = s; frameQ.push({ s, m });
  if (frameQ.length > 150) frameQ.splice(0, frameQ.length - 150);
}
function drainFrames(now) { while (frameQ.length && frameQ[0].s <= now) { const { m } = frameQ.shift(); mergeFrame(m); ingestFrame(m); if (m.P) paintPher(m.P); } }
// remote frames carry only what changed near the screen; keep the rest of the map from earlier updates
let worldI = new Float32Array(0), worldB = new Float32Array(0);
function patch(world, part, stride, r) {
  let keep = 0; for (let o = 0; o < world.length; o += stride) { const x = world[o + 1], y = world[o + 2]; if (!(x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) keep++; }
  const out = new Float32Array(keep * stride + part.length); let p = 0;
  for (let o = 0; o < world.length; o += stride) { const x = world[o + 1], y = world[o + 2]; if (!(x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) { out.set(world.subarray(o, o + stride), p); p += stride; } }
  out.set(part, p); return out;
}
function mergeFrame(m) {
  if (!m.vr) return;
  if (m.I) worldI = m.fullI ? m.I : patch(worldI, m.I, 4, m.vr); m.I = worldI;
  if (m.B) worldB = m.fullB ? m.B : patch(worldB, m.B, 9, m.vr); m.B = worldB;
}
// tell the host what this screen shows (with a margin) and which yip is selected, a few times a second at most
let camSent = '', camT = 0;
function sendCam(now) {
  if (now - camT < 250) return;
  const a = toWorld(0, 0), b = toWorld(cw, ch), mx = (b.x - a.x) * .35 + 40, my = (b.y - a.y) * .35 + 40;
  const r = [a.x - mx, a.y - my, b.x + mx, b.y + my].map(Math.round), key = r.join() + '|' + selected + '|' + ui.scent;
  if (key === camSent && now - camT < 3000) return;
  camSent = key; camT = now; remoteSend({ cmd: 'cam', r, sel: selected, scent: !!ui.scent });
}
const netDelay = () => frameQ.length ? Math.max(0, frameQ[frameQ.length - 1].s - performance.now()) : 0;
if (REMOTE) setInterval(() => { netRate = netBytes; netBytes = 0; }, 1000);
function updateNetNote() {
  if (!REMOTE) return;
  const where = PEER_WATCH ? `host ${PEER_WATCH}` : `${remoteHost} at ${location.host}`;
  $('netNote').textContent = netState === 'connected' ? `Watching ${where}. The islands run there; this device only draws them, so closing this page doesn't stop them.` : PEER_WATCH ? `Looking for host ${PEER_WATCH}… Keep the host's tab open with hosting on.` : 'Not connected to the sim server. Retrying every 2 seconds…';
}

(function boot() {
  if (REMOTE) { sims.push(remoteProxy(0)); return; }
  for (let i = 0; i < islandCount; i++) { try { spawnIsland(i); } catch { break; } if (!usingWorker) break; }
})();
const send = (type, rest = {}) => sims[watched].postMessage({ type, ...rest });
const sendAll = (type, rest = {}) => sims.forEach(w => w.postMessage({ type, ...rest }));
// background islands always run flat out; the watched one follows the speed control (or flat out in Turbo)
function syncIslands() {
  sims.forEach((w, i) => {
    const mine = i === watched;
    w.postMessage({ type: 'view', on: mine && !turbo && !(REMOTE && document.hidden) });
    w.postMessage({ type: 'speed', speed: SPEEDS[speedIdx], max: !mine || turbo || maxMode });
  });
}

/* ================= app state ================= */
let soilAt = 0, natI = null, natAt = 0, natCv = null, natZ = 1, natDirty = true, F = null, stats = null, insp = null, names = {};
const nameOf = id => names[id] || `#${id}`;
let selected = 0, follow = false, running = true, tool = 'select', maxMode = false;
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const ui = Object.assign({ netBuf: 'normal', netFps: 15, notify: 'important', scent: false, night: true, fx: true, sense: true, trail: true, legend: true, perf: true, auto: true, hidePause: true, wake: true, speedIdx: 2, brushSize: 22, brushAmt: 1 }, store.get('alife.ui', {}));
ui.speedIdx = clamp(ui.speedIdx | 0, 0, SPEEDS.length - 1);
let speedIdx = ui.speedIdx;
const saveUi = () => store.set('alife.ui', ui);
const isTouch = matchMedia('(pointer:coarse)').matches;
const compact = () => cw < 760 || ch <= 520;
const rpos = new Map();       // id -> smoothed render position
const bpos = new Map();       // beast id -> smoothed render position
let trail = [], fx = [];
let simTps = 0, renderFps = 0;
const wd = (d, L) => d > L / 2 ? d - L : d < -L / 2 ? d + L : d;
const wrapC = (v, L) => ((v % L) + L) % L;
const hyper = () => maxMode || SPEEDS[speedIdx] >= 64;

function preferredShape() { const w = innerWidth, h = innerHeight; return h > w * 1.15 ? 'tall' : w > h * 1.15 ? 'wide' : 'square'; }
function onSim(m, isl = 0) {
  if (m.type === 'pulse') { pulses[isl] = m; renderIslands(); return; }
  if (m.type === 'saved') { onSaved(m, isl); return; }
  if (m.type === 'libraryPack') { onLibraryPack(m, isl); return; }
  if (isl !== watched && m.type !== 'toast') return;
  if (m.type === 'toast' && isl !== watched) return;
  switch (m.type) {
    case 'meta': {
      const first = !meta; meta = m; W = m.W; H = m.H; natI = null; natCv = null; worldI = new Float32Array(0); worldB = new Float32Array(0); frameQ = []; if (cw) minZ = Math.min(cw / W, ch / H) * .6; buildTerrain(m);
      if (first) buildClimate(m.settings); else syncSliders(m.settings);
      rpos.clear(); bpos.clear(); trail = [];
      if (first || !cw) fit(true); else fit(true);
      break;
    }
    case 'frame': ingestFrame(m); if (m.P) paintPher(m.P); break;
    case 'stats': stats = m; if (m.names) names = m.names; if (m.soil && meta && performance.now() - soilAt > 8000) { soilAt = performance.now(); meta.fert = Float32Array.from(m.soil, v => v / 255); buildTerrain(meta); } renderStats(); break;
    case 'inspect': insp = m; if (m.name) names[m.id] = m.name; renderInspector(); break;
    case 'selected': setSelected(m.id, { fromSim: true }); break;
    case 'toast': if (ui.notify === 'all' || (ui.notify === 'important' && m.important)) toast(m.s, m.kind); break;

    case 'loaded':
      if (m.ok) { toast('World loaded', 'info'); syncSliders(m.settings); trail = []; rpos.clear(); }
      else toast('Could not load: ' + m.error, 'death');
      break;
  }
}
let pherCanvas = null, pherImg = null;
function paintPher(P) {
  if (!meta) return;
  if (!pherCanvas) { pherCanvas = document.createElement('canvas'); pherCanvas.width = meta.FW; pherCanvas.height = meta.FH; pherImg = pherCanvas.getContext('2d').createImageData(meta.FW, meta.FH); }
  const d = pherImg.data; for (let i = 0; i < P.length; i++) { const v = P[i]; d[i * 4] = 220; d[i * 4 + 1] = 120; d[i * 4 + 2] = 255; d[i * 4 + 3] = v; }
  pherCanvas.getContext('2d').putImageData(pherImg, 0, 0);
}
function ingestFrame(m) {
  F = m; simTps = m.tps;
  const A = m.A, seen = new Set(), snap = hyper(), now = performance.now(), doFx = ui.fx && !snap && fx.length < 260;
  for (let o = 0; o < A.length; o += 10) {
    const id = A[o]; seen.add(id);
    let p = rpos.get(id);
    if (!p) rpos.set(id, p = { x: A[o + 1], y: A[o + 2], hd: A[o + 4] });
    p.tx = A[o + 1]; p.ty = A[o + 2]; p.thd = A[o + 4]; p.i = o;
    if (snap) { p.x = p.tx; p.y = p.ty; p.hd = p.thd; }
    const f = A[o + 9];
    if (doFx && (f & 255)) { for (const bit of [1, 2, 4, 8, 32, 64, 128]) if (f & bit) fx.push({ x: p.tx, y: p.ty, k: bit, t: now }); }
  }
  for (const id of rpos.keys()) if (!seen.has(id)) rpos.delete(id);
  const Z = m.Z, bseen = new Set();
  for (let o = 0; o < Z.length; o += 6) {
    const id = Z[o]; bseen.add(id);
    let p = bpos.get(id); if (!p) bpos.set(id, p = { x: Z[o + 1], y: Z[o + 2], hd: Z[o + 3] });
    p.tx = Z[o + 1]; p.ty = Z[o + 2]; p.thd = Z[o + 3]; p.hp = Z[o + 4]; p.hunt = Z[o + 5];
    if (snap) { p.x = p.tx; p.y = p.ty; p.hd = p.thd; }
  }
  for (const id of bpos.keys()) if (!bseen.has(id)) bpos.delete(id);
}

/* ================= canvas, camera ================= */
const cv = $('world'), ctx = cv.getContext('2d', { alpha: false });
let cw = 0, ch = 0, dpr = 1;
const cam = { x: 480, y: 300, z: 1 };
let minZ = .3, camTarget = null, lastFitZ = 0;
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = cv.clientWidth; ch = cv.clientHeight;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  minZ = Math.min(cw / W, ch / H) * .6;
}
const vc = { x: 0, y: 0, tx: 0, ty: 0 };   // screen point the camera centers on, kept clear of open drawers
function viewRect() {
  let l = 0, r = cw, t = 0, b = ch;
  const cr = cv.getBoundingClientRect();
  for (const d of ['dStats', 'dClimate', 'dSettings', 'dInspect']) {
    const el = $(d); if (!el.classList.contains('open')) continue;
    const q = el.getBoundingClientRect();
    if (q.width >= cw * .9) b = Math.min(b, q.top - cr.top);
    else if (q.left - cr.left < cw / 2) l = Math.max(l, q.right - cr.left);
    else r = Math.min(r, q.left - cr.left);
  }
  if (r - l < 120) { l = 0; r = cw; }
  return { l, r, t, b };
}
function updateViewCenter(dt) {
  const v = viewRect(); vc.tx = (v.l + v.r) / 2; vc.ty = (v.t + v.b) / 2;
  if (!vc.x) { vc.x = vc.tx; vc.y = vc.ty; }
  const k = 1 - Math.exp(-dt * 8); vc.x += (vc.tx - vc.x) * k; vc.y += (vc.ty - vc.y) * k;
}
const toWorld = (sx, sy) => ({ x: (sx - vc.x) / cam.z + cam.x, y: (sy - vc.y) / cam.z + cam.y });
const toScreen = (wx, wy) => ({ x: wd(wx - cam.x, W) * cam.z + vc.x, y: wd(wy - cam.y, H) * cam.z + vc.y });
function chrome() {
  const top = document.querySelector('.top').getBoundingClientRect(), bot = $('bottom').getBoundingClientRect(), cr = cv.getBoundingClientRect();
  const t = top.bottom - cr.top + 8, b = bot.top - cr.top - (cw < 760 ? 8 : 10);
  return { t, b: Math.max(t + 80, b) };
}
// fit = the whole map visible in the band between the top bar and the dock
function fitZoom() { const c = chrome(), side = cw < 760 ? 8 : 24; return clamp(Math.min((cw - side * 2) / W, (c.b - c.t) / H), minZ, 9); }
function fit(instant) {
  if (!cw) return;
  const c = chrome(), z = fitZoom(); lastFitZ = z;
  const bandY = (c.t + c.b) / 2, v = viewRect(), cx = (v.l + v.r) / 2, cy = (v.t + v.b) / 2;
  camTarget = { x: W / 2 - (cw / 2 - cx) / z, y: H / 2 - (bandY - cy) / z, z };
  if (instant) { Object.assign(cam, camTarget); camTarget = null; }
}
new ResizeObserver(() => { const first = !cw, wasFit = Math.abs(cam.z - lastFitZ) < .02; resize(); vc.x = 0; updateViewCenter(1); if (first || wasFit) requestAnimationFrame(() => fit(true)); }).observe(cv);
new ResizeObserver(() => document.documentElement.style.setProperty('--bh', $('bottom').offsetHeight + 'px')).observe($('bottom'));
function zoomAt(sx, sy, z) {
  z = clamp(z, minZ, 10);
  const p = toWorld(sx, sy);
  cam.z = z; cam.x = p.x - (sx - vc.x) / z; cam.y = p.y - (sy - vc.y) / z;
  clampCam(); camTarget = null;
}
function clampCam() { cam.x = clamp(cam.x, 0, W); cam.y = clamp(cam.y, 0, H); }

/* ================= sprites ================= */
function sprite(size, draw) { const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); return c; }
const SP = 64;
// Everything that isn't a yip is a simple, single-colour icon.
const ICOL = { bush: '#62b85a', wheat: '#d9b54a', tree: '#2f7f52', stone: '#9ca2ae', meat: '#b9513f', rot: '#8f9c3b' };
// Icons from game-icons.net (CC BY 3.0): pine tree and wheat by Lorc, berry bush and stone pile by Delapouite, ham shank by Skoll.
const GI = {"tree": "M249.28 19.188v.25c-18.114 38.634-45.065 72.36-77.686 102.937l37.72-3.938-51.345 65.032 24.81-7.907-33.624 54.875 16.53 9.843-65.25 92.157 36.095.188-51.686 83.594 63.562-8.126 12 32.094 66.438-25.282L215.5 493.28h52.938l-6.532-68.217 38.188 16.406 10.187-24.783 44.283 20.97 56.406-20.75-37.064-64.094-12.437-2.282 6.78 17.19 7.844 19.905-19.938-7.78-50.906-19.908V395.688l-14.156-8.594-69.375-42-21.595 21.25-18.03 17.75 2.155-25.22 2.125-24.655 18.188 1.56 9.218-9.092 5.19-5.094 6.218 3.75 61.375 37.156v-29.906l12.75 4.97 43.718 17.092-5.092-12.906-6.157-15.656 16.533 3.03 45.468 8.345-34.53-38.94-23.625 14.033-6.688 3.968-5.125-5.874-14.28-16.437.218 1.217-18.406 3.22-5.97-34.313-5.75-33.063 22 25.345 31.188 35.875 43.907-26.03c-24.67-19.543-39.507-33.87-49.658-48.814l.813 12.656 1.97 31-18.75-24.75-34.47-45.437-22.25 46.813-13.844 29.125-3.843-32.032-3.5-28.843 16.532-1.968 16.624-34.97 6.594-13.875 9.28 12.22 25 32.936-.75-11.53-.906-14.28 13.47 4.936L341.81 188l-26.125-35.156-55.843-28.875-8.938 20.218-9.656 21.937-7.72-22.688-7.468-21.875 16.97-5.78 3.718-8.438 4-9.125 8.844 4.593 49.375 25.53 16.467-5.562c-43.42-34.31-64.63-68.886-76.156-103.593z", "wheat": "M98.344 16.688C79.692 43.785 68.498 69.01 65.5 89.56l23.938 39.157 28.624-33.47c.868-21.213-5.49-48.677-19.718-78.563zM472.5 19.625C444.04 36.055 423.112 54 411.562 71.25l4.75 45.688L456.563 99c9.89-18.777 15.938-46.29 15.938-79.375zm-91.75 27.28c-10.153 21.036-16.8 40.84-20.156 58.314l18.375 57.686 19.78-34.25-6.5-62.22h.03c-3.422-6.392-7.252-12.906-11.53-19.53zM27.25 80.782c-.125 23.364 2.393 44.102 6.875 61.314L75.5 186.25l3.125-39.406L46 93.47l.03-.032c-5.83-4.287-12.08-8.52-18.78-12.657zm132.844 10.532c-8.415 3.504-16.29 7.213-23.594 11.094l-39.25 45.97-3.094 39.374 50.438-39.094c6.712-15.904 12.09-35.263 15.5-57.344zm177.22 21.626c-24.024 58.09-16.16 97.86 7.873 108.5l21.157-36.625-19.594-61.438c-2.973-3.46-6.108-6.943-9.438-10.438zm146.03.218c-4.55-.028-8.97.084-13.28.28L414.935 138l-19.78 34.28 62.343-13.655c12.897-11.47 26.09-26.626 38.656-45.094-4.358-.216-8.64-.348-12.812-.374zm-226.094 8.72c-23.24 23.238-38.832 46.003-45.53 65.655l16.436 42.907 34.22-27.75c4.695-20.704 3.436-48.856-5.126-80.812zM16.406 159.06c3.28 62.77 27.482 95.31 53.75 94.594l3.344-42.22-44.063-47c-4.175-1.844-8.515-3.647-13.03-5.374zm143.22 11.375c-6.457 1.354-12.63 2.896-18.5 4.563l-48.97 37.938-3.312 41.75c26.492 7.51 57.16-20.567 70.78-84.25zm16.06 1.563c-4.36 22.935-5.65 43.762-4.374 61.5l32.688 51 10.22-38.188-22.407-58.437h.03c-4.952-5.28-10.318-10.592-16.155-15.875zm267.408 8.938l-60.563 13.218-20.936 36.25c20.682 18.195 60.438 6.035 100.125-45.625-6.413-1.552-12.62-2.823-18.626-3.843zm-138.688 25.53c-8.912 1.92-17.304 4.16-25.187 6.657l-46.97 38.03-10.22 38.19 56.69-29.283c9.493-14.424 18.323-32.49 25.686-53.593zm155.125 25.063c-25.85 20.324-44.046 41.06-53.03 59.782l11.22 44.532 37.28-23.47c7.126-19.99 9.236-48.088 4.53-80.843zm-123.342 8.595c-34.435 77.573-59.394 159.06-62.97 253.03h18.72c3.558-90.792 27.573-169.428 61.312-245.436l-17.063-7.595zm-185.375 6.906c-8.173 62.347 9.714 98.713 35.687 102.75l10.97-40.874-34.814-54.25c-3.77-2.57-7.713-5.105-11.844-7.625zm221.75 24.532c-7.053 22.243-10.817 42.77-11.657 60.532l26.406 54.594L402 349.967l-15.28-60.687h.06c-4.3-5.848-9.033-11.76-14.217-17.717zm-302.47 1.532c-8.664 74.584-8.13 147.835 12.188 220.062h19.44c-20.877-70.772-21.764-143.02-13.064-217.906l-18.562-2.156zm219.47 11.094c-6.613.16-12.953.54-19.032 1.125L215.5 313.78l-10.844 40.408c24.69 12.23 59.938-9.82 84.906-70zm206.718 36.937c-9.072.844-17.664 2.052-25.78 3.594l-51.156 32.217-14.688 36.657 59.75-22.313c11.14-13.193 22.055-30.075 31.875-50.155zm-157.31 22c-15.528 60.938-2.096 99.19 23.217 106.28l15.72-39.28-28.094-58.03c-3.43-3-7.053-5.985-10.844-8.97zM183.25 368.72c-12.674 41.233-22.26 82.547-26.844 124.436h18.813c4.507-39.722 13.69-79.23 25.905-118.97l-17.875-5.467zm270 26.655l-58 21.688-15.563 38.875c23.056 15.098 60.673-2.606 92.625-59.407-6.594-.627-12.95-1.003-19.062-1.155zM356.5 469.03c-1.874 7.713-3.185 15.757-3.656 24.126h18.687c.45-6.686 1.55-13.206 3.126-19.687l-18.156-4.44z", "bush": "M59.88 52.08c-6.83.11-12.17 1.87-15.99 5.34C19.35 79.67 15.6 117.7 26.63 158c9.74 35.6 31.13 71.9 56.99 96.9.48.2.98.4 1.47.6-.84-11.8.74-23.3 6.28-36l16.43 7.2c-5 11.4-6 20-4.7 30.3 16.8-6 36.4 9 39.9 23.3 6 24.1-23.8 55.9-48.48 56.4-15.43.3-32.55-12.6-41.23-28-6.94 6.3-13.04 12.6-17.91 18.9-13.01 16.8-17.27 31.4-9.21 46.8 6.62 12.8 17.27 20.9 31.47 26 14.19 5.1 31.84 6.8 50.56 5.8 23-1.3 47.5-6.7 69.5-13.9-3.6-5.9-5.9-12.4-5.8-18.7.3-15.7 11-36.2 28.7-30.7l-2.6-17.2 17.8-2.8 3 19.3c2.1-.7 4.3-1.1 6.5-1.1 11.8 0 23.9 9.7 27.3 19.8 2.9 8.6.9 18.7-3.8 27.9 17.9 8 37.7 15.8 58.3 22.3 2.9-9.8 11.4-20.1 21.8-20.3 2.7-.1 5.5.6 8.4 2.1 1.5-8.1 2.3-15.5 1.1-22.4l17.8-3c1.6 9.9.5 19.2-1.1 27.9 12-.1 23.3 11.5 24.6 21.6.4 3.3 0 6.6-1.1 9.9 19.6 2.1 38.2 1.8 55-1.6-5.9-5.7-10-12.8-10.4-19.9-.8-12.8 7.2-30.4 22.8-28-.5-6.1-1.2-12.2-2.2-18.1l17.6-3.4c1.3 6.5 2.1 13 2.6 19.3 2-.7 4.1-1.1 6.2-1.1 7.8-.2 15.8 3.8 20.7 9.2.6-4.3.4-9.3-.5-14.9-1.9-11.9-6.9-25.7-12.9-38.6-6.2-13.4-13.2-25.8-18.6-34.6-6.2 4.5-13.2 7.5-19.7 7.6-17.5.4-37.8-21.1-35.9-38.5 1.3-11 9.4-24.3 21.1-24.7 2.2-.1 4.5.3 7 1.2-.1-10-1-22.2-1.7-30.3l18-1.6c.7 8.3 2 20.8 1.9 32.4 4.2-.5 8.4.4 12.2 2.2 2.7-7.2 5.6-15.4 8.2-24.1 9-29.4 14.1-64.1 6.2-81.4-4.7-10.3-11.9-20.1-20.7-28.8 2.6 4 4.4 8.2 4.9 12.3 3.3 24.6-29.8 52.8-54.4 50.5-22.7-1.9-45.8-32.9-40.8-55.3 3.1-13.5 14.6-28.87 28.9-29.21 6.5-.15 13.6 2.8 20.7 10.43 8-5.62 16.7-5.55 24.3-2.35-23.9-17.08-54.1-27.46-80.6-26-10.4.56-28.7 12.65-42.8 25.62C301.6 108.2 291.2 121 291.2 121l-6.6 8.1-7-7.7s-9.4-10.3-21.9-20.7c-12.5-10.44-28.7-20.12-37.2-20.6-4.3-.24-15.8 4.57-24.7 10.46-9 5.9-16 11.94-16 11.94l-5.6 4.9-5.8-4.6s-24.3-18.72-52.6-33.46c-14.08-7.36-29.2-13.63-41.97-16.08-3.19-.62-6.16-.99-8.93-1.13-.52 0-1.03 0-1.53-.1h-1.49zm27.49 39.34c3.22 8.1 4.87 16.18 5.65 24.08 1.9-.6 4-1 6.1-1 9.68-.1 19.88 5.9 23.58 13.2 8.7 16.8-8 45.6-26.28 50.3-16.96 4.4-41.65-11.9-43.79-29.3-1.52-13.3 5.84-32 22.64-29.1-.51-7.4-1.85-14.5-4.64-21.54zM234.8 169.2l17.8 2c-1 8.7-1.4 17.7-1 26.9 12.4-3 26.2 7.8 28.8 18.1.4 1.6.6 3.3.6 5 4.7-3.9 10.5-5.5 17-2.6 1.8-12.1 6.6-23.6 11.7-34.5l16.4 7.6c-4.6 9.8-8.3 19-9.9 27.7 12.7-2.6 26.3 10.3 29 22.7 4.8 22.7-19.2 52.6-39 53-18.3.5-39.5-26.1-37.6-47.6 0-.4.1-.7.1-1.1-7.3 7.4-16.8 12.6-25.5 12.7-17.5.4-37.8-21.1-35.9-38.5 1.3-10.9 9.4-24.2 21.1-24.6 1.7-.1 3.4.1 5.2.6-.2-9.3.2-18.5 1.2-27.4zm-80.6 248.4c-7.5 1.7-15.1 3.1-22.8 4.3-5.5 21.6-12.4 45.8-29.8 68.3h86.5c-17.5-22-28.5-48-33.9-72.6zm210.7 27.8c-8.2 6.6-18.4 10.8-27.2 9.9-.8-.1-1.7-.2-2.5-.4-2.9 11.9-7.3 24.2-14.4 36.3h79.5c-14.6-10.6-24.5-22.4-30.8-34.9-1.8-3.6-3.3-7.3-4.6-10.9z", "stone": "M317.727 108.904l-95.192 96.592-26.93 86.815 17.54 36.723 20.417 9.287 33.182-55.082 11.297-3.61 61.75 26.85 20.26-12.998 4.47-43.7 11.42 53.634-10.622 14.162 3.772 1.64 5.238 6.5 6.832 34.343 55.977-66.775 13.98.23 22.397 28.575-9.453-52.244L434.01 166.81l-116.28-57.906zM123.61 120.896L94.08 173l-4.603 27.62 25.98-8.442 11.704 7.377.084.634 28.295 59.865 13.773-4.543 10.94 4.668 3.922 8.21 19.517-62.917-1.074-33.336-40.15-.522-29.732-23.78 34.06 10.888 42.49-7.727 26.034 15.88 36.282-36.815c-2.777-1.18-5.615-2.356-8.58-3.52l-79.58 10.126-3.528-.25-56.307-15.52zm249.33 36.422l47.058 66.02 2.107 62.51-25.283-59.698-65.322-60.404 41.44-8.428zm-262.2 55.32l-64.234 20.876-16.71 78.552 50.794 5.582.596-7.14 37.662-36.707-8.108-61.16zm56.688 62.45l-36.44 12.016-31.644 30.84 22.588 30.867 57.326 1.74 16.5-16.16-28.33-59.302zm110.666 24.19l-44.307 73.546-.033 57.14 97.264 12.216 44.242-19.528-17.666-88.806-79.5-34.567zM443.8 313.36l-46.843 55.876.287 1.774 65.147 13.887 25.78-14.926-44.37-56.613zm-138.382 15.89l39.23 22.842 13.41 50.658-26.82 23.838-45.015-2.553 38.562-28.242 2.483-39.23-21.85-27.312zm-238.37 53.838l-8.77 28.51 13.152 48.498 91.037-11.91 1.32-26.418-62.582-31.995-34.156-6.684z", "meat": "M475.346 189.398a27.276 27.276 0 0 1-38.433-19.066l-30.05 14.232a63.31 63.31 0 0 0-3.586-11.274 59.572 59.572 0 0 0-9.853-15.827l29.222-13.836a27.358 27.358 0 1 1 45.713-5.905 27.358 27.358 0 0 1 6.986 51.676zm-295.59 74.107c13.17 31.015 17.61 63.416 12.508 91.217-4.845 26.39-17.738 45.27-36.303 53.155-18.564 7.885-41.112 4.053-63.46-10.797-23.55-15.63-43.816-41.333-56.942-72.372-13.126-31.038-17.61-63.404-12.497-91.204 4.846-26.392 17.74-45.27 36.304-53.156a51.245 51.245 0 0 1 20.15-4.006c13.718 0 28.556 5.008 43.312 14.803 23.538 15.64 43.757 41.345 56.93 72.36zm-48.79 20.708c-8.29-19.53-25.446-30.922-38.328-25.46-12.88 5.463-16.596 25.728-8.304 45.26 8.293 19.53 25.448 30.92 38.33 25.46 12.88-5.464 16.596-25.73 8.303-45.248zm255.12-103.655c-7.174-16.9-23.21-25.297-40.646-25.297a58.105 58.105 0 0 0-16.736 2.517c-25.75 7.757-51.152 10.482-75.598 10.482-56.22 0-107.347-14.315-146.037-14.315-10.483 0-20.045 1.06-28.547 3.727 17.644-.233 36.337 5.824 54.587 17.948 26.555 17.633 49.196 46.26 63.777 80.594 14.582 34.335 19.508 70.532 13.685 101.885-4.332 23.618-14.29 42.568-28.697 55.204 66.572-20.312 96.748-133.028 185.18-177.762 19.917-10.04 27.732-34.474 19.032-54.96z"};
const icon = (key, col) => sprite(SP, (g, s) => { g.scale(s / 512, s / 512); g.fillStyle = col; g.fill(new Path2D(GI[key])); });
const sprBush = icon('bush', ICOL.bush), sprWheat = icon('wheat', ICOL.wheat), sprTree = icon('tree', ICOL.tree), sprStone = icon('stone', ICOL.stone);
const sprMeat = col => icon('meat', col);
// index = item code from the sim: 0 bush, 1 tree, 2 stone, 3 meat, 4 rotting meat, 5 wheat
const ISPR = [[sprBush, 3.3], [sprTree, 6], [sprStone, 3], [sprMeat(ICOL.meat), 3.8], [sprMeat(ICOL.rot), 4], [sprWheat, 4]];
const sprGlow = col => sprite(128, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, col); gr.addColorStop(.35, col.replace(/[\d.]+\)$/, '.35)')); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
const glowFire = sprGlow('rgba(255,150,70,1)'), glowHouse = sprGlow('rgba(255,210,140,1)');

/* terrain: painted from the simulation's biome fields (fertile valleys, forest, rock) */
let terrain = null;
function buildTerrain(m) {
  const { FW, FH, FC, fert, forest, rock, seed, water } = m;
  const small = document.createElement('canvas'); small.width = FW; small.height = FH;
  const sg = small.getContext('2d'), img = sg.createImageData(FW, FH);
  const lerp = (a, b, t) => a + (b - a) * t;
  for (let i = 0; i < FW * FH; i++) {
    const f = fert[i], fo = forest[i], r = rock[i];
    // dry ochre -> lush green by fertility, deep green where forest, grey-brown where rock
    let R = lerp(52, 30, f), G = lerp(54, 82, f), B = lerp(36, 52, f);
    const ft = clamp((fo - .45) * 2.2, 0, 1); R = lerp(R, 18, ft * .7); G = lerp(G, 58, ft * .7); B = lerp(B, 44, ft * .7);
    const rt = clamp((r - .55) * 2.6, 0, 1); R = lerp(R, 70, rt); G = lerp(G, 70, rt); B = lerp(B, 66, rt);
    if (water && water[i] === 1) { R = 34; G = 78; B = 104; } else if (water && water[i] === 2) { R = 16; G = 40; B = 62; }
    img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B; img.data[i * 4 + 3] = 255;
  }
  sg.putImageData(img, 0, 0);
  const S = innerWidth < 760 ? 1 : 1.5, t = document.createElement('canvas'); t.width = W * S; t.height = H * S;
  const g = t.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  // draw the small map three times wide and tall so smoothing blends across the wrap, then keep the centre
  for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) g.drawImage(small, xx * W * S, yy * H * S, FW * FC * S, FH * FC * S);
  let sd = seed || 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 360; i++) {
    const x = rr() * t.width, y = rr() * t.height, rad = (16 + rr() * 80) * S;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, rr() < .5 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.035)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 12000; i++) {
    const x = rr() * W, y = rr() * H, rk = rock[clamp(x / FC | 0, 0, FW - 1) + clamp(y / FC | 0, 0, FH - 1) * FW];
    g.fillStyle = rk > .6 && rr() < .5 ? 'rgba(200,200,190,.08)' : rr() < .5 ? 'rgba(170,220,170,.05)' : 'rgba(0,0,0,.14)';
    g.fillRect(x * S, y * S, S * (1 + rr()), S * (1 + rr()));
  }
  if (water) { g.strokeStyle = 'rgba(160,210,240,.10)'; g.lineWidth = 1; for (let i = 0; i < 2200; i++) { const x = rr() * W, y = rr() * H; if (water[clamp(x / FC | 0, 0, FW - 1) + clamp(y / FC | 0, 0, FH - 1) * FW]) { g.beginPath(); g.moveTo(x * S, y * S); g.lineTo((x + 3 + rr() * 4) * S, y * S); g.stroke(); } } }
  g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(0, 0, t.width, t.height);
  g.strokeStyle = 'rgba(190,230,210,.04)'; g.lineWidth = 1;
  for (let x = 40; x < W; x += 40) { g.beginPath(); g.moveTo(x * S, 0); g.lineTo(x * S, t.height); g.stroke(); }
  for (let y = 40; y < H; y += 40) { g.beginPath(); g.moveTo(0, y * S); g.lineTo(t.width, y * S); g.stroke(); }
  terrain = t;
}

/* ================= world rendering ================= */
let lastT = performance.now(), fpsFrames = 0, fpsT = lastT, hoverId = 0, pointerWorld = null, flash = 0;
const phaseOf = (ticks, len) => len ? (ticks % len) / len : 0;
const SYMFONT = '"Noto Sans Runic","Noto Sans Canadian Aboriginal","Instrument Sans",system-ui,sans-serif';
const FXC = { 1: [126, 214, 176], 2: [242, 100, 90], 4: [240, 179, 90], 8: [201, 179, 230], 32: [255, 80, 70], 64: [127, 216, 234], 128: [255, 143, 200] };
function render(t) {
  if (REMOTE) { drainFrames(t); if (cw) sendCam(t); }
  const dt = Math.min(.1, (t - lastT) / 1000); lastT = t;
  if (camTarget) { const k = 1 - Math.exp(-dt * 9); cam.x += (camTarget.x - cam.x) * k; cam.y += (camTarget.y - cam.y) * k; cam.z += (camTarget.z - cam.z) * k; if (Math.abs(camTarget.z - cam.z) < .001 && Math.hypot(camTarget.x - cam.x, camTarget.y - cam.y) < .05) { Object.assign(cam, camTarget); camTarget = null; } }
  const k = 1 - Math.exp(-dt * (REMOTE ? clamp(1300 / arriveMean, 5, 16) : 16)), fast = hyper();
  if (!fast) {
    for (const map of [rpos, bpos]) for (const p of map.values()) {
      if (p.tx === undefined) continue;
      const dx = wd(p.tx - p.x, W), dy = wd(p.ty - p.y, H);
      if (dx * dx + dy * dy > 1600) { p.x = p.tx; p.y = p.ty; } else { p.x = wrapC(p.x + dx * k, W); p.y = wrapC(p.y + dy * k, H); }
      let dh = p.thd - p.hd; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); p.hd += dh * Math.min(1, k * 1.4);
    }
  }
  const sp = selected && rpos.get(selected);
  if (follow && !sp && selected) { follow = false; $('iFollow').classList.remove('on'); }
  if (follow && sp && camTarget) { camTarget.x = cam.x + wd(sp.x - cam.x, W); camTarget.y = cam.y + wd(sp.y - cam.y, H); }
  else if (follow && sp) { const kk = 1 - Math.exp(-dt * 6); cam.x += wd(sp.x - cam.x, W) * kk; cam.y += wd(sp.y - cam.y, H) * kk; }
  if (sp && ui.trail && !fast) { const lp = trail[trail.length - 1]; if (!lp || Math.hypot(wd(lp.x - sp.x, W), wd(lp.y - sp.y, H)) > 1.5) { trail.push({ x: sp.x, y: sp.y }); if (trail.length > 90) trail.shift(); } }

  updateViewCenter(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, cw, ch);
  if (!F || !terrain) { requestAnimationFrame(render); return; }
  const z = cam.z, now = t / 1000;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (vc.x - cam.x * z), dpr * (vc.y - cam.y * z));
  const vx0 = cam.x - vc.x / z - 12, vx1 = cam.x + (cw - vc.x) / z + 12, vy0 = cam.y - vc.y / z - 12, vy1 = cam.y + (ch - vc.y) / z + 12;
  // the world is a torus: draw one copy per tile the view touches
  // each world is an island in open sea: draw it once, with sea beyond its edges
  ctx.fillStyle = '#10283e'; ctx.fillRect(vx0 - 50, vy0 - 50, vx1 - vx0 + 100, vy1 - vy0 + 100);
  drawTile(0, 0, z, now, dt, vx0, vx1, vy0, vy1, fast, sp);
  fpsFrames++;
  if (t - fpsT > 500) { renderFps = Math.round(fpsFrames * 1000 / (t - fpsT)); fpsFrames = 0; fpsT = t; updateHud(); }
  requestAnimationFrame(render);
}
function drawTile(ox, oy, z, now, dt, vx0, vx1, vy0, vy1, fast, sp) {
  const inView = (x, y) => x + ox > vx0 && x + ox < vx1 && y + oy > vy0 && y + oy < vy1;
  const t = now * 1000;
  ctx.save(); ctx.translate(ox, oy);
  ctx.drawImage(terrain, 0, 0, W, H);
  if (ui.scent && pherCanvas) { ctx.globalAlpha = .55; ctx.imageSmoothingEnabled = true; ctx.drawImage(pherCanvas, 0, 0, W, H); ctx.globalAlpha = 1; }
  const temp = F.temp;
  if (temp < 10) { ctx.fillStyle = `rgba(170,205,255,${clamp((10 - temp) / 30, 0, 1) * .3})`; ctx.fillRect(0, 0, W, H); }
  else if (temp > 27) { ctx.fillStyle = `rgba(255,190,110,${clamp((temp - 27) / 23, 0, 1) * .2})`; ctx.fillRect(0, 0, W, H); }

  // resources. Nature changes slowly, so it is redrawn from a snapshot that refreshes only every second or two.
  // Zoomed out, all of it (trees too) is painted once into a cached layer and shown faint, so the yips stand out.
  const now2 = performance.now();
  if (!natI || now2 - natAt > (z < .7 ? 2500 : 1000)) { natI = { I: F.I }; natAt = now2; natDirty = true; }
  const I = natI.I;
  if (z < .7) {
    if (natDirty || !natCv || Math.abs(Math.log(z / natZ)) > .35) {
      natCv = natCv || document.createElement('canvas'); natCv.width = W; natCv.height = H; natZ = z; natDirty = false;
      const g = natCv.getContext('2d'), s = 1.6 / Math.max(.25, z), cols = [ICOL.bush, ICOL.tree, ICOL.stone, ICOL.meat, ICOL.rot, ICOL.wheat];
      for (let ty = 0; ty < 6; ty++) { g.fillStyle = cols[ty]; const ss = ty === 1 ? s * 1.5 : s; for (let o = 0; o < I.length; o += 4) if (I[o] === ty) g.fillRect(I[o + 1] - ss / 2, I[o + 2] - ss / 2, ss, ss); }
    }
    ctx.globalAlpha = .3; ctx.drawImage(natCv, 0, 0, W, H);
  } else for (let o = 0; o < I.length; o += 4) {
    if (I[o] === 1) continue;
    const x = I[o + 1], y = I[o + 2]; if (!inView(x, y)) continue;
    const [img, r0] = ISPR[I[o]], life = I[o + 3];
    const carc = I[o] === 3 || I[o] === 4, r = carc ? r0 * (.55 + .6 * life) : r0;
    ctx.globalAlpha = !carc && life < .15 ? .25 + life / .15 * .75 : 1;
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;

  // structures
  const B = F.B;
  for (let o = 0; o < B.length; o += 9) {
    const ty = B[o], x = B[o + 1], y = B[o + 2], r = B[o + 3], hp = B[o + 4], col = BCOL[ty];
    if (!inView(x, y)) continue;
    ctx.globalAlpha = .5 + .5 * hp;
    if (ty === 3) {
      const fl = fast ? 1 : 1 + Math.sin(now * 13 + x) * .12 + Math.sin(now * 7.3 + y) * .08;
      ctx.fillStyle = 'rgba(240,138,75,.18)'; ctx.beginPath(); ctx.arc(x, y, r * 1.05, 0, TAU); ctx.fill();
      ctx.fillStyle = '#5a3a26'; ctx.beginPath(); ctx.arc(x, y, r * .55, 0, TAU); ctx.fill();
      ctx.fillStyle = C.fire; ctx.beginPath(); ctx.arc(x, y, r * .42 * fl, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd27a'; ctx.beginPath(); ctx.arc(x, y - .6, r * .2 * fl, 0, TAU); ctx.fill();
    } else if (ty === 2) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(B[o + 8]);
      ctx.fillStyle = 'rgba(0,0,0,.45)'; roundRect(-r, -2.4, r * 2, 6.4, 2.5); ctx.fill();
      ctx.fillStyle = col; roundRect(-r, -3.2, r * 2, 6, 2); ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,60,.55)'; ctx.lineWidth = .5; ctx.beginPath();
      for (let k2 = -r + 5; k2 < r - 1; k2 += 5) { ctx.moveTo(k2, -3.2); ctx.lineTo(k2, 2.8); }
      ctx.moveTo(-r, -.2); ctx.lineTo(r, -.2); ctx.stroke();
      ctx.restore();
    } else {
      const wt = Math.max(2.2, r * .22), h = r - wt / 2;
      ctx.strokeStyle = col; ctx.lineWidth = wt; ctx.lineJoin = 'miter'; ctx.strokeRect(x - h, y - h, h * 2, h * 2);
      ctx.lineWidth = .8; ctx.beginPath();
      if (ty === 0) { /* a house is just its walls */ } else if (false) { ctx.moveTo(x - r * .6, y - r * .05); ctx.lineTo(x, y - r * .6); ctx.lineTo(x + r * .6, y - r * .05); ctx.moveTo(x - r * .15, y + r); ctx.lineTo(x - r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r); }
      else { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
      ctx.stroke();
      const stock = B[o + 6];
      if (stock > 0) { ctx.fillStyle = col; const f = Math.min(1, stock / 30); ctx.fillRect(x - r + 2, y + r - 3, (r * 2 - 4) * f, 1.8); }
    }
    if (hp < .55) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - 8, y - r - 5, 16, 2); ctx.fillStyle = hp < .25 ? C.bad : C.warn; ctx.fillRect(x - 8, y - r - 5, 16 * hp, 2); }
  }
  ctx.globalAlpha = 1;

  // night
  const lightS = Math.sin(TAU * phaseOf(F.ticks, F.day));
  const dark = ui.night && !fast ? clamp((-lightS + .2) / 1.2, 0, 1) * .52 : 0;
  if (dark > .01) {
    ctx.fillStyle = `rgba(4,8,24,${dark})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (let o = 0; o < B.length; o += 9) {
      const ty = B[o]; if (ty === 2) continue;
      const x = B[o + 1], y = B[o + 2]; if (!inView(x, y)) continue;
      if (ty === 3) { const R = 70 + Math.sin(now * 9 + x) * 4; ctx.globalAlpha = .55 * dark / .52; ctx.drawImage(glowFire, x - R, y - R, R * 2, R * 2); }
      else { const R = B[o + 3] * 2.2; ctx.globalAlpha = .28 * dark / .52; ctx.drawImage(glowHouse, x - R, y - R, R * 2, R * 2); }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  // storms
  const S = F.S;
  for (let o = 0; o < S.length; o += 5) {
    const x = S[o], y = S[o + 1], w = S[o + 2], h = S[o + 3], x0 = x - w / 2, y0 = y - h / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    const gr = ctx.createLinearGradient(x0, 0, x0 + w, 0); gr.addColorStop(0, 'rgba(110,135,230,0)'); gr.addColorStop(.3, 'rgba(110,135,230,.22)'); gr.addColorStop(1, 'rgba(90,110,200,.3)');
    ctx.fillStyle = gr; ctx.fillRect(x0, y0, w, h);
    if (!fast) {
      ctx.strokeStyle = 'rgba(200,215,255,.35)'; ctx.lineWidth = .5; ctx.beginPath();
      const off = (now * 140) % 24;
      for (let i = -h; i < w + h; i += 9) for (let j = -24; j < h; j += 24) { const sx = x0 + i - (j + off) * .35, sy = y0 + j + off; ctx.moveTo(sx, sy); ctx.lineTo(sx - 2.2, sy + 6); }
      ctx.stroke();
      if (Math.random() < .006) flash = 1;
      if (flash > 0) { ctx.fillStyle = `rgba(230,235,255,${flash * .35})`; ctx.fillRect(x0, y0, w, h); }
    }
    ctx.restore();
  }
  flash = Math.max(0, flash - dt * 5);

  // agents
  const A = F.A, list = [], R = 3.3;
  for (let o = 0; o < A.length; o += 10) { const p = rpos.get(A[o]); if (!p || !inView(p.x, p.y)) continue; list.push(o, p); }
  ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const p = list[i + 1]; ctx.moveTo(p.x + R + 1.1, p.y + .6); ctx.arc(p.x, p.y + .6, R + 1.1, 0, TAU); }
  ctx.fill();
  for (let i = 0; i < list.length; i += 2) {
    const o = list[i], p = list[i + 1], e = A[o + 5], flags = A[o + 7];
    ctx.globalAlpha = (flags & 1) ? .5 : e < .08 ? .6 : 1;
    ctx.fillStyle = hueFill[(A[o + 3] | 0) % 360]; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(170,215,255,.7)'; ctx.lineWidth = .6; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 16)) continue; const rr = R + 2.5 + Math.sin(now * 5 + p.x) * .8; ctx.moveTo(p.x + rr, p.y); ctx.arc(p.x, p.y, rr, 0, TAU); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(170,200,80,.85)'; ctx.lineWidth = .7; ctx.setLineDash([1.2, 1]); ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 32)) continue; ctx.moveTo(p.x + R + 1.2, p.y); ctx.arc(p.x, p.y, R + 1.2, 0, TAU); }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,214,150,.9)'; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 64)) continue; ctx.moveTo(p.x + .9, p.y + R * .2); ctx.arc(p.x, p.y + R * .2, .9, 0, TAU); }
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,143,200,.8)'; ctx.lineWidth = .8; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 8)) continue; ctx.moveTo(p.x + R + 1.8, p.y); ctx.arc(p.x, p.y, R + 1.8, 0, TAU); }
  ctx.stroke();
  // what they are saying: the current word (up to four symbols), with ! when shouted
  if (meta && meta.syms && z > .45 && !fast) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < list.length; i += 2) {
      const o = list[i], p = list[i + 1], code = Math.floor(A[o + 9] / 256); if (!code) continue;
      const shout = code & 1; let u = code >> 1, w = ''; while (u > 0) { w = meta.syms[(u % 12) - 1] + w; u = Math.floor(u / 12); }
      if (!w || (!shout && z < .9)) continue;
      const fs = shout ? 7 : 5.5, txt = (shout ? '! ' : '') + w;
      ctx.font = `${shout ? 700 : 500} ${fs}px ${SYMFONT}`;
      const tw = ctx.measureText(txt).width + 5, yy = p.y - R - 6.5 - (shout ? 1 : 0);
      ctx.fillStyle = shout ? 'rgba(60,22,14,.88)' : 'rgba(10,18,17,.82)'; roundRect(p.x - tw / 2, yy - fs * .75, tw, fs * 1.5, 3); ctx.fill();
      ctx.fillStyle = shout ? '#ffb38a' : '#e9efe9'; ctx.fillText(txt, p.x, yy + .3);
    }
  }
  if (z > .6) {
    ctx.strokeStyle = 'rgba(8,14,13,.85)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round'; ctx.beginPath();
    for (let i = 0; i < list.length; i += 2) { const p = list[i + 1], c = Math.cos(p.hd), s = Math.sin(p.hd); ctx.moveTo(p.x + c * .6, p.y + s * .6); ctx.lineTo(p.x + c * R * 1.05, p.y + s * R * 1.05); }
    ctx.stroke();
    ctx.fillStyle = '#e8c48f'; ctx.beginPath();
    for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 2)) continue; const c = Math.cos(p.hd), s = Math.sin(p.hd); ctx.moveTo(p.x - c * R * 1.25 + 1, p.y - s * R * 1.25); ctx.arc(p.x - c * R * 1.25, p.y - s * R * 1.25, 1, 0, TAU); }
    ctx.fill();
    // tools: a short pale shaft on the agent's right side
    ctx.strokeStyle = '#f4efe4'; ctx.lineWidth = .9; ctx.beginPath();
    for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 4)) continue; const a = p.hd + 1.2, c = Math.cos(a), s = Math.sin(a), c2 = Math.cos(p.hd), s2 = Math.sin(p.hd); const bx = p.x + c * (R + .8), by = p.y + s * (R + .8); ctx.moveTo(bx - c2 * 1.5, by - s2 * 1.5); ctx.lineTo(bx + c2 * 3, by + s2 * 3); }
    ctx.stroke();
  }

  // beasts
  for (const p of bpos.values()) {
    if (!inView(p.x, p.y)) continue;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.hd);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(1, 1.2, 7.5, 4.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6b2620'; ctx.beginPath(); ctx.ellipse(0, 0, 7, 4.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = C.beast; ctx.beginPath(); ctx.ellipse(-.5, 0, 5.6, 3.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7b2c25'; ctx.beginPath(); ctx.moveTo(5, -2.6); ctx.lineTo(8, -4.5); ctx.lineTo(7, -1); ctx.moveTo(5, 2.6); ctx.lineTo(8, 4.5); ctx.lineTo(7, 1); ctx.fill();
    ctx.fillStyle = p.hunt ? '#ffe08a' : '#ffb59a'; ctx.globalAlpha = .7 + dark; ctx.beginPath(); ctx.arc(5.6, -1.4, .8, 0, TAU); ctx.arc(5.6, 1.4, .8, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
    ctx.restore();
    if (p.hp < .98) { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(p.x - 7, p.y - 9, 14, 2); ctx.fillStyle = C.beast; ctx.fillRect(p.x - 7, p.y - 9, 14 * p.hp, 2); }
  }

  // trees stand over everything on the ground, yips included (dimmed at night like the ground); zoomed out they are in the faint layer
  if (z >= .7) {
    if (dark > .01) ctx.filter = `brightness(${1 - dark})`;
    for (let o = 0; o < I.length; o += 4) {
      if (I[o] !== 1) continue; const x = I[o + 1], y = I[o + 2]; if (!inView(x, y)) continue;
      const life = I[o + 3], r = 6;
      ctx.globalAlpha = life < .15 ? .25 + life / .15 * .75 : .95; ctx.drawImage(sprTree, x - r, y - r * 1.15, r * 2, r * 2);
    }
    ctx.globalAlpha = 1; ctx.filter = 'none';
  }

  // action effects
  if (fx.length) {
    const nowMs = performance.now(); let w = 0; ctx.lineWidth = 1.1;
    for (const e of fx) {
      const age = (nowMs - e.t) / 520; if (age >= 1) continue; fx[w++] = e;
      if (!inView(e.x, e.y)) continue;
      const [r, g, b] = FXC[e.k], a = (1 - age) * .9;
      ctx.strokeStyle = `rgba(${r},${g},${b},${a})`; ctx.beginPath();
      if (e.k === 2 || e.k === 4) { const s = 3 + age * 6; ctx.moveTo(e.x - s, e.y - s); ctx.lineTo(e.x + s, e.y + s); ctx.moveTo(e.x + s, e.y - s); ctx.lineTo(e.x - s, e.y + s); }
      else if (e.k === 128) { const yy = e.y - 7 - age * 6; ctx.globalAlpha = 1 - age; ctx.fillStyle = 'rgba(12,20,19,.8)'; roundRect(e.x - 5, yy - 4.5, 10, 9, 4); ctx.fill(); ctx.fillStyle = 'rgb(255,143,200)'; ctx.font = '7px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('♡', e.x, yy + .5); ctx.globalAlpha = 1; continue; }
      else if (e.k === 32) { ctx.fillStyle = `rgba(${r},${g},${b},${a * .5})`; ctx.arc(e.x, e.y, 4.5, 0, TAU); ctx.fill(); continue; }
      else if (e.k === 8) { for (let q = 0; q < 4; q++) { const ang = q * Math.PI / 2 + age * 2, d = 3 + age * 7; ctx.moveTo(e.x + Math.cos(ang) * d, e.y + Math.sin(ang) * d); ctx.arc(e.x + Math.cos(ang) * d, e.y + Math.sin(ang) * d, .7, 0, TAU); } }
      else ctx.arc(e.x, e.y, 4 + age * 9, 0, TAU);
      ctx.stroke();
    }
    fx.length = w;
  }

  // selection
  if (sp) {
    if (ui.trail && trail.length > 1 && !fast) {
      ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) { if (Math.abs(trail[i].x - trail[i - 1].x) > W / 2 || Math.abs(trail[i].y - trail[i - 1].y) > H / 2) continue; ctx.strokeStyle = `rgba(243,201,107,${(i / trail.length) * .55})`; ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke(); }
    }
    const sense = A[sp.i + 8] || 0;
    if (ui.sense && sense) { ctx.strokeStyle = 'rgba(243,201,107,.4)'; ctx.fillStyle = 'rgba(243,201,107,.035)'; ctx.lineWidth = 1 / z; ctx.setLineDash([5 / z, 5 / z]); ctx.beginPath(); ctx.arc(sp.x, sp.y, sense, 0, TAU); ctx.fill(); ctx.stroke(); ctx.setLineDash([]); }
    const pulse = 1 + Math.sin(now * 4) * .12;
    ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(1.4, 1.6 / z); ctx.beginPath(); ctx.arc(sp.x, sp.y, Math.max(7.5, 9 / z) * pulse, 0, TAU); ctx.stroke();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(sp.x, sp.y, R * .55, 0, TAU); ctx.fill();
  }
  if (hoverId && hoverId !== selected) { const hp = rpos.get(hoverId); if (hp) { ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5 / z; ctx.beginPath(); ctx.arc(hp.x, hp.y, 6.5, 0, TAU); ctx.stroke(); } }
  if (pointerWorld && tool !== 'select' && ox === 0 && oy === 0) {
    const col = { food: C.food, tree: C.tree, stone: C.stone, wall: C.wall, fire: C.fire, beast: C.beast, erase: C.fg }[tool];
    const r = tool === 'fire' ? 12 : tool === 'beast' ? 8 : tool === 'wall' ? 15 : ui.brushSize;
    ctx.strokeStyle = col; ctx.lineWidth = 1.2 / z; ctx.setLineDash([4 / z, 3 / z]); ctx.beginPath(); ctx.arc(pointerWorld.x - ox, pointerWorld.y - oy, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
requestAnimationFrame(render);

/* ================= islands & turbo ================= */
function renderIslands() {
  const html = sims.map((_, i) => { const p = pulses[i]; return `<button class="isl${i === watched ? ' on' : ''}" data-isl="${i}"><b>${ISLAND(i)}</b><span class="num">${p ? p.pop : '…'}</span><small>${p ? 'gen ' + p.maxGen : ''}</small></button>`; }).join('');
  $('islands').innerHTML = html; $('islands2').innerHTML = html; $('islands').hidden = sims.length < 2; $('islandCount').value = sims.length;
  if (turbo) {
    $('turboStats').innerHTML = sims.map((_, i) => { const p = pulses[i] || {}; return `<div class="tcard${i === watched ? ' on' : ''}"><b>Island ${ISLAND(i)}</b><div><span>Tick</span><b class="num">${fmt(p.ticks || 0)}</b></div><div><span>Ticks / s</span><b class="num">${fmt(p.tps || 0)}</b></div><div><span>Living</span><b class="num">${p.pop ?? '…'}</b></div><div><span>Generation</span><b class="num">${p.maxGen ?? 0} <em>avg ${(p.avgGen || 0).toFixed(1)}</em></b></div><div><span>Births / deaths</span><b class="num">${fmt(p.births || 0)} / ${fmt(p.deaths || 0)}</b></div></div>`; }).join('');
    const total = pulses.reduce((s, p) => s + (p ? p.tps : 0), 0);
    $('turboTotal').textContent = `${fmt(total)} ticks per second across ${sims.length} island${sims.length > 1 ? 's' : ''}`;
  }
}
function watchIsland(i) {
  if (i === watched || !sims[i]) return;
  watched = i; F = null; stats = null; insp = null; rpos.clear(); bpos.clear(); trail = []; terrain = null; pherCanvas = null;
  setSelected(0); syncIslands(); renderIslands();
  toast(`Watching island ${ISLAND(i)}`, 'info');
}
document.addEventListener('click', e => { const b = e.target.closest('[data-isl]'); if (b) watchIsland(+b.dataset.isl); });
function setTurbo(on) {
  turbo = on; $('turbo').hidden = !on; $('bTurbo').classList.toggle('hot', on);
  if (on && !running) setRunning(true);
  syncIslands(); renderIslands();
}
$('bTurbo').onclick = () => setTurbo(!turbo);
$('turboExit').onclick = () => setTurbo(false);
$('islandCount').value = islandCount;
// change the number of islands live: new ones start fresh, removed ones are discarded (save first to keep them)
function setIslandCount(n) {
  if (REMOTE) { remoteSend({ cmd: 'islands', n: clamp(n, 1, 4) }); return; }
  if (!usingWorker) { toast('This browser can only run one island', 'info'); return; }
  n = clamp(n, 1, 4);
  while (sims.length > n) { const i = sims.length - 1; workers.pop().terminate(); sims.pop(); isl.pop(); pulses.length = sims.length; for (const v of viewers) if (v.watch === i) v.watch = v.local ? 0 : -1; if (watched === i) watchIsland(0); }
  while (sims.length < n) spawnIsland(sims.length);
  islandCount = n; ui.islands = n; saveUi(); updateCoreNote(); renderIslands(); helloPeers(); hubViews();
}
const updateCoreNote = () => { $('coreNote').textContent = REMOTE ? `${sims.length} island${sims.length > 1 ? 's are' : ' is'} running on ${remoteHost || 'the server'}.` : `This device reports ${cores} CPU core${cores > 1 ? 's' : ''}; ${sims.length} island${sims.length > 1 ? 's are' : ' is'} running.${sims.length >= cores ? ' More islands than cores share the processor and each runs slower.' : ''}`; };
$('islandCount').onchange = () => { const n = +$('islandCount').value, gone = sims.length - n; setIslandCount(n); if (gone) toast(gone > 0 ? `Removed ${gone} island${gone > 1 ? 's' : ''}` : `${-gone} new island${-gone > 1 ? 's' : ''} started with fresh founders`, 'info'); };
updateCoreNote();

/* ================= HUD ================= */
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const dayLabel = p => p < .06 || p >= .94 ? 'Dawn' : p < .44 ? 'Day' : p < .56 ? 'Dusk' : 'Night';
function updateHud() {
  if (!F) return;
  const pop = REMOTE && pulses[watched] ? pulses[watched].pop : F.A.length / 10;   // remote frames hold only nearby yips
  $('roPop').textContent = pop;
  $('roBeasts').textContent = F.Z.length / 6;
  $('roBuilt').textContent = F.B.length / 9;
  $('roTps').textContent = fmt(simTps);
  if (stats) $('roGen').innerHTML = `${stats.avgGen.toFixed(1)}<em>max ${stats.maxGen}</em>`;
  const p = phaseOf(F.ticks, F.day), season = F.season ? SEASONS[Math.floor(phaseOf(F.ticks, F.season) * 4)] : '';
  $('roDayL').textContent = cw < 760 ? `Day ${Math.floor(F.ticks / F.day) + 1}` : `Day ${Math.floor(F.ticks / F.day) + 1} · ${season || dayLabel(p)}`;
  $('roTemp').innerHTML = `<span class="sun" id="sun"></span>${F.temp.toFixed(0)}°C<em>${dayLabel(p).toLowerCase()}</em>`;
  const sun = $('sun'), light = Math.sin(TAU * p);
  sun.style.background = light > 0 ? C.accent : '#9cb6ff'; sun.style.boxShadow = `0 0 ${light > 0 ? 8 : 4}px ${light > 0 ? C.accent : '#9cb6ff'}`;
  $('perf').textContent = `${REMOTE ? `${remoteHost || 'server'} · buffer ${Math.round(netDelay())} ms · ${fmt(Math.round(netRate / 1024))} KB/s · ` : ''}island ${ISLAND(watched)} of ${sims.length} · tick ${fmt(F.ticks)} · ${fmt(simTps)} ticks/s · ${renderFps} fps`;
}

/* ================= controls ================= */
const ICON = {
  pause: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Pause</span>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg><span>Play</span>',
};
function paintPlay() { const b = $('bPlay'); b.innerHTML = ICON[running ? 'pause' : 'play']; b.dataset.tip = running ? 'Pause' : 'Resume'; b.dataset.state = String(running); }
let setRunning = v => { running = v; sendAll('play', { running }); paintPlay(); syncWake(); };
function applySpeed() {
  syncIslands();
  $('spOut').textContent = maxMode ? 'MAX' : SPEEDS[speedIdx] + '×';
  $('bMax').classList.toggle('hot', maxMode);
  $('ctx').classList.toggle('hyper', maxMode);
  ui.speedIdx = speedIdx; saveUi(); updateCtx();
}
function setSpeed(i) {
  if (i >= SPEEDS.length) { if (!maxMode) { maxMode = true; toast('Hyperspeed: drawing is reduced to keep the simulation fast', 'info'); } }
  else { maxMode = false; speedIdx = clamp(i, 0, SPEEDS.length - 1); }
  applySpeed();
}
$('bPlay').onclick = () => setRunning(!running);
$('bStep').onclick = () => send('step', { n: 100 });
$('spDown').onclick = () => setSpeed(maxMode ? SPEEDS.length - 1 : speedIdx - 1);
$('spUp').onclick = () => setSpeed(maxMode ? SPEEDS.length : speedIdx + 1);
$('bMax').onclick = () => { if (maxMode) { maxMode = false; applySpeed(); } else { if (!running) setRunning(true); setSpeed(SPEEDS.length); } };

/* tools + context bar */
const TOOLS = {
  select: ['Select & pan', 'Tap a yip to inspect it. Drag to pan; pinch or scroll to zoom.'],
  food: ['Food brush', 'Drag across the map to paint food.'],
  tree: ['Tree brush', 'Drag to plant trees. Yips harvest them for wood.'],
  stone: ['Stone brush', 'Drag to drop stone for building and tools.'],
  wall: ['Wall brush', 'Drag to draw a wall line. Walls block yips and beasts and break storm winds.'],
  fire: ['Fire', 'Tap to light a fire. It warms and scares beasts off, but burns anyone standing in it.'],
  beast: ['Beast', 'Tap to release a beast. Beasts hunt exposed yips; walls, fire and houses protect them.'],
  erase: ['Eraser', 'Drag to clear resources, structures and beasts.'],
};
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  cv.classList.toggle('brush', t !== 'select');
  updateCtx();
}
function updateCtx() {
  const [name, hint] = TOOLS[tool];
  $('ctxName').textContent = name;
  $('ctxHint').textContent = maxMode ? `Hyperspeed on: ${fmt(simTps)} ticks/s, drawing reduced. ${hint}` : hint;
  $('ctxIco').innerHTML = document.querySelector(`[data-tool="${tool}"] svg`).outerHTML;
  $('optSize').hidden = !['food', 'tree', 'stone', 'erase'].includes(tool);
  $('optAmt').hidden = !['food', 'tree', 'stone'].includes(tool);
  $('ctxInspect').hidden = !(tool === 'select' && selected && !$('dInspect').classList.contains('open'));
}
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('brushSize').value = ui.brushSize; $('brushAmt').value = ui.brushAmt;
function paintMini() { $('brushSizeV').textContent = ui.brushSize; $('brushAmtV').textContent = ui.brushAmt + '×'; for (const id of ['brushSize', 'brushAmt']) { const el = $(id); el.style.setProperty('--p', (el.value - el.min) / (el.max - el.min) * 100 + '%'); } }
$('brushSize').oninput = () => { ui.brushSize = +$('brushSize').value; paintMini(); saveUi(); };
$('brushAmt').oninput = () => { ui.brushAmt = +$('brushAmt').value; paintMini(); saveUi(); };
paintMini();
$('ctxInspect').onclick = () => { if (selected) openDrawer('dInspect'); };
setTool('select');
paintPlay(); applySpeed();
setInterval(() => { if (maxMode) updateCtx(); }, 1000);
const quick = { qStorm: 'storm', qBloom: 'bloom', eStorm: 'storm', eBloom: 'bloom', eCold: 'cold', eHeat: 'heat' };
for (const [id, cmd] of Object.entries(quick)) $(id).onclick = () => { send(cmd); if (cmd === 'cold' || cmd === 'heat') { const el = $('temperature'); el.value = clamp(+el.value + (cmd === 'cold' ? -12 : 12), -20, 50); paintSlider(el); } if (cmd === 'bloom') toast('Food bloom', 'food'); };

/* drawers */
const DRAWERS = { bStats: 'dStats', bClimate: 'dClimate', bSettings: 'dSettings' };
const LEFT = ['dStats', 'dClimate', 'dSettings'];
function openDrawer(id) {
  const isLeft = id !== 'dInspect', el = $(id), opening = !el.classList.contains('open');
  if (isLeft) for (const d of LEFT) $(d).classList.toggle('open', d === id && opening);
  else el.classList.toggle('open', opening);
  if (compact() && opening) { if (isLeft) $('dInspect').classList.remove('open'); else for (const d of LEFT) $(d).classList.remove('open'); }
  for (const [b, d] of Object.entries(DRAWERS)) $(b).classList.toggle('on', $(d).classList.contains('open'));
  send('inspect', { on: $('dInspect').classList.contains('open') });
  if (id === 'dStats' && opening) renderStats();
  if (id === 'dInspect' && opening) renderInspector();
  updateCtx();
}
function closeDrawer(id) { if ($(id).classList.contains('open')) openDrawer(id); }
for (const [b, d] of Object.entries(DRAWERS)) $(b).onclick = () => openDrawer(d);
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeDrawer(b.dataset.close));
$('bFit').onclick = () => { follow = false; $('iFollow').classList.remove('on'); fit(); };

/* fullscreen (hidden where the browser has none, e.g. iPhone Safari) */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
if (!fsOk) $('bFull').hidden = true;
$('bFull').onclick = async () => {
  try {
    if (fsEl()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { const el = document.documentElement; await (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' }); }
  } catch { toast('Fullscreen is not available here', 'info'); }
};
const onFs = () => { $('bFull').classList.toggle('on', !!fsEl()); $('fullIco').innerHTML = fsEl() ? '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>' : '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>'; };
document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);

/* selection */
function setSelected(id, { fromSim = false, open = true } = {}) {
  if (id !== selected) trail = [];
  selected = id || 0;
  if (!fromSim) send('select', { id: selected });
  if (selected && open && !$('dInspect').classList.contains('open')) openDrawer('dInspect');
  if (!selected) { follow = false; $('iFollow').classList.remove('on'); closeDrawer('dInspect'); updateCtx(); return; }
  updateCtx();
  setTimeout(revealSelected, 60);
}
function revealSelected() {
  const p = rpos.get(selected); if (!p) return;
  const v = viewRect(), c = chrome(), s = toScreen(p.x, p.y), m = 40;
  if (s.x < v.l + m || s.x > v.r - m || s.y < Math.max(v.t, c.t) + 20 || s.y > Math.min(v.b, c.b) - 20) camTarget = { x: cam.x + wd(p.x - cam.x, W), y: cam.y + wd(p.y - cam.y, H), z: Math.max(cam.z, fitZoom() * (cw < 760 ? 1.8 : 1)) };
}
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => send('pick', { how: b.dataset.pick }));
$('iFollow').onclick = () => toggleFollow();
function toggleFollow() { if (!selected) return; follow = !follow; $('iFollow').classList.toggle('on', follow); if (follow) { const p = rpos.get(selected); camTarget = { x: p ? cam.x + wd(p.x - cam.x, W) : cam.x, y: p ? cam.y + wd(p.y - cam.y, H) : cam.y, z: Math.max(cam.z, 2.6) }; } }

/* pointer input on the world */
const ptrs = new Map(); let gesture = null, lastPaint = 0;
function agentAt(sx, sy, touch) {
  const w = toWorld(sx, sy), r = Math.max(7, (touch ? 26 : 14) / cam.z); let best = 0, bd = r * r;
  for (const [id, p] of rpos) { const dx = wd(p.x - w.x, W), dy = wd(p.y - w.y, H), d = dx * dx + dy * dy; if (d < bd) { bd = d; best = id; } }
  return best;
}
const inWorld = w => w.x >= 0 && w.y >= 0 && w.x < W && w.y < H;
function paint(sx, sy) { const w = toWorld(sx, sy); if (!inWorld(w)) return; send('paint', { x: w.x, y: w.y, k: tool, r: ui.brushSize, n: ui.brushAmt }); lastPaint = performance.now(); }
function wallTo(w) {
  const g = gesture; if (!g.last) { g.last = w; return; }
  const dx = w.x - g.last.x, dy = w.y - g.last.y, d = Math.hypot(dx, dy);
  if (d < 26) return;
  const ang = Math.atan2(dy, dx), steps = Math.floor(d / 28);
  for (let i = 0; i < steps; i++) {
    const cx = wrapC(g.last.x + Math.cos(ang) * 14, W), cy = wrapC(g.last.y + Math.sin(ang) * 14, H);
    send('paint', { x: cx, y: cy, k: 'wall', ang });
    g.last = { x: g.last.x + Math.cos(ang) * 28, y: g.last.y + Math.sin(ang) * 28 }; g.placed = true;
  }
}
const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
cv.addEventListener('pointerdown', e => {
  const p = local(e); ptrs.set(e.pointerId, p); cv.setPointerCapture(e.pointerId);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
  if (ptrs.size > 2) return;
  if (e.button === 1 || e.button === 2 || tool === 'select') { gesture = { type: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: 0, tap: e.button === 0, touch: e.pointerType !== 'mouse' }; cv.classList.add('panning'); }
  else if (tool === 'wall') { gesture = { type: 'wall', last: null, start: toWorld(p.x, p.y) }; wallTo(toWorld(p.x, p.y)); }
  else if (tool === 'fire' || tool === 'beast') { gesture = { type: 'once' }; paint(p.x, p.y); }
  else { gesture = { type: 'paint' }; paint(p.x, p.y); }
});
cv.addEventListener('pointermove', e => {
  const p = local(e);
  pointerWorld = toWorld(p.x, p.y);
  if (!ptrs.has(e.pointerId)) {
    if (e.pointerType === 'mouse') { hoverId = tool === 'select' ? agentAt(p.x, p.y) : 0; showHover(hoverId, e.clientX, e.clientY); }
    return;
  }
  ptrs.set(e.pointerId, p);
  if (!gesture) return;
  if (gesture.type === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomAt(mx, my, gesture.z0 * d / Math.max(1, gesture.d0));
    cam.x -= (mx - gesture.mx) / cam.z; cam.y -= (my - gesture.my) / cam.z; gesture.mx = mx; gesture.my = my; clampCam(); follow = false;
  } else if (gesture.type === 'pan') {
    gesture.moved = Math.max(gesture.moved, Math.hypot(p.x - gesture.sx, p.y - gesture.sy));
    if (gesture.moved > (gesture.touch ? 10 : 4)) { cam.x = gesture.cx - (p.x - gesture.sx) / cam.z; cam.y = gesture.cy - (p.y - gesture.sy) / cam.z; clampCam(); camTarget = null; if (follow) { follow = false; $('iFollow').classList.remove('on'); } }
  } else if (gesture.type === 'paint' && performance.now() - lastPaint > 60) paint(p.x, p.y);
  else if (gesture.type === 'wall') wallTo(toWorld(p.x, p.y));
});
let lastTap = { t: 0, x: 0, y: 0 };
function endPtr(e) {
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  if (gesture && gesture.type === 'pan' && gesture.tap && gesture.moved <= (gesture.touch ? 10 : 4) && p) {
    const now = performance.now(), id = agentAt(p.x, p.y, gesture.touch);
    if (id) { setSelected(id); if (navigator.vibrate) try { navigator.vibrate(8); } catch {} lastTap.t = 0; }
    else if (gesture.touch && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { zoomAt(p.x, p.y, cam.z * 1.8); lastTap.t = 0; }
    else lastTap = { t: now, x: p.x, y: p.y };
  }
  if (gesture && gesture.type === 'wall' && !gesture.placed && p) { const w = toWorld(p.x, p.y); if (inWorld(w)) send('paint', { x: w.x, y: w.y, k: 'wall', ang: 0 }); }
  if (!ptrs.size) { gesture = null; cv.classList.remove('panning'); }
  else if (gesture && gesture.type === 'pinch') { const [q] = [...ptrs.values()]; gesture = { type: 'pan', sx: q.x, sy: q.y, cx: cam.x, cy: cam.y, moved: 99, tap: false, touch: true }; }
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { pointerWorld = null; hoverId = 0; showHover(0); } });
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, cam.z * Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0016))); }, { passive: false });
cv.addEventListener('dblclick', e => { if (isTouch) return; const p = local(e); if (!agentAt(p.x, p.y)) zoomAt(p.x, p.y, cam.z * 1.8); });
function showHover(id, x, y) {
  const el = $('hover');
  if (!id || !F) { el.classList.remove('show'); return; }
  const p = rpos.get(id); if (!p) return;
  const o = p.i, A = F.A;
  el.innerHTML = `${esc(nameOf(id))} · energy ${Math.round(A[o + 5] * 200)} · health ${Math.round(A[o + 6] * 100)}${A[o + 7] & 4 ? ' · tool' : ''}`;
  el.style.left = Math.min(x + 14, innerWidth - 220) + 'px'; el.style.top = (y + 12) + 'px'; el.classList.add('show');
}

/* tooltips (mouse only; touch gets the context bar and labels instead) */
const tip = $('tip');
document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    tip.innerHTML = esc(el.dataset.tip) + (el.dataset.key ? `<kbd>${el.dataset.key}</kbd>` : '');
    const r = el.getBoundingClientRect(), below = r.top < 120;
    tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('show');
    const tw = tip.offsetWidth;
    tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8) + 'px';
    tip.style.top = (below ? r.bottom + 8 : r.top - 34) + 'px';
  });
  el.addEventListener('pointerleave', () => tip.classList.remove('show'));
});

/* keyboard */
const TOOLKEYS = ['select', 'food', 'tree', 'stone', 'wall', 'fire', 'beast', 'erase'];
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); setRunning(!running); }
  else if (k === '.') send('step', { n: 100 });
  else if (k === '-' || k === '_') $('spDown').click();
  else if (k === '=' || k === '+') $('spUp').click();
  else if (k === 'm' || k === 'M') $('bMax').click();
  else if (k === 't' || k === 'T') setTurbo(!turbo);
  else if (k >= '1' && k <= '8') setTool(TOOLKEYS[+k - 1]);
  else if (k === '[' || k === ']') { ui.brushSize = clamp(ui.brushSize + (k === ']' ? 4 : -4), 8, 70); $('brushSize').value = ui.brushSize; paintMini(); saveUi(); }
  else if (k === 'f' || k === 'F') toggleFollow();
  else if (k === '0') $('bFit').click();
  else if (k === 's' || k === 'S') openDrawer('dStats');
  else if (k === 'c' || k === 'C') openDrawer('dClimate');
  else if (k === 'Escape') {
    if (!$('modal').hidden) { $('modal').hidden = true; return; }
    if (turbo) { setTurbo(false); return; }
    const open = LEFT.find(d => $(d).classList.contains('open'));
    if (open) closeDrawer(open); else setSelected(0);
  }
});

/* ================= toasts ================= */
const KCOL = { storm: C.storm, death: C.bad, birth: C.good, build: C.house, cold: '#9cc6ff', heat: '#ff9d6b', food: C.food, beast: C.beast, info: C.muted };
function toast(s, kind = 'info') {
  const el = document.createElement('div'); el.className = 'toast glass';
  el.innerHTML = `<i style="background:${KCOL[kind] || C.muted}"></i>`; el.append(s);
  const box = $('toasts'); box.prepend(el); while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

/* ================= world settings ================= */
const SLIDERS = [
  ['temperature', 'Average temperature', -20, 50, 1, v => `${v}°C`],
  ['food', 'Food growth', 0, 24, .25, v => `${(+v).toFixed(2)} / tick`],
  ['trees', 'Tree growth', 0, 1.5, .01, v => `${Math.round(v * 1000)} / 1k ticks`],
  ['stone', 'Stone emergence', 0, 1.2, .01, v => `${Math.round(v * 1000)} / 1k ticks`],
  ['drain', 'Metabolic pressure', .3, 3, .1, v => `${(+v).toFixed(1)}×`],
  ['decay', 'Decay speed', 0, 4, .1, v => `${(+v).toFixed(1)}×`],
  ['storm', 'Storm severity', 0, 4, .1, v => `${(+v).toFixed(1)}×`],
  ['day', 'Day length', 100, 1500, 50, v => `${v} ticks`],
  ['season', 'Year length', 0, 6000, 100, v => +v ? `${v} ticks` : 'No seasons'],
];
const SLIDERS2 = [
  ['beasts', 'Beasts roaming', 0, 40, 1, v => +v ? `${v}` : 'None'],
  ['beastPower', 'Beast ferocity', .3, 3, .1, v => `${(+v).toFixed(1)}×`],
  ['popCap', 'Population cap', 40, 600, 10, v => `${v} yips`],
  ['mutation', 'Mutation rate', 0, 4, .1, v => `${(+v).toFixed(1)}×`],
  ['migrateEvery', 'Migration interval', 0, 10000, 500, v => +v ? `every ${v} ticks` : 'Never'],
  ['migrants', 'Migrants per trip', 1, 12, 1, v => `${v} yips`],
];
const ALLS = [...SLIDERS, ...SLIDERS2];
const PRESETS = [
  ['Temperate', 'Balanced defaults', { food: 7.5, trees: .3, stone: .2, drain: 1, decay: 1, storm: 1, temperature: 19, day: 500, season: 2600, beasts: 6, beastPower: 1 }],
  ['Abundance', 'Rich and mild', { food: 13, trees: .5, stone: .35, drain: .8, decay: 1, storm: .5, temperature: 21, day: 500, season: 2600, beasts: 3, beastPower: .8 }],
  ['Scarcity', 'Lean and hungry', { food: 3.5, trees: .17, stone: .12, drain: 1.3, decay: 1.2, storm: 1, temperature: 18, day: 500, season: 2600, beasts: 6, beastPower: 1 }],
  ['Long winter', 'Hoard or starve', { food: 6, trees: .3, stone: .2, drain: 1.1, decay: 1, storm: 1.5, temperature: 4, day: 600, season: 4200, beasts: 6, beastPower: 1.1 }],
  ['Predators', 'Hunted every day', { food: 7.5, trees: .35, stone: .25, drain: 1, decay: 1, storm: .8, temperature: 19, day: 500, season: 2600, beasts: 18, beastPower: 1.4 }],
  ['Tempest', 'Storm season', { food: 8, trees: .35, stone: .25, drain: 1, decay: 1.6, storm: 3, temperature: 15, day: 500, season: 2000, beasts: 6, beastPower: 1 }],
];
function currentSettings() {
  const o = {}; for (const [k] of (typeof ALLS !== 'undefined' ? ALLS : [])) { const el = $(k); if (el) o[k] = +el.value; }
  const r = $('oReseed'), l = $('oLearn'); if (r) o.autoReseed = r.checked; if (l) o.learning = l.checked;
  return o;
}
function paintSlider(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); const s = ALLS.find(x => x[0] === el.id); $(el.id + 'v').textContent = s[5](el.value); }
function buildClimate(settings) {
  for (const [boxId, list] of [['sliders', SLIDERS], ['sliders2', SLIDERS2]]) {
    const box = $(boxId); box.innerHTML = '';
    for (const [key, label, min, max, step] of list) {
      const d = document.createElement('div'); d.className = 'slider';
      d.innerHTML = `<label for="${key}">${label}</label><output id="${key}v"></output><input type="range" id="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}">`;
      box.append(d);
      const el = d.querySelector('input'); paintSlider(el);
      el.addEventListener('input', () => { paintSlider(el); sendAll('settings', { settings: { [key]: +el.value } }); markPreset(); });
    }
  }
  const pb = $('presets'); pb.innerHTML = '';
  PRESETS.forEach(([name, sub, vals]) => {
    const b = document.createElement('button'); b.className = 'preset'; b.innerHTML = `<b>${name}</b><small>${sub}</small>`;
    b.onclick = () => { sendAll('settings', { settings: vals }); syncSliders(vals); toast(`World set to ${name.toLowerCase()}`, 'info'); };
    pb.append(b);
  });
  $('oReseed').checked = settings.autoReseed !== false; $('oLearn').checked = settings.learning !== false;
  markPreset();
}
function syncSliders(s) {
  for (const [key] of ALLS) { const el = $(key); if (el && s[key] != null) { el.value = s[key]; paintSlider(el); } }
  if (s.autoReseed != null) $('oReseed').checked = s.autoReseed; if (s.learning != null) $('oLearn').checked = s.learning; markPreset();
}
function markPreset() { const cur = Object.fromEntries(ALLS.map(([k]) => [k, +$(k).value])); [...$('presets').children].forEach((b, i) => b.classList.toggle('on', Object.entries(PRESETS[i][2]).every(([k, v]) => Math.abs(cur[k] - v) < 1e-6))); }
$('oReseed').onchange = () => sendAll('settings', { settings: { autoReseed: $('oReseed').checked } });
$('oLearn').onchange = () => sendAll('settings', { settings: { learning: $('oLearn').checked } });

/* ================= settings ================= */
const OPTS = { oScent: 'scent', oNight: 'night', oFx: 'fx', oSense: 'sense', oTrail: 'trail', oLegend: 'legend', oPerf: 'perf', oAuto: 'auto', oHidePause: 'hidePause', oWake: 'wake' };
function applyUi() { document.body.classList.toggle('hidelegend', !ui.legend); document.body.classList.toggle('hideperf', !ui.perf); syncWake(); }
for (const [id, key] of Object.entries(OPTS)) { $(id).checked = ui[key]; $(id).onchange = () => { ui[key] = $(id).checked; saveUi(); applyUi(); }; }
// Saves hold every island. They are gzipped and kept in IndexedDB, which has room for long runs.
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => { try { const r = indexedDB.open('alife', 1); r.onupgradeneeded = () => r.result.createObjectStore('saves'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('saves', mode), st = t.objectStore('saves'); const q = fn(st); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
  return { put: (k, v) => tx('readwrite', st => st.put(v, k)), get: k => tx('readonly', st => st.get(k)) };
})();
async function pack(obj) { const txt = JSON.stringify(obj); if (typeof CompressionStream === 'undefined') return new Blob([txt], { type: 'application/json' }); return await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream('gzip'))).blob(); }
async function unpack(blob) { const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer()); if (head[0] === 0x1f && head[1] === 0x8b) return JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()); return JSON.parse(await blob.text()); }
let saveJob = null;
function saveAll(purpose) {
  if (saveJob) return;
  saveJob = { purpose, states: new Array(sims.length), left: sims.length };
  sims.forEach((w, i) => w.postMessage({ type: 'save', purpose }));
}
async function finishSave(job) {
  const bundle = { version: 'islands1', watched, at: Date.now(), islands: job.states };
  const blob = await pack(bundle), kb = Math.round(blob.size / 1024), ticks = job.states.map(s => s.ticks);
  if (job.purpose === 'file') {
    const url = URL.createObjectURL(blob), el = document.createElement('a'); el.href = url; el.download = `alife-${sims.length}-islands-tick-${Math.max(...ticks)}.json${blob.type === 'application/json' ? '' : '.gz'}`; document.body.append(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`Exported ${kb} KB (${sims.length} islands)`, 'info'); return;
  }
  try {
    await idb.put(job.purpose === 'auto' ? 'auto' : 'manual', blob);
    store.set('alife.saveMeta', { at: Date.now(), kb, ticks, islands: sims.length, slot: job.purpose === 'auto' ? 'auto' : 'manual' });
    showSaveInfo();
    if (job.purpose !== 'auto') toast(`Saved ${sims.length} island${sims.length > 1 ? 's' : ''} (${kb} KB)`, 'info');
  } catch { if (job.purpose !== 'auto') toast('Could not save in this browser. Use Download file instead.', 'death'); }
}
function onSaved(m, isl) {
  if (!saveJob) return;
  saveJob.states[isl] = JSON.parse(m.state); saveJob.left--;
  if (!saveJob.left) { const job = saveJob; saveJob = null; finishSave(job); }
}
function loadBundle(obj) {
  const list = obj && obj.version === 'islands1' ? obj.islands : [obj];
  list.slice(0, sims.length).forEach((st, i) => st && sims[i].postMessage({ type: 'load', state: st }));
  if (list.length > sims.length) toast(`This save has ${list.length} islands; ${sims.length} are running, so the rest were skipped`, 'info');
  trail = []; rpos.clear(); bpos.clear();
}
async function loadSlot() {
  const meta2 = store.get('alife.saveMeta', null), slot = (meta2 && meta2.slot) || 'manual';
  try { const blob = await idb.get(slot) || await idb.get(slot === 'auto' ? 'manual' : 'auto'); if (!blob) { toast('No browser save yet', 'info'); return; } loadBundle(await unpack(blob)); }
  catch (e) { toast('Could not read the browser save', 'death'); }
}
/* yip library: genomes kept across runs, stored gzipped in IndexedDB */
let library = [], libWait = null, libArm = 0;
idb.get('library').then(b => b ? unpack(b) : []).then(l => { library = Array.isArray(l) ? l : []; renderLibrary(); }).catch(() => renderLibrary());
const saveLibrary = () => pack(library).then(b => idb.put('library', b)).catch(() => toast('Could not store the library in this browser', 'death'));
function renderLibrary() {
  const on = library.filter(g => g.on !== false).length;
  $('libCount').textContent = library.length ? `${on} of ${library.length} checked` : 'empty';
  $('libList').innerHTML = library.map((g, i) => `<label class="libi"><input type="checkbox" data-i="${i}"${g.on !== false ? ' checked' : ''}><span class="sw2" style="background:hsl(${g.traits.hue} 70% 60%)"></span><div><b>${esc(g.name)}</b> <small>gen ${g.gen} · ${g.kids} kids · ${g.genes.length} genes · island ${'ABCD'[g.island] || '?'} t${fmt(g.tick)}</small></div><button data-del="${i}" aria-label="Remove ${esc(g.name)}">×</button></label>`).join('');
  $('lStart').disabled = !on;
}
$('libList').onchange = e => { const i = e.target.dataset.i; if (i == null) return; library[+i].on = e.target.checked; saveLibrary(); renderLibrary(); };
$('libList').onclick = e => { const i = e.target.dataset.del; if (i == null) return; e.preventDefault(); const g = library.splice(+i, 1)[0]; saveLibrary(); renderLibrary(); toast(`${g.name} removed from the library`, 'info'); };
function addToLibrary(pack) {
  const key = g => g.name + '|' + g.gen + '|' + g.island + '|' + g.clan;
  const have = new Map(library.map((g, i) => [key(g), i])); let added = 0;
  for (const g of pack) { g.on = true; if (have.has(key(g))) library[have.get(key(g))] = g; else { library.push(g); added++; } }
  saveLibrary(); renderLibrary(); return added;
}
function onLibraryPack(m) {
  if (!libWait) return;
  libWait.got.push(...m.pack);
  if (--libWait.left) return;
  const job = libWait; libWait = null;
  if (!job.got.length) { toast(job.one ? 'That yip is gone' : 'No yips old enough to keep yet', 'info'); return; }
  const n = addToLibrary(job.got);
  toast(job.one ? `${job.got[0].name} kept in the library` : `${job.got.length} yips kept (${n} new) · library holds ${library.length}`, 'birth');
}
function askLibrary(targets, msg, one) { if (libWait) return; libWait = { left: targets.length, got: [], one }; targets.forEach(w => w.postMessage({ type: 'library', ...msg })); }
$('lTop').onclick = () => askLibrary([sims[watched]], { n: 10 });
$('lAll').onclick = () => askLibrary(sims, { n: 5 });
$('iKeep').onclick = () => selected && askLibrary([sims[watched]], { id: selected }, true);
$('lStart').onclick = () => {
  const seeds = library.filter(g => g.on !== false); if (!seeds.length) return;
  if (Date.now() - libArm > 4000) { libArm = Date.now(); $('lStart').textContent = `Tap again: replace this run with ${seeds.length} yip${seeds.length > 1 ? 's' : ''}`; setTimeout(() => { $('lStart').textContent = 'New world from library'; }, 4000); return; }
  libArm = 0; $('lStart').textContent = 'New world from library';
  if (ui.auto) saveAll('auto');
  sendAll('reset', { seeds }); trail = []; rpos.clear(); bpos.clear(); setSelected(0);
  toast(`New islands bred from ${seeds.length} library yip${seeds.length > 1 ? 's' : ''}`, 'birth');
};
$('lExport').onclick = async () => { const blob = await pack({ version: 'yiplib1', yips: library }); const url = URL.createObjectURL(blob), el = document.createElement('a'); el.href = url; el.download = `yip-library-${library.length}.json${blob.type === 'application/json' ? '' : '.gz'}`; document.body.append(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); };
$('lImport').onclick = () => $('lFile').click();
$('lFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const o = await unpack(f), list = o.version === 'yiplib1' ? o.yips : Array.isArray(o) ? o : null; if (!list) throw 0; const n = addToLibrary(list); toast(`Imported ${n} new yips`, 'birth'); } catch { toast('That is not a yip library file', 'death'); } e.target.value = ''; };
$('sSave').onclick = () => saveAll('local');
$('sExport').onclick = () => saveAll('file');
$('sLoad').onclick = () => loadSlot();
$('sImport').onclick = () => $('sFile').click();
$('sFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { loadBundle(await unpack(f)); } catch { toast('Could not read that file', 'death'); } e.target.value = ''; };
let newShape = 'wide';
function markShape() { document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', b.dataset.shape === newShape)); }
document.querySelectorAll('[data-shape]').forEach(b => b.onclick = () => { newShape = b.dataset.shape; markShape(); });
$('sReset').onclick = () => { $('modal').hidden = false; $('mOk').focus(); };
$('mCancel').onclick = () => { $('modal').hidden = true; };
$('mOk').onclick = () => { $('modal').hidden = true; sendAll('reset', {}); trail = []; rpos.clear(); bpos.clear(); setSelected(0); toast('New islands: 300 founders each', 'birth'); };
function showSaveInfo() { const m = store.get('alife.saveMeta', null); $('saveInfo').textContent = m && m.ticks ? `Browser save: ${m.islands || 1} island${(m.islands || 1) > 1 ? 's' : ''} at tick ${[].concat(m.ticks).map(fmt).join(' / ')}, ${m.kb} KB, ${new Date(m.at).toLocaleString()}` : ''; }
showSaveInfo();
// embedded viewers block file downloads, so only offer it when the page is opened directly
let embedded = true; try { embedded = window.self !== window.top; } catch {}
if (embedded) { $('sExport').hidden = true; $('lExport').hidden = true; }

/* ================= charts ================= */
function setupCanvas(c) {
  const w = c.clientWidth, h = c.clientHeight; if (!w) return null;
  const d = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
function lineChart(c, series, { min = 0, decimals = 'auto' } = {}) {
  const s = setupCanvas(c); if (!s) return; const { g, w, h } = s;
  const n = series[0].values.length; if (n < 2) { g.fillStyle = C.dim; g.font = '11px "Instrument Sans",sans-serif'; g.fillText('Collecting data…', 4, h / 2); return; }
  let mx = -Infinity; for (const sr of series) for (const v of sr.values) if (v > mx) mx = v;
  const lo = min, hi = niceMax(mx - lo) + lo;
  const L = 34, Rr = 8, T = 8, Bb = 18, pw = w - L - Rr, ph = h - T - Bb;
  const X = i => L + i / (n - 1) * pw, Y = v => T + ph - (v - lo) / (hi - lo) * ph;
  const dec = decimals === 'auto' ? (hi - lo < 4 ? 1 : 0) : decimals;
  g.font = '10px "JetBrains Mono",monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); g.strokeStyle = 'rgba(188,228,212,.08)'; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Math.round(y) + .5); g.lineTo(w - Rr, Math.round(y) + .5); g.stroke(); g.fillStyle = C.dim; g.fillText(v.toFixed(dec), L - 6, y); }
  const hist = stats.history; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(`t ${fmt(hist[0].t)}`, L, h - 4); g.textAlign = 'right'; g.fillText(`t ${fmt(hist[hist.length - 1].t)}`, w - Rr, h - 4);
  series.forEach((sr, si) => {
    const path = () => { g.beginPath(); sr.values.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); };
    path();
    if (si === 0 && sr.area !== false) { g.save(); g.lineTo(X(n - 1), Y(lo)); g.lineTo(X(0), Y(lo)); g.closePath(); const gr = g.createLinearGradient(0, T, 0, T + ph); gr.addColorStop(0, sr.color + '40'); gr.addColorStop(1, sr.color + '00'); g.fillStyle = gr; g.fill(); g.restore(); path(); }
    g.strokeStyle = sr.color; g.lineWidth = si === 0 ? 1.8 : 1.4; g.lineJoin = 'round'; g.stroke();
    const lv = sr.values[n - 1]; g.fillStyle = sr.color; g.beginPath(); g.arc(X(n - 1), Y(lv), 3, 0, TAU); g.fill();
  });
}
// smooth noisy per-interval counts with a short moving average
const smooth = (a, k = 4) => a.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= i; j++) { s += a[j]; n++; } return s / n; });

/* ================= stats drawer ================= */
const DEATHC = { disease: '#98a64c', thirst: '#6fb6e8', drowning: '#3f7fb5', age: C.muted, hunger: C.warn, storm: C.storm, fire: C.fire, beast: C.beast, attack: '#b04a8a' };
const DEATHL = { disease: 'Disease', thirst: 'Thirst', drowning: 'Drowning', age: 'Old age', hunger: 'Starvation', storm: 'Storms', fire: 'Burns', beast: 'Beasts', attack: 'Killed by yips' };
const LEDC = { reserve: '#3d4a5c', soil: '#7a5a3a', plants: '#8fd67a', meat: '#b8574a', beasts: '#e05a4e', yips: '#f3c96b', built: '#c9b3e6' };
const LEDL = { reserve: 'Wild reserve', soil: 'Soil', plants: 'Plants', meat: 'Carcasses', beasts: 'Beasts', yips: 'Yips', built: 'Structures' };
const CTXL = { beast: 'a beast in sight', food: 'food nearby', hungry: 'hungry', hurt: 'hurt', kin: 'kin nearest', stranger: 'a stranger nearest', mate: 'ready to mate', fight: 'fighting', alone: 'alone', young: 'carrying young', sick: 'sick' };
const meansText = m => m && m.length ? m.map(([k, lift]) => `${CTXL[k] || k} ×${lift}`).join(', ') : '';
function renderLang(s) {
  const L = s.lang; if (!L) return;
  const smax = Math.max(1, ...L.symbols.map(x => x.n));
  $('langSyms').innerHTML = L.symbols.map(x => `<div class="lsym" title="${x.n} uses"><b class="sym">${x.s}</b><i style="height:${Math.max(2, x.n / smax * 26)}px"></i><small>${fmt(x.n)}</small>${x.means.length ? `<em>${esc(CTXL[x.means[0][0]] || x.means[0][0])}</em>` : ''}</div>`).join('');
  $('langWords').innerHTML = L.words.length ? L.words.map(w => `<div class="lword"><b class="sym">${w.shout > .5 ? '! ' : ''}${w.w}</b><span>${fmt(w.n)} × · ${w.speakers} speaker${w.speakers === 1 ? '' : 's'}${w.shout > .05 && w.shout <= .5 ? ` · ${Math.round(w.shout * 100)}% shouted` : ''}</span><em>${meansText(w.means) || 'no clear pattern yet'}</em></div>`).join('') : '<p class="note">Nobody has said anything yet.</p>';
  $('langNote').textContent = `${fmt(L.vocab)} distinct words in use. Meanings are inferred: a word is listed with situations it is used in far more often than chance (×2 = twice as often).`;
}
function renderLedger(s) {
  const L = s.ledger; if (!L) return;
  const keys = ['yips', 'plants', 'meat', 'beasts', 'built', 'soil', 'reserve'], tot = L.total || keys.reduce((x, k) => x + (L[k] || 0), 0) || 1;
  $('ledStack').innerHTML = keys.map(k => `<i style="width:${(L[k] || 0) / tot * 100}%;background:${LEDC[k]}"></i>`).join('');
  $('ledKey').innerHTML = keys.map(k => `<span><i style="background:${LEDC[k]}"></i>${LEDL[k]} <b class="num">${((L[k] || 0) / tot * 100).toFixed(1)}%</b></span>`).join('');
  $('ledNote').textContent = `${fmt(tot)} energy in this world, fixed. It moves between these and is never made or destroyed${Math.abs(L.drift || 0) > 1 ? ` (last check corrected ${fmt(Math.abs(L.drift))} of rounding)` : ''}.`;
  const b = s.bodies || {}, n = Math.max(1, s.pop);
  $('bodyMix').innerHTML = [['Carry and sire', b.both], ['Carry only', b.carry], ['Sire only', b.sire], ['Neither', b.neither], ['Carrying young', b.preg], ['Sick', b.sick]].map(([k, v]) => `<div><span>${k}</span><b>${v || 0}${k === 'Sick' || k === 'Carrying young' ? '' : ` · ${Math.round((v || 0) / n * 100)}%`}</b></div>`).join('') +
    `<div><span>Avg fat / mass</span><b>${fmt(s.avgFat || 0)} / ${(s.avgMass || 0).toFixed(2)}</b></div><div><span>Avg burn per tick</span><b>${(s.avgBurn || 0).toFixed(3)}</b></div><div><span>Gardens / carcasses</span><b>${s.gardens || 0} / ${s.carcasses || 0}</b></div>`;
}
function renderStats() {
  if (!stats) return;
  updateHud();
  if (!$('dStats').classList.contains('open')) return;
  const s = stats, ta = s.tally;
  renderLedger(s); renderLang(s);
  $('fPop').textContent = s.pop; $('fPeak').textContent = s.peakPop;
  $('fGen').innerHTML = `${s.maxGen}<em> avg ${s.avgGen.toFixed(1)}</em>`;
  $('fBD').innerHTML = `${fmt(s.births)}<em> / ${fmt(s.deaths)}</em>`;
  const bt = s.byType; $('fBuilt').textContent = bt.house + bt.store + bt.wall + bt.fire;
  $('fBuiltSub').textContent = `${bt.house} houses · ${bt.store} stores · ${bt.wall} walls · ${bt.fire} fires`;
  $('statsSub').textContent = `Tick ${fmt(s.ticks)} · ${s.counts[0]} food · ${s.counts[1]} trees · ${s.counts[2]} stone · ${s.beasts} beasts`;
  const h = s.history || [];
  if (h.length) $('hSpan').textContent = `last ${fmt(h[h.length - 1].t - h[0].t)} ticks`;
  const per100 = k => smooth(h.map((x, i) => i ? (x[k] || 0) * 100 / Math.max(1, x.t - h[i - 1].t) : 0));
  lineChart($('cPop'), [{ values: h.map(x => x.pop), color: C.good }, { values: h.map(x => x.build), color: C.house }, { values: h.map(x => (x.beasts || 0) * 10), color: C.beast }]);
  lineChart($('cBeh'), [{ values: per100('shares'), color: C.good }, { values: per100('thefts'), color: C.bad }, { values: per100('attacks').map(v => v / 10), color: C.beast + '99' }, { values: per100('hunts'), color: C.warn }, { values: per100('crafts'), color: C.wall }, { values: per100('affection'), color: '#ff8fc8' }, { values: per100('words').map(v => v / 5), color: C.accent }]);
  lineChart($('cSocial'), [{ values: h.map(x => x.rep || 0), color: '#ff8fc8' }, { values: h.map(x => (x.lonely || 0) * 5), color: '#9cb6ff' }], { decimals: 1 });
  $('behFigs').innerHTML = [['Gifts given', ta.shares], ['Food stolen', ta.thefts], ['Affection shown', ta.affection || 0], ['Words spoken', ta.words || 0], ['Shouts', ta.shouts || 0], ['Conceptions', ta.conceptions || 0], ['Births', ta.pairings], ['Miscarriages', ta.miscarriages || 0], ['Befriendings', ta.befriends], ['Beasts slain', ta.beastKills], ['Tools made', ta.crafts], ['Holding tools', Math.round(s.tools / Math.max(1, s.pop) * 100) + '%']]
    .map(([k, v]) => `<div class="fig"><b>${typeof v === 'number' ? fmt(v) : v}</b><small>${k}</small></div>`).join('');
  lineChart($('cGen'), [{ values: h.map(x => x.gen), color: C.accent }]);
  lineChart($('cBody'), [{ values: h.map(x => x.str), color: C.bad, area: false }, { values: h.map(x => x.spd), color: C.store }, { values: h.map(x => x.sense / 100), color: C.wall }, { values: h.map(x => x.agg || 0), color: C.beast }, { values: h.map(x => (x.neurons || 0) / 50), color: C.accent }], { decimals: 1 });
  if (s.geneUse) $('perkBars').innerHTML = s.geneUse.length ? s.geneUse.map(g => `<div class="generow"><div class="bar"><div class="bt"><i style="width:${g.share * 100}%"></i><span>${esc(g.name)} · ${CONDL[g.cond] || g.cond}</span></div><b>${Math.round(g.share * 100)}%</b></div><p>${fxText(g.fx)}</p></div>`).join('') : '<p class="note">No genes in the population yet.</p>';
  $('mentAvg').innerHTML = traitRows(meta.ment, s.traits, null);
  // who each social act is aimed at
  const RELC = ['#7ed6b0', '#f3c96b', '#93a8a0', '#f2836f'], RELN = { attack: 'Attacks', share: 'Gifts', thank: 'Affection', befriend: 'Befriends' };
  if (s.relTally) $('relBars').innerHTML = ['attack', 'share', 'thank', 'befriend'].map(k => { const v = s.relTally[k], sm = v.reduce((x, y) => x + y, 0) || 1; return `<div class="relrow"><span>${RELN[k]}</span><div class="stack">${v.map((x, i) => `<i style="width:${x / sm * 100}%;background:${RELC[i]}"></i>`).join('')}</div><b>${fmt(v.reduce((x, y) => x + y, 0))}</b></div>`; }).join('');
  const relSeries = k => smooth(h.map(x => x.rel && x.rel[k] ? (x.rel[k][0] + x.rel[k][1]) * 100 : null).map((v, i, arr) => v ?? (i ? arr[i - 1] ?? 0 : 0)), 8);
  lineChart($('cRel'), [{ values: relSeries('attack'), color: C.bad, area: false }, { values: relSeries('thank'), color: C.good }, { values: relSeries('share'), color: C.wall }], { decimals: 0 });
  if (s.families) $('fams').innerHTML = s.families.map(f => { const top = f.mix.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).filter(([, i]) => i > 3).slice(0, 3).map(([v, i]) => `${meta.short[i]} ${(v * 100).toFixed(0)}%`).join(' · '); return `<div class="fam"><i style="background:${hueFill[(f.hue | 0) % 360]}"></i><b>${esc(f.clan)}'s line</b><span class="num">${f.n} alive · gen ${f.gen}</span><small>Attack ${(f.mix[14] * 100).toFixed(1)}% · Share ${(f.mix[13] * 100).toFixed(1)}% · Thank ${(f.mix[19] * 100).toFixed(1)}% · most of all: ${top}</small></div>`; }).join('');
  const tot = Object.values(s.deathsBy).reduce((a, b) => a + b, 0) || 1;
  $('deathStack').innerHTML = Object.entries(s.deathsBy).map(([k, v]) => `<i style="width:${v / tot * 100}%;background:${DEATHC[k] || C.dim}"></i>`).join('');
  $('deathKey').innerHTML = Object.entries(s.deathsBy).map(([k, v]) => `<span><i style="background:${DEATHC[k] || C.dim}"></i>${DEATHL[k] || k} <b class="num">${Math.round(v / tot * 100)}%</b></span>`).join('');
  $('sensBars').innerHTML = s.sensUse.filter(([k]) => k !== 'bias').slice(0, 12).map(([k, v]) => `<div class="bar"><div class="bt"><i style="width:${v * 100}%"></i><span>${esc(meta.senses[k] || k)}</span></div><b>${Math.round(v * 100)}%</b></div>`).join('');
  const mxA = Math.max(...s.actMix, 1e-9);
  $('actBars').innerHTML = s.actMix.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([v, i]) => `<div class="bar${v === mxA ? ' hl' : ''}"><div class="bt"><i style="width:${v / mxA * 100}%"></i><span>${meta.actions[i]}</span></div><b>${(v * 100).toFixed(1)}%</b></div>`).join('');
  $('elite').innerHTML = s.eliteTop.length ? s.eliteTop.map(e => `<span class="chip dead" title="Score ${e.score}"><i style="background:hsl(${e.hue | 0} 72% 66%)"></i>${esc(e.name)} · gen ${e.gen}</span>`).join('') : '<span class="note">Filled as yips die.</span>';
  $('log').innerHTML = s.events.slice(0, 30).map(e => `<div><time>${fmt(e.t)}</time><i style="background:${KCOL[e.kind] || C.muted}"></i><span>${esc(e.s)}</span></div>`).join('');
}

/* ================= inspector ================= */
let pane = 'pMind'; const lastName = {};
document.querySelectorAll('[data-pane]').forEach(b => b.onclick = () => { pane = b.dataset.pane; document.querySelectorAll('[data-pane]').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== pane); renderInspector(); });
const DIGITS = { lr: 4, sense: 0, hearing: 0 };
function traitRows(keys, vals, avg) {
  return keys.map(k => {
    const [label, info] = meta.traitInfo[k], [lo, hi] = meta.bounds[k], v = vals[k] ?? 0, d = DIGITS[k] ?? 2;
    const f = clamp((v - lo) / (hi - lo), 0, 1), a = avg && avg[k] != null ? clamp((avg[k] - lo) / (hi - lo), 0, 1) : null;
    return `<div class="trait"><span title="${esc(info)}">${label}</span><div class="tr"><i style="width:${f * 100}%"></i>${a != null ? `<u style="left:${a * 100}%"></u>` : ''}</div><b>${v.toFixed(d)}</b></div>`;
  }).join('');
}
// describe a gene by what it does to the body, using the simulation's own dial definitions
function fxText(fx) {
  return Object.entries(fx).map(([d, v]) => { const D = meta.dials[d]; if (!D) return ''; const good = v * D.good > 0, val = D.kind === 'mul' ? `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%` : `${v > 0 ? '+' : '−'}${Math.abs(v) < 1 ? Math.abs(v).toFixed(3) : Math.abs(v).toFixed(0)}`; return `<span class="${good ? 'g' : 'x'}">${val} ${D.label}</span>`; }).filter(Boolean).join(' · ');
}
const CONDL = { always: 'always', cold: 'when cold', hot: 'when hot', night: 'at night', day: 'by day', young: 'while young', old: 'when old', starving: 'when starving', fed: 'when well fed', swimming: 'while swimming', hurt: 'when badly hurt' };
function renderGenes(genes) {
  $('geneList').innerHTML = genes.length ? genes.map(g => `<div class="gene${g.on ? ' on' : ''}"><div><b>${esc(g.name)}</b><span class="badge${g.cond === 'always' ? '' : g.on ? ' good' : ''}">${CONDL[g.cond] || g.cond}${g.cond !== 'always' ? (g.on ? ' · on' : ' · off') : ''}</span><em class="num">${(g.cost * 1000).toFixed(1)} mE/tick</em></div><p>${fxText(g.fx)}</p></div>`).join('') : '<p class="note">No genes: this yip runs on its base traits alone.</p>';
}
function renderInspector() {
  const m = insp; if (!m || !$('dInspect').classList.contains('open')) return;
  const dead = m.none && m.id === selected;
  $('iBody').hidden = dead; $('iEmpty').hidden = !dead;
  if (dead) {
    const g = m.grave, nm = (g && g.name) || lastName[m.id] || `Yip #${m.id}`;
    const CAUSE = { disease: 'of disease', age: 'of old age', hunger: 'of starvation', thirst: 'of thirst', drowning: 'by drowning', storm: 'in a storm', fire: 'in a fire', beast: 'to a beast', attack: 'at the hands of another yip' };
    $('iTitle').textContent = nm; $('iSub').textContent = g ? `Died ${CAUSE[g.cause] || ''} at age ${fmt(g.age)} · generation ${g.gen} · ${g.kids} offspring` : 'No longer alive'; $('iBadges').innerHTML = '<span class="badge bad">Dead</span>';
    $('iEmptyTitle').textContent = `${nm} has died`; return;
  }
  lastName[m.id] = m.name;
  if (m.none || m.id !== selected) return;
  const hue = m.traits.hue | 0;
  $('iSwatch').style.background = hueFill[hue]; $('iSwatch').style.setProperty('--hue', `hsl(${hue} 72% 66% / .5)`);
  $('iTitle').textContent = m.name || `Yip #${m.id}`;
  $('iSub').textContent = `#${m.id} · ${m.clan ? esc(m.clan) + "'s line · " : ''}generation ${m.gen} · age ${fmt(m.age)} · ${m.kids} offspring`;
  const badges = [];
  badges.push(m.sheltered ? ['Sheltered', 'good'] : ['Exposed', '']);
  if (m.tool > 0) badges.push([`Tool ${m.tool}`, 'good']);
  if (m.energy < 30) badges.push(['Starving', 'bad']); else if (m.energy > 135) badges.push(['Ready to breed', 'good']);
  if (m.health < 40) badges.push(['Injured', 'bad']);
  if (m.pain > .3) badges.push(['Under attack', 'bad']);
  if (m.rep > 3) badges.push(['Popular', 'good']);
  if (m.inWater) badges.push(['Swimming', '']);
  if (m.drv.thirst > .7) badges.push(['Parched', 'bad']);
  if (m.temp < 10) badges.push([`Cold ${m.temp.toFixed(0)}°`, 'warn']); else if (m.temp > 31) badges.push([`Hot ${m.temp.toFixed(0)}°`, 'warn']);
  $('iBadges').innerHTML = badges.map(([t, c]) => `<span class="badge ${c}">${t}</span>`).join('');
  meter('E', m.energy, (m.ph && m.ph.maxE) || 200, m.energy.toFixed(0)); meter('H', m.health, (m.ph && m.ph.maxH) || 100, m.health.toFixed(0));
  meter('A', m.age, m.lifespan, Math.round(m.age / m.lifespan * 100) + '%'); meter('L', m.load, m.cap, `${m.load.toFixed(1)}/${m.cap.toFixed(1)}`);
  const DL = { urge: ['Urge to breed', '#ff8fc8'], grief: ['Grief', '#b9a6d6'], thirst: ['Thirst', '#6fb6e8'], hunger: ['Hunger', C.warn], cold: ['Cold / heat', '#9cc6ff'], injury: ['Injury', C.bad], fatigue: ['Fatigue', C.muted], lonely: ['Loneliness', '#c9b3e6'], insecure: ['Insecurity', C.tree] };
  $('driveBars').innerHTML = meta.drives.map(k => { const v = m.drv[k] || 0; return `<div class="drive"><div>${DL[k][0]}<b>${Math.round(v * 100)}</b></div><div class="meter"><i style="width:${v * 100}%;background:${DL[k][1]}"></i></div></div>`; }).join('');
  if (pane === 'pMind') { drawBrain(m); probBars(m); }
  else if (pane === 'pBody') bodyPane(m);
  else if (pane === 'pSocial') socialPane(m);
  else if (pane === 'pTime') timePane(m);
  else linePane(m);
}
function timePane(m) {
  const tl = m.timeline || [];
  $('timeline').innerHTML = tl.length ? tl.map(([t, c, id, nm, tv]) => `<div class="tl"><time>${fmt(t)}</time><span><b>${meta.actions[c]}</b>${id ? ` → ${esc(nm)}` : ''}</span>${id ? `<span class="tv ${tv > .05 ? 'p' : tv < -.05 ? 'n' : 'z'}">${tv > 0 ? '+' : ''}${tv.toFixed(2)}</span>` : '<span></span>'}</div>`).join('') : '<p class="note">Nothing yet. Successful actions other than walking appear here.</p>';
}
function meter(k, v, max, label) { $('v' + k).textContent = label; $('m' + k).style.width = clamp(v / max * 100, 0, 100) + '%'; }
function probBars(m) {
  const order = m.probs.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).slice(0, 6), mx = order[0][0];
  $('probBars').innerHTML = order.map(([p, i]) => `<div class="bar${i === m.lastChoice ? ' hl' : ''}"><div class="bt"><i style="width:${p / mx * 100}%"></i><span>${meta.actions[i]}${i === m.lastChoice ? ' · chosen' : ''}</span></div><b>${(p * 100).toFixed(1)}%</b></div>`).join('');
  $('iLayers').textContent = m.sizes.join(' → ');
  $('contKV').innerHTML = [['Voice', m.signal], ['Memory A', m.memA], ['Memory B', m.memB], ['Scent laid', m.acts[m.acts.length - 1][meta.short.length + 3] || 0]].map(([k, v]) => `<div><span>${k}</span><b>${v >= 0 ? '+' : ''}${v.toFixed(2)}</b></div>`).join('');
}
function bodyPane(m) {
  const avg = stats ? stats.traits : null;
  $('physList').innerHTML = traitRows(meta.phys, m.traits, avg);
  $('mentList').innerHTML = traitRows(meta.ment, m.traits, avg);
  const bd = m.body || {}, up = bd.upkeep || {}, ph0 = m.ph || {};
  const UPL = { base: 'Resting body (mass)', brain: 'Brain', eyes: 'Eyes', ears: 'Ears', nose: 'Nose', immune: 'Immune system', healing: 'Healing', insulation: 'Insulation', repro: 'Reproductive organs', genes: 'Genes switched on' };
  const ups = Object.entries(up).sort((x, y) => y[1] - x[1]), umax = Math.max(.0001, ...ups.map(u => u[1])), tot = ups.reduce((s0, u) => s0 + u[1], 0);
  const sex = ph0.womb > .05 && ph0.seed > .05 ? 'Can carry and sire young' : ph0.womb > .05 ? 'Can only carry young' : ph0.seed > .05 ? 'Can only sire young' : 'Cannot reproduce';
  $('budgetBar').innerHTML = `<div class="row2"><span>Energy held</span><b>${fmt(m.energy)} usable · ${fmt(bd.gut)} in stomach · ${fmt(bd.fat)} fat · ${fmt(bd.body)} body</b></div>
    <div class="row2"><span>Burns per tick</span><b>${(bd.burn || 0).toFixed(3)} (at rest ${tot.toFixed(3)})</b></div>
    <div class="bars">${ups.map(([k, v]) => `<div class="bar"><div class="bt"><i style="width:${v / umax * 100}%"></i><span>${UPL[k] || k}</span></div><b>${(v * 1000).toFixed(1)}</b></div>`).join('')}</div>
    <span>Upkeep in thousandths of energy per tick, before movement, work, fighting, temperature and illness. Metabolism is just the sum.</span>
    <div class="row2"><span>Body</span><b>mass ${(bd.mass || 0).toFixed(2)} · muscle ${Math.round((bd.muscle || 0) * 100)}% · strength ${(bd.str || 0).toFixed(2)}</b></div>
    <div class="row2"><span>Reproduction</span><b>${sex}${bd.preg ? ` · carrying young ${Math.round(bd.preg.e / bd.preg.need * 100)}%` : ''}</b></div>
    ${bd.inbred ? `<div class="row2"><span>Inbred</span><b style="color:var(--warn)">${Math.round(bd.inbred * 100)}% related parents · ${bd.defects} defect gene${bd.defects === 1 ? '' : 's'}</b></div>` : bd.defects ? `<div class="row2"><span>Inherited defects</span><b style="color:var(--warn)">${bd.defects} gene${bd.defects === 1 ? '' : 's'}</b></div>` : ''}
    ${bd.frail < .99 ? `<div class="row2"><span>Age</span><b>frail: can hold ${Math.round(bd.frail * 100)}% of full health</b></div>` : ''}
    ${bd.sick > .02 ? `<div class="row2"><span>Illness</span><b style="color:var(--bad)">sick ${Math.round(bd.sick * 100)}%</b></div>` : ''}`;
  renderGenes(m.genes || []);
  const d = m.deeds;
  $('deedKV').innerHTML = [['Gifts given', d.shared], ['Food stolen', d.stolen], ['Attacks', d.attacks], ['Yips killed', d.kills], ['Beast hits', d.hunts], ['Beasts slain', d.beastKills], ['Tools made', d.crafts], ['Items stored', d.deposits], ['Built', d.builds], ['Harvested', m.success]]
    .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  const ph = m.ph || {};
  const kv = [['Wellbeing', m.wellbeing.toFixed(2)], ['Avg reward', (m.rewardAvg >= 0 ? '+' : '') + m.rewardAvg.toFixed(3)], ['Food carried', m.inv.food], ['Meat carried', m.inv.meat ? `${m.inv.meat}${m.inv.mR ? ` (${m.inv.mR} rotten)` : ''}` : 0], ['Seeds', m.inv.seeds || 0], ['Wood / stone', `${m.inv.wood} / ${m.inv.stone}`], ['Tool uses left', m.tool], ['Stomach', `${fmt((m.body || {}).gut || 0)} / ${fmt((m.body || {}).gutCap || 0)}`], ['Digestion', `${Math.round(Math.min(95, 85 * (ph.food || 1)))}% kept`], ['Comfort range', `${ph.coldT}–${ph.hotT}°C`], ['Felt temp.', m.temp.toFixed(1) + '°C'], ['Max energy / health', `${ph.maxE} / ${ph.maxH}`], ['Lifespan', fmt(m.lifespan)], ['Last act', meta.short[m.lastChoice]]];
  $('bodyKV').innerHTML = kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
function socialPane(m) {
  $('socialKV').innerHTML = [['Popularity', m.rep.toFixed(2)], ['Admirers', m.admirers], ['Affection received', m.affectionGot || 0], ['Saying', m.speaking ? `<span class="sym">${esc(m.speaking)}</span>` : '—'], ['Hears', m.heardNow ? `<span class="sym">${esc(m.heardNow)}</span>` : '—'], ['Recently said', m.said && m.said.length ? `<span class="sym">${m.said.slice(0, 5).map(x => esc(x[1])).join(' · ')}</span>` : 'nothing'], ['Children had', m.partners], ['Co-parent', m.coparent ? `${esc(m.coparentName || '#' + m.coparent)}${m.coparentAlive ? '' : ' (gone)'}` : 'none'], ['Owes thanks to', m.owed && m.owed.length ? m.owed.filter(o => o[1] > .05).slice(0, 3).map(o => esc(o[0])).join(', ') || 'nobody' : 'nobody']].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('trustedBy').innerHTML = m.trustedBy.length ? m.trustedBy.map(t => `<button class="chip" data-goto="${t.id}"><i style="background:${hueFill[t.hue | 0]}"></i>${esc(t.name || '#' + t.id)} · ${t.v.toFixed(2)}</button>`).join('') : '<p class="note">Nobody yet. Trust is earned slowly by sharing food or materials, warmth, shelter, repairs and defending others from beasts, and lost fast by attacks and theft.</p>';
  $('trustBars').innerHTML = m.trust.length ? m.trust.map(t => {
    const w = Math.abs(t.v) * 50, left = t.v < 0 ? 50 - w : 50;
    return `<div class="bar"><div class="bt" style="cursor:${t.alive ? 'pointer' : 'default'}" ${t.alive ? `data-goto="${t.id}"` : ''}><i style="left:${left}%;width:${w}%;background:${t.v < 0 ? 'rgba(242,131,111,.4)' : 'rgba(126,214,176,.35)'}"></i><span style="${t.alive ? '' : 'color:var(--dim)'}">${esc(t.name || '#' + t.id)}${t.alive ? '' : ' · gone'}</span></div><b>${t.v > 0 ? '+' : ''}${t.v.toFixed(2)}</b></div>`;
  }).join('') : '<p class="note">No relationships yet. Trust rises when food is shared and falls after attacks or theft.</p>';
  $('kidChips').innerHTML = m.livingKids.length ? m.livingKids.map(k => `<button class="chip" data-goto="${k.id}"><i style="background:${hueFill[k.hue | 0]}"></i>${esc(k.name || '#' + k.id)}</button>`).join('') : '<p class="note">None alive right now.</p>';
}
function linePane(m) {
  const rows = [`<div><i class="nd" style="background:${hueFill[m.traits.hue | 0]};box-shadow:0 0 0 2px var(--accent)"></i><span>${esc(m.name || '#' + m.id)} <b>this yip</b></span><small>gen ${m.gen}</small></div>`]
    .concat(m.lineage.map(l => l.alive ? `<button data-goto="${l.id}"><i class="nd" style="background:${hueFill[(l.hue | 0) % 360]}"></i><span>${esc(l.name || '#' + l.id)} · alive</span><small>gen ${l.gen}</small></button>` : `<div><i class="nd" style="background:${l.hue ? hueFill[(l.hue | 0) % 360] : C.dim};opacity:.4"></i><span style="color:var(--muted)">${esc(l.name || '#' + l.id)}</span><small>gen ${l.gen}</small></div>`));
  if (!m.lineage.length) rows.push('<p class="note">A founder: no recorded ancestors.</p>');
  $('chain').innerHTML = rows.join('');
}
$('dInspect').addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) setSelected(+g.dataset.goto); });

/* brain canvas */
let brainNodes = [], brainHover = null;
function drawBrain(m) {
  const c = $('brain'), s = setupCanvas(c); if (!s) return; const { g, w, h } = s;
  const L = m.sizes.length, padL = 78, padR = 62, padT = 22, padB = 10;
  const xs = m.sizes.map((_, l) => padL + l * (w - padL - padR) / (L - 1));
  const pos = m.sizes.map((n, l) => Array.from({ length: n }, (_, i) => ({ x: xs[l], y: n === 1 ? (padT + h - padB) / 2 : padT + i * (h - padT - padB) / (n - 1) })));
  brainNodes = [];
  const hv = brainHover, thr = m.ws.reduce((s, x) => s + x.length, 0) > 900 ? .3 : .15;
  for (let l = 0; l < m.ws.length; l++) {
    const wl = m.ws[l], cols = m.sizes[l], rows = m.sizes[l + 1];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const v = wl[j * cols + i]; if (Math.abs(v) < thr) continue;
      const lit = hv && ((hv.l === l && hv.j === i) || (hv.l === l + 1 && hv.j === j));
      const a = clamp(Math.abs(v) / 2.4, .05, .7) * (hv ? (lit ? 1.4 : .2) : 1);
      g.strokeStyle = v > 0 ? `rgba(126,214,176,${a})` : `rgba(242,131,111,${a})`; g.lineWidth = .4 + Math.abs(v) * .5;
      const p = pos[l][i], q = pos[l + 1][j]; g.beginPath(); g.moveTo(p.x, p.y); g.bezierCurveTo((p.x + q.x) / 2, p.y, (p.x + q.x) / 2, q.y, q.x, q.y); g.stroke();
    }
  }
  const O = meta.short.length, fs = Math.max(8, Math.min(10, (h - padT) / Math.max(...m.sizes) * .9));
  g.textBaseline = 'middle';
  for (let l = 0; l < L; l++) {
    g.font = `${fs}px "JetBrains Mono",monospace`;
    for (let j = 0; j < m.sizes[l]; j++) {
      const p = pos[l][j], v = m.acts[l][j] || 0, out = l === L - 1, disc = out && j < O, chosen = disc && j === m.lastChoice;
      const r = disc ? 2.5 + m.probs[j] * 9 : 3 + Math.abs(v) * 2.2;
      g.beginPath(); g.arc(p.x, p.y, r, 0, TAU);
      g.fillStyle = disc ? (chosen ? C.accent : `rgba(231,239,233,${.25 + m.probs[j] * 2})`) : out ? 'rgba(201,179,230,.85)' : v >= 0 ? `rgba(126,214,176,${.35 + Math.abs(v) * .65})` : `rgba(242,131,111,${.35 + Math.abs(v) * .65})`;
      g.fill(); if (chosen) { g.strokeStyle = C.accent; g.lineWidth = 1.2; g.beginPath(); g.arc(p.x, p.y, r + 3, 0, TAU); g.stroke(); }
      if (l === 0) { g.textAlign = 'right'; g.fillStyle = C.muted; g.fillText(m.inputs[j], p.x - 8, p.y); }
      if (out) { g.textAlign = 'left'; g.fillStyle = chosen ? C.accent : disc ? C.muted : C.wall; g.fillText(disc ? meta.short[j] : meta.cont[j - O], p.x + 10, p.y); }
      brainNodes.push({ x: p.x, y: p.y, l, j, v });
    }
    g.textAlign = 'center'; g.fillStyle = C.dim; g.font = '600 9px "Instrument Sans",sans-serif';
    g.fillText(l === 0 ? 'SENSES' : l === L - 1 ? 'OUTPUTS' : `H${l}`, xs[l], 9);
  }
}
function brainPoint(e) {
  const r = $('brain').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const n = brainNodes.find(n => Math.hypot(n.x - x, n.y - y) < (e.pointerType === 'mouse' ? 8 : 14));
  brainHover = n ? { l: n.l, j: n.j } : null;
  if (!insp || insp.none) return;
  if (n) {
    const m = insp, L = m.sizes.length, O = meta.short.length;
    const label = n.l === 0 ? `${m.inputs[n.j]} · ${meta.senses[m.inputs[n.j]] || ''}` : n.l === L - 1 ? (n.j < O ? `${meta.actions[n.j]} · ${(m.probs[n.j] * 100).toFixed(1)}% chance` : `${meta.cont[n.j - O]} (continuous output)`) : `Hidden layer ${n.l}, neuron ${n.j + 1}`;
    let links = 0; if (n.l) { const cols = m.sizes[n.l - 1]; for (let i = 0; i < cols; i++) if (Math.abs(m.ws[n.l - 1][n.j * cols + i]) > .15) links++; }
    $('brainInfo').innerHTML = `<b>${esc(label)}</b> · activation ${n.v.toFixed(3)}${n.l ? ` · ${links} strong inputs` : ''}`;
  } else $('brainInfo').textContent = 'Hover or tap a neuron to read it. Teal links excite, coral links inhibit.';
  drawBrain(insp);
}
$('brain').addEventListener('pointermove', brainPoint);
$('brain').addEventListener('pointerdown', brainPoint);
$('brain').addEventListener('pointerleave', e => { if (e.pointerType !== 'mouse') return; brainHover = null; if (insp && !insp.none) drawBrain(insp); });
addEventListener('resize', () => { if (insp && !insp.none && pane === 'pMind') drawBrain(insp); renderStats(); });

/* ================= touch & quality of life ================= */
// swipe a bottom sheet down by its header to close it
document.querySelectorAll('.drawer .dh').forEach(h => {
  let y0 = null, id = null;
  h.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || e.target.closest('button')) return; y0 = e.clientY; id = e.pointerId; h.setPointerCapture(id); });
  h.addEventListener('pointermove', e => { if (y0 == null || e.pointerId !== id) return; if (getComputedStyle(h.parentElement).borderTopLeftRadius !== '16px') return; h.parentElement.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; h.parentElement.style.transition = 'none'; });
  const end = e => { if (y0 == null) return; const dy = e.clientY - y0, d = h.parentElement; d.style.transform = ''; d.style.transition = ''; y0 = null; if (dy > 70) closeDrawer(d.id); };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
});
// keep the screen awake while the colony runs (phones), released when paused
let wake = null;
async function syncWake() {
  try {
    const want = ui.wake && running && document.visibilityState === 'visible';
    if (want && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!want && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}
addEventListener('pointerdown', syncWake, { once: true });
let hiddenPaused = false;
document.addEventListener('visibilitychange', () => {
  if (REMOTE) { syncIslands(); if (document.visibilityState !== 'hidden') { frameQ = []; lastSched = 0; } syncWake(); return; }
  if (hostState !== 'off') { syncWake(); return; }   // a host keeps running for its viewers
  if (document.visibilityState === 'hidden') { if (ui.hidePause && running) { hiddenPaused = true; running = false; sendAll('play', { running: false }); paintPlay(); } if (ui.auto) saveAll('auto'); }
  else if (hiddenPaused) { hiddenPaused = false; setRunning(true); }
  syncWake();
});
setInterval(() => { if (!REMOTE && ui.auto && running && (pulses[watched] || {}).ticks > 200) saveAll('auto'); }, 120000);
document.querySelectorAll('[name=netBuf]').forEach(r => { r.checked = r.value === ui.netBuf; r.onchange = () => { if (r.checked) { ui.netBuf = r.value; saveUi(); } }; });
$('netFps').value = ui.netFps; $('netFps').onchange = () => { ui.netFps = +$('netFps').value; saveUi(); remoteSend({ cmd: 'rate', fps: ui.netFps }); };
$('netSec').hidden = !REMOTE; if (REMOTE) { updateNetNote(); connect(); }
$('netLeave').hidden = !PEER_WATCH; $('netLeave').onclick = () => { location.hash = ''; location.reload(); };
$('hostSec').hidden = REMOTE;
function renderHost() {
  const on = hostState !== 'off', n = [...viewers].filter(v => !v.local).length;
  $('hHost').textContent = on ? 'Stop hosting' : 'Start hosting';
  $('hHost').classList.toggle('pri', !on);
  $('hostInfo').hidden = !on;
  if (!on) return;
  $('hCodeBig').textContent = ui.hostCode;
  $('hState').textContent = hostState === 'on' ? (n ? `${n} device${n > 1 ? 's' : ''} watching` : 'Waiting for a device to join') : 'Connecting to the broker…';
  $('hLink').textContent = watchLink();
  if (location.protocol === 'file:') $('hState').textContent += ' · this page was opened as a file, so the link won\'t work; enter the code on the other device instead';
  loadScript(QRJS).then(() => { if ($('hQr').dataset.code === ui.hostCode) return; const q = qrcode(0, 'M'); q.addData(watchLink()); q.make(); $('hQr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); $('hQr').dataset.code = ui.hostCode; }).catch(() => { });
}
$('hHost').onclick = () => hostState === 'off' ? startHosting() : stopHosting();
$('hCopy').onclick = () => { const t = watchLink(); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Link copied', 'info'), () => { const r = document.createRange(); r.selectNodeContents($('hLink')); getSelection().removeAllRanges(); getSelection().addRange(r); }); };
$('hJoin').onclick = () => { const c = $('hCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length < 4) { toast('Enter the code shown on the host', 'info'); return; } location.hash = 'watch-' + c; location.reload(); };
$('hCode').onkeydown = e => { if (e.key === 'Enter') $('hJoin').click(); };
if (!REMOTE) { renderHost(); if (ui.hosting) startHosting(); }
document.querySelectorAll('[name=notify]').forEach(r => { r.checked = r.value === ui.notify; r.onchange = () => { if (r.checked) { ui.notify = r.value; saveUi(); } }; });
applyUi();

/* coach mark & resume prompt */
if (isTouch) $('coachText').innerHTML = '<b>Tap a yip</b> to read its mind · <b>pinch</b> to zoom · <b>drag</b> to pan · <b>double-tap</b> to zoom in';
if (!store.get('alife.coached11', false)) $('coach').hidden = false;
$('coachOk').onclick = () => { $('coach').hidden = true; store.set('alife.coached11', true); };
(() => {
  const m = store.get('alife.saveMeta', null);
  if (REMOTE || !m || !m.ticks) return;
  $('coach').hidden = false;
  $('coachText').innerHTML = `<b>Saved run found</b> · ${m.islands || 1} island${(m.islands || 1) > 1 ? 's' : ''}, tick ${[].concat(m.ticks).map(fmt).join(' / ')} from ${new Date(m.at).toLocaleDateString()}`;
  $('coachResume').hidden = false;
  $('coachResume').onclick = () => { $('sLoad').click(); $('coach').hidden = true; };
})();
