'use strict';
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

/* ================= palette (mirrors CSS tokens for canvas use) ================= */
const C = {
  ink: '#0a1110', fg: '#e7efe9', muted: '#93a8a0', dim: '#62776f', line: 'rgba(188,228,212,.11)', accent: '#f3c96b', good: '#7ed6b0', bad: '#f2836f', warn: '#f0b35a',
  food: '#8fd67a', tree: '#c49a6c', stone: '#aab0bf', house: '#f0c87e', store: '#7fd8ea', wall: '#c9b3e6', fire: '#f08a4b', storm: '#8aa4ff',
};
const BCOL = [C.house, C.store, C.wall, C.fire];
const hueFill = Array.from({ length: 360 }, (_, h) => `hsl(${h} 72% 66%)`);

/* ================= simulation worker ================= */
let meta = null, W = 840, H = 520;
let sim = null, usingWorker = true;
(function boot() {
  const src = $('simSource').textContent;
  const handler = e => onSim(e.data);
  try {
    sim = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    sim.onmessage = handler;
    sim.onerror = e => { console.warn('Worker error', e); };
  } catch (err) {
    usingWorker = false;
    const fake = { onmessage: null, postMessage: m => queueMicrotask(() => handler({ data: m })) };
    new Function('self', src)(fake);
    sim = { postMessage: m => fake.onmessage && fake.onmessage({ data: m }) };
  }
})();
const send = (type, rest = {}) => sim.postMessage({ type, ...rest });

/* ================= app state ================= */
let F = null;                 // latest frame
let stats = null, insp = null;
let selected = 0, follow = false, running = true, tool = 'select';
const SPEEDS = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120];
let speedIdx = 2;
const ui = Object.assign({ night: true, sense: true, trail: true, legend: true, perf: true, auto: true, hidePause: true, speedIdx: 2 }, store.get('alife.ui', {}));
const isTouch = matchMedia('(pointer:coarse)').matches;
const compact = () => cw < 760 || ch <= 500;
const rpos = new Map();       // id -> smoothed render position
let trail = [];
let simTps = 0, renderFps = 0;

function onSim(m) {
  switch (m.type) {
    case 'meta': meta = m; W = m.W; H = m.H; buildClimate(m.settings); fit(true); break;
    case 'frame': ingestFrame(m); break;
    case 'stats': stats = m; renderStats(); break;
    case 'inspect': insp = m; renderInspector(); break;
    case 'selected': setSelected(m.id, { fromSim: true }); break;
    case 'toast': toast(m.s, m.kind); break;
    case 'saved': onSaved(m); break;
    case 'loaded':
      if (m.ok) { toast('World loaded', 'info'); syncSliders(m.settings); trail = []; rpos.clear(); }
      else toast('Could not load: ' + m.error, 'death');
      break;
  }
}
function ingestFrame(m) {
  F = m; simTps = m.tps;
  const A = m.A, seen = new Set();
  for (let o = 0; o < A.length; o += 9) {
    const id = A[o]; seen.add(id);
    let p = rpos.get(id);
    if (!p) rpos.set(id, p = { x: A[o + 1], y: A[o + 2], hd: A[o + 4] });
    p.tx = A[o + 1]; p.ty = A[o + 2]; p.thd = A[o + 4]; p.i = o;
  }
  for (const id of rpos.keys()) if (!seen.has(id)) rpos.delete(id);
  if (selected && !seen.has(selected) && insp && insp.id === selected) { /* death handled by inspector */ }
}

/* ================= canvas, camera ================= */
const cv = $('world'), ctx = cv.getContext('2d', { alpha: false });
let cw = 0, ch = 0, dpr = 1;
const cam = { x: 420, y: 260, z: 1 };
let minZ = .3;
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = cv.clientWidth; ch = cv.clientHeight;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  minZ = Math.min(cw / W, ch / H) * .5;
}
function fitZoom() {
  const narrow = cw < 760, short = ch <= 500;
  const zw = (cw - (narrow ? 12 : 40)) / W, zh = (ch - (short ? 104 : narrow ? 130 : 170)) / H;
  // tall portrait screens: zoom past width-fit so the world fills more of the screen (pan to see the edges)
  return zh > zw * 1.25 ? Math.min(zh, zw * 1.55) : Math.min(zw, zh);
}
function fit(instant) { lastFitZ = fitZoom(); const z = fitZoom(); camTarget = { x: W / 2, y: H / 2 + (ch <= 500 ? -2 : cw < 760 ? 4 : -6) / z, z }; if (instant) Object.assign(cam, camTarget), camTarget = null; }
let camTarget = null;
let lastFitZ = 0;
new ResizeObserver(() => { const first = !cw, wasFit = Math.abs(cam.z - lastFitZ) < .02; resize(); vc.x = 0; updateViewCenter(1); if (first || wasFit) { fit(true); } lastFitZ = fitZoom(); }).observe(cv);
const vc = { x: 0, y: 0, tx: 0, ty: 0 };   // screen point the camera centers on, kept clear of drawers
function viewRect() {
  let l = 0, r = cw, t = 0, b = ch;
  for (const d of ['dStats', 'dClimate', 'dSettings', 'dInspect']) {
    const el = $(d); if (!el.classList.contains('open')) continue;
    const q = el.getBoundingClientRect(), cr = cv.getBoundingClientRect();
    if (q.width >= cw * .9) b = Math.min(b, q.top - cr.top);          // bottom sheet
    else if (q.left - cr.left < cw / 2) l = Math.max(l, q.right - cr.left);
    else r = Math.min(r, q.left - cr.left);
  }
  if (r - l < 120) { l = 0; r = cw; }
  return { l, r, t, b };
}
function updateViewCenter(dt) {
  const v = viewRect(); vc.tx = (v.l + v.r) / 2; vc.ty = (v.t + v.b) / 2;
  if (!vc.x) { vc.x = vc.tx; vc.y = vc.ty; }
  const k = 1 - Math.exp(-dt * 8);
  vc.x += (vc.tx - vc.x) * k; vc.y += (vc.ty - vc.y) * k;

}
const toWorld = (sx, sy) => ({ x: (sx - vc.x) / cam.z + cam.x, y: (sy - vc.y) / cam.z + cam.y });
const toScreen = (wx, wy) => ({ x: (wx - cam.x) * cam.z + vc.x, y: (wy - cam.y) * cam.z + vc.y });
function zoomAt(sx, sy, z) {
  z = clamp(z, minZ, 9);
  const p = toWorld(sx, sy);
  cam.z = z;
  cam.x = p.x - (sx - vc.x) / z; cam.y = p.y - (sy - vc.y) / z;
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
  const blobs = [[0, 0, .3], [-.14, -.1, .2], [.15, -.08, .21], [.02, .15, .2], [-.12, .12, .17], [.14, .13, .16]];
  for (const [dx, dy, rr] of blobs) {
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
const sprGlow = (col) => sprite(128, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, col); gr.addColorStop(.35, col.replace(/[\d.]+\)$/, '.35)')); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
const glowFire = sprGlow('rgba(255,150,70,1)'), glowHouse = sprGlow('rgba(255,210,140,1)');

/* terrain: rendered once, seeded so it is stable across reloads */
let terrain = null;
function buildTerrain() {
  const S = 2, t = document.createElement('canvas'); t.width = W * S; t.height = H * S;
  const g = t.getContext('2d');
  let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = '#132420'; g.fillRect(0, 0, t.width, t.height);
  const tones = ['rgba(34,66,52,.5)', 'rgba(22,48,44,.55)', 'rgba(44,72,50,.4)', 'rgba(16,36,38,.5)', 'rgba(52,70,48,.3)'];
  for (let i = 0; i < 520; i++) {
    const x = r() * t.width, y = r() * t.height, rad = (20 + r() * 110) * S;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, tones[i % tones.length]); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 9000; i++) { g.fillStyle = r() < .5 ? 'rgba(160,210,170,.05)' : 'rgba(0,0,0,.12)'; g.fillRect(r() * t.width, r() * t.height, S * (1 + r()), S * (1 + r())); }
  g.strokeStyle = 'rgba(190,230,210,.045)'; g.lineWidth = 1;
  for (let x = 40; x < W; x += 40) { g.beginPath(); g.moveTo(x * S, 0); g.lineTo(x * S, t.height); g.stroke(); }
  for (let y = 40; y < H; y += 40) { g.beginPath(); g.moveTo(0, y * S); g.lineTo(t.width, y * S); g.stroke(); }
  terrain = t;
}

/* ================= world rendering ================= */
let lastT = performance.now(), fpsFrames = 0, fpsT = lastT, hoverId = 0, pointerWorld = null, flash = 0;
function phaseOf(ticks, len) { return len ? (ticks % len) / len : 0; }
function render(t) {
  const dt = Math.min(.1, (t - lastT) / 1000); lastT = t;
  if (!terrain && meta) buildTerrain();
  if (camTarget) { const k = 1 - Math.exp(-dt * 9); cam.x += (camTarget.x - cam.x) * k; cam.y += (camTarget.y - cam.y) * k; cam.z += (camTarget.z - cam.z) * k; if (Math.abs(camTarget.z - cam.z) < .001 && Math.hypot(camTarget.x - cam.x, camTarget.y - cam.y) < .05) camTarget = null; }
  // smooth agent positions
  const k = 1 - Math.exp(-dt * 16);
  for (const p of rpos.values()) {
    if (p.tx === undefined) continue;
    const dx = p.tx - p.x, dy = p.ty - p.y;
    if (dx * dx + dy * dy > 1600) { p.x = p.tx; p.y = p.ty; } else { p.x += dx * k; p.y += dy * k; }
    let dh = p.thd - p.hd; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); p.hd += dh * Math.min(1, k * 1.4);
  }
  const sp = selected && rpos.get(selected);
  if (follow && sp) { const kk = 1 - Math.exp(-dt * 6); cam.x += (sp.x - cam.x) * kk; cam.y += (sp.y - cam.y) * kk; }
  if (sp && ui.trail) { const lp = trail[trail.length - 1]; if (!lp || Math.hypot(lp.x - sp.x, lp.y - sp.y) > 1.5) { trail.push({ x: sp.x, y: sp.y }); if (trail.length > 90) trail.shift(); } }

  updateViewCenter(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, cw, ch);
  if (!F || !terrain) { requestAnimationFrame(render); return; }
  const z = cam.z;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (vc.x - cam.x * z), dpr * (vc.y - cam.y * z));
  const vx0 = cam.x - vc.x / z - 10, vx1 = cam.x + (cw - vc.x) / z + 10, vy0 = cam.y - vc.y / z - 10, vy1 = cam.y + (ch - vc.y) / z + 10;

  // ground
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-3, -3, W + 6, H + 8);
  ctx.drawImage(terrain, 0, 0, W, H);
  const temp = F.temp;
  if (temp < 10) { ctx.fillStyle = `rgba(160,200,255,${clamp((10 - temp) / 30, 0, 1) * .28})`; ctx.fillRect(0, 0, W, H); }
  else if (temp > 27) { ctx.fillStyle = `rgba(255,190,110,${clamp((temp - 27) / 23, 0, 1) * .2})`; ctx.fillRect(0, 0, W, H); }

  // resources
  const I = F.I;
  for (let o = 0; o < I.length; o += 4) {
    const x = I[o + 1], y = I[o + 2]; if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    const [img, r0] = ISPR[I[o]], life = I[o + 3];
    const r = r0 * (life > .985 ? .4 + (1 - life) / .015 * .6 : 1);
    ctx.globalAlpha = life < .15 ? .25 + life / .15 * .75 : 1;
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;

  // structures
  const B = F.B, now = t / 1000;
  for (let o = 0; o < B.length; o += 8) {
    const ty = B[o], x = B[o + 1], y = B[o + 2], r = B[o + 3], hp = B[o + 4], col = BCOL[ty];
    ctx.globalAlpha = .45 + .55 * hp;
    if (ty === 3) {
      const fl = 1 + Math.sin(now * 13 + x) * .12 + Math.sin(now * 7.3 + y) * .08;
      ctx.fillStyle = 'rgba(240,138,75,.18)'; ctx.beginPath(); ctx.arc(x, y, r * 1.05, 0, TAU); ctx.fill();
      ctx.fillStyle = '#5a3a26'; ctx.beginPath(); ctx.arc(x, y, r * .55, 0, TAU); ctx.fill();
      ctx.fillStyle = C.fire; ctx.beginPath(); ctx.arc(x, y, r * .42 * fl, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd27a'; ctx.beginPath(); ctx.arc(x, y - .6, r * .2 * fl, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(240,138,75,.35)'; ctx.lineWidth = .6; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(x, y, 40, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    } else if (ty === 2) {
      ctx.fillStyle = '#2c2638'; roundRect(x - r, y - 3.4, r * 2, 6.8, 2.5); ctx.fill();
      ctx.fillStyle = col; roundRect(x - r, y - 3, r * 2, 5, 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = .5; for (let k2 = -r + 4; k2 < r; k2 += 4) { ctx.beginPath(); ctx.moveTo(x + k2, y - 3); ctx.lineTo(x + k2, y + 2); ctx.stroke(); }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.35)'; roundRect(x - r + 1.5, y - r + 2, r * 2, r * 2, 3); ctx.fill();
      ctx.fillStyle = ty === 0 ? 'rgba(240,200,126,.2)' : 'rgba(127,216,234,.16)'; roundRect(x - r, y - r, r * 2, r * 2, 3); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.3; roundRect(x - r, y - r, r * 2, r * 2, 3); ctx.stroke();
      ctx.lineWidth = .8; ctx.beginPath();
      if (ty === 0) { ctx.moveTo(x - r * .6, y - r * .05); ctx.lineTo(x, y - r * .6); ctx.lineTo(x + r * .6, y - r * .05); ctx.moveTo(x - r * .15, y + r); ctx.lineTo(x - r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r * .45); ctx.lineTo(x + r * .15, y + r); }
      else { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
      ctx.stroke();
      const stock = B[o + 6];
      if (stock > 0) { ctx.fillStyle = col; const f = Math.min(1, stock / 24); ctx.fillRect(x - r + 2, y + r - 3, (r * 2 - 4) * f, 1.6); }
    }
    if (hp < .55) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - 8, y - r - 5, 16, 2); ctx.fillStyle = hp < .25 ? C.bad : C.warn; ctx.fillRect(x - 8, y - r - 5, 16 * hp, 2); }
  }
  ctx.globalAlpha = 1;

  // night
  const lightS = Math.sin(TAU * phaseOf(F.ticks, F.day) );
  const dark = ui.night ? clamp((-lightS + .2) / 1.2, 0, 1) * .52 : 0;
  if (dark > 0.01) {
    ctx.fillStyle = `rgba(4,8,24,${dark})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (let o = 0; o < B.length; o += 8) {
      const ty = B[o]; if (ty === 2) continue;
      const x = B[o + 1], y = B[o + 2];
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
    ctx.strokeStyle = 'rgba(200,215,255,.35)'; ctx.lineWidth = .5; ctx.beginPath();
    const off = (now * 140) % 24;
    for (let i = -h; i < w + h; i += 9) for (let j = -24; j < h; j += 24) { const sx = x0 + i - (j + off) * .35, sy = y0 + j + off; ctx.moveTo(sx, sy); ctx.lineTo(sx - 2.2, sy + 6); }
    ctx.stroke();
    if (Math.random() < .006) flash = 1;
    if (flash > 0) { ctx.fillStyle = `rgba(230,235,255,${flash * .35})`; ctx.fillRect(x0, y0, w, h); }
    ctx.restore();
  }
  flash = Math.max(0, flash - dt * 5);

  // agents
  const A = F.A, list = [];
  for (let o = 0; o < A.length; o += 9) { const p = rpos.get(A[o]); if (!p || p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue; list.push(o, p); }
  const R = 3.3;
  ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const p = list[i + 1]; ctx.moveTo(p.x + R + 1.1, p.y + .6); ctx.arc(p.x, p.y + .6, R + 1.1, 0, TAU); }
  ctx.fill();
  for (let i = 0; i < list.length; i += 2) {
    const o = list[i], p = list[i + 1], e = A[o + 5], flags = A[o + 7];
    ctx.globalAlpha = (flags & 1) ? .5 : e < .08 ? .6 : 1;
    ctx.fillStyle = hueFill[(A[o + 3] | 0) % 360]; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(8,14,13,.85)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round'; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const p = list[i + 1], c = Math.cos(p.hd), s = Math.sin(p.hd); ctx.moveTo(p.x + c * .6, p.y + s * .6); ctx.lineTo(p.x + c * R * 1.05, p.y + s * R * 1.05); }
  ctx.stroke();
  ctx.fillStyle = '#e8c48f'; ctx.beginPath();
  for (let i = 0; i < list.length; i += 2) { const o = list[i], p = list[i + 1]; if (!(A[o + 7] & 2)) continue; const c = Math.cos(p.hd), s = Math.sin(p.hd); ctx.moveTo(p.x - c * R * 1.25 + 1, p.y - s * R * 1.25); ctx.arc(p.x - c * R * 1.25, p.y - s * R * 1.25, 1, 0, TAU); }
  ctx.fill();

  // selection
  if (sp) {
    if (ui.trail && trail.length > 1) {
      ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) { ctx.strokeStyle = `rgba(243,201,107,${(i / trail.length) * .55})`; ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke(); }
    }
    const sense = A[sp.i + 8] || 0;
    if (ui.sense && sense) { ctx.strokeStyle = 'rgba(243,201,107,.4)'; ctx.fillStyle = 'rgba(243,201,107,.035)'; ctx.lineWidth = 1 / z; ctx.setLineDash([5 / z, 5 / z]); ctx.beginPath(); ctx.arc(sp.x, sp.y, sense, 0, TAU); ctx.fill(); ctx.stroke(); ctx.setLineDash([]); }
    const pulse = 1 + Math.sin(now * 4) * .12;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(sp.x, sp.y, 7.5 * pulse, 0, TAU); ctx.stroke();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(sp.x, sp.y, R * .55, 0, TAU); ctx.fill();
  }
  if (hoverId && hoverId !== selected) { const hp = rpos.get(hoverId); if (hp) { ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1 / z * 1.5; ctx.beginPath(); ctx.arc(hp.x, hp.y, 6.5, 0, TAU); ctx.stroke(); } }
  if (pointerWorld && tool !== 'select') {
    const col = { food: C.food, tree: C.tree, stone: C.stone, fire: C.fire, erase: C.fg }[tool];
    ctx.strokeStyle = col; ctx.lineWidth = 1.2 / z; ctx.setLineDash([4 / z, 3 / z]); ctx.beginPath(); ctx.arc(pointerWorld.x, pointerWorld.y, tool === 'fire' ? 12 : 20, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = 'rgba(190,230,210,.18)'; ctx.lineWidth = 1 / z; ctx.strokeRect(0, 0, W, H);

  fpsFrames++;
  if (t - fpsT > 500) { renderFps = Math.round(fpsFrames * 1000 / (t - fpsT)); fpsFrames = 0; fpsT = t; updateHud(); }
  requestAnimationFrame(render);
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
requestAnimationFrame(render);

/* ================= HUD ================= */
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
function dayLabel(p) { return p < .06 || p >= .94 ? 'Dawn' : p < .44 ? 'Day' : p < .56 ? 'Dusk' : 'Night'; }
function updateHud() {
  if (!F) return;
  const pop = F.A.length / 9;
  $('roPop').textContent = pop;
  $('roTick').textContent = fmt(F.ticks);
  $('roBuilt').textContent = F.B.length / 8;
  if (stats) { $('roGen').innerHTML = `${stats.avgGen.toFixed(1)}<em>max ${stats.maxGen}</em>`; $('roFood').textContent = stats.counts[0]; }
  const p = phaseOf(F.ticks, F.day), season = F.season ? SEASONS[Math.floor(phaseOf(F.ticks, F.season) * 4)] : '';
  $('roDayL').textContent = cw < 760 ? `Day ${Math.floor(F.ticks / F.day) + 1}` : `Day ${Math.floor(F.ticks / F.day) + 1} · ${season || dayLabel(p)}`;
  $('roTemp').innerHTML = `<span class="sun" id="sun"></span>${F.temp.toFixed(0)}°C<em>${dayLabel(p).toLowerCase()}</em>`;
  const sun = $('sun'), light = Math.sin(TAU * p);
  sun.style.background = light > 0 ? C.accent : '#9cb6ff'; sun.style.boxShadow = `0 0 ${light > 0 ? 8 : 4}px ${light > 0 ? C.accent : '#9cb6ff'}`;
  $('perf').textContent = `${usingWorker ? 'worker' : 'main thread'} · ${simTps} ticks/s · ${renderFps} fps · ${pop} agents`;
}

/* ================= controls ================= */
const ICON = {
  pause: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
};
let setRunning = function (v) { running = v; send('play', { running }); $('bPlay').innerHTML = ICON[running ? 'pause' : 'play']; $('bPlay').dataset.tip = running ? 'Pause' : 'Resume'; };
function setSpeed(i) { speedIdx = clamp(i, 0, SPEEDS.length - 1); ui.speedIdx = speedIdx; store.set('alife.ui', ui); $('spOut').textContent = SPEEDS[speedIdx] + '×'; send('speed', { speed: SPEEDS[speedIdx] }); }
setRunning(true); setSpeed(ui.speedIdx);
$('bPlay').onclick = () => setRunning(!running);
$('bStep').onclick = () => send('step', { n: 100 });
$('spDown').onclick = () => setSpeed(speedIdx - 1);
$('spUp').onclick = () => setSpeed(speedIdx + 1);
function setTool(t) { tool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); cv.classList.toggle('brush', t !== 'select'); }
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
const quick = { qStorm: 'storm', qBloom: 'bloom', eStorm: 'storm', eBloom: 'bloom', eCold: 'cold', eHeat: 'heat' };
for (const [id, cmd] of Object.entries(quick)) $(id).onclick = () => { send(cmd); if (cmd === 'cold' || cmd === 'heat') { const el = $('temperature'); el.value = clamp(+el.value + (cmd === 'cold' ? -12 : 12), -20, 50); paintSlider(el); } };

/* drawers */
const DRAWERS = { bStats: 'dStats', bClimate: 'dClimate', bSettings: 'dSettings' };
function openDrawer(id) {
  const isLeft = id !== 'dInspect', el = $(id), opening = !el.classList.contains('open');
  if (isLeft) for (const d of ['dStats', 'dClimate', 'dSettings']) $(d).classList.toggle('open', d === id && opening);
  else el.classList.toggle('open', opening);
  if (compact() && opening) { if (isLeft) $('dInspect').classList.remove('open'); else for (const d of ['dStats', 'dClimate', 'dSettings']) $(d).classList.remove('open'); }
  for (const [b, d] of Object.entries(DRAWERS)) $(b).classList.toggle('on', $(d).classList.contains('open'));
  send('inspect', { on: $('dInspect').classList.contains('open') });
  if (id === 'dStats' && opening) renderStats();
}
function closeDrawer(id) { if ($(id).classList.contains('open')) openDrawer(id); }
for (const [b, d] of Object.entries(DRAWERS)) $(b).onclick = () => openDrawer(d);
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeDrawer(b.dataset.close));
$('bFit').onclick = () => { follow = false; $('iFollow').classList.remove('on'); fit(); };
$('bFull').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('Fullscreen is not available here', 'info'); } };

/* selection */
function setSelected(id, { fromSim = false, open = true } = {}) {
  if (id !== selected) trail = [];
  selected = id || 0;
  if (!fromSim) send('select', { id: selected });
  if (selected && open && !$('dInspect').classList.contains('open')) openDrawer('dInspect');
  if (!selected) { follow = false; $('iFollow').classList.remove('on'); closeDrawer('dInspect'); return; }
  setTimeout(revealSelected, 60);
}
function revealSelected() {
  const p = rpos.get(selected); if (!p) return;
  const v = viewRect(), s = toScreen(p.x, p.y), m = 40;
  if (s.x < v.l + m || s.x > v.r - m || s.y < v.t + 60 || s.y > v.b - 70) camTarget = { x: p.x, y: p.y, z: Math.max(cam.z, fitZoom() * (cw < 760 ? 1.8 : 1)) };
}
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => send('pick', { how: b.dataset.pick }));
$('iFollow').onclick = () => toggleFollow();
function toggleFollow() { if (!selected) return; follow = !follow; $('iFollow').classList.toggle('on', follow); if (follow && cam.z < 2.2) camTarget = { x: cam.x, y: cam.y, z: 2.6 }; }

/* pointer input on the world */
const ptrs = new Map(); let gesture = null, lastPaint = 0;
function agentAt(sx, sy, touch) {
  const w = toWorld(sx, sy), r = Math.max(7, (touch ? 26 : 14) / cam.z); let best = 0, bd = r * r;
  for (const [id, p] of rpos) { const dx = p.x - w.x, dy = p.y - w.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = id; } }
  return best;
}
function paint(sx, sy) { const w = toWorld(sx, sy); if (w.x < 0 || w.y < 0 || w.x > W || w.y > H) return; send('paint', { x: w.x, y: w.y, k: tool }); lastPaint = performance.now(); }
const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
cv.addEventListener('pointerdown', e => {
  const p = local(e); ptrs.set(e.pointerId, p); cv.setPointerCapture(e.pointerId);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
  if (e.button === 1 || e.button === 2 || tool === 'select') { gesture = { type: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: 0, tap: e.button === 0, touch: e.pointerType !== 'mouse' }; cv.classList.add('panning'); }
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
    if (gesture.moved > 4) { cam.x = gesture.cx - (p.x - gesture.sx) / cam.z; cam.y = gesture.cy - (p.y - gesture.sy) / cam.z; clampCam(); camTarget = null; if (follow) { follow = false; $('iFollow').classList.remove('on'); } }
  } else if (gesture.type === 'paint' && performance.now() - lastPaint > 70) paint(p.x, p.y);
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
  if (!ptrs.size) { gesture = null; cv.classList.remove('panning'); }
  else if (gesture && gesture.type === 'pinch') {
    // one finger left after a pinch: continue as a pan from here so the view does not jump
    const [q] = [...ptrs.values()]; gesture = { type: 'pan', sx: q.x, sy: q.y, cx: cam.x, cy: cam.y, moved: 99, tap: false, touch: true };
  }
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', () => { pointerWorld = null; hoverId = 0; showHover(0); });
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, cam.z * Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0016))); }, { passive: false });
cv.addEventListener('dblclick', e => { if (isTouch) return; const p = local(e); if (!agentAt(p.x, p.y)) zoomAt(p.x, p.y, cam.z * 1.8); });
function showHover(id, x, y) {
  const el = $('hover');
  if (!id || !F) { el.classList.remove('show'); return; }
  const p = rpos.get(id); if (!p) return;
  const o = p.i, A = F.A;
  el.innerHTML = `#${id} · energy ${Math.round(A[o + 5] * 200)} · health ${Math.round(A[o + 6] * 100)}`;
  el.style.left = Math.min(x + 14, innerWidth - 200) + 'px'; el.style.top = (y + 12) + 'px'; el.classList.add('show');
}

/* tooltips */
const tip = $('tip');
document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    tip.innerHTML = el.dataset.tip + (el.dataset.key ? `<kbd>${el.dataset.key}</kbd>` : '');
    const r = el.getBoundingClientRect(), below = r.top < 120;
    tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('show');
    const tw = tip.offsetWidth;
    tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8) + 'px';
    tip.style.top = (below ? r.bottom + 8 : r.top - 34) + 'px';
  });
  el.addEventListener('pointerleave', () => tip.classList.remove('show'));
});

/* keyboard */
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); setRunning(!running); }
  else if (k === '.') send('step', { n: 100 });
  else if (k === '-' || k === '_') setSpeed(speedIdx - 1);
  else if (k === '=' || k === '+') setSpeed(speedIdx + 1);
  else if (k >= '1' && k <= '6') setTool(['select', 'food', 'tree', 'stone', 'fire', 'erase'][+k - 1]);
  else if (k === 'f' || k === 'F') toggleFollow();
  else if (k === '0') { follow = false; fit(); }
  else if (k === 's' || k === 'S') openDrawer('dStats');
  else if (k === 'c' || k === 'C') openDrawer('dClimate');
  else if (k === 'Escape') {
    if (!$('modal').hidden) { $('modal').hidden = true; return; }
    const open = ['dStats', 'dClimate', 'dSettings'].find(d => $(d).classList.contains('open'));
    if (open) closeDrawer(open); else setSelected(0);
  }
});

/* ================= toasts ================= */
const KCOL = { storm: C.storm, death: C.bad, birth: C.good, build: C.house, cold: '#9cc6ff', heat: '#ff9d6b', food: C.food, info: C.muted };
function toast(s, kind = 'info') {
  const el = document.createElement('div'); el.className = 'toast glass';
  el.innerHTML = `<i style="background:${KCOL[kind] || C.muted}"></i>`; el.append(s);
  const box = $('toasts'); box.prepend(el); while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

/* ================= climate ================= */
const SLIDERS = [
  ['temperature', 'Average temperature', -20, 50, 1, v => `${v}°C`],
  ['food', 'Food growth', 0, 9, .25, v => `${(+v).toFixed(2)} / tick`],
  ['trees', 'Tree growth', 0, .5, .01, v => `${Math.round(v * 1000)} / 1k ticks`],
  ['stone', 'Stone emergence', 0, .4, .01, v => `${Math.round(v * 1000)} / 1k ticks`],
  ['drain', 'Metabolic pressure', .3, 3, .1, v => `${(+v).toFixed(1)}×`],
  ['decay', 'Decay speed', 0, 4, .1, v => `${(+v).toFixed(1)}×`],
  ['storm', 'Storm severity', 0, 4, .1, v => `${(+v).toFixed(1)}×`],
  ['day', 'Day length', 100, 1500, 50, v => `${v} ticks`],
  ['season', 'Year length', 0, 6000, 100, v => +v ? `${v} ticks` : 'No seasons'],
];
const PRESETS = [
  ['Temperate', 'Balanced defaults', { food: 2.5, trees: .09, stone: .06, drain: 1, decay: 1, storm: 1, temperature: 19, day: 500, season: 2600 }],
  ['Abundance', 'Rich and mild', { food: 5, trees: .18, stone: .12, drain: .8, decay: 1, storm: .5, temperature: 21, day: 500, season: 2600 }],
  ['Scarcity', 'Lean and hungry', { food: 1.2, trees: .05, stone: .04, drain: 1.4, decay: 1.2, storm: 1, temperature: 18, day: 500, season: 2600 }],
  ['Long winter', 'Cold, slow years', { food: 2, trees: .08, stone: .06, drain: 1.1, decay: 1, storm: 1.5, temperature: 4, day: 600, season: 4200 }],
  ['Desert', 'Hot, sparse wood', { food: 1.6, trees: .03, stone: .1, drain: 1.1, decay: 1.4, storm: .6, temperature: 36, day: 450, season: 2600 }],
  ['Tempest', 'Storm season', { food: 2.8, trees: .1, stone: .08, drain: 1, decay: 1.6, storm: 3, temperature: 15, day: 500, season: 2000 }],
];
function paintSlider(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); const s = SLIDERS.find(x => x[0] === el.id); $(el.id + 'v').textContent = s[5](el.value); }
function buildClimate(settings) {
  const box = $('sliders'); box.innerHTML = '';
  for (const [key, label, min, max, step] of SLIDERS) {
    const d = document.createElement('div'); d.className = 'slider';
    d.innerHTML = `<label for="${key}">${label}</label><output id="${key}v"></output><input type="range" id="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}">`;
    box.append(d);
    const el = d.querySelector('input'); paintSlider(el);
    el.addEventListener('input', () => { paintSlider(el); send('settings', { settings: { [key]: +el.value } }); markPreset(); });
  }
  const pb = $('presets'); pb.innerHTML = '';
  PRESETS.forEach(([name, sub, vals]) => {
    const b = document.createElement('button'); b.className = 'preset'; b.innerHTML = `<b>${name}</b><small>${sub}</small>`;
    b.onclick = () => { send('settings', { settings: vals }); syncSliders(vals); toast(`Climate set to ${name.toLowerCase()}`, 'info'); };
    pb.append(b);
  });
  $('oReseed').checked = settings.autoReseed !== false;
  markPreset();
}
function syncSliders(s) { for (const [key] of SLIDERS) { const el = $(key); if (el && s[key] != null) { el.value = s[key]; paintSlider(el); } } if (s.autoReseed != null) $('oReseed').checked = s.autoReseed; markPreset(); }
function markPreset() { const cur = Object.fromEntries(SLIDERS.map(([k]) => [k, +$(k).value])); [...$('presets').children].forEach((b, i) => b.classList.toggle('on', Object.entries(PRESETS[i][2]).every(([k, v]) => Math.abs(cur[k] - v) < 1e-6))); }

/* ================= settings ================= */
const OPTS = { oNight: 'night', oSense: 'sense', oTrail: 'trail', oLegend: 'legend', oPerf: 'perf' };
function applyUi() { document.body.classList.toggle('hidelegend', !ui.legend); document.body.classList.toggle('hideperf', !ui.perf); }
for (const [id, key] of Object.entries(OPTS)) { $(id).checked = ui[key]; $(id).onchange = () => { ui[key] = $(id).checked; store.set('alife.ui', ui); applyUi(); }; }
applyUi();
$('oReseed').onchange = () => send('settings', { settings: { autoReseed: $('oReseed').checked } });
$('sSave').onclick = () => send('save', { purpose: 'local' });
$('sExport').onclick = () => send('save', { purpose: 'file' });
$('sLoad').onclick = () => { let s = null; try { s = localStorage.getItem('alife.save'); } catch {} if (!s) { toast('No browser save yet', 'info'); return; } send('load', { state: s }); };
$('sImport').onclick = () => $('sFile').click();
$('sFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { send('load', { state: await f.text() }); } catch (err) { toast('Could not read that file', 'death'); } e.target.value = ''; };
$('sReset').onclick = () => { $('modal').hidden = false; $('mOk').focus(); };
$('mCancel').onclick = () => { $('modal').hidden = true; };
$('mOk').onclick = () => { $('modal').hidden = true; send('reset'); trail = []; rpos.clear(); setSelected(0); toast('New world: 100 founders released', 'birth'); };
function onSaved(m) {
  const kb = (m.state.length / 1024).toFixed(0);
  if (m.purpose === 'auto') { try { localStorage.setItem('alife.save', m.state); localStorage.setItem('alife.saveMeta', JSON.stringify({ ticks: m.ticks, at: Date.now(), kb })); showSaveInfo(); } catch {} return; }
  if (m.purpose === 'local') {
    try { localStorage.setItem('alife.save', m.state); localStorage.setItem('alife.saveMeta', JSON.stringify({ ticks: m.ticks, at: Date.now(), kb })); toast(`Saved at tick ${fmt(m.ticks)}`, 'info'); showSaveInfo(); }
    catch { toast('Browser storage is full or blocked. Use Download file instead.', 'death'); }
  } else {
    const url = URL.createObjectURL(new Blob([m.state], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `alife-tick-${m.ticks}.json`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${kb} KB snapshot`, 'info');
  }
}
function showSaveInfo() { const m = store.get('alife.saveMeta', null); $('saveInfo').textContent = m ? `Browser save: tick ${fmt(m.ticks)}, ${m.kb} KB, ${new Date(m.at).toLocaleString()}` : ''; }
showSaveInfo();
// embedded viewers (e.g. a hosted preview) block file downloads, so only offer it when the page is opened directly
let embedded = true; try { embedded = window.self !== window.top; } catch {}
if (embedded) $('sExport').hidden = true;

/* coach mark */
if (!store.get('alife.coached', false)) { $('coach').hidden = false; }
$('coachOk').onclick = () => { $('coach').hidden = true; store.set('alife.coached', true); };
cv.addEventListener('pointerdown', () => { if (!$('coach').hidden && $('coachResume').hidden) setTimeout(() => { $('coach').hidden = true; store.set('alife.coached', true); }, 2500); }, { once: true });

/* ================= charts ================= */
function setupCanvas(c) {
  const w = c.clientWidth, h = c.clientHeight; if (!w) return null;
  const d = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }
function lineChart(c, series, { min = 0, decimals = 0 } = {}) {
  const s = setupCanvas(c); if (!s) return; const { g, w, h } = s;
  const n = series[0].values.length; if (n < 2) { g.fillStyle = C.dim; g.font = '11px "Instrument Sans",sans-serif'; g.fillText('Collecting data…', 4, h / 2); return; }
  let mx = -Infinity, mn = Infinity; for (const sr of series) for (const v of sr.values) { if (v > mx) mx = v; if (v < mn) mn = v; }
  const lo = min === 'auto' ? Math.floor(mn * 10) / 10 : min, hi = niceMax(mx - lo) + lo;
  const L = 34, Rr = 8, T = 8, Bb = 18, pw = w - L - Rr, ph = h - T - Bb;
  const X = i => L + i / (n - 1) * pw, Y = v => T + ph - (v - lo) / (hi - lo) * ph;
  g.font = '10px "JetBrains Mono",monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
  const dec = decimals === 'auto' ? (hi - lo < 4 ? 1 : 0) : decimals;
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); g.strokeStyle = 'rgba(188,228,212,.08)'; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Math.round(y) + .5); g.lineTo(w - Rr, Math.round(y) + .5); g.stroke(); g.fillStyle = C.dim; g.fillText(v.toFixed(dec), L - 6, y); }
  const hist = stats.history; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(`t ${fmt(hist[0].t)}`, L, h - 4); g.textAlign = 'right'; g.fillText(`t ${fmt(hist[hist.length - 1].t)}`, w - Rr, h - 4);
  series.forEach((sr, si) => {
    g.beginPath(); sr.values.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
    if (si === 0 && sr.area !== false) { g.save(); g.lineTo(X(n - 1), Y(lo)); g.lineTo(X(0), Y(lo)); g.closePath(); const gr = g.createLinearGradient(0, T, 0, T + ph); gr.addColorStop(0, sr.color + '40'); gr.addColorStop(1, sr.color + '00'); g.fillStyle = gr; g.fill(); g.restore(); g.beginPath(); sr.values.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); }
    g.strokeStyle = sr.color; g.lineWidth = si === 0 ? 1.8 : 1.4; g.lineJoin = 'round'; g.stroke();
    const lv = sr.values[n - 1]; g.fillStyle = sr.color; g.beginPath(); g.arc(X(n - 1), Y(lv), 3, 0, TAU); g.fill();
  });
}

/* ================= stats drawer ================= */
const DEATHC = { age: C.muted, hunger: C.warn, storm: C.storm, fire: C.fire };
const DEATHL = { age: 'Old age', hunger: 'Starvation', storm: 'Storms', fire: 'Burns' };
function renderStats() {
  if (!stats) return;
  updateHud();
  if (!$('dStats').classList.contains('open')) return;
  const s = stats;
  $('fPop').textContent = s.pop; $('fPeak').textContent = s.peakPop;
  $('fGen').innerHTML = `${s.maxGen}<em> avg ${s.avgGen.toFixed(1)}</em>`;
  $('fBD').innerHTML = `${fmt(s.births)}<em> / ${fmt(s.deaths)}</em>`;
  const bt = s.byType; $('fBuilt').textContent = bt.house + bt.store + bt.wall + bt.fire;
  $('fBuiltSub').textContent = `${bt.house} houses · ${bt.store} stores · ${bt.wall} walls · ${bt.fire} fires`;
  $('statsSub').textContent = `Tick ${fmt(s.ticks)} · ${s.counts[0]} food · ${s.counts[1]} trees · ${s.counts[2]} stone`;
  const h = s.history || [];
  if (h.length) $('hSpan').textContent = `last ${fmt(h[h.length - 1].t - h[0].t)} ticks`;
  lineChart($('cPop'), [{ values: h.map(x => x.pop), color: C.good }, { values: h.map(x => x.build), color: C.house }]);
  lineChart($('cGen'), [{ values: h.map(x => x.gen), color: C.accent }], { decimals: 'auto' });
  lineChart($('cBody'), [{ values: h.map(x => x.str), color: C.bad, area: false }, { values: h.map(x => x.spd), color: C.store }, { values: h.map(x => x.sense / 100), color: C.wall }, { values: h.map(x => (x.neurons || 0) / 30), color: C.accent }], { min: 0, decimals: 1 });
  const tot = Object.values(s.deathsBy).reduce((a, b) => a + b, 0) || 1;
  $('deathStack').innerHTML = Object.entries(s.deathsBy).map(([k, v]) => `<i style="width:${v / tot * 100}%;background:${DEATHC[k]}"></i>`).join('');
  $('deathKey').innerHTML = Object.entries(s.deathsBy).map(([k, v]) => `<span><i style="background:${DEATHC[k]}"></i>${DEATHL[k]} <b class="num">${Math.round(v / tot * 100)}%</b></span>`).join('');
  $('sensBars').innerHTML = s.sensUse.filter(([k]) => k !== 'bias').slice(0, 10).map(([k, v]) => `<div class="bar"><div class="bt"><i style="width:${v * 100}%"></i><span>${meta.senses[k]}</span></div><b>${Math.round(v * 100)}%</b></div>`).join('');
  const mxA = Math.max(...s.actMix);
  $('actBars').innerHTML = s.actMix.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([v, i]) => `<div class="bar${v === mxA ? ' hl' : ''}"><div class="bt"><i style="width:${v / mxA * 100}%"></i><span>${meta.actions[i]}</span></div><b>${(v * 100).toFixed(1)}%</b></div>`).join('');
  $('elite').innerHTML = s.eliteTop.length ? s.eliteTop.map(e => `<span class="chip dead" title="Score ${e.score}"><i style="background:hsl(${e.hue|0} 72% 66%)"></i>#${e.id} · gen ${e.gen}</span>`).join('') : '<span class="note">Filled as agents die.</span>';
  $('log').innerHTML = s.events.slice(0, 30).map(e => `<div><time>${fmt(e.t)}</time><i style="background:${KCOL[e.kind] || C.muted}"></i><span>${esc(e.s)}</span></div>`).join('');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ================= inspector ================= */
let pane = 'pMind';
document.querySelectorAll('[data-pane]').forEach(b => b.onclick = () => { pane = b.dataset.pane; document.querySelectorAll('[data-pane]').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== pane); renderInspector(); });
const TRAITS = [['strength', 'Strength', .2, 3, 2], ['speed', 'Speed', .2, 3, 2], ['thermal', 'Thermal tol.', .2, 2.5, 2], ['sense', 'Sensing range', 30, 210, 0], ['social', 'Sociability', .2, 2.5, 2], ['budget', 'Body budget', 2, 15, 1], ['explore', 'Exploration', .02, 2.8, 2], ['lr', 'Learning rate', .0001, .15, 4]];
const SHORT = ['N', 'E', 'S', 'W', 'Harvest', 'Eat', 'Deposit', 'House', 'Store', 'Wall', 'Fire', 'Repair', 'Signal', 'Rest'];
function renderInspector() {
  const m = insp; if (!m || !$('dInspect').classList.contains('open')) return;
  const dead = m.none && m.id === selected;
  $('iBody').hidden = dead; $('iEmpty').hidden = !dead;
  if (dead) { $('iTitle').textContent = `#${m.id}`; $('iSub').textContent = 'No longer alive'; $('iBadges').innerHTML = ''; return; }
  if (m.none || m.id !== selected) return;
  const hue = m.traits.hue | 0;
  $('iSwatch').style.background = hueFill[hue]; $('iSwatch').style.setProperty('--hue', `hsl(${hue} 72% 66% / .5)`);
  $('iTitle').textContent = `Agent #${m.id}`;
  $('iSub').textContent = `Generation ${m.gen} · age ${fmt(m.age)} · ${m.kids} offspring`;
  const badges = [];
  badges.push(m.sheltered ? ['Sheltered', 'good'] : ['Exposed', '']);
  if (m.energy < 30) badges.push(['Starving', 'bad']); else if (m.energy > 135) badges.push(['Ready to breed', 'good']);
  if (m.health < 40) badges.push(['Injured', 'bad']);
  if (m.temp < 10) badges.push([`Cold ${m.temp.toFixed(0)}°`, 'warn']); else if (m.temp > 31) badges.push([`Hot ${m.temp.toFixed(0)}°`, 'warn']);
  $('iBadges').innerHTML = badges.map(([t, c]) => `<span class="badge ${c}">${t}</span>`).join('');
  meter('E', m.energy, 200, m.energy.toFixed(0)); meter('H', m.health, 100, m.health.toFixed(0));
  meter('A', m.age, m.lifespan, Math.round(m.age / m.lifespan * 100) + '%'); meter('L', m.load, m.cap, `${m.load.toFixed(1)}/${m.cap.toFixed(1)}`);
  if (pane === 'pMind') { drawBrain(m); probBars(m); }
  else if (pane === 'pBody') bodyPane(m);
  else if (pane === 'pSocial') socialPane(m);
  else linePane(m);
}
function meter(k, v, max, label) { $('v' + k).textContent = label; $('m' + k).style.width = clamp(v / max * 100, 0, 100) + '%'; }
function probBars(m) {
  const order = m.probs.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).slice(0, 6), mx = order[0][0];
  $('probBars').innerHTML = order.map(([p, i]) => `<div class="bar${i === m.lastChoice ? ' hl' : ''}"><div class="bt"><i style="width:${p / mx * 100}%"></i><span>${meta.actions[i]}${i === m.lastChoice ? ' · chosen' : ''}</span></div><b>${(p * 100).toFixed(1)}%</b></div>`).join('');
  $('iLayers').textContent = m.sizes.join(' → ');
}
function bodyPane(m) {
  const avg = stats ? stats.traits : {};
  $('traitList').innerHTML = TRAITS.map(([k, label, lo, hi, d]) => {
    const v = m.traits[k], f = clamp((v - lo) / (hi - lo), 0, 1), a = avg[k] != null ? clamp((avg[k] - lo) / (hi - lo), 0, 1) : null;
    return `<div class="trait"><span>${label}</span><div class="tr"><i style="width:${f * 100}%"></i>${a != null ? `<u style="left:${a * 100}%"></u>` : ''}</div><b>${v.toFixed(d)}</b></div>`;
  }).join('');
  const kv = [['Food carried', m.inv.food], ['Wood carried', m.inv.wood], ['Stone carried', m.inv.stone], ['Trait cost', m.cost.toFixed(2)], ['Metabolism', m.metab.toFixed(2) + '×'], ['Felt temp.', m.temp.toFixed(1) + '°C'], ['Built', m.builds], ['Harvested', m.success], ['Memory', m.memory.toFixed(2)], ['Lifespan', fmt(m.lifespan)], ['Last act', SHORT[m.lastChoice]], ['Position', `${m.x | 0}, ${m.y | 0}`]];
  $('bodyKV').innerHTML = kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}
function socialPane(m) {
  $('trustBars').innerHTML = m.trust.length ? m.trust.map(t => {
    const w = Math.abs(t.v) * 50, left = t.v < 0 ? 50 - w : 50;
    return `<div class="bar"><div class="bt" style="cursor:${t.alive ? 'pointer' : 'default'}" ${t.alive ? `data-goto="${t.id}"` : ''}><i style="left:${left}%;width:${w}%;background:${t.v < 0 ? 'rgba(242,131,111,.4)' : 'rgba(126,214,176,.35)'}"></i><span style="${t.alive ? '' : 'color:var(--dim)'}">#${t.id}${t.alive ? '' : ' · gone'}</span></div><b>${t.v > 0 ? '+' : ''}${t.v.toFixed(2)}</b></div>`;
  }).join('') : '<p class="note">No relationships yet. Trust forms when agents meet and signal.</p>';
  $('kidChips').innerHTML = m.livingKids.length ? m.livingKids.map(k => `<button class="chip" data-goto="${k.id}"><i style="background:${hueFill[k.hue | 0]}"></i>#${k.id}</button>`).join('') : '<p class="note">None alive right now.</p>';
}
function linePane(m) {
  const rows = [`<div><i class="nd" style="background:${hueFill[m.traits.hue | 0]};box-shadow:0 0 0 2px var(--accent)"></i><span>#${m.id} <b>this agent</b></span><small>gen ${m.gen}</small></div>`]
    .concat(m.lineage.map(l => l.alive ? `<button data-goto="${l.id}"><i class="nd" style="background:${hueFill[(l.hue | 0) % 360]}"></i><span>#${l.id} · alive</span><small>gen ${l.gen}</small></button>` : `<div><i class="nd" style="background:${l.hue ? hueFill[(l.hue | 0) % 360] : C.dim};opacity:.4"></i><span style="color:var(--muted)">#${l.id}</span><small>gen ${l.gen}</small></div>`));
  if (!m.lineage.length) rows.push('<p class="note">A founder: no recorded ancestors.</p>');
  $('chain').innerHTML = rows.join('');
}
$('dInspect').addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) setSelected(+g.dataset.goto); });

/* brain canvas */
let brainNodes = [], brainHover = null;
function drawBrain(m) {
  const c = $('brain'), s = setupCanvas(c); if (!s) return; const { g, w, h } = s;
  const L = m.sizes.length, padL = 78, padR = 66, padT = 22, padB = 12;
  const xs = m.sizes.map((_, l) => padL + l * (w - padL - padR) / (L - 1));
  const pos = m.sizes.map((n, l) => Array.from({ length: n }, (_, i) => ({ x: xs[l], y: n === 1 ? (padT + h - padB) / 2 : padT + i * (h - padT - padB) / (n - 1) })));
  brainNodes = [];
  const hv = brainHover;
  for (let l = 0; l < m.ws.length; l++) {
    const wl = m.ws[l], cols = m.sizes[l], rows = m.sizes[l + 1];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const v = wl[j * cols + i]; if (Math.abs(v) < .15) continue;
      const lit = hv && ((hv.l === l && hv.j === i) || (hv.l === l + 1 && hv.j === j));
      const a = clamp(Math.abs(v) / 2.4, .05, .7) * (hv ? (lit ? 1.4 : .25) : 1);
      g.strokeStyle = v > 0 ? `rgba(126,214,176,${a})` : `rgba(242,131,111,${a})`; g.lineWidth = .4 + Math.abs(v) * .55;
      const p = pos[l][i], q = pos[l + 1][j]; g.beginPath(); g.moveTo(p.x, p.y); g.bezierCurveTo((p.x + q.x) / 2, p.y, (p.x + q.x) / 2, q.y, q.x, q.y); g.stroke();
    }
  }
  g.font = '10px "JetBrains Mono",monospace'; g.textBaseline = 'middle';
  for (let l = 0; l < L; l++) {
    for (let j = 0; j < m.sizes[l]; j++) {
      const p = pos[l][j], v = m.acts[l][j] || 0, out = l === L - 1, chosen = out && j === m.lastChoice;
      const r = out ? 3 + m.probs[j] * 9 : 3.5 + Math.abs(v) * 2.5;
      g.beginPath(); g.arc(p.x, p.y, r, 0, TAU);
      g.fillStyle = out ? (chosen ? C.accent : `rgba(231,239,233,${.25 + m.probs[j] * 2})`) : v >= 0 ? `rgba(126,214,176,${.35 + Math.abs(v) * .65})` : `rgba(242,131,111,${.35 + Math.abs(v) * .65})`;
      g.fill(); if (chosen) { g.strokeStyle = C.accent; g.lineWidth = 1.2; g.beginPath(); g.arc(p.x, p.y, r + 3, 0, TAU); g.stroke(); }
      if (l === 0) { g.textAlign = 'right'; g.fillStyle = C.muted; g.fillText(m.inputs[j], p.x - 9, p.y); }
      if (out) { g.textAlign = 'left'; g.fillStyle = chosen ? C.accent : C.muted; g.fillText(SHORT[j], p.x + 12, p.y); }
      brainNodes.push({ x: p.x, y: p.y, l, j, v });
    }
    g.textAlign = 'center'; g.fillStyle = C.dim; g.font = '600 9px "Instrument Sans",sans-serif';
    g.fillText(l === 0 ? 'SENSES' : l === L - 1 ? 'ACTIONS' : `H${l}`, xs[l], 9); g.font = '10px "JetBrains Mono",monospace';
  }
}
$('brain').addEventListener('pointermove', e => {
  const r = $('brain').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const n = brainNodes.find(n => Math.hypot(n.x - x, n.y - y) < 9);
  brainHover = n ? { l: n.l, j: n.j } : null;
  if (!insp || insp.none) return;
  if (n) {
    const m = insp, L = m.sizes.length;
    const label = n.l === 0 ? `${m.inputs[n.j]} · ${meta.senses[m.inputs[n.j]]}` : n.l === L - 1 ? `${meta.actions[n.j]} · ${(m.probs[n.j] * 100).toFixed(1)}% chance` : `Hidden layer ${n.l}, neuron ${n.j + 1}`;
    let links = 0; if (n.l) { const cols = m.sizes[n.l - 1]; for (let i = 0; i < cols; i++) if (Math.abs(m.ws[n.l - 1][n.j * cols + i]) > .15) links++; }
    $('brainInfo').innerHTML = `<b>${esc(label)}</b> · activation ${n.v.toFixed(3)}${n.l ? ` · ${links} strong inputs` : ''}`;
  } else $('brainInfo').textContent = 'Hover a neuron to read it. Teal links excite, coral links inhibit.';
  drawBrain(insp);
});
$('brain').addEventListener('pointerleave', () => { brainHover = null; if (insp && !insp.none) drawBrain(insp); });
addEventListener('resize', () => { if (insp && !insp.none && pane === 'pMind') drawBrain(insp); renderStats(); });

/* ================= touch & quality of life ================= */
// swipe a bottom sheet down by its header to close it
document.querySelectorAll('.drawer .dh').forEach(h => {
  let y0 = null, id = null;
  h.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || e.target.closest('button')) return; y0 = e.clientY; id = e.pointerId; h.setPointerCapture(id); });
  h.addEventListener('pointermove', e => { if (y0 == null || e.pointerId !== id) return; const dy = Math.max(0, e.clientY - y0); if (window.getComputedStyle(h.parentElement).borderTopLeftRadius !== '16px') return; h.parentElement.style.transform = `translateY(${dy}px)`; h.parentElement.style.transition = 'none'; });
  const end = e => { if (y0 == null) return; const dy = e.clientY - y0, d = h.parentElement; d.style.transform = ''; d.style.transition = ''; y0 = null; if (dy > 70) closeDrawer(d.id); };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
});
// keep the screen awake while the colony runs (phones), released when paused
let wake = null;
async function syncWake() {
  try {
    if (running && document.visibilityState === 'visible' && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if ((!running || document.visibilityState !== 'visible') && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}
addEventListener('pointerdown', syncWake, { once: true });
const _setRunning = setRunning;
setRunning = v => { _setRunning(v); syncWake(); };
// pause while hidden, resume on return
let hiddenPaused = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (ui.hidePause && running) { hiddenPaused = true; _setRunning(false); } if (ui.auto) send('save', { purpose: 'auto' }); }
  else if (hiddenPaused) { hiddenPaused = false; _setRunning(true); }
  syncWake();
});
for (const [id, key] of [['oAuto', 'auto'], ['oHidePause', 'hidePause']]) { $(id).checked = ui[key]; $(id).onchange = () => { ui[key] = $(id).checked; store.set('alife.ui', ui); }; }
setInterval(() => { if (ui.auto && running && F && F.ticks > 200) send('save', { purpose: 'auto' }); }, 120000);
// touch-specific coach copy and resume prompt
if (isTouch) $('coachText').innerHTML = '<b>Tap an agent</b> to read its mind · <b>pinch</b> to zoom · <b>drag</b> to pan · <b>double-tap</b> to zoom in';
(() => {
  const m = store.get('alife.saveMeta', null);
  if (!m || !m.ticks) return;
  $('coach').hidden = false;
  $('coachText').innerHTML = `<b>Saved world found</b> · tick ${fmt(m.ticks)} from ${new Date(m.at).toLocaleDateString()}`;
  $('coachResume').hidden = false;
  $('coachResume').onclick = () => { $('sLoad').click(); $('coach').hidden = true; };
})();
