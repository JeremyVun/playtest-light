import { inflateSync } from 'node:zlib';

export type Grey = { width: number; height: number; pixels: Float64Array };

// Decodes an 8-bit, non-interlaced PNG (what Chrome emits) to luminance.
export function decodePngGrey(png: Buffer): Grey {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`unsupported PNG: bit depth ${data[8]}, interlace ${data[12]}`);
      colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const current = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);
  const pixels = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      let r: number, g: number, bl: number;
      if (colorType === 3) {
        r = palette![current[i] * 3];
        g = palette![current[i] * 3 + 1];
        bl = palette![current[i] * 3 + 2];
      } else if (channels < 3) r = g = bl = current[i];
      else [r, g, bl] = [current[i], current[i + 1], current[i + 2]];
      pixels[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * bl;
    }
    current.copy(previous);
  }
  return { width, height, pixels };
}

function areaAverage(img: Grey, cols: number, rows: number): Float64Array {
  const out = new Float64Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * img.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * img.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / cols));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += img.pixels[y * img.width + x];
      out[gy * cols + gx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

export const GRID = 8;

// 16 hex digits of difference hash, then GRID×GRID hex digits of mean grey (4 bits each).
export function fingerprintOf(png: Buffer): string {
  const img = decodePngGrey(png);
  const small = areaAverage(img, 9, 8);
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (small[y * 9 + x] > small[y * 9 + x + 1] ? 1n : 0n);
  const grid = [...areaAverage(img, GRID, GRID)].map((v) => Math.min(15, Math.floor(v / 16)).toString(16)).join('');
  return hash.toString(16).padStart(16, '0') + grid;
}

// Hamming distance of the hashes plus the summed grey-level difference of the grid.
export function fingerprintDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let bits = BigInt(`0x${a.slice(0, 16)}`) ^ BigInt(`0x${b.slice(0, 16)}`);
  let distance = 0;
  for (; bits; bits &= bits - 1n) distance++;
  for (let i = 16; i < a.length; i++) distance += Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16));
  return distance;
}

// Repeat captures measured 0 apart (same machine, across browser launches); a typed password moved a step by 1.
export const FINGERPRINT_THRESHOLD = 2;

export function fingerprintsMatch(a: string, b: string): boolean {
  return fingerprintDistance(a, b) <= FINGERPRINT_THRESHOLD;
}
