// End-to-end check: real Hub + several headless browser "devices".
// Usage: npx tsx scripts/e2e.ts [--base http://localhost:8080] [--nodes 4] [--only sort,kill,fed,sweep,tutor,http]
// Start the Hub first (npm run hub). Prints a PASS/FAIL line per check.

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import WebSocket from 'ws';
import type { ConsoleState } from '../web/src/shared/protocol';

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:8080');
const N = Number(arg('nodes', '4'));
const ONLY = new Set(arg('only', 'sort,kill,fed,sweep,tutor,http').split(','));
const WORKERS = Number(arg('workers', '1'));
const results: { name: string; ok: boolean; detail: string }[] = [];
const report = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

// ---------- console over WebSocket (localhost = teacher) ----------
let S: ConsoleState | null = null;
const wsUrl = BASE.replace(/^http/, 'ws') + '/ws?role=console';
const con = new WebSocket(wsUrl);
con.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.type === 'state') S = m.state;
  if (m.type === 'toast') console.log(`   [hub] ${m.text}`);
});
await new Promise((r) => con.once('open', r));
const cmd = (c: Record<string, unknown>) => con.send(JSON.stringify(c));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}
await until(() => S, 5000, 'console state');
cmd({ cmd: 'reset' });
cmd({ cmd: 'demo', on: false });

// ---------- devices ----------
const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream'] });
interface Dev {
  ctx: BrowserContext;
  page: Page;
  id: string;
  errors: string[];
}
async function device(label: string, base = BASE, extra = ''): Promise<Dev> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/join?room=${S!.room}&workers=${WORKERS}${extra}`);
  const id = await page.waitForFunction(() => (window as any).__recompute?.state?.welcomed && (window as any).__recompute.state.nodeId, null, { timeout: 20000 }).then((h) => h.jsonValue() as Promise<string>);
  cmd({ cmd: 'rename', nodeId: id, name: label });
  return { ctx, page, id, errors };
}
const nodeView = (id: string) => S!.nodes.find((n) => n.id === id);
async function ready(d: Dev) {
  await until(() => nodeView(d.id)?.status.ready.mobilenet, 90_000, 'image model on node');
}

const devs: Dev[] = [];
for (let k = 0; k < N; k++) devs.push(await device(`Test device ${k + 1}`));
await Promise.all(devs.map(ready));
cmd({ cmd: 'node', nodeId: '*', action: 'prepare', args: { images: true } });
await until(() => devs.every((d) => (nodeView(d.id)?.status.ready.dataset ?? 0) >= S!.datasetCount), 180_000, 'photos cached on nodes');
console.log(`   ${N} devices joined, image model + ${S!.datasetCount} photos cached on each`);

async function runLab(lab: string, options: Record<string, unknown>, ms = 300_000) {
  cmd({ cmd: 'start', lab, options });
  await until(() => S!.run?.lab === lab && S!.run.status === 'running', 10_000, `${lab} start`);
  const jobId = S!.run!.jobId;
  await until(() => S!.run?.jobId === jobId && S!.run.status !== 'running', ms, `${lab} finish`);
  return S!.run!;
}

try {
  // ---------- 1. Swarm Sort completes + speedup grows with devices ----------
  if (ONLY.has('sort')) {
    const items = Number(arg('items', '600'));
    cmd({ cmd: 'experiment', lab: 'swarm-sort', items, order: devs.map((d) => d.id) });
    const ex = await until(() => S!.experiment?.status === 'done' && S!.experiment, 900_000, 'speedup experiment');
    for (const r of ex.rows) console.log(`   ${r.devices} device(s): ${r.seconds}s  ${r.itemsPerSec} img/s  speedup ${r.speedup}×`);
    const sp = ex.rows.map((r) => r.speedup);
    const monotone = sp.every((v, i) => i === 0 || v > sp[i - 1] * 0.97);
    report('Swarm Sort completes on 1..N devices', ex.rows.length === N, `${ex.rows.length} runs of ${items} images`);
    report('Speedup increases with devices', monotone && sp.at(-1)! > 1.5, `speedups ${sp.join(' → ')}`);
    const last = S!.run!;
    report('All items labelled exactly once (no losses)', last.done === last.total && last.failed === 0, `${last.done}/${last.total}, failed ${last.failed}`);
    report('Spot checks agree', last.spot.disagree === 0, `${last.spot.checks} checks, ${last.spot.agree} agree, ${last.spot.disagree} disagree`);
  }

  // ---------- 2. A device leaving mid-job loses nothing ----------
  if (ONLY.has('kill')) {
    const victim = await device('Victim');
    await ready(victim);
    cmd({ cmd: 'start', lab: 'swarm-sort', options: { count: 1000 } });
    await until(() => S!.run?.status === 'running' && (nodeView(victim.id)?.leases ?? 0) > 0 && S!.run.done > 100, 60_000, 'victim holding work');
    const held = nodeView(victim.id)!.leases;
    await victim.ctx.close();
    console.log(`   closed "Victim" while it held ${held} lease(s), ${S!.run!.done}/${S!.run!.total} done`);
    const jobId = S!.run!.jobId;
    await until(() => S!.run?.jobId === jobId && S!.run.status !== 'running', 300_000, 'job finish after kill');
    const r = S!.run!;
    report('Device killed mid-job: job still completes', r.status === 'done' && r.done === r.total && r.failed === 0, `${r.done}/${r.total} done, failed ${r.failed}, status ${r.status}`);
    cmd({ cmd: 'forget-offline' });
  }

  // ---------- 3. Science Sweep ----------
  if (ONLY.has('sweep')) {
    const pi = await runLab('sweep', { kind: 'pi' });
    const est = (pi.extra as any).pi;
    report('Science Sweep π', pi.status === 'done' && Math.abs(est.estimate - Math.PI) < 0.01, `π ≈ ${est.estimate} from ${est.samples} samples in ${pi.elapsed.toFixed(1)}s`);
    const sir = await runLab('sweep', { kind: 'sir' });
    const cells = (sir.extra as any).sir.cells as ([number, number] | null)[];
    const filled = cells.filter(Boolean).length;
    report('Science Sweep SIR grid', sir.status === 'done' && filled === cells.length, `${filled}/${cells.length} scenarios in ${sir.elapsed.toFixed(1)}s`);
  }

  // ---------- 4. Teach the Swarm: FedAvg accuracy rises ----------
  if (ONLY.has('fed')) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('data/swarmsort/manifest.json'), 'utf8')) as { items: { file: string; category: string }[] };
    const groups = [
      ['Motorbikes', 'car_side', 'wheelchair'],
      ['cougar_face', 'Leopards', 'dalmatian'],
      ['sunflower', 'lotus', 'water_lilly'],
    ];
    const byClass = groups.map((cats) => manifest.items.filter((it) => cats.includes(it.category)).map((it) => `/data/swarmsort/images/${it.file}`));
    console.log(`   Teach test: ${byClass.map((c) => c.length).join('/')} photos per class, split across ${devs.length} devices`);
    cmd({ cmd: 'start', lab: 'teach' });
    await sleep(1000);
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < byClass[c].length; i++) {
        const d = devs[i % devs.length];
        await d.page.evaluate(([u, l]) => (window as any).__recompute.addPhotoFromUrl(u, l), [byClass[c][i], c] as const);
      }
    await until(() => S!.fed.photosOnDevices.reduce((a, b) => a + b, 0) >= byClass.flat().length, 20_000, 'photo counts');
    const rounds = Number(arg('rounds', '6'));
    for (let r = 1; r <= rounds; r++) {
      cmd({ cmd: 'fed-round' });
      await until(() => S!.fed.round >= r && !S!.fed.roundOpen, 120_000, `fed round ${r}`);
    }
    // One more evaluation of the final model.
    cmd({ cmd: 'fed-round' });
    await until(() => S!.fed.round >= rounds + 1 && !S!.fed.roundOpen, 120_000, 'final round');
    const acc = S!.fed.history.map((h) => h.overall ?? 0);
    console.log(`   accuracy per round: ${acc.map((a) => `${Math.round(a * 100)}%`).join(' → ')}`);
    report('FedAvg accuracy rises', acc.at(-1)! > acc[0] + 0.2 && acc.at(-1)! >= 0.6, `${Math.round(acc[0] * 100)}% → ${Math.round(acc.at(-1)! * 100)}%`);
    report('0 photos uploaded', S!.fed.photosUploaded === 0, `${S!.fed.weightBytesTotal} bytes of weights exchanged, photos stayed on devices`);
  }

  // ---------- 5. Private Tutor ----------
  if (ONLY.has('tutor')) {
    const tm = await until(() => S!.models.find((m) => m.id === 'smollm2-360m' && m.ready), 900_000, 'SmolLM2 on hub');
    const d = devs[0];
    await d.page.evaluate((id) => (window as any).__recompute.loadTutor(id), tm.id);
    await d.page.waitForFunction(() => (window as any).__recompute.state.tutor.ready, null, { timeout: 300_000 });
    const ans = await d.page.evaluate(() => (window as any).__recompute.ask('What is photosynthesis?', 48));
    report('Tutor generates tokens (solo, in-browser)', ans.tokens > 5 && ans.text.length > 10, `${ans.tokens} tokens at ${ans.tokPerSec?.toFixed(1)} tok/s: "${ans.text.slice(0, 80)}…"`);
    const run = await runLab('tutor', { model: tm.id, questions: ['What is photosynthesis?', 'Why is the sky blue?', 'What is a fraction?', 'Who was Ada Lovelace?'], maxTokens: 48 }, 900_000);
    const answers = (run.extra as any).answers as unknown[];
    report('Tutor swarm answers a question queue', run.status === 'done' && answers.length === run.total, `${answers.length} answers from ${run.perDevice.length} device(s) in ${run.elapsed.toFixed(0)}s`);
  }

  // ---------- 6. Plain-HTTP LAN page (no certificate) still works ----------
  if (ONLY.has('http')) {
    const lan = S!.urls.joinHttp.replace(/\/join.*$/, '');
    const d = await device('HTTP device', lan);
    const info = await d.page.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated, banner: document.body.innerText.includes('Basic mode') }));
    await ready(d);
    const out = await d.page.evaluate(() => (window as any).__recompute.engine.run('classify', { datasetCount: 1000 }, [0, 1, 2, 3]));
    report('Plain-HTTP (untrusted) page degrades but computes', !info.secure && info.banner && out.outputs.length === 4, `secure=${info.secure} isolated=${info.isolated} banner=${info.banner} labels=${out.outputs.map((o: any) => o.label).join(',')}`);
    const https = S!.urls.join.replace(/\/join.*$/, '');
    const d2 = await device('HTTPS device', https);
    const info2 = await d2.page.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated }));
    report('HTTPS LAN page is secure + cross-origin isolated', info2.secure && info2.isolated, JSON.stringify(info2));
    await d.ctx.close();
    await d2.ctx.close();
    cmd({ cmd: 'forget-offline' });
  }
} catch (e) {
  report('e2e run', false, e instanceof Error ? e.message : String(e));
}

for (const d of devs) if (d.errors.length) console.log(`   page errors on ${d.id}: ${[...new Set(d.errors)].slice(0, 5).join(' | ')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
con.close();
process.exit(failed.length ? 1 : 0);
