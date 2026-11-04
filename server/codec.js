// Binary message codec shared by the sim server and the page.
// A message is any JSON-able object whose fields may also be typed arrays (frames, terrain).
// Layout: [u32 json byte length][json][padding to 8][typed array bytes, each 8-aligned].
// Typed arrays are replaced in the JSON by {"$ta":[kind, byteOffset, length]}.
const CODEC = (() => {
  const KINDS = ['Float32Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float64Array', 'Int8Array', 'Uint8ClampedArray'];
  const CTOR = KINDS.map(k => globalThis[k]);
  const pad8 = n => (n + 7) & ~7;
  function encode(msg) {
    const parts = []; let off = 0;
    const json = JSON.stringify(msg, function (k, v) {
      if (v && ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        const kind = KINDS.indexOf(v.constructor.name); if (kind < 0) return Array.from(v);
        const at = off; parts.push(v); off = pad8(off + v.byteLength); return { $ta: [kind, at, v.length] };
      }
      return v;
    });
    const jb = new TextEncoder().encode(json), head = pad8(4 + jb.length), out = new Uint8Array(head + off);
    new DataView(out.buffer).setUint32(0, jb.length, true); out.set(jb, 4);
    let at = head; for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at); at = pad8(at + p.byteLength); }
    return out;
  }
  function decode(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const ab = u8.byteOffset % 8 ? new Uint8Array(u8).buffer : u8.buffer, base = u8.byteOffset % 8 ? 0 : u8.byteOffset;
    const n = new DataView(ab, base, 4).getUint32(0, true), head = pad8(4 + n);
    const json = new TextDecoder().decode(new Uint8Array(ab, base + 4, n));
    return JSON.parse(json, (k, v) => v && v.$ta ? new CTOR[v.$ta[0]](ab.slice(base + head + v.$ta[1], base + head + v.$ta[1] + v.$ta[2] * CTOR[v.$ta[0]].BYTES_PER_ELEMENT)) : v);
  }
  // Trim a frame for a remote viewer: yips on (or near) its screen and around its selected yip every frame,
  // food, wood, stone and buildings on screen about once a second and across the whole map every few seconds,
  // pheromones only if that viewer shows them. v = { rect:[x0,y0,x1,y1], sel, scent, tI, tIf, tB, tBf, tP } (timers are kept on v).
  function cull(m, v, now) {
    const r = v.rect; if (!r) return m;
    const out = {}; for (const k in m) if (k !== 'A' && k !== 'I' && k !== 'B' && k !== 'P') out[k] = m[k];
    const pick = (src, stride, keep) => { let n = 0; for (let o = 0; o < src.length; o += stride) if (keep(src, o)) n++; const dst = new Float32Array(n * stride); let p = 0; for (let o = 0; o < src.length; o += stride) if (keep(src, o)) { dst.set(src.subarray(o, o + stride), p); p += stride; } return dst; };
    const inR = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    let sx = NaN, sy = NaN;
    if (v.sel) for (let o = 0; o < m.A.length; o += 10) if (m.A[o] === v.sel) { sx = m.A[o + 1]; sy = m.A[o + 2]; break; }
    out.A = pick(m.A, 10, (A, o) => inR(A[o + 1], A[o + 2]) || A[o] === v.sel || (sx === sx && Math.abs(A[o + 1] - sx) < 170 && Math.abs(A[o + 2] - sy) < 170));
    out.vr = r;
    if (now - (v.tIf || 0) > 6000) { out.I = m.I; out.fullI = true; v.tIf = v.tI = now; }
    else if (now - (v.tI || 0) > 1000) { out.I = pick(m.I, 4, (I, o) => inR(I[o + 1], I[o + 2])); v.tI = now; }
    if (now - (v.tBf || 0) > 6000) { out.B = m.B; out.fullB = true; v.tBf = v.tB = now; }
    else if (now - (v.tB || 0) > 1000) { out.B = pick(m.B, 9, (B, o) => inR(B[o + 1], B[o + 2])); v.tB = now; }
    if (m.P && v.scent && now - (v.tP || 0) > 3000) { out.P = m.P; v.tP = now; }
    return out;
  }
  // stats and inspector updates are throttled per remote viewer too
  function due(v, key, gap, now) { if (now - (v[key] || 0) < gap) return false; v[key] = now; return true; }
  return { encode, decode, cull, due };
})();
if (typeof module !== 'undefined') module.exports = CODEC;
