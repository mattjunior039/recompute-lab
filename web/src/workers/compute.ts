// Compute worker: runs ONLY the built-in kernels below. The Hub sends item
// numbers and parameters, never code.

import { piBatch, sirScenario, type SirParams } from '../shared/kernels';
import { fetchCached } from '../shared/filecache';
import type { ClassifyOutput } from '../shared/protocol';

type Ort = typeof import('onnxruntime-web');

export type WorkerIn =
  | { type: 'init-model'; model: ArrayBuffer; ortBase: string; gpu: boolean }
  | { type: 'run'; id: number; kernel: string; params: Record<string, unknown>; items: number[]; pixels?: Uint8ClampedArray[] }
  | { type: 'features'; id: number; pixels: Uint8ClampedArray };

export type WorkerOut =
  | { type: 'hello'; canDecode: boolean }
  | { type: 'model-ready'; backend: string; ms: number }
  | { type: 'model-error'; error: string }
  | { type: 'done'; id: number; outputs: unknown[]; ms: number }
  | { type: 'error'; id: number; error: string }
  | { type: 'features'; id: number; features: Float32Array; logits: Float32Array; ms: number };

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MAX_BATCH = 4;

let ort: Ort | null = null;
let session: import('onnxruntime-web').InferenceSession | null = null;
let backend = 'none';
const canDecode = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' && !!safeCtx();

function safeCtx() {
  try {
    return new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  } catch {
    return null;
  }
}

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'init-model') {
    const t0 = performance.now();
    try {
      await initModel(m.model, m.ortBase, m.gpu);
      post({ type: 'model-ready', backend, ms: performance.now() - t0 });
    } catch (err) {
      post({ type: 'model-error', error: errText(err) });
    }
    return;
  }
  if (m.type === 'features') {
    try {
      const t0 = performance.now();
      const { features, logits } = await infer([m.pixels], true);
      post({ type: 'features', id: m.id, features: features![0], logits: logits[0], ms: performance.now() - t0 });
    } catch (err) {
      post({ type: 'error', id: m.id, error: errText(err) });
    }
    return;
  }
  if (m.type === 'run') {
    const t0 = performance.now();
    try {
      const outputs = await runKernel(m.kernel, m.params, m.items, m.pixels);
      post({ type: 'done', id: m.id, outputs, ms: performance.now() - t0 });
    } catch (err) {
      post({ type: 'error', id: m.id, error: errText(err) });
    }
  }
};

post({ type: 'hello', canDecode });

async function initModel(model: ArrayBuffer, ortBase: string, gpu: boolean) {
  const file = gpu ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs';
  ort = (await import(/* @vite-ignore */ `${ortBase}${file}`)) as Ort;
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.wasm.numThreads = 1; // one thread per worker; we scale with workers instead
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const providers = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: providers, graphOptimizationLevel: 'all' });
  backend = gpu ? 'webgpu' : 'wasm';
  // Warm-up so the first timed chunk isn't penalised by JIT/allocations.
  await infer([new Uint8ClampedArray(SIZE * SIZE * 4)], false);
}

async function runKernel(kernel: string, params: Record<string, unknown>, items: number[], pixels?: Uint8ClampedArray[]): Promise<unknown[]> {
  switch (kernel) {
    case 'pi':
      return items.map((i) => piBatch(i, params as { samples: number; seed: number }));
    case 'sir':
      return items.map((i) => sirScenario(i, params as unknown as SirParams));
    case 'classify': {
      if (!session) throw new Error('model not loaded');
      const count = Number(params.datasetCount) || 1000;
      const px = pixels ?? (await Promise.all(items.map((i) => loadImage(i % count))));
      const out: ClassifyOutput[] = [];
      for (let k = 0; k < px.length; k += MAX_BATCH) {
        const { logits } = await infer(px.slice(k, k + MAX_BATCH), false);
        for (const l of logits) out.push(top1(l));
      }
      return out;
    }
    default:
      throw new Error(`unknown kernel ${kernel}`);
  }
}

export function imageUrl(i: number) {
  return `/data/swarmsort/images/${String(i).padStart(4, '0')}.jpg`;
}

async function loadImage(i: number): Promise<Uint8ClampedArray> {
  const buf = await fetchCached(imageUrl(i));
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  const c = new OffscreenCanvas(SIZE, SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
  bmp.close?.();
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

async function infer(px: Uint8ClampedArray[], withFeatures: boolean) {
  const b = px.length;
  const plane = SIZE * SIZE;
  const input = new Float32Array(b * 3 * plane);
  for (let n = 0; n < b; n++) {
    const src = px[n];
    const base = n * 3 * plane;
    for (let p = 0; p < plane; p++) {
      input[base + p] = (src[p * 4] / 255 - MEAN[0]) / STD[0];
      input[base + plane + p] = (src[p * 4 + 1] / 255 - MEAN[1]) / STD[1];
      input[base + 2 * plane + p] = (src[p * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  const tensor = new ort!.Tensor('float32', input, [b, 3, SIZE, SIZE]);
  const names = session!.outputNames;
  const featName = names.find((n) => n !== 'logits');
  const fetch = withFeatures && featName ? ['logits', featName] : ['logits'];
  const res = await session!.run({ [session!.inputNames[0]]: tensor }, fetch);
  const lg = res.logits.data as Float32Array;
  const classes = lg.length / b;
  const logits = Array.from({ length: b }, (_, n) => lg.slice(n * classes, (n + 1) * classes));
  let features: Float32Array[] | null = null;
  if (withFeatures && featName) {
    const fd = res[featName].data as Float32Array;
    const dim = fd.length / b;
    features = Array.from({ length: b }, (_, n) => fd.slice(n * dim, (n + 1) * dim));
  }
  tensor.dispose?.();
  return { logits, features };
}

function top1(l: Float32Array): ClassifyOutput {
  let best = 0;
  let max = -Infinity;
  for (let k = 0; k < l.length; k++)
    if (l[k] > max) {
      max = l[k];
      best = k;
    }
  let sum = 0;
  for (let k = 0; k < l.length; k++) sum += Math.exp(l[k] - max);
  return { label: best, score: Math.round((1 / sum) * 1000) / 1000 };
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
