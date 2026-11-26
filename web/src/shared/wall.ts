// Screen Wall: several device screens side by side show one continuous picture.
// Pure layout + drawing code shared by the node page (each device draws its slice),
// the Console (preview of the whole wall) and the tests (slices must line up).

import type { WallScene } from './protocol';

export interface WallDevice {
  id: string;
  w: number; // CSS px
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Devices left to right with `gap` px between them (the bezels), vertically centred. */
export function wallLayout(devices: WallDevice[], gap: number) {
  const H = Math.max(1, ...devices.map((d) => d.h));
  const slots = new Map<string, Rect>();
  let x = 0;
  devices.forEach((d, k) => {
    if (k > 0) x += gap;
    slots.set(d.id, { x, y: Math.round((H - d.h) / 2), w: d.w, h: d.h });
    x += d.w;
  });
  return { canvas: { w: Math.max(1, x), h: H }, slots };
}

/** Where the picture sits in the shared canvas: cover the whole wall, centred (cropped, never stretched). */
export function coverRect(imgW: number, imgH: number, canvas: { w: number; h: number }): Rect {
  const s = Math.max(canvas.w / imgW, canvas.h / imgH);
  const w = imgW * s;
  const h = imgH * s;
  return { x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h };
}

// ---------- block font: identical on every device (system fonts differ and would not line up) ----------
const GLYPHS: Record<string, string[]> = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};
const WORD = 'RECOMPUTE';

/** The wordmark as cells in the shared canvas. Spans ~86% of the wall width. */
export function wordmarkCells(canvas: { w: number; h: number }) {
  const cols = WORD.length * 6 - 1;
  const cell = Math.max(2, Math.min((canvas.w * 0.86) / cols, (canvas.h * 0.42) / 7));
  const x0 = (canvas.w - cols * cell) / 2;
  const y0 = (canvas.h - 7 * cell) / 2;
  const cells: { x: number; y: number; s: number }[] = [];
  [...WORD].forEach((ch, k) => {
    GLYPHS[ch].forEach((row, r) => {
      for (let c = 0; c < 5; c++) if (row[c] === '1') cells.push({ x: x0 + (k * 6 + c) * cell, y: y0 + r * cell, s: cell });
    });
  });
  return cells;
}

// ---------- timing ----------
export const WAKE_STEP_MS = 900;
export const WAKE_PULSE_MS = 1100;
export const FADE_MS = 1400;
export const SWEEP_MS = 3200;
export const SWEEP_PAUSE_MS = 1600;

export function wakeEnd(count: number) {
  return count * WAKE_STEP_MS + 900;
}
/** When the 'show' scene switches from the picture to the wordmark sweep. */
export function showSweepStart(count: number) {
  return wakeEnd(count) + FADE_MS + 3500;
}

export interface WallState {
  scene: WallScene;
  at: number; // Hub clock ms when the scene starts
  slot: Rect; // this screen's rectangle in the shared canvas
  canvas: { w: number; h: number };
  index: number;
  count: number;
}

const TEAL = [45, 212, 191];
const GLOW = [184, 255, 240]; // brightest colour we ever draw: never pure white (keeps phone cameras from pumping exposure)

const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/**
 * Draw this device's slice of the wall at Hub time `now`. `ctx` is already scaled so that
 * 1 unit = 1 CSS px of this screen, origin top-left of the screen.
 */
export function drawWall(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, st: WallState, now: number, img: CanvasImageSource | null, imgSize: { w: number; h: number } | null) {
  const { slot, canvas } = st;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, slot.w, slot.h);
  ctx.translate(-slot.x, -slot.y);
  const t = now - st.at;
  if (st.scene === 'black' || st.scene === 'off' || t < 0) {
    ctx.restore();
    return;
  }
  const picture = (alpha: number, dim = 1) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    if (img && imgSize) {
      const r = coverRect(imgSize.w, imgSize.h, canvas);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
    } else {
      const g = ctx.createLinearGradient(0, 0, canvas.w, canvas.h);
      g.addColorStop(0, '#0b1220');
      g.addColorStop(0.5, '#123a4a');
      g.addColorStop(1, '#2a1240');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.w, canvas.h);
    }
    if (dim < 1) {
      ctx.globalAlpha = alpha * (1 - dim);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.w, canvas.h);
    }
    ctx.globalAlpha = 1;
  };

  if (st.scene === 'image') {
    picture(ease(t / FADE_MS));
  } else if (st.scene === 'wake' || st.scene === 'show') {
    const end = wakeEnd(st.count);
    const sweepAt = st.scene === 'show' ? showSweepStart(st.count) : Infinity;
    if (t < end + FADE_MS) wakePulse(ctx, st, t);
    if (t >= end) {
      const a = ease((t - end) / FADE_MS);
      if (t < sweepAt) picture(a);
      else sweep(ctx, st, t - sweepAt, picture);
    }
  } else if (st.scene === 'sweep') {
    sweep(ctx, st, t, picture);
  }
  ctx.restore();
}

/** Each screen wakes in turn: a soft teal ring grows from its centre. */
function wakePulse(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, st: WallState, t: number) {
  const { slot } = st;
  const local = t - st.index * WAKE_STEP_MS;
  if (local < 0) return;
  const cx = slot.x + slot.w / 2;
  const cy = slot.y + slot.h / 2;
  const R = Math.hypot(slot.w, slot.h) / 2;
  const p = clamp01(local / WAKE_PULSE_MS);
  // base glow that stays on after the pulse
  const base = ease(local / 600) * 0.55;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, rgba([18, 60, 70], base));
  g.addColorStop(1, rgba([6, 14, 24], base));
  ctx.fillStyle = g;
  ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
  if (p < 1) {
    const r = 8 + p * R * 1.1;
    ctx.lineWidth = Math.max(3, Math.min(slot.w, slot.h) * 0.03) * (1 - p * 0.6);
    ctx.strokeStyle = rgba(TEAL, (1 - p) * 0.9);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // a small steady dot: "this device is on the wall"
  ctx.fillStyle = rgba(GLOW, 0.75 * ease(local / 400));
  const d = Math.max(4, Math.min(slot.w, slot.h) * 0.018);
  ctx.beginPath();
  ctx.arc(cx, cy, d, 0, Math.PI * 2);
  ctx.fill();
}

/** The RECOMPUTE wordmark across all screens, lit by a glow band moving left → right. */
function sweep(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, st: WallState, t: number, picture: (a: number, dim?: number) => void) {
  const { canvas } = st;
  picture(1, 0.28);
  const cycle = SWEEP_MS + SWEEP_PAUSE_MS;
  const k = Math.floor(t / cycle);
  const local = t - k * cycle;
  const band = canvas.w * 0.18;
  const bx = -band + (canvas.w + 2 * band) * clamp01(local / SWEEP_MS);
  const intro = ease(t / 900);
  for (const c of wordmarkCells(canvas)) {
    const cx = c.x + c.s / 2;
    const near = Math.max(0, 1 - Math.abs(cx - bx) / band);
    // letters the band has passed stay softly lit (and every later cycle starts lit)
    const lit = k > 0 || cx < bx ? 0.6 : 0.18;
    const a = intro * Math.min(1, lit + near * 0.8);
    const col = near > 0.02 ? [TEAL[0] + (GLOW[0] - TEAL[0]) * near, TEAL[1] + (GLOW[1] - TEAL[1]) * near, TEAL[2] + (GLOW[2] - TEAL[2]) * near] : TEAL;
    ctx.fillStyle = rgba(col, a);
    const pad = c.s * 0.08;
    ctx.fillRect(c.x + pad, c.y + pad, c.s - 2 * pad, c.s - 2 * pad);
  }
  // the band itself: a faint vertical glow
  if (local < SWEEP_MS) {
    const g = ctx.createLinearGradient(bx - band, 0, bx + band, 0);
    g.addColorStop(0, rgba(TEAL, 0));
    g.addColorStop(0.5, rgba(TEAL, 0.16));
    g.addColorStop(1, rgba(TEAL, 0));
    ctx.fillStyle = g;
    ctx.fillRect(bx - band, 0, band * 2, canvas.h);
  }
}

// ---------- clock sync (NTP-style) ----------
export interface ClockSample {
  sent: number; // local ms when the ping left
  hub: number; // Hub ms in the reply
  recv: number; // local ms when the reply arrived
}
/** Offset to add to the local clock to get Hub time, from the sample with the smallest round trip. */
export function clockOffset(samples: ClockSample[]) {
  if (!samples.length) return null;
  const best = samples.reduce((a, b) => (b.recv - b.sent < a.recv - a.sent ? b : a));
  const rtt = best.recv - best.sent;
  return { offset: best.hub + rtt / 2 - best.recv, rtt };
}
