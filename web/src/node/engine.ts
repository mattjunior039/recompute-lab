// The node's compute engine: a pool of Web Workers (cores − 1), each running
// one single-threaded copy of the built-in kernels. Also handles thermal
// backoff: if chunks start taking noticeably longer, use fewer workers.

import type { WorkerIn, WorkerOut } from '../workers/compute';
import { fetchCached } from '../shared/filecache';
import type { ModelInfo } from '../shared/protocol';

interface Slot {
  w: Worker;
  busy: boolean;
  enabled: boolean;
  model: boolean;
  canDecode: boolean;
}

interface Task {
  msg: WorkerIn & { id: number };
  transfer: Transferable[];
  resolve: (m: WorkerOut) => void;
  reject: (e: Error) => void;
  front: boolean;
}

export interface EngineEvents {
  onChange?: () => void;
  onThrottle?: (level: number, reason: string) => void;
}

const SIZE = 224;

export class Engine {
  slots: Slot[] = [];
  private queue: Task[] = [];
  private pending = new Map<number, { slot: Slot; task: Task }>();
  private nextId = 1;
  modelReady = false;
  modelLoading: Promise<void> | null = null;
  backend = 'wasm';
  modelError: string | null = null;
  throttle = 0;
  /** Where the image model came from, so a restarted worker can load it again (from this device's cache). */
  private modelSrc: { url: string; sha: string; gpu: boolean } | null = null;
  private perf = new Map<string, { samples: number[]; base: number | null; ewma: number | null; slowRuns: number; coolSince: number | null }>();

  constructor(
    public readonly size: number,
    private ev: EngineEvents = {},
  ) {
    for (let k = 0; k < size; k++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const w = new Worker('/dist/compute.js', { type: 'module', name: 'recompute-compute' });
    const slot: Slot = { w, busy: false, enabled: true, model: false, canDecode: true };
    w.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(slot, e.data);
    w.onerror = (e) => {
      console.warn('worker error', e.message);
      this.failSlot(slot, e.message || 'worker crashed');
    };
    return slot;
  }

  private failSlot(slot: Slot, error: string) {
    for (const [id, p] of this.pending) if (p.slot === slot) {
      this.pending.delete(id);
      p.task.reject(new Error(error));
    }
    slot.busy = false;
    this.drain();
  }

  private onWorker(slot: Slot, m: WorkerOut) {
    if (m.type === 'hello') {
      slot.canDecode = m.canDecode;
      return;
    }
    if (m.type === 'model-ready' || m.type === 'model-error') return; // handled by loadModel's listener
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    slot.busy = false;
    if (m.type === 'error') p.task.reject(new Error(m.error));
    else p.task.resolve(m);
    this.drain();
    this.ev.onChange?.();
  }

  get enabled() {
    return this.slots.filter((s) => s.enabled).length;
  }
  get busy() {
    return this.slots.filter((s) => s.busy).length;
  }
  get queued() {
    return this.queue.length;
  }
  get canDecode() {
    return this.slots.every((s) => s.canDecode);
  }

  private drain() {
    while (this.queue.length) {
      const slot = this.slots.find((s) => s.enabled && !s.busy) ?? (this.enabled === 0 ? this.slots.find((s) => !s.busy) : undefined);
      if (!slot) return;
      const task = this.queue.shift()!;
      slot.busy = true;
      this.pending.set(task.msg.id, { slot, task });
      slot.w.postMessage(task.msg, task.transfer);
    }
  }

  private submit(msg: WorkerIn & { id: number }, transfer: Transferable[] = [], front = false) {
    return new Promise<WorkerOut>((resolve, reject) => {
      const task = { msg, transfer, resolve, reject, front };
      if (front) this.queue.unshift(task);
      else this.queue.push(task);
      this.drain();
    });
  }

  /** Download (once, then cached) and load MobileNet into every worker. */
  loadModel(info: ModelInfo, opts: { gpu: boolean; onProgress?: (f: number) => void }) {
    if (this.modelReady) return Promise.resolve();
    if (this.modelLoading) return this.modelLoading;
    const file = info.files.find((f) => f.name.endsWith('.onnx'));
    if (!file) return Promise.reject(new Error('no model file'));
    this.modelLoading = (async () => {
      try {
        const bytes = await fetchCached(file.url, { sha: file.sha256, onProgress: opts.onProgress });
        const results = await Promise.all(this.slots.map((slot) => this.initModel(slot, bytes, opts.gpu)));
        this.modelSrc = { url: file.url, sha: file.sha256, gpu: opts.gpu };
        this.backend = results[0] ?? 'wasm';
        this.modelReady = true;
        this.modelError = null;
      } catch (e) {
        this.modelError = e instanceof Error ? e.message : String(e);
        this.modelLoading = null;
        throw e;
      } finally {
        this.ev.onChange?.();
      }
    })();
    return this.modelLoading;
  }

  private initModel(slot: Slot, bytes: ArrayBuffer, gpu: boolean) {
    return new Promise<string>((resolve, reject) => {
      const prev = slot.w.onmessage;
      slot.w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'model-ready') {
          slot.model = true;
          slot.w.onmessage = prev;
          resolve(m.backend);
        } else if (m.type === 'model-error') {
          slot.w.onmessage = prev;
          reject(new Error(m.error));
        } else prev?.call(slot.w, e);
      };
      slot.w.postMessage({ type: 'init-model', model: bytes.slice(0), ortBase: '/vendor/ort/', gpu } satisfies WorkerIn);
    });
  }

  /**
   * Stop all class work right now (Stop button, pause while in use): queued work is
   * dropped and workers in the middle of a job are shut down and replaced by fresh
   * ones, so the processor is free at once. The Hub gives that work to another device.
   */
  interrupt() {
    this.cancelQueued();
    this.slots = this.slots.map((slot) => {
      const running = [...this.pending].filter(([, p]) => p.slot === slot);
      if (!running.length || running.some(([, p]) => p.task.msg.type !== 'run')) return slot; // Teach photos finish
      slot.w.terminate();
      for (const [id, p] of running) {
        this.pending.delete(id);
        p.task.reject(new Error('cancelled'));
      }
      const fresh = this.spawn();
      fresh.enabled = slot.enabled;
      if (slot.model && this.modelSrc) {
        const src = this.modelSrc;
        fresh.busy = true; // no work until the model is back in this worker
        void fetchCached(src.url, { sha: src.sha })
          .then((bytes) => this.initModel(fresh, bytes, src.gpu))
          .catch((e) => console.warn('model reload failed', e))
          .finally(() => {
            fresh.busy = false;
            this.drain();
            this.ev.onChange?.();
          });
      }
      return fresh;
    });
    this.ev.onChange?.();
  }

  /** Run a built-in kernel on some items. */
  async run(kernel: string, params: Record<string, unknown>, items: number[]): Promise<{ outputs: unknown[]; ms: number }> {
    const t0 = performance.now();
    let pixels: Uint8ClampedArray[] | undefined;
    if (kernel === 'classify' && !this.canDecode) {
      const count = Number(params.datasetCount) || 1000;
      pixels = await Promise.all(items.map((i) => decodeOnMain(imageUrl(i % count))));
    }
    const m = await this.submit({ type: 'run', id: this.nextId++, kernel, params, items, pixels }, pixels ? pixels.map((p) => p.buffer as ArrayBuffer) : []);
    if (m.type !== 'done') throw new Error('unexpected reply');
    const ms = performance.now() - t0;
    this.observe(kernel, ms / Math.max(1, items.length));
    return { outputs: m.outputs, ms };
  }

  /** MobileNet features for one photo (Teach the Swarm). Jumps the queue. */
  async features(pixels: Uint8ClampedArray) {
    const m = await this.submit({ type: 'features', id: this.nextId++, pixels }, [pixels.buffer as ArrayBuffer], true);
    if (m.type !== 'features') throw new Error('unexpected reply');
    return m;
  }

  /** Drop or restore workers (Stop button / thermal backoff). */
  setEnabled(n: number) {
    n = Math.max(0, Math.min(this.size, n));
    this.slots.forEach((s, k) => (s.enabled = k < n));
    this.drain();
    this.ev.onChange?.();
  }

  cancelQueued() {
    const dropped = this.queue.splice(0);
    for (const t of dropped) t.reject(new Error('cancelled'));
  }

  /** Thermal backoff on chunk-time drift (per kernel, time per item). */
  private observe(kernel: string, msPerItem: number) {
    let p = this.perf.get(kernel);
    if (!p) this.perf.set(kernel, (p = { samples: [], base: null, ewma: null, slowRuns: 0, coolSince: null }));
    if (p.base === null) {
      p.samples.push(msPerItem);
      // The first chunk includes warm-up; take the median of the next few as "normal".
      if (p.samples.length >= 6) {
        const s = p.samples.slice(1).sort((a, b) => a - b);
        p.base = s[Math.floor(s.length / 2)];
        p.ewma = p.base;
      }
      return;
    }
    p.ewma = 0.7 * p.ewma! + 0.3 * msPerItem;
    const ratio = p.ewma / p.base;
    const now = Date.now();
    if (ratio > 1.35) {
      p.slowRuns++;
      p.coolSince = null;
      if (p.slowRuns >= 3 && this.enabled > 1) {
        p.slowRuns = 0;
        this.throttle++;
        this.setEnabled(this.enabled - 1);
        p.ewma = p.base * 1.15; // give the smaller pool a fair chance
        this.ev.onThrottle?.(this.throttle, `chunks got ${Math.round((ratio - 1) * 100)}% slower — using ${this.enabled} worker${this.enabled === 1 ? '' : 's'} to cool down`);
      }
    } else {
      p.slowRuns = 0;
      if (ratio < 1.1 && this.throttle > 0) {
        p.coolSince ??= now;
        if (now - p.coolSince > 30_000) {
          this.throttle--;
          p.coolSince = null;
          this.setEnabled(this.enabled + 1);
          this.ev.onThrottle?.(this.throttle, `back to ${this.enabled} worker${this.enabled === 1 ? '' : 's'}`);
        }
      } else p.coolSince = null;
    }
  }

  terminate() {
    for (const s of this.slots) s.w.terminate();
    this.slots = [];
  }
}

export function imageUrl(i: number) {
  return `/data/swarmsort/images/${String(i).padStart(4, '0')}.jpg`;
}

/** Fallback when workers can't decode images (older Safari): decode on the page. */
export async function decodeOnMain(url: string): Promise<Uint8ClampedArray> {
  const buf = await fetchCached(url);
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const src = await loadBitmap(blob);
  return pixelsFrom(src);
}

export async function loadBitmap(blob: Blob): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {}
  }
  const img = new Image();
  const u = URL.createObjectURL(blob);
  try {
    img.src = u;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
}

/** Center-crop to a square and scale to 224×224 RGBA. */
export function pixelsFrom(src: CanvasImageSource, crop = false): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const w = (src as HTMLVideoElement).videoWidth || (src as { width: number }).width;
  const hh = (src as HTMLVideoElement).videoHeight || (src as { height: number }).height;
  if (crop && w && hh) {
    const s = Math.min(w, hh);
    ctx.drawImage(src, (w - s) / 2, (hh - s) / 2, s, s, 0, 0, SIZE, SIZE);
  } else ctx.drawImage(src, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}
