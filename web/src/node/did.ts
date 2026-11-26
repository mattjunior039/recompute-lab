// "What my device did": real counters of the work this device did for the class,
// and a privacy check on every message it sends to the Hub. The privacy numbers
// are not decoration: files and accounts are out of reach of a web page (the
// browser sandbox, and Recompute uses no file picker or sign-in), and anything
// that looks like a photo or a sound file is blocked before it can leave.

import { h, clear, fmtInt, fmtTime, fmtBytes } from '../shared/dom';
import type { Kernel } from '../shared/protocol';

interface Counts {
  since: number;
  jobs: number;
  recentJobs: string[];
  items: Partial<Record<Kernel, number>>;
  audioSec: number;
  computeMs: number;
  sentMsgs: number;
  sentBytes: number;
  blocked: number;
}

const LABELS: Record<Kernel, [string, string]> = {
  classify: ['image sorted', 'images sorted'],
  render: ['picture tile rendered', 'picture tiles rendered'],
  caption: ['audio piece captioned', 'audio pieces captioned'],
  translate: ['paragraph translated', 'paragraphs translated'],
  tutor: ['tutor answer', 'tutor answers'],
  pi: ['π batch', 'π batches'],
  sir: ['epidemic simulation', 'epidemic simulations'],
};

// Data-URIs anywhere, or a string field that starts like a JPEG/PNG/GIF/WebP/WAV file.
// Raw numeric payloads (rendered pixels, model weights) are checked only for data-URIs.
const MEDIA_URI = /data:(image|audio|video)\//i;
const MEDIA_FIELD = /"(?!rgb"|weights")[A-Za-z_]+":"(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)/;

export class DeviceLog {
  c: Counts;
  private store: (v: string) => void;

  constructor(load: () => string | null, store: (v: string) => void) {
    this.store = store;
    this.c = { since: Date.now(), jobs: 0, recentJobs: [], items: {}, audioSec: 0, computeMs: 0, sentMsgs: 0, sentBytes: 0, blocked: 0 };
    try {
      const v = JSON.parse(load() ?? 'null') as Partial<Counts> | null;
      if (v && typeof v.since === 'number') this.c = { ...this.c, ...v };
    } catch {}
  }

  /** Returns the text to send, or null if the message must not leave this device. */
  checkOutgoing(text: string): string | null {
    if (MEDIA_URI.test(text) || MEDIA_FIELD.test(text)) {
      this.c.blocked++;
      this.save();
      return null;
    }
    this.c.sentMsgs++;
    this.c.sentBytes += text.length;
    this.saveSoon();
    return text;
  }

  work(jobId: string, kernel: Kernel, items: number, ms: number, audioSec = 0) {
    if (!this.c.recentJobs.includes(jobId)) {
      this.c.jobs++;
      this.c.recentJobs = [jobId, ...this.c.recentJobs].slice(0, 30);
    }
    this.c.items[kernel] = (this.c.items[kernel] ?? 0) + items;
    this.c.computeMs += ms;
    this.c.audioSec += audioSec;
    this.saveSoon();
  }

  reset() {
    this.c = { since: Date.now(), jobs: 0, recentJobs: [], items: {}, audioSec: 0, computeMs: 0, sentMsgs: 0, sentBytes: 0, blocked: 0 };
    this.save();
  }

  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveSoon() {
    this.timer ??= setTimeout(() => this.save(), 2000);
  }
  private save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.store(JSON.stringify(this.c));
  }
}

/** The panel. `teachPhotos` = photos taken for Teach the Swarm, which stay on this device. */
export function didPanel(log: DeviceLog, teachPhotos: number, compact = false) {
  const c = log.c;
  const work = (Object.keys(LABELS) as Kernel[])
    .filter((k) => (c.items[k] ?? 0) > 0)
    .map((k) => {
      const n = c.items[k]!;
      const extra = k === 'caption' && c.audioSec ? ` (${fmtTime(c.audioSec)} of audio, in memory only)` : '';
      return h('li', null, h('b', { class: 'num' }, fmtInt(n)), ` ${LABELS[k][n === 1 ? 0 : 1]}${extra}`);
    });
  const zero = (n: number, label: string) => h('div', { class: 'zero' }, h('b', { class: 'num' }, String(n)), h('span', null, label));
  const since = new Date(c.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const resetBtn = h('button', { class: 'ghost small', 'data-no-pause': '' }, 'Reset counts');
  resetBtn.onclick = () => {
    log.reset();
    resetBtn.dispatchEvent(new CustomEvent('did-reset', { bubbles: true }));
  };
  return h(
    'div',
    { class: `card did ${compact ? 'compact' : ''}` },
    h('h3', null, 'What my device did'),
    h(
      'div',
      { class: 'muted small' },
      c.jobs ? `Since ${since}: helped with ${fmtInt(c.jobs)} class job${c.jobs === 1 ? '' : 's'} · ${fmtTime(c.computeMs / 1000)} of computing` : `Nothing yet. Work this device does for the class is counted here.`,
    ),
    work.length ? h('ul', { class: 'did-list' }, ...work) : null,
    teachPhotos && !compact ? h('div', { class: 'small' }, `📷 ${fmtInt(teachPhotos)} Teach photo${teachPhotos === 1 ? '' : 's'} on this device: used for training here, never sent.`) : null,
    h('div', { class: 'did-privacy' }, zero(0, 'files accessed'), zero(0, 'accounts touched'), zero(0, 'photos uploaded'), zero(0, 'audio saved')),
    h(
      'div',
      { class: 'muted small' },
      'Why always 0: the browser sandbox keeps web pages away from your files and accounts, Recompute has no file picker or sign-in, and audio is only held in memory. ',
      `Every message this device sends is checked, and anything that looks like a photo or sound is blocked: ${fmtInt(c.sentMsgs)} sent (${fmtBytes(c.sentBytes)}), only results and model weights.`,
      c.blocked ? ` ${fmtInt(c.blocked)} blocked because they looked like a photo or sound.` : '',
    ),
    compact ? null : h('div', { class: 'row', style: 'justify-content:flex-end' }, resetBtn),
  );
}
