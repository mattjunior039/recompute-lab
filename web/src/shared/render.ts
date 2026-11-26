// Swarm Render kernel: a deterministic CPU ray caster for a night-time
// "circuit city" (glowing chip-like towers on a circuit-board ground, looking
// down a main avenue toward a low sun). One item = one tile of the picture.
// Pure math, no allocations in the inner loops, runs the same in a Web Worker
// or in Node (the Hub uses it for a small fallback picture).

export interface RenderParams {
  width: number;
  height: number;
  tile: number;
  spp: number; // samples per pixel (anti-aliasing)
  seed: number;
}

export interface RenderOutput {
  x: number;
  y: number;
  w: number;
  h: number;
  rgb: string; // base64 of w*h*3 bytes, row-major
  sum: number; // mean brightness 0..255, for spot-checks
}

export const RENDER_PRESETS = {
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
  '8k': { width: 7680, height: 4320 },
} as const;
export type RenderRes = keyof typeof RENDER_PRESETS;

export function tileGrid(p: Pick<RenderParams, 'width' | 'height' | 'tile'>) {
  const cols = Math.ceil(p.width / p.tile);
  const rows = Math.ceil(p.height / p.tile);
  return { cols, rows, count: cols * rows };
}

const orderCache = new Map<string, Int32Array>();
/** Tiles are handed out centre-first, so the picture grows outward from the middle. */
export function tileOrder(p: Pick<RenderParams, 'width' | 'height' | 'tile'>): Int32Array {
  const key = `${p.width}x${p.height}/${p.tile}`;
  let o = orderCache.get(key);
  if (o) return o;
  const { cols, rows, count } = tileGrid(p);
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const idx = Array.from({ length: count }, (_, k) => k);
  const d = (k: number) => {
    const dx = (k % cols) - cx;
    const dy = (Math.floor(k / cols) - cy) * 1.6;
    return dx * dx + dy * dy;
  };
  idx.sort((a, b) => d(a) - d(b) || a - b);
  o = Int32Array.from(idx);
  orderCache.set(key, o);
  return o;
}

export function tileRect(item: number, p: Pick<RenderParams, 'width' | 'height' | 'tile'>) {
  const { cols } = tileGrid(p);
  const t = tileOrder(p)[item];
  const x = (t % cols) * p.tile;
  const y = Math.floor(t / cols) * p.tile;
  return { tile: t, x, y, w: Math.min(p.tile, p.width - x), h: Math.min(p.tile, p.height - y) };
}

// ---------- scene ----------

const MAXD = 150;
const CITY_TOP = 7;
const CAM_X = 0.5, CAM_Y = 3.4, CAM_Z = -4;
const PITCH = -0.13;
const FOV_Y = (34 * Math.PI) / 180;
// Low sun straight down the avenue.
const SUN_X = 0, SUN_Y = 0.075, SUN_Z = 1;
const SUN_L = Math.hypot(SUN_X, SUN_Y, SUN_Z);
const SX = SUN_X / SUN_L, SY = SUN_Y / SUN_L, SZ = SUN_Z / SUN_L;

function hash3(i: number, j: number, k: number) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a: number, n: number) => ((a % n) + n) % n;
const fract = (x: number) => x - Math.floor(x);

function isRoad(i: number, j: number) {
  return (i >= -1 && i <= 1) || mod(i, 6) === 0 || mod(j, 7) === 0;
}
/** Building height in cell (i, j); 0 = no building. */
function heightAt(i: number, j: number) {
  if (isRoad(i, j)) return 0;
  const r = hash3(i, j, 1);
  if (r < 0.1) return 0;
  const tall = hash3(i, j, 2);
  const side = Math.min(1, Math.abs(i) / 3); // keep the avenue edges a little lower
  const near = Math.min(1, Math.abs(i) / 5);
  return 0.3 + tall * tall * tall * 5.2 * (0.35 + 0.65 * near) + (r > 0.94 ? 1.4 * side : 0);
}

// Scratch "registers" for the tracer (avoids allocating objects per ray).
let HT = 0, HK = 0, HI = 0, HJ = 0, HN = 0, HH = 0, HX0 = 0, HX1 = 0, HZ0 = 0, HZ1 = 0;
// HK: 0 sky, 1 ground, 2 building.  HN: 0 ±x wall, 1 roof, 2 ±z wall

function trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
  let i = Math.floor(ox), j = Math.floor(oz);
  const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx) < 1e-9 ? 1e-9 : Math.abs(dx);
  const adz = Math.abs(dz) < 1e-9 ? 1e-9 : Math.abs(dz);
  let tMaxX = (dx > 0 ? i + 1 - ox : ox - i) / adx;
  let tMaxZ = (dz > 0 ? j + 1 - oz : oz - j) / adz;
  const tdx = 1 / adx, tdz = 1 / adz;
  const tGround = dy < 0 ? -oy / dy : Infinity;
  const tEnd = Math.min(tGround, maxT);
  const idx = 1 / (dx === 0 ? 1e-9 : dx), idy = 1 / (dy === 0 ? 1e-9 : dy), idz = 1 / (dz === 0 ? 1e-9 : dz);
  let t = 0;
  for (let steps = 0; steps < 400 && t < tEnd; steps++) {
    const hgt = heightAt(i, j);
    if (hgt > 0) {
      const ins = 0.08 + 0.1 * hash3(i, j, 3);
      const x0 = i + ins, x1 = i + 1 - ins, z0 = j + ins, z1 = j + 1 - ins;
      let a0 = (x0 - ox) * idx, a1 = (x1 - ox) * idx;
      let nx = 0;
      if (a0 > a1) { const s = a0; a0 = a1; a1 = s; }
      let lo = a0, hi = a1;
      let b0 = (0 - oy) * idy, b1 = (hgt - oy) * idy;
      if (b0 > b1) { const s = b0; b0 = b1; b1 = s; }
      if (b0 > lo) { lo = b0; nx = 1; }
      if (b1 < hi) hi = b1;
      let c0 = (z0 - oz) * idz, c1 = (z1 - oz) * idz;
      if (c0 > c1) { const s = c0; c0 = c1; c1 = s; }
      if (c0 > lo) { lo = c0; nx = 2; }
      if (c1 < hi) hi = c1;
      if (lo <= hi && hi > 1e-4 && lo < tEnd) {
        HT = Math.max(lo, 0);
        HK = 2; HI = i; HJ = j; HN = nx; HH = hgt; HX0 = x0; HX1 = x1; HZ0 = z0; HZ1 = z1;
        return;
      }
    }
    if (dy > 0 && oy + dy * t > CITY_TOP) break;
    if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tdx; i += si; }
    else { t = tMaxZ; tMaxZ += tdz; j += sj; }
  }
  if (tGround < maxT) {
    HT = tGround; HK = 1;
    return;
  }
  HK = 0; HT = MAXD;
}

// Colour accumulator registers
let CR = 0, CG = 0, CB = 0;

function sky(dx: number, dy: number, dz: number) {
  const up = Math.max(0, dy);
  const hz = Math.exp(-up * 9);
  // deep navy zenith → violet → warm horizon
  CR = 0.012 + 0.32 * hz * hz + 0.05 * hz;
  CG = 0.016 + 0.07 * hz * hz;
  CB = 0.05 + 0.13 * hz;
  const c = dx * SX + dy * SY + dz * SZ;
  const ang = Math.sqrt(Math.max(0, 2 - 2 * c)); // ≈ angle to the sun
  const R = 0.135;
  if (ang < R) {
    const v = (dy - (SY - R)) / (2 * R); // 0 bottom .. 1 top of disc
    const stripe = v < 0.55 && fract(v * 14) < 0.18 + (0.55 - v) * 0.9 ? 0.12 : 1;
    CR += (1.25 + 0.5 * v) * stripe;
    CG += (0.12 + 0.75 * v * v) * stripe;
    CB += (0.42 - 0.3 * v) * stripe;
  }
  const halo = Math.exp(-ang * 7);
  CR += 0.55 * halo;
  CG += 0.12 * halo;
  CB += 0.2 * halo;
  if (dy > 0.08) {
    const q = 520;
    const s = hash3(Math.floor(dx * q), Math.floor(dy * q), Math.floor(dz * q));
    if (s > 0.9965) {
      const b = (s - 0.9965) * 300 * Math.min(1, (dy - 0.08) * 8);
      CR += b * 0.8;
      CG += b * 0.9;
      CB += b;
    }
  }
}

/** Thin glowing line of half-width w at distance d, filtered by ray distance to avoid shimmer. */
function line(d: number, w: number, t: number) {
  const ww = Math.max(w, t * 0.0016);
  return d < ww ? w / ww : 0;
}

function ground(px: number, pz: number, t: number) {
  const i = Math.floor(px), j = Math.floor(pz);
  const fx = px - i, fz = pz - j;
  let er = 0, eg = 0, eb = 0;
  CR = 0.006; CG = 0.012; CB = 0.014;
  if (isRoad(i, j)) {
    const avenueX = i >= -1 && i <= 1;
    const alongZ = avenueX || mod(i, 6) === 0;
    if (avenueX) {
      // Bus lines down the avenue: three glowing traces each side + dashed amber centre.
      const ax = px - 0.5;
      const d = Math.abs(ax);
      if (d < 0.025 && fract(pz * 0.5) < 0.55) { er += 1.8; eg += 0.9; eb += 0.15; }
      for (let k = 1; k <= 3; k++) {
        const lane = Math.abs(d - (0.45 + k * 0.22));
        const g = line(lane, 0.018, t);
        er += g * 0.05; eg += g * 1.05; eb += g * 0.75;
      }
    } else if (alongZ) {
      const g = line(Math.abs(fx - 0.5), 0.02, t);
      er += g * 0.1; eg += g * 0.6; eb += g * 1.1;
    }
    if (mod(j, 7) === 0 && !avenueX) {
      const g = line(Math.abs(fz - 0.5), 0.02, t);
      er += g * 0.1; eg += g * 0.6; eb += g * 1.1;
    }
  } else {
    // Circuit-board lot: traces on a fine grid, with solder pads at the ends.
    CR = 0.008; CG = 0.03; CB = 0.022;
    const q = 4;
    const gi = Math.floor(px * q), gj = Math.floor(pz * q);
    const ux = px * q - gi, uz = pz * q - gj;
    const hsh = hash3(gi, gj, 7);
    if (hsh < 0.55) {
      const horiz = hsh < 0.28;
      const d = horiz ? Math.abs(uz - 0.5) : Math.abs(ux - 0.5);
      const g = line(d, 0.07, t * q) * 0.55;
      er += g * 0.08; eg += g * 0.85; eb += g * 0.55;
    }
    if (hsh > 0.9) {
      const r = Math.hypot(ux - 0.5, uz - 0.5);
      const g = line(Math.abs(r - 0.18), 0.06, t * q) * 0.9;
      er += g * 0.9; eg += g * 0.6; eb += g * 0.1;
    }
  }
  CR += er; CG += eg; CB += eb;
}

function building(px: number, py: number, pz: number, dx: number, dz: number) {
  const i = HI, j = HJ, hgt = HH;
  let er = 0, eg = 0, eb = 0;
  // Dark body lit faintly by the warm horizon from the front.
  const facing = HN === 2 ? (dz > 0 ? 1 : 0) : HN === 0 ? 0.35 : 0.2;
  CR = 0.006 + 0.02 * facing; CG = 0.007 + 0.006 * facing; CB = 0.016 + 0.014 * facing;
  const hue = hash3(i, j, 4);
  const amber = hue > 0.8;
  const tr = amber ? 1.6 : hue > 0.62 ? 0.2 : 0.1;
  const tg = amber ? 0.75 : hue > 0.62 ? 0.75 : 1.0;
  const tb = amber ? 0.12 : hue > 0.62 ? 1.4 : 0.7;
  if (HN === 1) {
    // Roof: glowing outline like a chip package, beacon on the tallest.
    const ex = Math.min(px - HX0, HX1 - px, pz - HZ0, HZ1 - pz);
    if (ex < 0.025) { er += tr * 0.9; eg += tg * 0.9; eb += tb * 0.9; }
    else if (ex < 0.12 && fract((px + pz) * 12) < 0.35) { er += 0.25; eg += 0.25; eb += 0.28; } // pins
    if (hgt > 4.2) {
      const r = Math.hypot(px - (HX0 + HX1) / 2, pz - (HZ0 + HZ1) / 2);
      if (r < 0.07) { er += 3; eg += 0.4; eb += 0.3; }
    }
  } else {
    const u = HN === 0 ? pz : px;
    const face = HN === 0 ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3;
    const cols = 5, rows = 7;
    const cu = Math.floor(u * cols), rv = Math.floor(py * rows);
    const fu = u * cols - cu, fv = py * rows - rv;
    if (hgt - py < 0.035) { er += tr; eg += tg; eb += tb; } // crown line
    else if (py > 0.12 && fu > 0.22 && fu < 0.78 && fv > 0.28 && fv < 0.72) {
      const lit = hash3(cu * 31 + face, rv * 17 + i * 7, j * 13 + 5);
      if (lit > 0.58) {
        const b = 0.3 + 1.1 * (lit - 0.58);
        er += tr * b; eg += tg * b; eb += tb * b;
      } else { CR += 0.01; CG += 0.016; CB += 0.03; }
    }
  }
  CR += er; CG += eg; CB += eb;
}

const FOG_R = 0.1, FOG_G = 0.025, FOG_B = 0.075;

function fog(t: number) {
  const f = 1 - Math.exp(-t * 0.016);
  CR += (FOG_R - CR) * f;
  CG += (FOG_G - CG) * f;
  CB += (FOG_B - CB) * f;
}

/** Shade one primary ray; result in CR/CG/CB (linear). */
function shade(dx: number, dy: number, dz: number) {
  trace(CAM_X, CAM_Y, CAM_Z, dx, dy, dz, MAXD);
  if (HK === 0) {
    sky(dx, dy, dz);
    return;
  }
  const t = HT;
  const px = CAM_X + dx * t, py = CAM_Y + dy * t, pz = CAM_Z + dz * t;
  if (HK === 2) {
    building(px, py, pz, dx, dz);
    fog(t);
    return;
  }
  ground(px, pz, t);
  let r = CR, g = CG, b = CB;
  // Wet street: Fresnel reflection of the city in the ground.
  const cos = -dy;
  const fr = 0.06 + 0.6 * Math.pow(1 - cos, 5);
  const rdy = -dy;
  trace(px, 1e-4, pz, dx, rdy, dz, MAXD - t);
  if (HK === 0) sky(dx, rdy, dz);
  else if (HK === 2) {
    const tt = HT;
    building(px + dx * tt, rdy * tt, pz + dz * tt, dx, dz);
  } else ground(px + dx * HT, pz + dz * HT, t + HT);
  if (HK !== 0) fog(HT);
  r += CR * fr; g += CG * fr; b += CB * fr;
  CR = r; CG = g; CB = b;
  fog(t);
}

function tone(x: number) {
  // Filmic-ish curve, then gamma.
  const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  const c = y < 0 ? 0 : y > 1 ? 1 : y;
  return Math.round(Math.pow(c, 1 / 2.2) * 255);
}

/** Render one tile (item = position in the centre-first tile order). */
export function renderTile(item: number, p: RenderParams): RenderOutput {
  const r = tileRect(item, p);
  const W = p.width, H = p.height;
  const spp = Math.max(1, Math.min(16, Math.round(p.spp) || 1));
  const out = new Uint8Array(r.w * r.h * 3);
  const aspect = W / H;
  const th = Math.tan(FOV_Y / 2);
  const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  let sum = 0;
  let o = 0;
  for (let y = 0; y < r.h; y++) {
    const py = r.y + y;
    for (let x = 0; x < r.w; x++) {
      const px = r.x + x;
      const hp = hash3(px, py, p.seed);
      let ar = 0, ag = 0, ab = 0;
      for (let s = 0; s < spp; s++) {
        const jx = spp === 1 ? 0.5 : fract(0.5 + s * 0.7548776662 + hp);
        const jy = spp === 1 ? 0.5 : fract(0.5 + s * 0.569840291 + hp * 1.618);
        const u = (2 * (px + jx) / W - 1) * th * aspect;
        const v = (1 - 2 * (py + jy) / H) * th;
        // forward = (0, sp, cp), up = (0, cp, -sp), right = (1, 0, 0)
        let dx = u, dy = sp + v * cp, dz = cp - v * sp;
        const l = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= l; dy *= l; dz *= l;
        shade(dx, dy, dz);
        ar += CR; ag += CG; ab += CB;
      }
      const R = tone(ar / spp), G = tone(ag / spp), B = tone(ab / spp);
      out[o++] = R;
      out[o++] = G;
      out[o++] = B;
      sum += R + G + B;
    }
  }
  return { x: r.x, y: r.y, w: r.w, h: r.h, rgb: bytesToB64(out), sum: Math.round((sum / (r.w * r.h * 3)) * 100) / 100 };
}

export function bytesToB64(u: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(a: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(u).toString('base64');
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(a: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(b, 'base64'));
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
