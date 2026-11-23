/**
 * Compact text encoding for pen strokes.
 *
 * Drawings are stored as vector strokes, not bitmaps, so a typical sketch is a few KB
 * instead of hundreds. Points are quantized to integers on a fixed 1000-unit-wide
 * virtual canvas, delta-encoded, zig-zagged and written as base64 varints
 * (5 payload bits per character). Small pen movements therefore cost ~2 chars per point.
 */

export const PEN_COLORS = ['#1f2328', '#d1242f', '#0969da', '#1a7f37', '#bf8700', '#8250df'] as const;
export const PEN_WIDTHS = [3, 6, 12] as const;
/** Color index used by the eraser (drawn with destination-out). */
export const ERASER_COLOR = 255;
export const CANVAS_UNITS = 1000;

export interface Stroke {
  color: number; // index into PEN_COLORS, or ERASER_COLOR
  width: number; // index into PEN_WIDTHS
  points: number[]; // flat [x0, y0, x1, y1, ...] integer coordinates
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;
const VERSION = '1';

function writeUint(out: string[], n: number): void {
  do {
    let chunk = n & 31;
    n = Math.floor(n / 32);
    if (n > 0) chunk |= 32;
    out.push(ALPHABET[chunk]);
  } while (n > 0);
}

function writeInt(out: string[], n: number): void {
  writeUint(out, n < 0 ? -2 * n - 1 : 2 * n);
}

export function encodeStrokes(strokes: Stroke[]): string {
  if (strokes.length === 0) return '';
  const out: string[] = [VERSION];
  for (const s of strokes) {
    const n = Math.floor(s.points.length / 2);
    if (n === 0) continue;
    writeUint(out, s.color);
    writeUint(out, s.width);
    writeUint(out, n);
    let px = 0;
    let py = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.round(s.points[2 * i]);
      const y = Math.round(s.points[2 * i + 1]);
      writeInt(out, x - px);
      writeInt(out, y - py);
      px = x;
      py = y;
    }
  }
  return out.join('');
}

export function decodeStrokes(data: string): Stroke[] {
  if (!data) return [];
  if (data[0] !== VERSION) throw new Error('Unknown sketch format');
  let pos = 1;
  const readUint = (): number => {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (pos >= data.length) throw new Error('Truncated sketch data');
      const v = LOOKUP[data[pos++]];
      if (v === undefined) throw new Error('Invalid sketch data');
      result += (v & 31) * mul;
      if (!(v & 32)) return result;
      mul *= 32;
    }
  };
  const readInt = (): number => {
    const z = readUint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  };
  const strokes: Stroke[] = [];
  while (pos < data.length) {
    const color = readUint();
    const width = readUint();
    const n = readUint();
    const points = new Array<number>(n * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      x += readInt();
      y += readInt();
      points[2 * i] = x;
      points[2 * i + 1] = y;
    }
    strokes.push({ color, width, points });
  }
  return strokes;
}

/**
 * Drop points that are closer than `minDist` to the previously kept point.
 * Keeps the last point so strokes end where the pen lifted.
 */
export function simplifyPoints(points: number[], minDist = 2): number[] {
  if (points.length <= 4) return points.slice();
  const out = [points[0], points[1]];
  const min2 = minDist * minDist;
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2];
    const dy = points[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= min2) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}
