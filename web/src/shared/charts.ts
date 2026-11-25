// Minimal canvas charts, sized for being filmed: thick lines, big labels.

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  axis?: 'left' | 'right';
  step?: boolean;
  width?: number;
  dash?: number[];
}

function setup(canvas: HTMLCanvasElement, height: number) {
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  // The Console scales itself up with CSS zoom on big screens (4K); size the backing store to the
  // pixels actually on screen so lines and labels stay sharp.
  const shown = canvas.getBoundingClientRect().width;
  const zoom = shown > 0 && canvas.clientWidth > 0 ? shown / canvas.clientWidth : 1;
  const dpr = Math.min(4, Math.max(1, (window.devicePixelRatio || 1) * zoom));
  canvas.style.height = `${height}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export function lineChart(
  canvas: HTMLCanvasElement,
  series: Series[],
  o: { height?: number; xLabel?: string; yLabel?: string; y2Label?: string; xMax?: number; yMax?: number; y2Max?: number; yFmt?: (v: number) => string; y2Integer?: boolean } = {},
) {
  const { ctx, w, h } = setup(canvas, o.height ?? 260);
  const pad = { l: 58, r: series.some((s) => s.axis === 'right') ? 50 : 16, t: 14, b: 40 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const all = (ax: 'left' | 'right') => series.filter((s) => (s.axis ?? 'left') === ax).flatMap((s) => s.points);
  const xMax = o.xMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p[0]))));
  const yMax = o.yMax ?? niceMax(Math.max(0.001, ...all('left').map((p) => p[1])) * 1.1);
  const y2Max = o.y2Max ?? Math.max(1, ...all('right').map((p) => p[1])) + (o.y2Integer ? 1 : 0);
  const X = (x: number) => pad.l + (x / xMax) * pw;
  const Y = (y: number, ax: 'left' | 'right' = 'left') => pad.t + ph - (y / (ax === 'left' ? yMax : y2Max)) * ph;
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.strokeStyle = '#26324d';
  ctx.fillStyle = '#9fb0c8';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(o.yFmt ? o.yFmt(v) : v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 0 : 1), pad.l - 8, y);
  }
  if (series.some((s) => s.axis === 'right')) {
    ctx.textAlign = 'left';
    const step = o.y2Integer ? Math.max(1, Math.ceil(y2Max / 5)) : y2Max / 4;
    for (let v = 0; v <= y2Max + 1e-9; v += step) ctx.fillText(o.y2Integer ? String(Math.round(v)) : v.toFixed(1), w - pad.r + 8, Y(v, 'right'));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let k = 0; k <= 5; k++) {
    const v = (xMax * k) / 5;
    ctx.fillText(v >= 10 ? v.toFixed(0) : v.toFixed(1), X(v), h - pad.b + 6);
  }
  if (o.xLabel) ctx.fillText(o.xLabel, pad.l + pw / 2, h - 18);
  if (o.yLabel) {
    ctx.save();
    ctx.translate(14, pad.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(o.yLabel, 0, -6);
    ctx.restore();
  }
  if (o.y2Label) {
    ctx.save();
    ctx.translate(w - 10, pad.t + ph / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(o.y2Label, 0, -6);
    ctx.restore();
  }
  for (const s of series) {
    if (!s.points.length) continue;
    const ax = s.axis ?? 'left';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 3.5;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    s.points.forEach(([x, y], k) => {
      if (k === 0) ctx.moveTo(X(x), Y(y, ax));
      else if (s.step) {
        ctx.lineTo(X(x), Y(s.points[k - 1][1], ax));
        ctx.lineTo(X(x), Y(y, ax));
      } else ctx.lineTo(X(x), Y(y, ax));
    });
    ctx.stroke();
    if (s.points.length === 1) {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(X(s.points[0][0]), Y(s.points[0][1], ax), 5, 0, 7);
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
}

export function barChart(
  canvas: HTMLCanvasElement,
  bars: { label: string; value: number; color: string; note?: string }[],
  o: { height?: number; max?: number; ideal?: (label: string) => number | null; fmt?: (v: number) => string } = {},
) {
  const { ctx, w, h } = setup(canvas, o.height ?? 220);
  const pad = { l: 16, r: 16, t: 34, b: 34 };
  const n = Math.max(1, bars.length);
  const gap = 18;
  const bw = Math.min(140, (w - pad.l - pad.r - gap * (n - 1)) / n);
  const total = bw * n + gap * (n - 1);
  const x0 = pad.l + (w - pad.l - pad.r - total) / 2;
  const ideals = o.ideal ? bars.map((b) => o.ideal!(b.label) ?? 0) : [];
  const max = o.max ?? niceMax(Math.max(1, ...bars.map((b) => b.value), ...ideals) * 1.08);
  const ph = h - pad.t - pad.b;
  ctx.textAlign = 'center';
  bars.forEach((b, k) => {
    const x = x0 + k * (bw + gap);
    const bh = (b.value / max) * ph;
    if (o.ideal) {
      const iv = o.ideal(b.label);
      if (iv) {
        ctx.strokeStyle = '#9fb0c8';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2;
        ctx.strokeRect(x, pad.t + ph - (iv / max) * ph, bw, (iv / max) * ph);
        ctx.setLineDash([]);
      }
    }
    ctx.fillStyle = b.color;
    ctx.fillRect(x, pad.t + ph - bh, bw, bh);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '800 20px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(o.fmt ? o.fmt(b.value) : b.value.toFixed(1), x + bw / 2, pad.t + ph - bh - 4);
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillStyle = '#9fb0c8';
    ctx.textBaseline = 'top';
    ctx.fillText(b.label, x + bw / 2, h - pad.b + 8);
  });
}
