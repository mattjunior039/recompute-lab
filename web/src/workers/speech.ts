// Speech worker: live captions (Whisper tiny.en) and English→Spanish translation
// (OPUS-MT) with Transformers.js on the onnxruntime-web WASM backend.
// Fully offline: every model file and the ONNX runtime come from the Hub through
// filecache (hash-checked, kept on the device), never from the internet.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type TranslationPipeline } from '@huggingface/transformers';
import { fetchCached } from '../shared/filecache';
import type { ModelInfo } from '../shared/protocol';
import { cleanTranscript, splitSentences } from '../node/speech';

export type SpeechIn =
  | { type: 'init'; models: { asr?: ModelInfo; mt?: ModelInfo }; base: string; threads?: number }
  | { type: 'asr'; id: number; pcm: Float32Array }
  | { type: 'translate'; id: number; texts: string[] };

export type SpeechOut =
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'ready'; ms: number; backend: string; threads: number; asr: boolean; mt: boolean }
  | { type: 'asr'; id: number; text: string; ms: number }
  | { type: 'translate'; id: number; texts: string[]; sentences: number; ms: number }
  | { type: 'error'; id?: number; error: string };

const SR = 16000;
const SILENCE_RMS = 0.006; // loudest 20 ms frame below this = nothing worth transcribing

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let mt: TranslationPipeline | null = null;
const files = new Map<string, { url: string; sha256: string; size: number }>(); // "<modelId>/<name>" → Hub file
const loaded = new Map<string, number>();
let totalBytes = 0;
let vendor = '';

const post = (m: SpeechOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

// Transformers.js asks its cache for `<localModelPath><id>/onnx/x.onnx` (and the ORT runtime files);
// we answer from filecache so the bytes are hash-verified and survive the Hub going away.
const cache = {
  async match(key: string): Promise<Response | undefined> {
    let url: string | null = null;
    let sha: string | undefined;
    let progressKey = '';
    const m = /\/models\/([^/]+)\/(?:.*\/)?([^/]+)$/.exec(key);
    const f = m ? files.get(`${m[1]}/${m[2]}`) : undefined;
    if (f) {
      url = f.url;
      sha = f.sha256;
      progressKey = `${m![1]}/${m![2]}`;
    } else if (vendor && key.startsWith(vendor)) url = key;
    if (!url) return undefined;
    const buf = await fetchCached(url, {
      sha,
      onProgress: progressKey
        ? (p) => {
            loaded.set(progressKey, p * files.get(progressKey)!.size);
            post({ type: 'progress', loaded: [...loaded.values()].reduce((a, b) => a + b, 0), total: totalBytes, file: progressKey });
          }
        : undefined,
    });
    if (progressKey) loaded.set(progressKey, files.get(progressKey)!.size);
    const type = key.endsWith('.json') ? 'application/json' : key.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
    return new Response(buf, { headers: { 'content-type': type, 'content-length': String(buf.byteLength) } });
  },
  async put() {}, // filecache already stored it
};

async function init(msg: Extract<SpeechIn, { type: 'init' }>) {
  const t0 = performance.now();
  const base = msg.base.replace(/\/$/, '');
  vendor = `${base}/vendor/ort-tjs/`;
  env.allowRemoteModels = false; // never huggingface.co
  env.allowLocalModels = true;
  env.localModelPath = `${base}/models/`;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = cache;
  const wasm = env.backends.onnx.wasm!;
  // Plain SIMD build (no WebGPU/asyncify): smallest and fastest for the CPU-only targets.
  wasm.wasmPaths = { mjs: `${vendor}ort-wasm-simd-threaded.mjs`, wasm: `${vendor}ort-wasm-simd-threaded.wasm` };
  const cores = navigator.hardwareConcurrency || 2;
  // Threads need cross-origin isolation (SharedArrayBuffer); otherwise ORT runs single-threaded.
  const threads = crossOriginIsolated ? Math.max(1, Math.min(4, msg.threads ?? cores - 1)) : 1;
  wasm.numThreads = threads;
  wasm.proxy = false;

  files.clear();
  loaded.clear();
  totalBytes = 0;
  for (const info of [msg.models.asr, msg.models.mt]) {
    if (!info) continue;
    for (const f of info.files) {
      files.set(`${info.id}/${f.name}`, f);
      totalBytes += f.size;
    }
  }
  const opts = { device: 'wasm' as const, dtype: 'q8' as const };
  if (msg.models.asr && !asr) asr = (await pipeline('automatic-speech-recognition', msg.models.asr.id, opts)) as AutomaticSpeechRecognitionPipeline;
  if (msg.models.mt && !mt) mt = (await pipeline('translation', msg.models.mt.id, opts)) as TranslationPipeline;
  post({ type: 'ready', ms: Math.round(performance.now() - t0), backend: threads > 1 ? 'wasm-threads' : 'wasm-1thread', threads, asr: !!asr, mt: !!mt });
}

/** Loudest 20 ms frame and the share of frames above the silence threshold. */
function energy(pcm: Float32Array) {
  const n = SR / 50;
  let peak = 0;
  let voiced = 0;
  let frames = 0;
  for (let i = 0; i < pcm.length; i += n) {
    const end = Math.min(pcm.length, i + n);
    let s = 0;
    for (let j = i; j < end; j++) s += pcm[j] * pcm[j];
    const rms = Math.sqrt(s / (end - i));
    peak = Math.max(peak, rms);
    if (rms >= SILENCE_RMS) voiced++;
    frames++;
  }
  return { peak, voiced: frames ? voiced / frames : 0 };
}

async function runAsr(pcm: Float32Array) {
  if (!asr) throw new Error('speech-to-text model not loaded');
  const e = energy(pcm);
  if (pcm.length < SR / 4 || e.peak < SILENCE_RMS) return '';
  const long = pcm.length > 30 * SR;
  // English-only model: no language/task tokens. Greedy decoding, no timestamps.
  const out = await asr(pcm, { return_timestamps: false, do_sample: false, num_beams: 1, ...(long ? { chunk_length_s: 30, stride_length_s: 5 } : {}) });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) ?? '';
  return cleanTranscript(text, e.voiced);
}

async function runTranslate(texts: string[]) {
  if (!mt) throw new Error('translation model not loaded');
  const parts = texts.map(splitSentences); // Marian models are more faithful one sentence at a time
  const flat = parts.flat();
  if (!flat.length) return { texts: texts.map(() => ''), sentences: 0 };
  const out = (await mt(flat, { max_new_tokens: 256, do_sample: false, num_beams: 1 })) as { translation_text: string }[];
  let k = 0;
  return { texts: parts.map((p) => p.map(() => out[k++].translation_text.trim()).join(' ')), sentences: flat.length };
}

self.onmessage = async (ev: MessageEvent<SpeechIn>) => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'asr') post({ type: 'asr', id: msg.id, text: await runAsr(msg.pcm), ms: Math.round(performance.now() - t0) });
    else if (msg.type === 'translate') {
      const r = await runTranslate(msg.texts);
      post({ type: 'translate', id: msg.id, ...r, ms: Math.round(performance.now() - t0) });
    }
  } catch (e) {
    post({ type: 'error', id: 'id' in msg ? msg.id : undefined, error: e instanceof Error ? e.message : String(e) });
  }
};
