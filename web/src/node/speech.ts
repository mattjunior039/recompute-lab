// Live captions and English→Spanish translation on this device. The models run in
// a Web Worker (workers/speech.ts); files come from the Hub once and are cached.

import type { ModelInfo } from '../shared/protocol';
import type { SpeechIn, SpeechOut } from '../workers/speech';

type Pending = { resolve: (m: SpeechOut) => void; reject: (e: Error) => void };

export class Speech {
  private w: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private loading: Promise<void> | null = null;
  private onReady: Pending | null = null;
  private progress?: (f: number) => void;
  ready = { asr: false, mt: false };
  backend = '';
  threads = 1;
  loadMs = 0;
  error: string | null = null;

  constructor(private onChange: () => void = () => {}) {}

  get busy() {
    return this.pending.size > 0;
  }

  /** Load (or add) models. `onProgress` gets 0..1 over all files that still need downloading. */
  load(models: { asr?: ModelInfo; mt?: ModelInfo }, onProgress?: (f: number) => void): Promise<void> {
    if ((!models.asr || this.ready.asr) && (!models.mt || this.ready.mt)) return this.loading ?? Promise.resolve();
    if (this.loading) return this.loading.then(() => this.load(models, onProgress));
    this.loading = new Promise<void>((resolve, reject) => {
      const w = (this.w ??= this.spawn());
      this.onReady = {
        resolve: (m) => {
          if (m.type === 'ready') {
            this.ready = { asr: m.asr, mt: m.mt };
            this.backend = m.backend;
            this.threads = m.threads;
            this.loadMs = m.ms;
          }
          resolve();
        },
        reject,
      };
      this.progress = onProgress;
      const want = { asr: this.ready.asr ? undefined : models.asr, mt: this.ready.mt ? undefined : models.mt };
      const msg: SpeechIn = { type: 'init', models: want, base: location.origin };
      w.postMessage(msg);
    })
      .then(
        () => void (this.error = null),
        (e: Error) => {
          this.error = e.message;
          throw e;
        },
      )
      .finally(() => {
        this.loading = null;
        this.onReady = null;
        this.progress = undefined;
        this.onChange();
      });
    this.onChange();
    return this.loading;
  }

  private spawn() {
    const w = new Worker('/dist/speech.js', { type: 'module', name: 'recompute-speech' });
    w.onmessage = (e: MessageEvent<SpeechOut>) => {
      const m = e.data;
      if (m.type === 'progress') return this.progress?.(m.total ? m.loaded / m.total : 0);
      if (m.type === 'ready') return this.onReady?.resolve(m);
      if (m.id === undefined) return m.type === 'error' && this.onReady?.reject(new Error(m.error));
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.error));
      else p.resolve(m);
      this.onChange();
    };
    w.onerror = (e) => {
      const err = new Error(e.message || 'speech worker crashed');
      this.onReady?.reject(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.unload();
    };
    return w;
  }

  private call(msg: SpeechIn, transfer: Transferable[] = []): Promise<SpeechOut> {
    if (!this.w) return Promise.reject(new Error('speech models not loaded'));
    return new Promise((resolve, reject) => {
      this.pending.set((msg as { id: number }).id, { resolve, reject });
      this.w!.postMessage(msg, transfer);
      this.onChange();
    });
  }

  /** Transcribe 16 kHz mono audio. Silence returns ''. */
  async asr(pcm: Float32Array): Promise<{ text: string; ms: number }> {
    const copy = pcm.slice(); // transferred, so the caller keeps its buffer
    const m = await this.call({ type: 'asr', id: ++this.seq, pcm: copy }, [copy.buffer]);
    return m.type === 'asr' ? { text: m.text, ms: m.ms } : { text: '', ms: 0 };
  }

  /** Translate English → Spanish, one output per input text. */
  async translate(texts: string[]): Promise<{ texts: string[]; ms: number; sentences: number }> {
    const m = await this.call({ type: 'translate', id: ++this.seq, texts });
    return m.type === 'translate' ? { texts: m.texts, ms: m.ms, sentences: m.sentences } : { texts: [], ms: 0, sentences: 0 };
  }

  unload() {
    this.w?.terminate();
    this.w = null;
    this.ready = { asr: false, mt: false };
    for (const p of this.pending.values()) p.reject(new Error('speech unloaded'));
    this.pending.clear();
    this.onChange();
  }
}

// Whisper's usual inventions on (near-)silence; dropped when little of the clip is voiced.
const HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'so', 'okay']);

/** Remove non-speech tags ([BLANK_AUDIO], (music), *laughs*, ♪) and silence hallucinations. */
export function cleanTranscript(text: string, voicedShare = 1) {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bare = t.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  if (!bare || (voicedShare < 0.3 && HALLUCINATIONS.has(bare))) return '';
  return t;
}

export function splitSentences(text: string) {
  return text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

/** Resample mono audio to 16 kHz (box-filter average when downsampling, linear interpolation when upsampling). */
export function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return input.slice();
  const ratio = fromRate / 16000;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const c = i * ratio;
    if (ratio > 1) {
      const a = Math.max(0, Math.floor(c - ratio / 2));
      const b = Math.min(input.length, Math.ceil(c + ratio / 2));
      let s = 0;
      for (let j = a; j < b; j++) s += input[j];
      out[i] = s / Math.max(1, b - a);
    } else {
      const j = Math.floor(c);
      const f = c - j;
      out[i] = input[j] * (1 - f) + (input[j + 1] ?? input[j]) * f;
    }
  }
  return out;
}

/** Parse a WAV file (PCM 8/16/24/32-bit or float32/64), mix down to mono, resample to 16 kHz. */
export function wavToPcm16k(buf: ArrayBuffer): Float32Array {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: [number, number] | null = null;
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = v.getUint16(o + 8, true);
      if (format === 0xfffe && len >= 26) format = v.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') data = [o + 8, Math.min(len, buf.byteLength - o - 8)];
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV file has no audio data');
  const { format, channels, rate, bits } = fmt;
  const bytes = bits / 8;
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && (bits === 32 || bits === 64))) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  const frames = Math.floor(data[1] / (bytes * channels));
  const read = (o: number) => {
    if (format === 3) return bits === 32 ? v.getFloat32(o, true) : v.getFloat64(o, true);
    if (bits === 8) return (v.getUint8(o) - 128) / 128;
    if (bits === 16) return v.getInt16(o, true) / 32768;
    if (bits === 24) return ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608);
    return v.getInt32(o, true) / 2147483648;
  };
  const mono = new Float32Array(frames);
  for (let i = 0, o = data[0]; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++, o += bytes) s += read(o);
    mono[i] = s / channels;
  }
  return rate === 16000 ? mono : resampleTo16k(mono, rate);
}
