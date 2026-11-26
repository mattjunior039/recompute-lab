// Benchmark page: probes this device and runs fixed, repeatable tests.
// Results go to the Hub (Benchmarks tab, bench.csv). Nothing here is estimated.

import { h, clear, fmtNum } from '../shared/dom';
import { probeCaps, defaultWorkers, webgpuAdapter } from '../shared/device';
import { Engine } from '../node/engine';
import { Tutor } from '../node/tutor';
import { Speech, wavToPcm16k } from '../node/speech';
import type { BenchRecord, Capabilities, ModelInfo } from '../shared/protocol';

const app = document.getElementById('app')!;
const qs = new URLSearchParams(location.search);
const IMAGES = Math.max(8, Math.min(1000, Number(qs.get('images')) || 96));
const TOKENS = 64;
const PI_SAMPLES = 2_000_000;
const PI_BATCHES_PER_WORKER = 4;

let caps: Capabilities;
let models: ModelInfo[] = [];
let datasetCount = 1000;
const log = h('div', { class: 'col' });
const rows: BenchRecord[] = [];
const deviceName = () => localStorage.getItem('recompute.name') || `${caps.deviceType} (${caps.browser})`;
const nodeId = () => localStorage.getItem('recompute.nodeId') ?? undefined;

function line(text: string, cls = '') {
  const el = h('div', { class: `banner ${cls || 'info'}` }, text);
  log.append(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

async function save(test: string, backend: string, threads: number, value: number, unit: string, detail?: string) {
  const rec: BenchRecord = { nodeId: nodeId(), device: deviceName(), caps, test, backend, threads, value: Math.round(value * 1000) / 1000, unit, detail };
  rows.push(rec);
  renderTable();
  try {
    const r = await fetch('/api/bench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    line(`Could not save to the Hub (${e instanceof Error ? e.message : e}). The result is still shown below.`, 'warn');
  }
}

const table = h('table');
function renderTable() {
  clear(
    table,
    h('tr', null, h('th', null, 'Test'), h('th', null, 'Backend'), h('th', null, 'Workers/threads'), h('th', null, 'Result')),
    ...rows.map((r) => h('tr', null, h('td', null, r.test), h('td', null, r.backend), h('td', { class: 'num' }, String(r.threads)), h('td', { class: 'num' }, `${fmtNum(r.value, 2)} ${r.unit}`))),
  );
}

async function classifyBench(workers: number, gpu: boolean) {
  const mn = models.find((m) => m.id === 'mobilenetv3');
  if (!mn?.ready) {
    line('Image model is not on the Hub yet; skipping image tests.', 'warn');
    return;
  }
  const label = `${workers} worker${workers === 1 ? '' : 's'}${gpu ? ', WebGPU' : ''}`;
  const status = line(`Image classification (${label}): loading model…`);
  const eng = new Engine(workers);
  try {
    await eng.loadModel(mn, { gpu, onProgress: (f) => (status.textContent = `Image classification (${label}): loading model ${Math.round(f * 100)}%`) });
    const backend = eng.backend;
    const params = { datasetCount };
    status.textContent = `Image classification (${label}): warming up…`;
    // Warm-up: one chunk per worker, also fills the image cache.
    await Promise.all(Array.from({ length: workers }, (_, k) => eng.run('classify', params, [k * 4, k * 4 + 1, k * 4 + 2, k * 4 + 3])));
    const ids = Array.from({ length: IMAGES }, (_, i) => (i * 7) % datasetCount);
    // Pre-fetch the measured images so the network isn't part of the number.
    status.textContent = `Image classification (${label}): caching ${IMAGES} images…`;
    await Promise.all(Array.from({ length: Math.min(6, workers + 2) }, async (_, k) => {
      for (let j = k; j < ids.length; j += Math.min(6, workers + 2)) await eng.run('classify', params, [ids[j]]);
    }));
    status.textContent = `Image classification (${label}): measuring ${IMAGES} images…`;
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 4) chunks.push(ids.slice(i, i + 4));
    const t0 = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < chunks.length) await eng.run('classify', params, chunks[next++]);
      }),
    );
    const sec = (performance.now() - t0) / 1000;
    const ips = IMAGES / sec;
    status.textContent = `✓ Image classification (${label}): ${fmtNum(ips, 2)} images/s`;
    status.className = 'banner ok';
    await save('classify mobilenetv3', backend, workers, ips, 'images/s', `${IMAGES} images in ${sec.toFixed(2)} s`);
  } catch (e) {
    status.textContent = `✗ Image classification (${label}) failed: ${e instanceof Error ? e.message : e}`;
    status.className = 'banner bad';
  } finally {
    eng.terminate();
  }
}

async function piBench(workers: number) {
  const status = line(`Monte Carlo π (${workers} workers): running…`);
  const eng = new Engine(workers);
  try {
    const params = { samples: PI_SAMPLES, seed: 7 };
    await eng.run('pi', { samples: 10_000, seed: 1 }, [0]);
    const n = workers * PI_BATCHES_PER_WORKER;
    const t0 = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < n) await eng.run('pi', params, [next++]);
    }));
    const sec = (performance.now() - t0) / 1000;
    const msps = (n * PI_SAMPLES) / sec / 1e6;
    status.textContent = `✓ Monte Carlo π (${workers} workers): ${fmtNum(msps, 2)} million samples/s`;
    status.className = 'banner ok';
    await save('pi monte carlo', 'js', workers, msps, 'Msamples/s', `${n} batches × ${PI_SAMPLES}`);
  } catch (e) {
    status.textContent = `✗ π failed: ${e instanceof Error ? e.message : e}`;
    status.className = 'banner bad';
  } finally {
    eng.terminate();
  }
}

/** Swarm Render speed: renders fixed 4K tiles; 1 ray = 1 pixel sample. */
async function renderBench(workers: number) {
  const status = line(`Swarm Render (${workers} workers): rendering…`);
  const eng = new Engine(workers);
  try {
    const params = { width: 3840, height: 2160, tile: 160, spp: 2, seed: 2026 };
    await eng.run('render', params, [0]);
    // a fixed band of tiles across the middle of the picture (sky, towers and street)
    const items = Array.from({ length: workers * 6 }, (_, k) => 24 * 6 + ((k * 5) % (24 * 6)));
    const t0 = performance.now();
    let next = 0;
    let rays = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const { outputs } = await eng.run('render', params, [items[next++]]);
        for (const o of outputs as { w: number; h: number }[]) rays += o.w * o.h * params.spp;
      }
    }));
    const sec = (performance.now() - t0) / 1000;
    const mrays = rays / sec / 1e6;
    status.textContent = `✓ Swarm Render (${workers} workers): ${fmtNum(mrays, 2)} million rays/s`;
    status.className = 'banner ok';
    await save('render tiles', 'js', workers, mrays, 'Mrays/s', `${items.length} tiles of 160×160 at 2 samples/pixel in ${sec.toFixed(2)} s`);
  } catch (e) {
    status.textContent = `✗ Render failed: ${e instanceof Error ? e.message : e}`;
    status.className = 'banner bad';
  } finally {
    eng.terminate();
  }
}

async function tutorBench(info: ModelInfo) {
  const status = line(`Tutor ${info.title}: loading (first time downloads ${Math.round(info.sizeBytes / 1e6)} MB from the Hub)…`);
  const tutor = new Tutor();
  try {
    await tutor.load(info, (f) => (status.textContent = `Tutor ${info.title}: loading ${Math.round(f * 100)}%`));
    status.textContent = `Tutor ${info.title}: generating ${TOKENS} tokens…`;
    await tutor.ask('Say hi.', { maxTokens: 8 });
    const r = await tutor.ask('Explain in simple words why recycling old electronics matters.', { maxTokens: TOKENS });
    const tps = r.tokPerSec ?? r.tokens / r.seconds;
    status.textContent = `✓ Tutor ${info.title}: ${fmtNum(tps, 2)} tokens/s (${tutor.threads} thread${tutor.threads === 1 ? '' : 's'})`;
    status.className = 'banner ok';
    await save(`llm ${info.id}`, crossOriginIsolated ? 'wasm-threads' : 'wasm-1thread', tutor.threads, tps, 'tokens/s', `${r.tokens} tokens; total ${r.seconds}s incl. prompt`);
  } catch (e) {
    status.textContent = `✗ Tutor ${info.title} failed: ${e instanceof Error ? e.message : e}`;
    status.className = 'banner bad';
  } finally {
    await tutor.unload();
  }
}

// Fixed sentences so translation speed is comparable between devices.
const MT_SENTENCES = [
  'Please open your notebooks to page twelve.',
  'Today we will learn how computers share work over a network.',
  'Each device solves a small part of the problem.',
  'When everyone is finished, we compare the results together.',
  'Old laptops can still be useful in a classroom.',
  'Remember to save your work before the bell rings.',
  'Who can explain the answer in their own words?',
  'Tomorrow we will measure how fast each device is.',
];

/** Captions speed: Whisper on a bundled clip (real-time factor) and English→Spanish sentences per second. */
async function captionsBench() {
  const asrInfo = models.find((m) => m.id === 'whisper-tiny-en');
  const mtInfo = models.find((m) => m.id === 'opus-mt-en-es');
  const status = line('Captions: loading speech models…');
  const sp = new Speech();
  try {
    await sp.load({ asr: asrInfo?.ready ? asrInfo : undefined, mt: mtInfo?.ready ? mtInfo : undefined }, (f) => (status.textContent = `Captions: loading speech models ${Math.round(f * 100)}%`));
    const summary: string[] = [];
    if (sp.ready.asr) {
      // sample-en.wav: synthesized with macOS text-to-speech from our own text (see data/speech/sample-en.json).
      const pcm = wavToPcm16k(await (await fetch('/data/speech/sample-en.wav')).arrayBuffer());
      const audioSec = pcm.length / 16000;
      status.textContent = 'Captions: warming up…';
      await sp.asr(pcm.subarray(0, 16000 * 2));
      status.textContent = `Captions: transcribing ${audioSec.toFixed(1)} s of speech…`;
      const r = await sp.asr(pcm);
      const rtf = audioSec / (r.ms / 1000);
      summary.push(`${fmtNum(rtf, 2)}× real time`);
      await save('captions whisper-tiny-en', sp.backend, sp.threads, rtf, 'x real time', `${audioSec.toFixed(1)} s audio in ${(r.ms / 1000).toFixed(2)} s: "${r.text}"`);
    }
    if (sp.ready.mt) {
      status.textContent = 'Captions: translating to Spanish…';
      await sp.translate([MT_SENTENCES[0]]);
      const r = await sp.translate(MT_SENTENCES);
      const sps = r.sentences / (r.ms / 1000);
      summary.push(`${fmtNum(sps, 2)} sentences/s translated`);
      await save('translate opus-mt-en-es', sp.backend, sp.threads, sps, 'sentences/s', `${r.sentences} sentences in ${(r.ms / 1000).toFixed(2)} s`);
    }
    if (!summary.length) throw new Error('speech models are not on the Hub yet');
    status.textContent = `✓ Captions: ${summary.join(', ')} (${sp.threads} thread${sp.threads === 1 ? '' : 's'}; load ${(sp.loadMs / 1000).toFixed(1)} s)`;
    status.className = 'banner ok';
  } catch (e) {
    status.textContent = `✗ Captions failed: ${e instanceof Error ? e.message : e}`;
    status.className = 'banner bad';
  } finally {
    sp.unload();
  }
}

Object.assign(globalThis, { __recomputeSpeech: { Speech, wavToPcm16k } }); // used by scripts/speech-check.ts

async function main() {
  const workers = Math.max(1, Number(qs.get('workers')) || defaultWorkers());
  caps = await probeCaps(workers);
  try {
    const info = await (await fetch('/api/info')).json();
    models = info.models;
    datasetCount = info.datasetCount;
  } catch {
    line('Could not reach the Hub. Open this page from the Hub address.', 'bad');
  }
  const gpu = await webgpuAdapter();
  const checks = {
    img: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement,
    gpu: h('input', { type: 'checkbox', checked: false, disabled: !gpu }) as HTMLInputElement,
    pi: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement,
    render: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement,
    captions: h('input', { type: 'checkbox', checked: false, disabled: !models.some((m) => m.kind === 'hf' && m.ready) }) as HTMLInputElement,
    llm: models.filter((m) => m.kind === 'gguf' && m.ready).map((m) => [m, h('input', { type: 'checkbox', checked: m.id === 'smollm2-360m' }) as HTMLInputElement] as const),
  };
  const run = h('button', { class: 'primary big' }, '▶ Run benchmarks');
  run.onclick = async () => {
    run.disabled = true;
    clear(log);
    try {
      if (checks.img.checked) {
        await classifyBench(1, false);
        if (workers > 1) await classifyBench(workers, false);
      }
      if (checks.gpu.checked) await classifyBench(1, true);
      if (checks.pi.checked) await piBench(workers);
      if (checks.render.checked) await renderBench(workers);
      if (checks.captions.checked) await captionsBench();
      for (const [m, c] of checks.llm) if (c.checked) await tutorBench(m);
      line('Done. Results are saved on the Hub (Console → Benchmarks).', 'ok');
    } finally {
      run.disabled = false;
    }
  };
  const label = (c: HTMLInputElement, t: string) => h('label', { class: 'row', style: 'gap:8px' }, c, t);
  clear(
    app,
    h(
      'div',
      { class: 'doc' },
      h('div', { class: 'brand' }, h('img', { src: '/static/icon.svg', alt: '' }), h('div', null, h('div', { class: 'name' }, 'Re', h('b', null, 'compute')), h('div', { class: 'tagline small' }, 'Benchmarks'))),
      h('h1', null, 'How fast is this device?'),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'kv' },
          h('span', { class: 'k' }, 'Device'), h('span', null, `${caps.deviceType} · ${caps.browser}`),
          h('span', { class: 'k' }, 'CPU cores'), h('span', null, `${caps.cores} (using ${workers} workers)`),
          h('span', { class: 'k' }, 'Memory'), h('span', null, caps.memoryGB ? `${caps.memoryGB} GB (browser-reported, rounded)` : 'not reported by this browser'),
          h('span', { class: 'k' }, 'WebGPU'), h('span', null, gpu ?? 'not available'),
          h('span', { class: 'k' }, 'Secure page'), h('span', null, caps.secure ? 'yes' : 'no (basic mode)'),
          h('span', { class: 'k' }, 'Multi-threading'), h('span', null, caps.isolated ? 'yes (cross-origin isolated)' : 'no'),
          h('span', { class: 'k' }, 'User agent'), h('span', { class: 'small mono' }, caps.ua),
        ),
      ),
      h(
        'div',
        { class: 'card col' },
        h('h2', null, 'Tests'),
        label(checks.img, `Image classification, MobileNetV3 (${IMAGES} photos; 1 worker, then ${workers})`),
        label(checks.gpu, `Image classification on WebGPU${gpu ? '' : ' (not available here)'}`),
        label(checks.pi, 'Monte Carlo π (pure CPU)'),
        label(checks.render, 'Swarm Render (pure CPU, million rays per second)'),
        label(checks.captions, `Captions speed: speech-to-text (× real time) and English→Spanish (sentences/s)${checks.captions.disabled ? ' (speech models not on the Hub yet)' : ''}`),
        ...checks.llm.map(([m, c]) => label(c, `Tutor: ${m.title} (tokens per second)`)),
        h('div', { class: 'muted small' }, 'Plug the device in and keep this screen on. Close other tabs. Each test takes about 10–60 seconds; the tutor test downloads the model once.'),
        run,
      ),
      log,
      h('div', { class: 'card' }, table),
      h('p', null, h('a', { href: '/join' }, '← Back to Recompute')),
    ),
  );
  renderTable();
}

void main();
