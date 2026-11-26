// Live captions: audio pieces are captioned by whichever devices are free, so
// they can finish out of order. This puts them back in order and measures the
// real delay. Audio itself is never kept: only the text comes back.

import type { CaptionLine } from '../../web/src/shared/protocol';

interface Waiting {
  receivedAt: number;
  audioSec: number;
}

export class CaptionOrderer {
  next = 0;
  private waiting = new Map<number, Waiting>();
  private ready = new Map<number, { en: string; es: string | null; node: string; at: number } | null>();

  constructor(private maxWaitMs = 30_000) {}

  get pending() {
    return this.waiting.size + this.ready.size;
  }

  /** A new piece of audio arrived (seq numbers start at 0 for each captions session). */
  add(seq: number, receivedAt: number, audioSec: number) {
    if (seq < this.next || this.waiting.has(seq) || this.ready.has(seq)) return false;
    this.waiting.set(seq, { receivedAt, audioSec });
    return true;
  }

  /** A device finished a piece (null = it failed and is skipped). Returns lines now ready to show, in order. */
  complete(seq: number, out: { en: string; es: string | null; node: string } | null, now: number): CaptionLine[] {
    if (!this.waiting.has(seq)) return [];
    this.ready.set(seq, out ? { ...out, at: now } : null);
    return this.release(now);
  }

  /** Release finished pieces in order. A piece stuck for too long is skipped so captions never freeze. */
  release(now: number): CaptionLine[] {
    const out: CaptionLine[] = [];
    for (;;) {
      if (this.ready.has(this.next)) {
        const r = this.ready.get(this.next)!;
        const w = this.waiting.get(this.next)!;
        this.ready.delete(this.next);
        this.waiting.delete(this.next);
        if (r && r.en.trim()) out.push({ seq: this.next, en: r.en.trim(), es: r.es?.trim() || null, node: r.node, lagSec: Math.round((now - w.receivedAt) / 100) / 10, audioSec: w.audioSec });
        this.next++;
        continue;
      }
      const w = this.waiting.get(this.next);
      const later = [...this.waiting.keys(), ...this.ready.keys()].some((s) => s > this.next);
      if ((!w && later) || (w && now - w.receivedAt > this.maxWaitMs)) {
        this.waiting.delete(this.next);
        this.next++;
        continue;
      }
      break;
    }
    return out;
  }

  reset() {
    this.next = 0;
    this.waiting.clear();
    this.ready.clear();
  }
}
