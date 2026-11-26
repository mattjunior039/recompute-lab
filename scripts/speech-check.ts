// Offline speech check: loads the speech worker from a running Hub with every non-Hub request blocked,
// transcribes data/speech/sample-en.wav, translates to Spanish, then repeats with the Hub's model and
// runtime files blocked too (must come from the device cache). Finally runs the bench page's Captions test.
// Usage: start a Hub, then  npx tsx scripts/speech-check.ts [https://localhost:8443]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../hub/src/config';

const BASE = (process.argv[2] ?? `https://localhost:${process.env.RECOMPUTE_HTTPS_PORT ?? 8443}`).replace(/\/$/, '');
const hubHost = new URL(BASE).host;
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/speech/sample-en.json'), 'utf8')).text as string;
const PARAGRAPHS = [
  'Our school collected twenty old laptops this year. Instead of recycling them right away, students cleaned them and installed a browser. Now they help with science projects every week.',
  'Please work with a partner and write down three questions about the experiment. When you are done, share your questions with the class.',
  'Computers use electricity even when they are idle. Turning off screens and unused devices at the end of the day saves energy and money.',
];
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the Hub's certificate is from its own local CA

const words = (s: string) => s.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
function overlap(got: string, want: string) {
  const g = new Set(words(got));
  const w = words(want);
  return w.filter((x) => g.has(x)).length / w.length;
}

// 1. Wait for the Hub to have both speech models.
for (let i = 0; ; i++) {
  try {
    const info = await (await fetch(`${BASE}/api/info`)).json();
    const sp = info.models.filter((m: { kind: string }) => m.kind === 'hf');
    if (sp.length >= 2 && sp.every((m: { ready: boolean }) => m.ready)) break;
    if (i % 10 === 0) console.log('waiting for speech models:', sp.map((m: { id: string; progress: number }) => `${m.id} ${Math.round(m.progress * 100)}%`).join(', '));
  } catch {}
  if (i > 600) throw new Error('speech models never became ready');
  await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
await context.addInitScript('globalThis.__name = f => f');
const seen = new Map<string, number>();
const blocked: string[] = [];
let hubDown = false; // phase 2: pretend the Hub's model + runtime files are unreachable
await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  const kind = u.host !== hubHost ? u.host : u.pathname.split('/').slice(0, 2).join('/') || '/';
  seen.set(kind, (seen.get(kind) ?? 0) + 1);
  if (u.host !== hubHost) {
    blocked.push(u.href);
    return route.abort();
  }
  if (hubDown && (u.pathname.startsWith('/models/') || u.pathname.startsWith('/vendor/ort-tjs/'))) {
    blocked.push(u.href);
    return route.abort('internetdisconnected');
  }
  return route.continue();
});
const page = await browser.contexts()[0].newPage();
page.on('console', (m) => m.type() === 'error' && console.log('  [page error]', m.text()));
await page.goto(`${BASE}/bench`);
await page.waitForFunction(() => 'crossOriginIsolated' in globalThis && (globalThis as any).__recomputeSpeech);

async function run(label: string, pg = page) {
  const r = await pg.evaluate(async (paragraphs) => {
    const { Speech, wavToPcm16k } = (globalThis as any).__recomputeSpeech;
    const info = await (await fetch('/api/info')).json();
    const asr = info.models.find((m: any) => m.id === 'whisper-tiny-en');
    const mt = info.models.find((m: any) => m.id === 'opus-mt-en-es');
    const sp = new Speech();
    const t0 = performance.now();
    await sp.load({ asr, mt });
    const loadWall = performance.now() - t0;
    const pcm: Float32Array = wavToPcm16k(await (await fetch('/data/speech/sample-en.wav')).arrayBuffer());
    const silence = await sp.asr(new Float32Array(16000 * 3).map(() => (Math.random() - 0.5) * 0.002));
    await sp.asr(pcm.subarray(0, 32000)); // warm-up
    const a = await sp.asr(pcm);
    const t = await sp.translate([a.text, ...paragraphs]);
    sp.unload();
    return { isolated: crossOriginIsolated, backend: sp.backend, threads: sp.threads, loadMs: sp.loadMs, loadWall, audioSec: pcm.length / 16000, asr: a, silence, tr: t };
  }, PARAGRAPHS);
  console.log(`\n=== ${label} ===`);
  console.log(`crossOriginIsolated=${r.isolated} backend=${r.backend} threads=${r.threads} load=${(r.loadWall / 1000).toFixed(2)} s`);
  console.log(`silence (3 s low noise) → ${JSON.stringify(r.silence.text)}`);
  console.log(`ASR: ${r.audioSec.toFixed(2)} s audio in ${r.asr.ms} ms → RTF ${(r.audioSec / (r.asr.ms / 1000)).toFixed(2)}× real time`);
  console.log(`transcript: ${JSON.stringify(r.asr.text)}`);
  console.log(`translate: ${r.tr.sentences} sentences in ${r.tr.ms} ms → ${(r.tr.sentences / (r.tr.ms / 1000)).toFixed(2)} sentences/s`);
  r.tr.texts.forEach((s: string, i: number) => console.log(`  es[${i}]: ${s}`));
  const ov = overlap(r.asr.text, expected);
  console.log(`word overlap with the known text: ${(ov * 100).toFixed(0)}%`);
  if (ov < 0.7) throw new Error(`transcript overlap too low (${(ov * 100).toFixed(0)}%)`);
  if (r.silence.text !== '') throw new Error('silence produced text');
  if (r.tr.texts.length !== PARAGRAPHS.length + 1 || r.tr.texts.some((s: string) => !s)) throw new Error('missing translations');
}

await run('first run (models from the Hub over the LAN)');
hubDown = true;
await run('second run (Hub model + runtime files blocked: device cache only)');

// The bench page's own Captions test (still with model files blocked).
await page.reload();
await page.waitForSelector('text=Run benchmarks');
for (const box of await page.locator('label input[type=checkbox]').all()) if (await box.isChecked()) await box.uncheck();
await page.locator('label', { hasText: 'Captions speed' }).locator('input').check();
await page.click('text=Run benchmarks');
await page.waitForSelector('text=Done. Results are saved', { timeout: 300_000 });
console.log('\n=== bench page ===');
for (const b of await page.locator('.banner').allTextContents()) console.log(' ', b);
for (const row of await page.locator('table tr').allTextContents()) console.log(' ', row);

console.log(`\nrequests seen (by path prefix): ${JSON.stringify(Object.fromEntries(seen))}`);
console.log(`blocked: ${blocked.filter((u) => !u.includes(hubHost)).length} non-Hub, ${blocked.filter((u) => u.includes(hubHost)).length} Hub (phase 2)`);
if (blocked.some((u) => !u.includes(hubHost))) console.log('  non-Hub attempts:', blocked.filter((u) => !u.includes(hubHost)));

// Without COOP/COEP (crossOriginIsolated=false): single-threaded wasm fallback.
const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
await ctx2.addInitScript('globalThis.__name = f => f');
await ctx2.route('**/*', async (route) => {
  if (new URL(route.request().url()).host !== hubHost) return route.abort();
  const res = await route.fetch();
  const headers = res.headers();
  delete headers['cross-origin-opener-policy'];
  delete headers['cross-origin-embedder-policy'];
  return route.fulfill({ response: res, headers });
});
const page2 = await ctx2.newPage();
await page2.goto(`${BASE}/bench`);
await page2.waitForFunction(() => (globalThis as any).__recomputeSpeech);
await run('third run (not crossOriginIsolated: 1 thread)', page2);

await browser.close();
console.log('speech check OK');
