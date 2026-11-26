// Screen Wall on a node: keeps this device's clock in step with the Hub and draws
// this screen's slice of the shared picture full-screen when the teacher starts the wall.

import type { HubToNode, NodeToHub, ScreenInfo, WallMsg } from '../shared/protocol';
import { clockOffset, drawWall, type ClockSample } from '../shared/wall';

export class WallNode {
  private samples: ClockSample[] = [];
  private sent = new Map<number, number>();
  private pingId = 0;
  private syncTimer: number | null = null;
  private resizeTimer: number | null = null;
  offset = 0;
  rtt: number | null = null;
  private msg: WallMsg | null = null;
  private el: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private img: HTMLImageElement | null = null;
  private imgUrl = '';
  private raf = 0;

  constructor(private send: (m: NodeToHub) => void) {
    addEventListener('resize', () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.reportScreen(), 400);
    });
  }

  get showing() {
    return !!this.msg && this.msg.scene !== 'off' && !!this.msg.slot;
  }

  /** Called on every (re)connect: a burst of pings, then a few every 20 s. */
  start() {
    this.samples = [];
    this.burst(8);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = window.setInterval(() => this.burst(4), 20_000);
  }

  private burst(n: number) {
    for (let k = 0; k < n; k++)
      setTimeout(() => {
        const id = ++this.pingId;
        this.sent.set(id, performance.now());
        this.send({ type: 'clock', id });
      }, k * 120);
    setTimeout(() => this.reportScreen(), n * 120 + 600);
  }

  screen(): ScreenInfo {
    return { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: devicePixelRatio || 1 };
  }

  private reportScreen() {
    const c = clockOffset(this.samples);
    this.send({ type: 'screen', screen: this.screen(), clock: c ? { offset: Math.round(c.offset), rtt: Math.round(c.rtt) } : null });
  }

  onMessage(m: HubToNode) {
    if (m.type === 'clock') {
      const sent = this.sent.get(m.id);
      if (sent === undefined) return;
      this.sent.delete(m.id);
      // Measure with the monotonic clock, convert to wall-clock ms for the offset.
      const recv = performance.now();
      const base = Date.now() - recv;
      this.samples.push({ sent: base + sent, hub: m.hub, recv: base + recv });
      if (this.samples.length > 24) this.samples.shift();
      const c = clockOffset(this.samples);
      if (c) {
        this.offset = c.offset;
        this.rtt = c.rtt;
      }
    } else if (m.type === 'wall') {
      this.msg = m;
      if (m.image && m.image !== this.imgUrl) {
        this.imgUrl = m.image;
        const img = new Image();
        img.onload = () => (this.img = img);
        img.src = m.image;
      }
      this.show(this.showing);
    }
  }

  hubNow() {
    return Date.now() + this.offset;
  }

  private show(on: boolean) {
    if (!on) {
      cancelAnimationFrame(this.raf);
      this.el?.remove();
      this.el = null;
      this.canvas = null;
      return;
    }
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'wall-overlay';
      this.el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;cursor:none;touch-action:none';
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      this.el.append(this.canvas);
      // Double-tap to leave the wall on this device (the teacher can also turn it off).
      let last = 0;
      this.el.addEventListener('pointerup', () => {
        const now = performance.now();
        if (now - last < 350) {
          this.msg = null;
          this.show(false);
        } else document.documentElement.requestFullscreen?.().catch(() => {});
        last = now;
      });
      document.body.append(this.el);
      const loop = () => {
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  private draw() {
    const m = this.msg;
    const cv = this.canvas;
    if (!m || !m.slot || !cv) return;
    const dpr = devicePixelRatio || 1;
    const W = Math.round(innerWidth * dpr);
    const H = Math.round(innerHeight * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // The slot was laid out with the size we reported; if the page is a little different now, centre it.
    const sx = W / dpr / m.slot.w;
    const sy = H / dpr / m.slot.h;
    const s = Math.min(sx, sy);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, (W - m.slot.w * s * dpr) / 2, (H - m.slot.h * s * dpr) / 2);
    const img = this.img;
    drawWall(ctx, { scene: m.scene, at: m.at, slot: m.slot, canvas: m.canvas, index: m.index, count: m.count }, this.hubNow(), img, img ? { w: img.naturalWidth, h: img.naturalHeight } : null);
  }
}
