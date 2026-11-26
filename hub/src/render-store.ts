// Swarm Render on the Hub: assembles finished tiles into the full picture,
// keeps a small preview for the Console and the Screen Wall, remembers which
// device rendered which tile (and when), and writes PNGs when done.

import fs from 'node:fs';
import path from 'node:path';
import { encodePngRgb } from './png';
import { b64ToBytes, bytesToB64, renderTile, tileGrid, type RenderOutput, type RenderParams } from '../../web/src/shared/render';
import type { RenderHeader } from '../../web/src/shared/protocol';

export const PREVIEW_MAX_W = 1920;

export interface PreviewTile {
  item: number;
  x: number;
  y: number;
  w: number;
  h: number;
  node: string;
  t: number; // ms since the job started
  rgb: string; // base64 RGB at preview scale
}

export class RenderStore {
  jobId: string | null = null;
  params: RenderParams | null = null;
  full: Uint8Array | null = null;
  preview: Uint8Array | null = null;
  factor = 1;
  pw = 0;
  ph = 0;
  startedAt = 0;
  finishedAt: number | null = null;
  count = 0;
  log: { item: number; node: string; t: number; x: number; y: number; w: number; h: number }[] = [];
  private tiles: PreviewTile[] = [];
  private fresh: PreviewTile[] = [];
  private have = new Set<number>();
  pngFile: string | null = null;
  wallPng: Buffer | null = null;
  pngBusy = false;
  private fallbackWall: Buffer | null = null;

  constructor(private dir: string) {}

  begin(jobId: string, params: RenderParams, now: number) {
    this.jobId = jobId;
    this.params = params;
    this.factor = Math.max(1, Math.round(params.width / PREVIEW_MAX_W));
    this.pw = Math.ceil(params.width / this.factor);
    this.ph = Math.ceil(params.height / this.factor);
    this.full = new Uint8Array(params.width * params.height * 3);
    this.preview = new Uint8Array(this.pw * this.ph * 3);
    this.startedAt = now;
    this.finishedAt = null;
    this.count = tileGrid(params).count;
    this.log = [];
    this.tiles = [];
    this.fresh = [];
    this.have.clear();
    this.pngFile = null;
    this.wallPng = null;
  }

  /** Store one finished tile. Returns false if it doesn't belong to the current picture. */
  put(jobId: string, item: number, out: RenderOutput, node: string, now: number): boolean {
    const p = this.params;
    if (jobId !== this.jobId || !p || !this.full || !this.preview || this.have.has(item)) return false;
    const { x, y, w, h } = out;
    if (!(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= p.width && y + h <= p.height)) return false;
    const src = b64ToBytes(out.rgb);
    if (src.length !== w * h * 3) return false;
    for (let r = 0; r < h; r++) this.full.set(src.subarray(r * w * 3, (r + 1) * w * 3), ((y + r) * p.width + x) * 3);
    // Box-filter down to the preview.
    const f = this.factor;
    const px = Math.floor(x / f);
    const py = Math.floor(y / f);
    const tw = Math.ceil(w / f);
    const th = Math.ceil(h / f);
    const tile = new Uint8Array(tw * th * 3);
    for (let ty = 0; ty < th; ty++)
      for (let tx = 0; tx < tw; tx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = ty * f; sy < Math.min(h, ty * f + f); sy++)
          for (let sx = tx * f; sx < Math.min(w, tx * f + f); sx++) {
            const o = (sy * w + sx) * 3;
            r += src[o];
            g += src[o + 1];
            b += src[o + 2];
            n++;
          }
        const o = (ty * tw + tx) * 3;
        tile[o] = Math.round(r / n);
        tile[o + 1] = Math.round(g / n);
        tile[o + 2] = Math.round(b / n);
      }
    for (let r = 0; r < th; r++) if (py + r < this.ph) this.preview.set(tile.subarray(r * tw * 3, (r * tw + Math.min(tw, this.pw - px)) * 3), ((py + r) * this.pw + px) * 3);
    const t = now - this.startedAt;
    const pt: PreviewTile = { item, x: px, y: py, w: tw, h: th, node, t, rgb: bytesToB64(tile) };
    this.tiles.push(pt);
    this.fresh.push(pt);
    this.have.add(item);
    this.log.push({ item, node, t, x, y, w, h });
    return true;
  }

  get done() {
    return this.have.size;
  }

  /** Tiles finished since the last call (for live Console updates). */
  takeFresh() {
    const f = this.fresh;
    this.fresh = [];
    return f;
  }

  all() {
    return this.tiles;
  }

  header(): RenderHeader | null {
    const p = this.params;
    return p ? { jobId: this.jobId, width: p.width, height: p.height, spp: p.spp, pw: this.pw, ph: this.ph, factor: this.factor, count: this.count, startedAt: this.startedAt, finishedAt: this.finishedAt, png: !!this.pngFile } : null;
  }

  /** Write the full-resolution PNG and the wall-size PNG (async; never blocks the Hub). */
  async finish(now: number) {
    const p = this.params;
    if (!p || !this.full || !this.preview || this.pngBusy) return;
    this.finishedAt = now;
    this.pngBusy = true;
    const jobId = this.jobId;
    try {
      this.wallPng = await encodePngRgb(this.preview, this.pw, this.ph);
      fs.mkdirSync(this.dir, { recursive: true });
      await fs.promises.writeFile(path.join(this.dir, 'wall.png'), this.wallPng);
      const png = await encodePngRgb(this.full, p.width, p.height, 3);
      if (jobId !== this.jobId) return;
      const file = path.join(this.dir, `recompute-render-${p.width}x${p.height}-${jobId}.png`);
      await fs.promises.writeFile(file, png);
      this.pngFile = file;
    } finally {
      this.pngBusy = false;
    }
  }

  csv(name: (id: string) => string) {
    const rows = ['order,tile,device,x,y,width,height,finished_seconds'];
    this.log.forEach((l, k) => rows.push([k + 1, l.item, JSON.stringify(name(l.node)), l.x, l.y, l.w, l.h, (l.t / 1000).toFixed(2)].join(',')));
    return rows.join('\n') + '\n';
  }

  /** The finished render at wall size; or, before any render exists, a small one drawn here on the Hub. */
  async wallImage(): Promise<Buffer> {
    if (this.wallPng) return this.wallPng;
    if (this.fallbackWall) return this.fallbackWall;
    try {
      // the last finished render, kept from before the Hub restarted
      return (this.fallbackWall = await fs.promises.readFile(path.join(this.dir, 'wall.png')));
    } catch {}
    const p: RenderParams = { width: 960, height: 540, tile: 160, spp: 1, seed: 2026 };
    const rgb = new Uint8Array(p.width * p.height * 3);
    const { count } = tileGrid(p);
    for (let i = 0; i < count; i++) {
      const o = renderTile(i, p);
      const src = b64ToBytes(o.rgb);
      for (let r = 0; r < o.h; r++) rgb.set(src.subarray(r * o.w * 3, (r + 1) * o.w * 3), ((o.y + r) * p.width + o.x) * 3);
      if (i % 4 === 3) await new Promise((r) => setImmediate(r));
    }
    this.fallbackWall = await encodePngRgb(rgb, p.width, p.height);
    return this.fallbackWall;
  }

  reset() {
    this.jobId = null;
    this.params = null;
    this.full = null;
    this.preview = null;
    this.tiles = [];
    this.fresh = [];
    this.log = [];
    this.have.clear();
  }
}
