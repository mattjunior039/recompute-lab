// Teach the Swarm: photos stay on this device. We turn each photo into 1,280
// numbers with the frozen MobileNet, train a tiny classifier head locally, and
// send ONLY the head's weights to the Hub, which averages them (FedAvg).

import { h, clear, fmtBytes, toast } from '../shared/dom';
import { evaluate, headSize, normalize, predict, argmax, trainHead } from '../shared/head';
import { FED_CLASSES, FEATURE_DIM, b64ToF32, f32ToB64, type HubToNode, type NodeToHub } from '../shared/protocol';
import { loadBitmap, pixelsFrom, type Engine } from './engine';

interface Photo {
  id?: number;
  label: number;
  held: boolean; // held out to measure accuracy, never trained on
  f: ArrayBuffer; // normalized features
  thumb: string;
  at: number;
}

const NICE = ['Repairable', 'Recyclable', 'Battery hazard'];
const ICON = ['🔧', '♻️', '🔋'];

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('recompute-teach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function allPhotos(): Promise<Photo[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('photos').objectStore('photos').getAll();
    r.onsuccess = () => resolve(r.result as Photo[]);
    r.onerror = () => reject(r.error);
  });
}
async function putPhoto(p: Photo) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction('photos', 'readwrite');
    tx.objectStore('photos').add(p);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function clearPhotos() {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction('photos', 'readwrite');
    tx.objectStore('photos').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface TeachCtx {
  engine: Engine;
  ensureModel: () => Promise<void>;
  send: (m: NodeToHub) => void;
  onCounts: (counts: number[]) => void;
}

export class Teach {
  el = h('div', { class: 'teach' });
  counts = [0, 0, 0];
  private photos: Photo[] = [];
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private global: { w: Float32Array; round: number } | null = null;
  private guessEl = h('div', { class: 'guess' }, 'Take a few photos of each kind, then the teacher starts a training round.');
  private roundEl = h('div', { class: 'muted' });
  private strip = h('div', { class: 'strip' });
  private countEls: HTMLElement[] = [];
  private guessTimer: ReturnType<typeof setInterval> | null = null;
  private visible = false;
  private busy = false;

  constructor(private ctx: TeachCtx) {
    this.render();
    void this.reload();
  }

  private async reload() {
    try {
      this.photos = await allPhotos();
    } catch {
      this.photos = [];
    }
    this.updateCounts();
  }

  private updateCounts() {
    this.counts = [0, 1, 2].map((c) => this.photos.filter((p) => p.label === c).length);
    this.countEls.forEach((el, c) => (el.textContent = String(this.counts[c])));
    clear(this.strip, ...this.photos.slice(-12).map((p) => h('img', { src: p.thumb, alt: NICE[p.label], class: `c${p.label}` })));
    this.ctx.onCounts(this.counts);
  }

  private render() {
    const camBox = h('div', { class: 'cam' });
    const canCamera = !!navigator.mediaDevices?.getUserMedia && globalThis.isSecureContext;
    if (canCamera) {
      this.video = h('video', { playsinline: '', muted: '', autoplay: '' }) as HTMLVideoElement;
      this.video.muted = true;
      camBox.append(this.video, this.guessEl);
    } else {
      camBox.append(h('div', { class: 'banner warn' }, 'Live camera needs the secure (https) page. You can still take photos with the buttons below.'));
    }
    const labelBtns = h(
      'div',
      { class: 'label-btns' },
      ...[0, 1, 2].map((c) => {
        const count = h('span', { class: 'count' }, '0');
        this.countEls[c] = count;
        const btn = h('button', { class: `c${c}` }, h('span', { class: 'ico' }, ICON[c]), h('span', null, NICE[c]), count);
        if (canCamera) btn.onclick = () => void this.snap(c);
        else {
          const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' }) as HTMLInputElement;
          input.onchange = async () => {
            const f = input.files?.[0];
            input.value = '';
            if (f) await this.addBlob(f, c);
          };
          btn.onclick = () => input.click();
          btn.append(input);
        }
        return btn;
      }),
    );
    const del = h('button', { class: 'link' }, 'Delete my photos from this device');
    del.onclick = async () => {
      if (!confirm('Delete all Teach the Swarm photos from this device?')) return;
      await clearPhotos();
      await this.reload();
      toast('Photos deleted from this device.');
    };
    clear(
      this.el,
      h('h2', null, 'Teach the Swarm'),
      h('p', { class: 'lead' }, 'Show the camera a device and tap what it is. ', h('b', null, 'Your photos never leave this device'), ' — only the model’s numbers are shared.'),
      camBox,
      canCamera ? null : this.guessEl,
      labelBtns,
      this.roundEl,
      this.strip,
      del,
    );
  }

  async show(visible: boolean) {
    this.visible = visible;
    if (visible) {
      if (this.video && !this.stream) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
          this.video.srcObject = this.stream;
          await this.video.play().catch(() => {});
        } catch (e) {
          toast(`Camera not available: ${e instanceof Error ? e.message : e}`, 'warn');
        }
      }
      this.ctx.ensureModel().catch(() => {});
      this.guessTimer ??= setInterval(() => void this.liveGuess(), 900);
    } else {
      if (this.guessTimer) clearInterval(this.guessTimer);
      this.guessTimer = null;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private async snap(label: number) {
    if (!this.video || !this.video.videoWidth) {
      toast('Camera is still starting…', 'warn');
      return;
    }
    await this.addPixels(pixelsFrom(this.video, true), label, thumbOf(this.video));
  }

  private async addBlob(blob: Blob, label: number) {
    const bmp = await loadBitmap(blob);
    await this.addPixels(pixelsFrom(bmp, true), label, thumbOf(bmp));
  }

  /** Test hook: add a labeled photo from a URL (used by the automated tests). */
  async addFromUrl(url: string, label: number) {
    const res = await fetch(url);
    await this.addBlob(await res.blob(), label);
  }

  private async addPixels(px: Uint8ClampedArray, label: number, thumb: string) {
    await this.ctx.ensureModel();
    const { features } = await this.ctx.engine.features(px);
    const nInClass = this.photos.filter((p) => p.label === label).length;
    const photo: Photo = { label, held: nInClass % 4 === 3, f: normalize(features).buffer as ArrayBuffer, thumb, at: Date.now() };
    await putPhoto(photo);
    this.photos.push(photo);
    this.updateCounts();
  }

  private async liveGuess() {
    if (!this.visible || this.busy || !this.global || !this.video?.videoWidth || !this.ctx.engine.modelReady) return;
    this.busy = true;
    try {
      const { features } = await this.ctx.engine.features(pixelsFrom(this.video, true));
      const p = predict(this.global.w, { classes: 3, inDim: FEATURE_DIM }, normalize(features));
      const k = argmax(p);
      clear(this.guessEl, h('span', { class: `pill c${k}` }, `${ICON[k]} ${NICE[k]}`), ` ${Math.round(p[k] * 100)}% sure (class model, round ${this.global.round})`);
    } catch {
    } finally {
      this.busy = false;
    }
  }

  async onMessage(m: HubToNode) {
    if (m.type === 'fed:model') {
      this.global = { w: b64ToF32(m.weights), round: m.round };
      if (!this.video) clear(this.guessEl, `Class model updated (round ${m.round}).`);
      return;
    }
    if (m.type === 'fed:reset') {
      this.global = null;
      clear(this.roundEl);
      clear(this.guessEl, 'New class model: take photos, then the teacher starts a round.');
      return;
    }
    if (m.type !== 'fed:round') return;
    const dims = { classes: m.dims[0], inDim: m.dims[1] };
    const start = b64ToF32(m.weights);
    if (start.length !== headSize(dims)) return;
    const train = this.photos.filter((p) => !p.held);
    const held = this.photos.filter((p) => p.held);
    // 1) How good is the class model we were just sent, on photos it has never seen?
    const ev = evaluate(start, dims, held.map((p) => new Float32Array(p.f)), held.map((p) => p.label));
    // 2) Improve it on this device's photos.
    const t0 = performance.now();
    const w = train.length ? trainHead(start, dims, train.map((p) => new Float32Array(p.f)), train.map((p) => p.label), { epochs: m.epochs, lr: m.lr, seed: m.round }) : null;
    const ms = performance.now() - t0;
    const payload = w ? f32ToB64(w) : null;
    this.ctx.send({ type: 'fed:update', sessionId: m.sessionId, round: m.round, weights: payload, n: train.length, evalCorrect: ev.correct, evalTotal: ev.total });
    clear(
      this.roundEl,
      `Round ${m.round}: trained on ${train.length} of my photos in ${Math.round(ms)} ms · sent ${payload ? fmtBytes(payload.length) : '0 B'} of numbers · `,
      h('b', null, '0 photos sent'),
    );
  }
}

function thumbOf(src: CanvasImageSource) {
  const c = document.createElement('canvas');
  c.width = c.height = 72;
  const g = c.getContext('2d')!;
  const w = (src as HTMLVideoElement).videoWidth || (src as { width: number }).width;
  const hh = (src as HTMLVideoElement).videoHeight || (src as { height: number }).height;
  const s = Math.min(w, hh);
  g.drawImage(src, (w - s) / 2, (hh - s) / 2, s, s, 0, 0, 72, 72);
  return c.toDataURL('image/jpeg', 0.7);
}

export { FED_CLASSES };
