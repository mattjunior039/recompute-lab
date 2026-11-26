// Lab definitions (which kernel, how big, how to check results) and live
// run tracking (throughput timeline, speedup vs one device, energy).

import type { Kernel, LabId, RunView, SirOutput, PiOutput, ClassifyOutput, TutorOutput } from '../../web/src/shared/protocol';
import type { ChunkPolicy } from '../../web/src/shared/scheduler';
import { RENDER_PRESETS, tileGrid, type RenderRes } from '../../web/src/shared/render';

export interface LabJobDef {
  kernel: Kernel;
  title: string;
  unit: string;
  total: number;
  params: Record<string, unknown>;
  chunk: Partial<ChunkPolicy>;
  spotCheck: boolean;
}

export const DEFAULT_QUESTIONS = [
  'In one or two sentences, what is photosynthesis?',
  'Why do we have seasons on Earth?',
  'What is the difference between weather and climate?',
  'Explain what a prime number is, with an example.',
  'What does a CPU do inside a computer?',
  'Why is recycling batteries important?',
  'What is the water cycle?',
  'What is an algorithm? Give a simple example.',
  'How do vaccines help the body fight disease?',
  'What is the Pythagorean theorem?',
  'Why does ice float on water?',
  'What is the difference between a virus and a bacterium?',
];

export function labJob(lab: LabId, options: Record<string, unknown>, datasetCount: number): LabJobDef {
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(options[k]);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
  };
  switch (lab) {
    case 'swarm-sort': {
      const total = num('count', datasetCount, 1, 20_000);
      return {
        kernel: 'classify',
        title: `Swarm Sort: label ${total.toLocaleString('en-US')} photos`,
        unit: 'images',
        total,
        params: { dataset: 'swarmsort', datasetCount, model: 'mobilenetv3' },
        chunk: { initial: 2, min: 1, max: 32, targetSec: 2, guessSecPerItem: 1.5 },
        spotCheck: true,
      };
    }
    case 'sweep': {
      if (options.kind === 'sir') {
        const grid = num('grid', 16, 4, 40);
        return {
          kernel: 'sir',
          title: `Science Sweep: disease spread, ${grid * grid} scenarios`,
          unit: 'scenarios',
          total: grid * grid,
          params: { grid, n: 1000, runs: num('runs', 60, 5, 500), days: 180, betaMin: 0.1, betaMax: 1.0, gammaMin: 0.05, gammaMax: 0.5, seed: 2026 },
          chunk: { initial: 2, min: 1, max: 32, targetSec: 2, guessSecPerItem: 0.5 },
          spotCheck: true,
        };
      }
      const total = num('batches', 400, 1, 100_000);
      const samples = num('samples', 2_000_000, 10_000, 50_000_000);
      return {
        kernel: 'pi',
        title: `Science Sweep: estimate π with ${((total * samples) / 1e6).toLocaleString('en-US')} million random darts`,
        unit: 'batches',
        total,
        params: { samples, seed: 2026 },
        chunk: { initial: 1, min: 1, max: 64, targetSec: 2, guessSecPerItem: 0.5 },
        spotCheck: true,
      };
    }
    case 'tutor': {
      const qs = Array.isArray(options.questions) ? (options.questions as unknown[]).map(String).filter((q) => q.trim()).slice(0, 200) : DEFAULT_QUESTIONS;
      return {
        kernel: 'tutor',
        title: `Private Tutor: answer ${qs.length} class questions`,
        unit: 'answers',
        total: qs.length,
        params: { questions: qs, model: String(options.model ?? 'smollm2-360m'), maxTokens: num('maxTokens', 96, 16, 512) },
        chunk: { initial: 1, min: 1, max: 1, targetSec: 1, guessSecPerItem: 30 },
        spotCheck: false, // language model answers legitimately vary between devices
      };
    }
    case 'render': {
      const res = (Object.keys(RENDER_PRESETS).includes(String(options.res)) ? options.res : '8k') as RenderRes;
      const { width, height } = RENDER_PRESETS[res];
      const spp = num('spp', 2, 1, 16);
      const params = { width, height, tile: 160, spp, seed: 2026 };
      const { count } = tileGrid(params);
      return {
        kernel: 'render',
        title: `Swarm Render: ${width.toLocaleString('en-US')}×${height.toLocaleString('en-US')} picture (${res.toUpperCase()}), ${count.toLocaleString('en-US')} tiles`,
        unit: 'tiles',
        total: count,
        params,
        chunk: { initial: 1, min: 1, max: 6, targetSec: 1.5, guessSecPerItem: 2 },
        spotCheck: true,
      };
    }
    case 'translate': {
      const paras = Array.isArray(options.paragraphs) ? (options.paragraphs as unknown[]).map((p) => String(p).trim().slice(0, 2000)).filter(Boolean).slice(0, 300) : [];
      if (!paras.length) throw new Error('Paste some text to translate first.');
      return {
        kernel: 'translate',
        title: `Translate a document: ${paras.length} paragraph${paras.length === 1 ? '' : 's'}, English → Spanish`,
        unit: 'paragraphs',
        total: paras.length,
        params: { paragraphs: paras, from: 'en', to: 'es' },
        chunk: { initial: 1, min: 1, max: 1, targetSec: 1, guessSecPerItem: 15 },
        spotCheck: false, // translations are checked by people, not by a second device
      };
    }
    default:
      throw new Error(`lab ${lab} is not a batch job`);
  }
}

/** Do two devices agree on a spot-checked item? */
export function compareOutputs(kernel: string, a: unknown, b: unknown): boolean {
  if (kernel === 'classify') return (a as ClassifyOutput)?.label === (b as ClassifyOutput)?.label;
  if (kernel === 'pi') return (a as PiOutput)?.inside === (b as PiOutput)?.inside && (a as PiOutput)?.samples === (b as PiOutput)?.samples;
  if (kernel === 'render') {
    // Browsers may round the last bit of Math.exp/pow differently; the average brightness of a tile must still match.
    const x = a as { sum: number; x: number; y: number }, y = b as { sum: number; x: number; y: number };
    return x?.x === y?.x && x?.y === y?.y && Math.abs(x.sum - y.sum) < 0.5;
  }
  if (kernel === 'sir') return Math.abs((a as SirOutput).attack - (b as SirOutput).attack) < 0.02 && Math.abs((a as SirOutput).peak - (b as SirOutput).peak) < 0.02;
  return true;
}

const WINDOW_SEC = 4;
const SAMPLE_MS = 500;

/** Live statistics for one running lab job. */
export class RunTracker {
  readonly startedAt: number;
  finishedAt: number | null = null;
  status: 'running' | 'done' | 'cancelled' = 'running';
  done = 0;
  failed = 0;
  private events: { t: number; n: number; nodeId: string }[] = []; // completions, for windowed rate
  timeline: [number, number, number, number][] = [];
  perDevice = new Map<string, { items: number; activeSec: number }>();
  private activeNow = new Set<string>();
  extra: Record<string, unknown> = {};
  private gallery: { i: number; label: number; score: number; node: string }[] = [];
  private labelCounts = new Map<number, number>();
  private pi = { inside: 0, samples: 0 };
  private sir: (SirOutput | null)[] = [];
  private answers: (TutorOutput & { i: number; node: string; question: string })[] = [];
  private translations: { i: number; en: string; es: string; node: string; seconds: number }[] = [];

  constructor(
    readonly jobId: string,
    readonly lab: LabId,
    readonly def: LabJobDef,
    now: number,
  ) {
    this.startedAt = now;
    if (def.kernel === 'sir') this.sir = new Array(def.total).fill(null);
  }

  record(items: { i: number; output: unknown; nodeId: string }[], nodeName: (id: string) => string, now: number) {
    for (const it of items) {
      this.done++;
      this.events.push({ t: now, n: 1, nodeId: it.nodeId });
      const d = this.perDevice.get(it.nodeId) ?? { items: 0, activeSec: 0 };
      d.items++;
      this.perDevice.set(it.nodeId, d);
      const o = it.output as Record<string, unknown>;
      switch (this.def.kernel) {
        case 'classify': {
          const c = o as unknown as ClassifyOutput;
          const n = Number(this.def.params.datasetCount) || 0;
          this.gallery.push({ i: n > 0 ? it.i % n : it.i, label: c.label, score: c.score, node: nodeName(it.nodeId) });
          if (this.gallery.length > 24) this.gallery.shift();
          this.labelCounts.set(c.label, (this.labelCounts.get(c.label) ?? 0) + 1);
          break;
        }
        case 'pi':
          this.pi.inside += Number(o.inside);
          this.pi.samples += Number(o.samples);
          break;
        case 'sir':
          this.sir[it.i] = o as unknown as SirOutput;
          break;
        case 'translate': {
          const paras = this.def.params.paragraphs as string[];
          this.translations.push({ i: it.i, en: paras[it.i], es: String((o as { text?: string }).text ?? ''), node: nodeName(it.nodeId), seconds: round(Number((o as { ms?: number }).ms ?? 0) / 1000, 1) });
          break;
        }
        case 'tutor': {
          const q = (this.def.params.questions as string[])[it.i];
          this.answers.push({ ...(o as unknown as TutorOutput), i: it.i, node: nodeName(it.nodeId), question: q });
          break;
        }
      }
    }
  }

  /** Called every SAMPLE_MS by the Hub with the set of devices currently holding work. */
  sample(now: number, active: Set<string>) {
    if (this.status !== 'running') return;
    const cutoff = now - WINDOW_SEC * 1000;
    while (this.events.length && this.events[0].t < cutoff - 30_000) this.events.shift();
    const recent = new Set(this.events.filter((e) => e.t >= now - 3000).map((e) => e.nodeId));
    for (const id of active) recent.add(id);
    this.activeNow = recent;
    for (const id of recent) {
      const d = this.perDevice.get(id) ?? { items: 0, activeSec: 0 };
      d.activeSec += SAMPLE_MS / 1000;
      this.perDevice.set(id, d);
    }
    const t = (now - this.startedAt) / 1000;
    this.timeline.push([round(t, 1), this.done, recent.size, round(this.rate(now), 2)]);
  }

  rate(now: number) {
    const from = Math.max(this.startedAt, now - WINDOW_SEC * 1000);
    const span = (now - from) / 1000;
    if (span < 0.5) return 0;
    let n = 0;
    for (let k = this.events.length - 1; k >= 0 && this.events[k].t >= from; k--) n += this.events[k].n;
    return n / span;
  }

  /**
   * Average throughput while k devices were working (ignoring each step's first
   * couple of seconds of ramp-up), and speedup relative to the one-device rate.
   */
  speedupTable(fallbackBaseline: number | null) {
    const groups = new Map<number, { t0: number; t1: number; d0: number; d1: number; seconds: number }[]>();
    // Split the timeline into stretches with a constant device count.
    let cur: { k: number; start: number } | null = null;
    const tl = this.timeline;
    for (let x = 0; x <= tl.length; x++) {
      const k = x < tl.length ? tl[x][2] : -1;
      if (cur && k === cur.k) continue;
      if (cur && cur.k > 0) {
        // drop the first 2 s of each stretch: work handed out before the change is still finishing
        const startIdx = Math.min(cur.start + 4, x - 1);
        const a = tl[startIdx];
        const b = tl[x - 1];
        if (b[0] - a[0] >= 2) {
          const arr = groups.get(cur.k) ?? [];
          arr.push({ t0: a[0], t1: b[0], d0: a[1], d1: b[1], seconds: b[0] - a[0] });
          groups.set(cur.k, arr);
        }
      }
      cur = x < tl.length ? { k, start: x } : null;
    }
    const rows = [...groups.entries()]
      .map(([devices, segs]) => {
        const seconds = segs.reduce((s, g) => s + g.seconds, 0);
        const items = segs.reduce((s, g) => s + (g.d1 - g.d0), 0);
        return { devices, rate: seconds > 0 ? items / seconds : 0, seconds: round(seconds, 1) };
      })
      .sort((a, b) => a.devices - b.devices);
    const solo = rows.find((r) => r.devices === 1 && r.seconds >= 3);
    const baseline = solo ? { rate: solo.rate, source: 'measured in this run with 1 device' } : fallbackBaseline ? { rate: fallbackBaseline, source: 'last solo run' } : null;
    return {
      baseline,
      rows: rows.map((r) => ({ ...r, rate: round(r.rate, 2), speedup: baseline && baseline.rate > 0 ? round(r.rate / baseline.rate, 2) : null })),
    };
  }

  /** Solo throughput from this run if it was entirely one device (to reuse as a later baseline). */
  soloRate(): number | null {
    const t = this.speedupTable(null);
    return t.rows.length === 1 && t.rows[0].devices === 1 && t.rows[0].seconds >= 3 ? t.rows[0].rate : null;
  }

  view(
    now: number,
    progress: { total: number; done: number; failed: number; spotChecks: number; spotAgree: number; spotDisagree: number; spotItems: number; spotSkipped: number } | null,
    nodeName: (id: string) => string,
    fallbackBaseline: number | null,
    watts: Map<string, number>,
  ): RunView {
    const end = this.finishedAt ?? now;
    const sp = this.speedupTable(fallbackBaseline);
    const perDevice = [...this.perDevice.entries()].map(([nodeId, d]) => ({ nodeId, name: nodeName(nodeId), items: d.items, activeSec: round(d.activeSec, 1) })).sort((a, b) => b.items - a.items);
    // Energy only from watts someone actually measured with a plug-in meter.
    let energy: RunView['energy'] = null;
    if (watts.size) {
      const devices: string[] = [];
      const missing: string[] = [];
      let joules = 0;
      for (const d of perDevice) {
        // The Hub computer's own node runs on the same machine as the Hub, so its plug-in meter
        // reading is the "Hub computer" row, counted once below for the whole run.
        if (d.nodeId === 'hubhost') {
          if (!watts.has('hub')) missing.push(d.name);
          continue;
        }
        const w = watts.get(d.nodeId);
        if (w === undefined) missing.push(d.name);
        else {
          devices.push(d.name);
          joules += w * d.activeSec;
        }
      }
      const hubW = watts.get('hub');
      if (hubW !== undefined) {
        devices.push('Hub');
        joules += hubW * ((end - this.startedAt) / 1000);
      }
      const wh = joules / 3600;
      // No measured device took part in this run: show nothing rather than a misleading 0 Wh.
      if (devices.length) energy = { wh: round(wh, 4), whPer1000: this.done ? round((wh / this.done) * 1000, 4) : null, devices, missing };
    }
    const extra: Record<string, unknown> = {};
    if (this.def.kernel === 'classify') {
      extra.gallery = this.gallery.slice(-12);
      extra.topLabels = [...this.labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    } else if (this.def.kernel === 'pi') {
      const est = this.pi.samples ? (4 * this.pi.inside) / this.pi.samples : null;
      extra.pi = { estimate: est, samples: this.pi.samples, error: est === null ? null : Math.abs(est - Math.PI) };
    } else if (this.def.kernel === 'sir') {
      extra.sir = { grid: this.def.params.grid, cells: this.sir.map((c) => (c ? [round(c.attack, 3), round(c.peak, 3)] : null)), params: this.def.params };
    } else if (this.def.kernel === 'tutor') {
      extra.answers = this.answers.slice().sort((a, b) => a.i - b.i);
    } else if (this.def.kernel === 'translate') {
      extra.translations = this.translations.slice().sort((a, b) => a.i - b.i);
    } else if (this.def.kernel === 'render') {
      const p = this.def.params;
      extra.render = { width: p.width, height: p.height, spp: p.spp, tile: p.tile };
    }
    return {
      jobId: this.jobId,
      lab: this.lab,
      kernel: this.def.kernel,
      title: this.def.title,
      status: this.status,
      total: this.def.total,
      done: progress?.done ?? this.done,
      failed: progress?.failed ?? this.failed,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsed: round((end - this.startedAt) / 1000, 1),
      rate: this.status === 'running' ? round(this.rate(now), 2) : round(this.done / Math.max(0.001, (end - this.startedAt) / 1000), 2),
      devices: this.status === 'running' ? this.activeNow.size : perDevice.filter((d) => d.items > 0).length,
      unit: this.def.unit,
      timeline: this.timeline.length > 900 ? this.timeline.filter((_, k) => k % Math.ceil(this.timeline.length / 900) === 0 || k === this.timeline.length - 1) : this.timeline,
      perDevice,
      baseline: sp.baseline ? { rate: round(sp.baseline.rate, 2), source: sp.baseline.source } : null,
      speedup: sp.rows,
      spot: progress
        ? { checks: progress.spotChecks, agree: progress.spotAgree, disagree: progress.spotDisagree, items: progress.spotItems, skipped: progress.spotSkipped }
        : { checks: 0, agree: 0, disagree: 0, items: 0, skipped: 0 },
      energy,
      extra,
    };
  }
}

function round(x: number, d: number) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
