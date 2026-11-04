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
  return { encode, decode };
})();
if (typeof module !== 'undefined') module.exports = CODEC;
