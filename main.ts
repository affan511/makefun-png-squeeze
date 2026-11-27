// png-squeeze-01 entry: lossless PNG re-encoder.
// Strategy: colour-type reduction (palette / grey / grey+alpha / RGB / RGBA, tRNS key),
// per-row filter choice (fixed, min-sum, fewest-pairs, brute-force by real deflate cost),
// screened at zlib level 1, winner re-deflated at level 9 / memLevel 9 with the best
// of the default and filtered strategies. Pure Node built-ins, deterministic, no clock.
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- CRC32 / PNG chunks ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function ihdrOf(w: number, h: number, ct: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  d[8] = 8; d[9] = ct; d[10] = 0; d[11] = 0; d[12] = 0;
  return d;
}
function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [sig, ...chunks.map(([t, d]) => chunk(t, d))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- PNG decode (input is stored RGBA, type 6, 8-bit) ----------
function paeth(left: number, above: number, upLeft: number): number {
  const p = left + above - upLeft;
  const pl = Math.abs(p - left), pa = Math.abs(p - above), pu = Math.abs(p - upLeft);
  if (pl <= pa && pl <= pu) return left;
  if (pa <= pu) return above;
  return upLeft;
}
function decodePng(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, ct = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0); height = dv.getUint32(4);
      bitDepth = data[8]; ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (ct !== 6 || bitDepth !== 8) throw new Error('input is not 8-bit RGBA PNG');
  const total = idat.reduce((a, p) => a + p.length, 0);
  const comp = new Uint8Array(total);
  let o = 0;
  for (const p of idat) { comp.set(p, o); o += p.length; }
  const raw = inflateSync(comp);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      const v = raw[rp + x];
      if (f === 0) row[x] = v;
      else if (f === 1) row[x] = (v + a) & 0xff;
      else if (f === 2) row[x] = (v + b) & 0xff;
      else if (f === 3) row[x] = (v + ((a + b) >> 1)) & 0xff;
      else row[x] = (v + paeth(a, b, c)) & 0xff;
    }
    rp += stride;
  }
  return { rgba, width, height };
}

// ---------- filters ----------
function filterRow(t: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  for (let x = 0; x < n; x++) {
    const left = x >= bpp ? cur[x - bpp] : 0;
    const up = prev ? prev[x] : 0;
    const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
    let pred = 0;
    if (t === 1) pred = left;
    else if (t === 2) pred = up;
    else if (t === 3) pred = (left + up) >> 1;
    else if (t === 4) pred = paeth(left, up, upLeft);
    out[x] = (cur[x] - pred) & 0xff;
  }
}
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---------- image analysis (as the kit's scale compressor) ----------
function wordsOf(rgba: Uint8Array): Uint32Array {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}
type Colour = { rgba: number[]; word: number; count: number };
function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteOrder(colours: Colour[], order: string): Colour[] {
  const lum = (c: Colour) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

// ---------- filtering ----------
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}
type FilterChoice = number | 'minsum' | 'pairs' | 'brute';
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice, raw?: Uint8Array): Uint8Array {
  const stride = width * bpp;
  const out = raw ?? new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) { const r = new Uint8Array(stride + 1); r[0] = t; trial.push(r); }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterRow(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    out.set(trial[type], at);
  }
  return out;
}

// ---------- forms & screen ----------
type Form = { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; filters: FilterChoice[] };
const FILTERS = {
  palette: [0] as FilterChoice[],
  paletteByLuminance: [0, 'minsum', 'brute'] as FilterChoice[],
  channels: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] as FilterChoice[],
};
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', FILTERS.palette], ['luminance', FILTERS.paletteByLuminance]] as const) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number, trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}
const chunkBytes = (f: Form) => (f.plte === null ? 0 : 12 + f.plte.length) + (f.trns === null ? 0 : 12 + f.trns.length);
const RANK = { level: 1, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
function screen(rgba: Uint8Array, width: number, height: number): { form: Form; data: Uint8Array } {
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  let spare: Uint8Array | null = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const bytes = deflateSync(data, RANK).length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, data, bytes };
      } else spare = data;
    }
  }
  return { form: (best as { form: Form }).form, data: (best as { data: Uint8Array }).data };
}
function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}
function bestDeflate(data: Uint8Array): Uint8Array {
  let best: Uint8Array | null = null;
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
    for (const memLevel of [9, 8]) {
      const z = deflateSync(data, { level: 9, memLevel, strategy });
      if (best === null || z.length < best.length) best = z;
    }
  }
  return best as Uint8Array;
}

// ---------- main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const { form, data } = screen(image.rgba, image.width, image.height);
  const png = pngOfForm(image.width, image.height, form, bestDeflate(data));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
