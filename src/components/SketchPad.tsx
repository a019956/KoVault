import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CANVAS_UNITS,
  ERASER_COLOR,
  PEN_COLORS,
  PEN_WIDTHS,
  decodeStrokes,
  encodeStrokes,
  simplifyPoints,
  type Stroke,
} from '../data/strokeCodec';

type Tool = 'pen' | 'eraser' | 'hand';

const MIN_HEIGHT_UNITS = 1300;
const PAGE_GROW = 600;
const ERASER_SCALE = 4;

interface Props {
  data: string;
  onChange: (data: string) => void;
}

function strokeWidth(s: Stroke): number {
  const w = PEN_WIDTHS[s.width] ?? PEN_WIDTHS[1];
  return s.color === ERASER_COLOR ? w * ERASER_SCALE : w;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number) {
  const p = s.points;
  if (p.length < 2) return;
  ctx.globalCompositeOperation = s.color === ERASER_COLOR ? 'destination-out' : 'source-over';
  ctx.strokeStyle = PEN_COLORS[s.color] ?? PEN_COLORS[0];
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = strokeWidth(s) * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0] * scale, p[1] * scale, (ctx.lineWidth / 2) || 1, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Smooth the polyline with quadratic curves through segment midpoints.
  ctx.beginPath();
  ctx.moveTo(p[0] * scale, p[1] * scale);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = ((p[i] + p[i + 2]) / 2) * scale;
    const my = ((p[i + 1] + p[i + 3]) / 2) * scale;
    ctx.quadraticCurveTo(p[i] * scale, p[i + 1] * scale, mx, my);
  }
  ctx.lineTo(p[p.length - 2] * scale, p[p.length - 1] * scale);
  ctx.stroke();
}

export function SketchPad({ data, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const redo = useRef<Stroke[]>([]);
  const current = useRef<{ stroke: Stroke; pointerId: number } | null>(null);
  const lastData = useRef<string | null>(null);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(0);
  const [width, setWidth] = useState(1);
  const [heightUnits, setHeightUnits] = useState(MIN_HEIGHT_UNITS);
  const [cssWidth, setCssWidth] = useState(0);
  const [, force] = useState(0);

  const scale = cssWidth / CANVAS_UNITS;

  // Decode incoming data (initial load, or a newer version from sync).
  useEffect(() => {
    if (data === lastData.current) return;
    lastData.current = data;
    try {
      strokes.current = decodeStrokes(data);
    } catch {
      strokes.current = [];
    }
    redo.current = [];
    let maxY = 0;
    for (const s of strokes.current) for (let i = 1; i < s.points.length; i += 2) maxY = Math.max(maxY, s.points[i]);
    setHeightUnits((h) => Math.max(h, MIN_HEIGHT_UNITS, Math.ceil((maxY + PAGE_GROW / 2) / 100) * 100));
    force((n) => n + 1);
  }, [data]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCssWidth(el.clientWidth));
    ro.observe(el);
    setCssWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cssWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const cssH = heightUnits * scale;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssH);
    for (const s of strokes.current) drawStroke(ctx, s, scale);
    if (current.current) drawStroke(ctx, current.current.stroke, scale);
  }, [cssWidth, heightUnits, scale]);

  useEffect(() => {
    redraw();
  });

  const commit = () => {
    const enc = encodeStrokes(strokes.current);
    lastData.current = enc;
    onChange(enc);
    force((n) => n + 1);
  };

  const toUnits = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / scale), Math.round((e.clientY - r.top) / scale)];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'hand' || current.current || !scale) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toUnits(e);
    current.current = {
      pointerId: e.pointerId,
      stroke: { color: tool === 'eraser' ? ERASER_COLOR : color, width, points: [x, y] },
    };
    redraw();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = current.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const [x, y] = toUnits(ev);
      const p = cur.stroke.points;
      if (p[p.length - 2] !== x || p[p.length - 1] !== y) p.push(x, y);
    }
    redraw();
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = current.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    current.current = null;
    cur.stroke.points = simplifyPoints(cur.stroke.points, 1.5);
    strokes.current.push(cur.stroke);
    redo.current = [];
    // Grow the page when drawing near the bottom.
    const maxY = Math.max(...cur.stroke.points.filter((_, i) => i % 2 === 1));
    if (maxY > heightUnits - 200) setHeightUnits((h) => h + PAGE_GROW);
    commit();
  };

  const undo = () => {
    const s = strokes.current.pop();
    if (s) {
      redo.current.push(s);
      commit();
    }
  };
  const redoOne = () => {
    const s = redo.current.pop();
    if (s) {
      strokes.current.push(s);
      commit();
    }
  };
  const clear = () => {
    if (!strokes.current.length || !confirm('Clear the whole drawing?')) return;
    redo.current = [...strokes.current].reverse();
    strokes.current = [];
    commit();
  };

  return (
    <div className="sketch">
      <div className="sketch-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="group">
          <button className={tool === 'pen' ? 'active' : ''} aria-pressed={tool === 'pen'} title="Pen" onClick={() => setTool('pen')}>
            ✒️
          </button>
          <button className={tool === 'eraser' ? 'active' : ''} aria-pressed={tool === 'eraser'} title="Eraser" onClick={() => setTool('eraser')}>
            🧽
          </button>
          <button className={tool === 'hand' ? 'active' : ''} aria-pressed={tool === 'hand'} title="Scroll (don't draw)" onClick={() => setTool('hand')}>
            ✋
          </button>
        </div>
        <div className="group">
          {PEN_COLORS.map((c, i) => (
            <button
              key={c}
              className={`swatch ${color === i && tool === 'pen' ? 'active' : ''}`}
              style={{ background: c }}
              aria-label={`Color ${i + 1}`}
              aria-pressed={color === i}
              onClick={() => {
                setColor(i);
                setTool('pen');
              }}
            />
          ))}
        </div>
        <div className="group">
          {PEN_WIDTHS.map((w, i) => (
            <button key={w} className={width === i ? 'active' : ''} aria-label={`Stroke width ${i + 1}`} aria-pressed={width === i} onClick={() => setWidth(i)}>
              <span className="width-dot" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
        </div>
        <div className="group">
          <button title="Undo" aria-label="Undo" disabled={!strokes.current.length} onClick={undo}>
            ↶
          </button>
          <button title="Redo" aria-label="Redo" disabled={!redo.current.length} onClick={redoOne}>
            ↷
          </button>
          <button title="Clear drawing" aria-label="Clear drawing" disabled={!strokes.current.length} onClick={clear}>
            🗑
          </button>
        </div>
      </div>
      <div ref={wrapRef} className="sketch-canvas-wrap">
        <canvas
          ref={canvasRef}
          className={`sketch-canvas tool-${tool}`}
          style={{ touchAction: tool === 'hand' ? 'pan-x pan-y' : 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
      <p className="hint center">
        {data.length.toLocaleString()} bytes · {strokes.current.length} strokes
      </p>
    </div>
  );
}
