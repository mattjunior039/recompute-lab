// Federated averaging (McMahan et al., 2017) for "Teach the Swarm".
// Devices send model weights + how many photos they trained on; never photos.

import { b64ToF32, f32ToB64, FED_CLASSES, FEATURE_DIM } from '../../web/src/shared/protocol';
import { headSize, type HeadDims } from '../../web/src/shared/head';

export interface FedUpdate {
  weights: Float32Array;
  n: number;
}

/** Weighted average of client weights, weighted by local sample count. */
export function fedAvg(updates: FedUpdate[]): Float32Array | null {
  const used = updates.filter((u) => u.n > 0);
  if (!used.length) return null;
  const len = used[0].weights.length;
  if (used.some((u) => u.weights.length !== len)) throw new Error('weight size mismatch');
  const total = used.reduce((s, u) => s + u.n, 0);
  const out = new Float64Array(len);
  for (const u of used) {
    const f = u.n / total;
    for (let i = 0; i < len; i++) out[i] += f * u.weights[i];
  }
  return Float32Array.from(out);
}

export interface RoundStats {
  round: number;
  perClass: (number | null)[]; // accuracy of the global model at the start of this round, on held-out photos
  overall: number | null;
  evalPhotos: number;
  trainPhotos: number;
  participants: number;
  weightBytes: number; // bytes of weights received this round
  at: number;
}

export class FedSession {
  readonly id: string;
  readonly classes = FED_CLASSES;
  readonly dims: HeadDims = { inDim: FEATURE_DIM, classes: FED_CLASSES.length };
  weights: Float32Array;
  round = 0;
  history: RoundStats[] = [];
  private open: { round: number; expected: Set<string>; got: Map<string, { u: FedUpdate | null; correct: number[]; total: number[]; bytes: number }>; startedAt: number } | null = null;

  constructor(id: string, seed = 7) {
    this.id = id;
    // Small random start, so round 0 is an honest "guessing" baseline.
    let s = seed;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.02;
    this.weights = new Float32Array(headSize(this.dims)).map(() => r());
  }

  get roundOpen() {
    return !!this.open;
  }

  /** Begin a round with these devices. Returns the message to send them. */
  startRound(nodeIds: string[], epochs = 20, lr = 0.5) {
    this.round++;
    this.open = { round: this.round, expected: new Set(nodeIds), got: new Map(), startedAt: Date.now() };
    return {
      type: 'fed:round' as const,
      sessionId: this.id,
      round: this.round,
      classes: this.classes,
      weights: f32ToB64(this.weights),
      dims: [this.dims.classes, this.dims.inDim] as [number, number],
      epochs,
      lr,
    };
  }

  /** Record one device's reply. Returns true when every expected device has replied. */
  submit(nodeId: string, msg: { round: number; weights: string | null; n: number; evalCorrect: number[]; evalTotal: number[] }) {
    if (!this.open || msg.round !== this.open.round || !this.open.expected.has(nodeId)) return false;
    let u: FedUpdate | null = null;
    if (msg.weights && msg.n > 0) {
      const w = b64ToF32(msg.weights);
      if (w.length === this.weights.length && w.every(Number.isFinite)) u = { weights: w, n: msg.n };
    }
    this.open.got.set(nodeId, { u, correct: msg.evalCorrect, total: msg.evalTotal, bytes: msg.weights ? msg.weights.length * 0.75 : 0 });
    return this.open.got.size >= this.open.expected.size;
  }

  dropNode(nodeId: string) {
    if (!this.open) return false;
    this.open.expected.delete(nodeId);
    return this.open.got.size >= this.open.expected.size;
  }

  /** Close the round: FedAvg the received weights and record accuracy. */
  finishRound(): RoundStats | null {
    if (!this.open) return null;
    const replies = [...this.open.got.values()];
    const updates = replies.filter((r) => r.u).map((r) => r.u!) as FedUpdate[];
    const avg = fedAvg(updates);
    if (avg) this.weights = avg;
    const C = this.classes.length;
    const correct = new Array(C).fill(0);
    const total = new Array(C).fill(0);
    for (const r of replies)
      for (let c = 0; c < C; c++) {
        correct[c] += r.correct?.[c] ?? 0;
        total[c] += r.total?.[c] ?? 0;
      }
    const evalPhotos = total.reduce((a, b) => a + b, 0);
    const stats: RoundStats = {
      round: this.open.round,
      perClass: total.map((t, c) => (t ? correct[c] / t : null)),
      overall: evalPhotos ? correct.reduce((a, b) => a + b, 0) / evalPhotos : null,
      evalPhotos,
      trainPhotos: updates.reduce((s, u) => s + u.n, 0),
      participants: updates.length,
      weightBytes: Math.round(replies.reduce((s, r) => s + r.bytes, 0)),
      at: Date.now(),
    };
    this.history.push(stats);
    this.open = null;
    return stats;
  }
}
