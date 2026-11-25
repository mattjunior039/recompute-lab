// Private Tutor: a small language model running entirely on this device via
// wllama (llama.cpp compiled to WebAssembly). Works with no internet at all:
// the model file comes from the Hub on the local network and is cached.

import { Wllama } from '@wllama/wllama';
import type { ModelInfo } from '../shared/protocol';

export const SYSTEM_PROMPT = 'You are a friendly, accurate tutor for high-school students. Answer clearly in at most three short sentences.';

export class Tutor {
  private w: Wllama | null = null;
  modelId: string | null = null;
  loading: Promise<void> | null = null;
  busy = false;
  threads = 1;
  lastTokPerSec: number | null = null;
  error: string | null = null;
  storage = "";

  constructor(private onChange: () => void = () => {}) {}

  get ready() {
    return !!this.w && !!this.modelId && !this.loading;
  }

  load(info: ModelInfo, onProgress?: (f: number) => void) {
    if (this.modelId === info.id && this.w) return this.loading ?? Promise.resolve();
    if (this.loading) return this.loading;
    const file = info.files.find((f) => f.name.endsWith('.gguf'));
    if (!file) return Promise.reject(new Error('no GGUF file'));
    this.loading = (async () => {
      try {
        await this.unload();
        const make = () => {
          const w = new Wllama({ default: '/vendor/wllama/wllama.wasm' }, { allowOffline: true, parallelDownloads: 3, suppressNativeLog: true, logger: quietLogger });
          w.setCompat({ wasm: '/vendor/wllama-compat/wllama.wasm' });
          return w;
        };
        const cores = navigator.hardwareConcurrency || 2;
        // Leave one core for the device; wllama only uses >1 thread when the page is cross-origin isolated.
        const params = { n_ctx: 1024, n_batch: 256, n_threads: Math.max(1, Math.min(4, cores - 1)) };
        const url = new URL(file.url, location.href).href;
        let w = make();
        let viaOpfs = false;
        if (await opfsAvailable()) {
          // Best path: wllama streams the model into on-device storage (OPFS) and reuses it next time.
          try {
            await w.loadModelFromUrl(url, { ...params, useCache: true, progressCallback: ({ loaded, total }) => onProgress?.(total ? loaded / total : 0) });
            viaOpfs = true;
          } catch (e) {
            console.warn('[tutor] OPFS load failed, using in-memory download', e);
            await w.exit().catch(() => {});
            w = make();
          }
        }
        if (!viaOpfs) {
          // Fallback (plain-http pages, private browsing, some Safari versions): download into memory.
          const blob = await fetchBlob(url, file.size, onProgress);
          await w.loadModel([blob], params);
        }
        this.storage = viaOpfs ? 'device storage' : 'memory (downloads again next time)';
        this.w = w;
        this.modelId = info.id;
        this.threads = w.getNumThreads?.() ?? 1;
        this.error = null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.loading = null;
        this.onChange();
      }
    })();
    this.onChange();
    return this.loading;
  }

  async unload() {
    const w = this.w;
    this.w = null;
    this.modelId = null;
    if (w) await w.exit().catch(() => {});
  }

  /** Stream an answer. Returns the full text, token count and seconds. */
  async ask(question: string, opts: { maxTokens?: number; onToken?: (text: string) => void; signal?: AbortSignal; history?: { role: 'user' | 'assistant'; content: string }[] } = {}) {
    if (!this.w) throw new Error('tutor not loaded');
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
    this.busy = true;
    this.onChange();
    const t0 = performance.now();
    let text = '';
    let tokens = 0;
    let tps: number | null = null;
    try {
      await this.w.createChatCompletion({
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...(opts.history ?? []), { role: 'user', content: question }],
        max_tokens: opts.maxTokens ?? 160,
        temperature: 0.3,
        stream: true,
        abortSignal: opts.signal,
        onData: (chunk) => {
          const d = chunk.choices?.[0]?.delta?.content;
          if (d) {
            text += d;
            tokens++;
            opts.onToken?.(text);
          }
          if (chunk.timings?.predicted_n) {
            tokens = chunk.timings.predicted_n;
            tps = chunk.timings.predicted_per_second;
          }
        },
      });
    } finally {
      this.busy = false;
    }
    const seconds = (performance.now() - t0) / 1000;
    this.lastTokPerSec = tps ?? (seconds > 0 ? tokens / seconds : null);
    this.onChange();
    return { text: text.trim(), tokens, seconds: Math.round(seconds * 10) / 10, tokPerSec: this.lastTokPerSec };
  }
}

async function fetchBlob(url: string, size: number, onProgress?: (f: number) => void): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || size;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(total ? got / total : 0);
  }
  return new Blob(parts as BlobPart[]);
}

async function opfsAvailable() {
  try {
    if (!globalThis.isSecureContext || !navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

const quietLogger = {
  debug: () => {},
  log: () => {},
  warn: (...a: unknown[]) => console.warn('[tutor]', ...a),
  error: (...a: unknown[]) => console.error('[tutor]', ...a),
};
