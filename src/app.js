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
const REMOTE = !!window.ALIFE_SERVER;   // set when the page is served by server/server.js
const ISLAND = i => 'ABCD'[i] || String(i + 1);
const cores = navigator.hardwareConcurrency || 2;
const prefIslands = (() => { try { const v = JSON.parse(localStorage.getItem('alife.ui') || '{}').islands; return v; } catch { return null; } })();
let islandCount = clamp(prefIslands || Math.min(3, Math.max(2, cores - 1)), 1, 4);
const pulses = [];
const simUrl = REMOTE ? '' : URL.createObjectURL(new Blob([$('simSource').textContent], { type: 'text/javascript' }));
function spawnIsland(i) { const w = new Worker(simUrl); w.onmessage = e => onSim(e.data, i); w.onerror = e => console.warn('Worker error', e); sims[i] = w; return w; }
/* ---------- remote viewing: a sim server on another computer runs the islands and this page only draws ----------
   Frames are queued and played back at an even pace a little behind real time, so network hiccups don't stutter. */
let ws = null, remoteHost = '', netState = 'connecting', frameQ = [], lastSched = 0, lastArrive = 0, arriveMean = 66, netBytes = 0, netRate = 0;
const BUFFER_MS = { low: 60, normal: 250, smooth: 800 };
const remoteProxy = i => ({ postMessage: m => wsSendJson({ isl: i, m }), terminate() { } });
function wsSendJson(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { netState = 'connected'; wsSendJson({ cmd: 'rate', fps: ui.netFps }); };
  ws.onmessage = e => {
    if (typeof e.data === 'string') { const h = JSON.parse(e.data); if (h.hello) onHello(h); return; }
    netBytes += e.data.byteLength;
    const { isl, m } = CODEC.decode(e.data);
    if (m.type === 'frame') { if (isl === watched) queueFrame(m); return; }
    onSim(m, isl);
  };
  ws.onclose = () => { if (netState !== 'lost') toast('Lost the sim server. Reconnecting…', 'death'); netState = 'lost'; updateNetNote(); setTimeout(connect, 2000); };
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
function drainFrames(now) { while (frameQ.length && frameQ[0].s <= now) { const { m } = frameQ.shift(); ingestFrame(m); if (m.P) paintPher(m.P); } }
const netDelay = () => frameQ.length ? Math.max(0, frameQ[frameQ.length - 1].s - performance.now()) : 0;
if (REMOTE) setInterval(() => { netRate = netBytes; netBytes = 0; }, 1000);
function updateNetNote() { if (!REMOTE) return; $('netNote').textContent = netState === 'connected' ? `Connected to ${remoteHost} at ${location.host}. The islands run there; this device only draws them, so closing this page doesn't stop them. The server autosaves to its own disk.` : 'Not connected to the sim server. Retrying every 2 seconds…'; }

(function boot() {
  const src = $('simSource').textContent;
  if (REMOTE) { sims.push(remoteProxy(0)); return; }
  for (let i = 0; i < islandCount; i++) {
    try {
      spawnIsland(i);
    } catch (err) {
      if (i > 0) break;
      usingWorker = false;
      const fake = { onmessage: null, postMessage: m => queueMicrotask(() => onSim(m, 0)) };
      new Function('self', src)(fake);
      sims.push({ postMessage: m => fake.onmessage && fake.onmessage({ data: m }) });
      break;
    }
  }
})();
const send = (type, rest = {}) => sims[watched].postMessage({ type, ...rest });
const sendAll = (type, rest = {}) => sims.forEach(w => w.postMessage({ type, ...rest }));
// background islands always run flat out; the watched one follows the speed control (or flat out in Turbo)
function syncIslands() {
  sims.forEach((w, i) => {
    const me = i === watched;
    w.postMessage({ type: 'view', on: me && !turbo && !(REMOTE && document.hidden) });
    w.postMessage({ type: 'speed', speed: SPEEDS[speedIdx], max: !me || turbo || maxMode });
  });
}

/* ================= app state ================= */
let F = null, stats = null, insp = null, names = {};
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
  if (m.type === 'ready') { sims[isl].postMessage({ type: 'init', island: isl, view: isl === watched, settings: currentSettings() }); if (isl !== watched) sims[isl].postMessage({ type: 'speed', speed: 1, max: true }); return; }
  if (m.type === 'pulse') { pulses[isl] = m; renderIslands(); return; }
  if (m.type === 'saved') { onSaved(m, isl); return; }
  if (m.type === 'libraryPack') { onLibraryPack(m, isl); return; }
  if (m.type === 'emigrants') { if (sims.length > 1) { let to = Math.floor(Math.random() * (sims.length - 1)); if (to >= isl) to++; sims[to].postMessage({ type: 'immigrants', pack: m.pack, from: isl }); } else sims[isl].postMessage({ type: 'immigrants', pack: m.pack, from: isl }); return; }
  if (isl !== watched && m.type !== 'toast') return;
  if (m.type === 'toast' && isl !== watched) return;
  switch (m.type) {
    case 'meta': {
      const first = !meta; meta = m; W = m.W; H = m.H; if (cw) minZ = Math.min(cw / W, ch / H) * .6; buildTerrain(m);
      if (first) buildClimate(m.settings); else syncSliders(m.settings);
      rpos.clear(); bpos.clear(); trail = [];
      if (first || !cw) fit(true); else fit(true);
      break;
    }
    case 'frame': ingestFrame(m); if (m.P) paintPher(m.P); break;
    case 'stats': stats = m; if (m.names) names = m.names; renderStats(); break;
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
    if (doFx && f) { for (const bit of [1, 2, 4, 8, 32, 64, 128, 256]) if (f & bit) fx.push({ x: p.tx, y: p.ty, k: bit, t: now }); }
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
const sprFood = sprite(SP, (g, s) => {
  const r = s * .34, c = s / 2;
  const gr = g.createRadialGradient(c - r * .35, c - r * .4, r * .1, c, c, r);
  gr.addColorStop(0, '#d8f7c8'); gr.addColorStop(.45, C.food); gr.addColorStop(1, '#3f8a3a');
  g.fillStyle = gr; g.beginPath(); g.arc(c, c + 2, r, 0, TAU); g.fill();
  g.fillStyle = '#5fae4c'; g.beginPath(); g.ellipse(c + r * .45, c - r * .85, r * .45, r * .2, -.6, 0, TAU); g.fill();
});
const sprTree = sprite(SP, (g, s) => {
  const c = s / 2;
  g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(c + 3, c + 4, s * .4, 0, TAU); g.fill();
  for (const [dx, dy, rr] of [[0, 0, .3], [-.14, -.1, .2], [.15, -.08, .21], [.02, .15, .2], [-.12, .12, .17], [.14, .13, .16]]) {
    const x = c + dx * s, y = c + dy * s, r = rr * s;
    const gr = g.createRadialGradient(x - r * .4, y - r * .4, r * .1, x, y, r);
    gr.addColorStop(0, '#e9c79b'); gr.addColorStop(.6, C.tree); gr.addColorStop(1, '#7a5a37');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  g.fillStyle = '#5b3f22'; g.beginPath(); g.arc(c, c, s * .05, 0, TAU); g.fill();
});
const sprStone = sprite(SP, (g, s) => {
  const c = s / 2, pts = [[-.34, .08], [-.2, -.26], [.12, -.33], [.34, -.08], [.28, .24], [-.04, .33], [-.28, .26]];
  g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](c + x * s + 2, c + y * s + 3)); g.fill();
  const gr = g.createLinearGradient(0, 0, s, s); gr.addColorStop(0, '#e4e7ef'); gr.addColorStop(.5, C.stone); gr.addColorStop(1, '#5d6372');
  g.fillStyle = gr; g.beginPath(); pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](c + x * s, c + y * s)); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = s * .03; g.beginPath(); g.moveTo(c - .2 * s, c - .26 * s); g.lineTo(c + .12 * s, c - .33 * s); g.stroke();
});
const ISPR = [[sprFood, 2.6], [sprTree, 4.6], [sprStone, 3.2]];
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
const FXC = { 1: [126, 214, 176], 2: [242, 100, 90], 4: [240, 179, 90], 8: [201, 179, 230], 32: [255, 80, 70], 64: [127, 216, 234], 128: [243, 201, 107], 256: [255, 143, 200] };
function render(t) {
  if (REMOTE) drainFrames(t);
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

  // resources
  const I = F.I;
  if (z < .7) {
    const s = 1.4 / Math.max(.25, z) * .9, cols = [C.food, C.tree, C.stone];
    for (let ty = 0; ty < 3; ty++) { ctx.fillStyle = cols[ty]; for (let o = 0; o < I.length; o += 4) { if (I[o] !== ty) continue; const x = I[o + 1], y = I[o + 2]; if (inView(x, y)) ctx.fillRect(x - s / 2, y - s / 2, s, s); } }
  } else for (let o = 0; o < I.length; o += 4) {
    const x = I[o + 1], y = I[o + 2]; if (!inView(x, y)) continue;
    const [img, r0] = ISPR[I[o]], life = I[o + 3];
    const r = fast ? r0 : r0 * (life > .985 ? .4 + (1 - life) / .015 * .6 : 1);
    ctx.globalAlpha = life < .15 ? .25 + life / .15 * .75 : 1;
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
      ctx.fillStyle = 'rgba(0,0,0,.35)'; roundRect(x - r + 1.5, y - r + 2, r * 2, r * 2, 3); ctx.fill();
      ctx.fillStyle = ty === 0 ? 'rgba(240,200,126,.2)' : 'rgba(127,216,234,.16)'; roundRect(x - r, y - r, r * 2, r * 2, 3); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.3; roundRect(x - r, y - r, r * 2, r * 2, 3); ctx.stroke();
      ctx.lineWidth = .8; ctx.beginPath();
      if (ty === 0) { ctx.moveTo(x - r * .6, y - r * .05); ctx.lineTo(x, y - r * .6); ctx.lineTo(x + r * .6, y - r * .05); ctx.moveTo(x - r * .15, y + r); ctx.lineTo(x - r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r); }
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
  ctx.strokeStyle = 'rgba(255,143,200,.8)'; ctx.lineWidth = .8; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 8)) continue; ctx.moveTo(p.x + R + 1.8, p.y); ctx.arc(p.x, p.y, R + 1.8, 0, TAU); }
  ctx.stroke();
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

  // action effects
  if (fx.length) {
    const nowMs = performance.now(); let w = 0; ctx.lineWidth = 1.1;
    for (const e of fx) {
      const age = (nowMs - e.t) / 520; if (age >= 1) continue; fx[w++] = e;
      if (!inView(e.x, e.y)) continue;
      const [r, g, b] = FXC[e.k], a = (1 - age) * .9;
      ctx.strokeStyle = `rgba(${r},${g},${b},${a})`; ctx.beginPath();
      if (e.k === 2 || e.k === 4) { const s = 3 + age * 6; ctx.moveTo(e.x - s, e.y - s); ctx.lineTo(e.x + s, e.y + s); ctx.moveTo(e.x + s, e.y - s); ctx.lineTo(e.x - s, e.y + s); }
      else if (e.k === 128 || e.k === 256) { const love = e.k === 256, yy = e.y - 7 - age * 6; ctx.globalAlpha = 1 - age; ctx.fillStyle = 'rgba(12,20,19,.8)'; roundRect(e.x - (love ? 6 : 5.5), yy - 4.5, love ? 12 : 11, 9, 4); ctx.fill(); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.font = love ? '7px sans-serif' : 'bold 5px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(love ? '😍' : 'ty', e.x, yy + .3); ctx.globalAlpha = 1; continue; }
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
  if (REMOTE) { wsSendJson({ cmd: 'islands', n: clamp(n, 1, 4) }); return; }
  if (!usingWorker) { toast('This browser can only run one island', 'info'); return; }
  n = clamp(n, 1, 4);
  while (sims.length > n) { const i = sims.length - 1; sims.pop().terminate(); pulses.length = sims.length; if (watched === i) watchIsland(0); }
  while (sims.length < n) spawnIsland(sims.length);
  islandCount = n; ui.islands = n; saveUi(); updateCoreNote(); renderIslands();
}
const updateCoreNote = () => { $('coreNote').textContent = REMOTE ? `${sims.length} island${sims.length > 1 ? 's are' : ' is'} running on ${remoteHost || 'the server'}.` : `This device reports ${cores} CPU core${cores > 1 ? 's' : ''}; ${sims.length} island${sims.length > 1 ? 's are' : ' is'} running.${sims.length >= cores ? ' More islands than cores share the processor and each runs slower.' : ''}`; };
$('islandCount').onchange = () => { const n = +$('islandCount').value, gone = sims.length - n; setIslandCount(n); if (gone) toast(gone > 0 ? `Removed ${gone} island${gone > 1 ? 's' : ''}` : `${-gone} new island${-gone > 1 ? 's' : ''} started with fresh founders`, 'info'); };
updateCoreNote();

/* ================= HUD ================= */
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const dayLabel = p => p < .06 || p >= .94 ? 'Dawn' : p < .44 ? 'Day' : p < .56 ? 'Dusk' : 'Night';
function updateHud() {
  if (!F) return;
  const pop = F.A.length / 10;
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
const DEATHC = { thirst: '#6fb6e8', drowning: '#3f7fb5', age: C.muted, hunger: C.warn, storm: C.storm, fire: C.fire, beast: C.beast, attack: '#b04a8a' };
const DEATHL = { thirst: 'Thirst', drowning: 'Drowning', age: 'Old age', hunger: 'Starvation', storm: 'Storms', fire: 'Burns', beast: 'Beasts', attack: 'Killed by yips' };
function renderStats() {
  if (!stats) return;
  updateHud();
  if (!$('dStats').classList.contains('open')) return;
  const s = stats, ta = s.tally;
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
  lineChart($('cBeh'), [{ values: per100('shares'), color: C.good }, { values: per100('thefts'), color: C.bad }, { values: per100('attacks').map(v => v / 10), color: C.beast + '99' }, { values: per100('hunts'), color: C.warn }, { values: per100('crafts'), color: C.wall }, { values: per100('thanks'), color: C.accent }, { values: per100('loves').map(v => v * 5), color: '#ff8fc8' }]);
  lineChart($('cSocial'), [{ values: h.map(x => x.rep || 0), color: '#ff8fc8' }, { values: h.map(x => (x.lonely || 0) * 5), color: '#9cb6ff' }], { decimals: 1 });
  $('behFigs').innerHTML = [['Gifts given', ta.shares], ['Food stolen', ta.thefts], ['Thank-yous', ta.thanks], ['Loving thanks', ta.loves], ['Births', ta.pairings], ['From loving thanks', ta.loveBirths || 0], ['Befriendings', ta.befriends], ['Beasts slain', ta.beastKills], ['Tools made', ta.crafts], ['Holding tools', Math.round(s.tools / Math.max(1, s.pop) * 100) + '%']]
    .map(([k, v]) => `<div class="fig"><b>${typeof v === 'number' ? fmt(v) : v}</b><small>${k}</small></div>`).join('');
  lineChart($('cGen'), [{ values: h.map(x => x.gen), color: C.accent }]);
  lineChart($('cBody'), [{ values: h.map(x => x.str), color: C.bad, area: false }, { values: h.map(x => x.spd), color: C.store }, { values: h.map(x => x.sense / 100), color: C.wall }, { values: h.map(x => x.agg || 0), color: C.beast }, { values: h.map(x => (x.neurons || 0) / 50), color: C.accent }], { decimals: 1 });
  if (s.geneUse) $('perkBars').innerHTML = s.geneUse.length ? s.geneUse.map(g => `<div class="generow"><div class="bar"><div class="bt"><i style="width:${g.share * 100}%"></i><span>${esc(g.name)} · ${CONDL[g.cond] || g.cond}</span></div><b>${Math.round(g.share * 100)}%</b></div><p>${fxText(g.fx)}</p></div>`).join('') : '<p class="note">No genes in the population yet.</p>';
  $('mentAvg').innerHTML = traitRows(meta.ment, s.traits, null);
  // who each social act is aimed at
  const RELC = ['#7ed6b0', '#f3c96b', '#93a8a0', '#f2836f'], RELN = { attack: 'Attacks', share: 'Gifts', thank: 'Thanks', befriend: 'Befriends' };
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
const DIGITS = { lr: 4, sense: 0, budget: 1 };
function traitRows(keys, vals, avg) {
  return keys.map(k => {
    const [label, info] = meta.traitInfo[k], [lo, hi] = meta.bounds[k], v = vals[k] ?? 0, d = DIGITS[k] ?? 2;
    const f = clamp((v - lo) / (hi - lo), 0, 1), a = avg && avg[k] != null ? clamp((avg[k] - lo) / (hi - lo), 0, 1) : null;
    return `<div class="trait"><span title="${esc(info)}">${label}</span><div class="tr"><i style="width:${f * 100}%"></i>${a != null ? `<u style="left:${a * 100}%"></u>` : ''}</div><b>${v.toFixed(d)}</b></div>`;
  }).join('');
}
// describe a gene by what it does to the body, using the simulation's own dial definitions
function fxText(fx) {
  return Object.entries(fx).map(([d, v]) => { const D = meta.dials[d]; if (!D) return ''; const good = v * D.good > 0, val = D.kind === 'mul' ? `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%` : `${v > 0 ? '+' : '−'}${Math.abs(v) < 1 ? Math.abs(v).toFixed(3) : Math.abs(v).toFixed(0)}`; return `<span class="${good ? 'g' : 'x'}">${val} ${D.label}</span>`; }).join(' · ');
}
const CONDL = { always: 'always', cold: 'when cold', hot: 'when hot', night: 'at night', day: 'by day', young: 'while young', old: 'when old', starving: 'when starving', fed: 'when well fed', swimming: 'while swimming', hurt: 'when badly hurt' };
function renderGenes(genes) {
  $('geneList').innerHTML = genes.length ? genes.map(g => `<div class="gene${g.on ? ' on' : ''}"><div><b>${esc(g.name)}</b><span class="badge${g.cond === 'always' ? '' : g.on ? ' good' : ''}">${CONDL[g.cond] || g.cond}${g.cond !== 'always' ? (g.on ? ' · on' : ' · off') : ''}</span><em class="num">${g.cost >= 0 ? 'costs ' + g.cost.toFixed(2) : 'frees ' + (-g.cost).toFixed(2)} budget</em></div><p>${fxText(g.fx)}</p></div>`).join('') : '<p class="note">No genes: this yip runs on its base traits alone.</p>';
}
function renderInspector() {
  const m = insp; if (!m || !$('dInspect').classList.contains('open')) return;
  const dead = m.none && m.id === selected;
  $('iBody').hidden = dead; $('iEmpty').hidden = !dead;
  if (dead) {
    const g = m.grave, nm = (g && g.name) || lastName[m.id] || `Yip #${m.id}`;
    const CAUSE = { age: 'of old age', hunger: 'of starvation', thirst: 'of thirst', drowning: 'by drowning', storm: 'in a storm', fire: 'in a fire', beast: 'to a beast', attack: 'at the hands of another yip' };
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
  const budget = m.traits.budget, cost = m.cost, over = cost > budget, pct = v => clamp(v / Math.max(budget, cost) * 100, 0, 100);
  $('budgetBar').innerHTML = `<div class="row2"><span>Body budget used</span><b>${cost.toFixed(1)} / ${budget.toFixed(1)}${over ? ' · over budget' : ''}</b></div><div class="bb"><i style="width:${pct(cost)}%;background:${over ? 'var(--bad)' : 'var(--good)'};opacity:.7"></i><u style="left:${pct(budget)}%"></u></div><span>Going over the budget raises metabolism. Upgrades and strong physical traits use it up.</span>`;
  renderGenes(m.genes || []);
  const d = m.deeds;
  $('deedKV').innerHTML = [['Gifts given', d.shared], ['Food stolen', d.stolen], ['Attacks', d.attacks], ['Yips killed', d.kills], ['Beast hits', d.hunts], ['Beasts slain', d.beastKills], ['Tools made', d.crafts], ['Items stored', d.deposits], ['Built', d.builds], ['Harvested', m.success]]
    .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  const ph = m.ph || {};
  const kv = [['Wellbeing', m.wellbeing.toFixed(2)], ['Avg reward', (m.rewardAvg >= 0 ? '+' : '') + m.rewardAvg.toFixed(3)], ['Food carried', m.inv.food], ['Wood / stone', `${m.inv.wood} / ${m.inv.stone}`], ['Tool uses left', m.tool], ['Metabolism', m.metab.toFixed(2) + '×'], ['Brain upkeep', m.brainCost.toFixed(3)], ['Comfort range', `${ph.coldT}–${ph.hotT}°C`], ['Felt temp.', m.temp.toFixed(1) + '°C'], ['Max energy / health', `${ph.maxE} / ${ph.maxH}`], ['Lifespan', fmt(m.lifespan)], ['Last act', meta.short[m.lastChoice]]];
  $('bodyKV').innerHTML = kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
function socialPane(m) {
  $('socialKV').innerHTML = [['Popularity', m.rep.toFixed(2)], ['Admirers', m.admirers], ['Thanks received', m.thanksGot], ['Loving thanks', m.lovesGot], ['Children had', m.partners], ['Co-parent', m.coparent ? `${esc(m.coparentName || '#' + m.coparent)}${m.coparentAlive ? '' : ' (gone)'}` : 'none'], ['Owes thanks to', m.owed && m.owed.length ? m.owed.filter(o => o[1] > .05).slice(0, 3).map(o => esc(o[0])).join(', ') || 'nobody' : 'nobody']].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
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
  if (document.visibilityState === 'hidden') { if (ui.hidePause && running) { hiddenPaused = true; running = false; sendAll('play', { running: false }); paintPlay(); } if (ui.auto) saveAll('auto'); }
  else if (hiddenPaused) { hiddenPaused = false; setRunning(true); }
  syncWake();
});
setInterval(() => { if (!REMOTE && ui.auto && running && (pulses[watched] || {}).ticks > 200) saveAll('auto'); }, 120000);
document.querySelectorAll('[name=netBuf]').forEach(r => { r.checked = r.value === ui.netBuf; r.onchange = () => { if (r.checked) { ui.netBuf = r.value; saveUi(); } }; });
$('netFps').value = ui.netFps; $('netFps').onchange = () => { ui.netFps = +$('netFps').value; saveUi(); wsSendJson({ cmd: 'rate', fps: ui.netFps }); };
$('netSec').hidden = !REMOTE; if (REMOTE) { updateNetNote(); connect(); }
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
