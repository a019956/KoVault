import { describe, expect, it } from 'vitest';
import { decodeStrokes, encodeStrokes, simplifyPoints, ERASER_COLOR, type Stroke } from '../src/data/strokeCodec';

describe('strokeCodec', () => {
  it('round-trips strokes, including negative deltas and large coordinates', () => {
    const strokes: Stroke[] = [
      { color: 0, width: 1, points: [10, 20, 11, 22, 9, 19, 999, 4000] },
      { color: ERASER_COLOR, width: 2, points: [0, 0] },
      { color: 5, width: 0, points: [500, 500, 400, 600, 123456, 7] },
    ];
    expect(decodeStrokes(encodeStrokes(strokes))).toEqual(strokes);
  });

  it('is compact: ~2 chars per small pen movement', () => {
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push(100 + i, 200 + Math.round(Math.sin(i / 10) * 5));
    const enc = encodeStrokes([{ color: 1, width: 1, points: pts }]);
    expect(enc.length).toBeLessThan(500 * 2 * 1.1 + 20);
    // JSON for the same data would be several times larger.
    expect(enc.length * 3).toBeLessThan(JSON.stringify(pts).length);
  });

  it('handles empty input and rejects garbage', () => {
    expect(encodeStrokes([])).toBe('');
    expect(decodeStrokes('')).toEqual([]);
    expect(() => decodeStrokes('9abc')).toThrow();
    expect(() => decodeStrokes('1B')).toThrow();
  });

  it('simplifies nearby points but keeps endpoints', () => {
    const out = simplifyPoints([0, 0, 0.5, 0.5, 1, 1, 5, 5, 5.2, 5.1, 9, 9], 2);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(out.slice(-2)).toEqual([9, 9]);
    expect(out.length).toBeLessThan(12);
  });
});
