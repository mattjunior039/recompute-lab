// End-to-end check: real Hub + several headless browser "devices".
// Usage: npx tsx scripts/e2e.ts [--base http://localhost:8080] [--nodes 4] [--only sort,kill,fed,sweep,tutor,http,render,wall,captions,translate,console]
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
// Swarm Render tiles streamed to the Console: who rendered which tile.
const tileOwner = new Map<number, string>();
let tileJob: string | null = null;
con.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.type === 'state') S = m.state;
  if (m.type === 'render-tiles') {
    // Same rule as the real Console (web/src/console/v2.ts onRenderTiles), so a reset that
    // would wipe the on-screen picture shows up here as missing tiles.
    const job = m.header?.jobId ?? null;
    if (job !== tileJob || (m.reset && m.tiles.length)) tileOwner.clear();
    tileJob = job;
    for (const t of m.tiles) tileOwner.set(t.item, t.node);
  }
  if (m.type === 'toast') console.log(`   [hub] ${m.text}`);
});
await new Promise((r) => con.once('open', r));
const cmd = (c: Record<string, unknown>) => con.send(JSON.stringify(c));
const buf4 = (b: Buffer, o: number) => b.toString('latin1', o, o + 4);
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
const externalRequests: string[] = [];
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 820, height: 1180 },
];
let devCount = 0;
const browser = await chromium.launch({ args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream'] });
interface Dev {
  ctx: BrowserContext;
  page: Page;
  id: string;
  errors: string[];
}
async function device(label: string, base = BASE, extra = ''): Promise<Dev> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORTS[devCount++ % VIEWPORTS.length] });
  // Devices may only talk to the Hub: any request to the internet is blocked and counted.
  await ctx.route('**/*', (r) => {
    const host = new URL(r.request().url()).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local')) return r.continue();
    externalRequests.push(r.request().url());
    return r.abort();
  });
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
if (['sort', 'kill', 'fed', 'http'].some((k) => ONLY.has(k))) {
  await Promise.all(devs.map(ready));
  cmd({ cmd: 'node', nodeId: '*', action: 'prepare', args: { images: true } });
  await until(() => devs.every((d) => (nodeView(d.id)?.status.ready.dataset ?? 0) >= S!.datasetCount), 180_000, 'photos cached on nodes');
  console.log(`   ${N} devices joined, image model + ${S!.datasetCount} photos cached on each`);
} else console.log(`   ${N} devices joined`);

async function runLab(lab: string, options: Record<string, unknown>, ms = 300_000) {
  const before = S!.run?.jobId;
  cmd({ cmd: 'start', lab, options });
  await until(() => S!.run?.lab === lab && S!.run.jobId !== before, 10_000, `${lab} start`);
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

  // ---------- 7. Swarm Render: completes, every tile attributed, PNG saved, race ----------
  if (ONLY.has('render')) {
    const res = arg('res', '1080p');
    const spp = Number(arg('spp', '1'));
    const run = await runLab('render', { res, spp }, 900_000);
    await until(() => tileOwner.size >= run.total, 20_000, 'all tiles streamed to the Console');
    const owners = new Map<string, number>();
    for (const id of tileOwner.values()) owners.set(id, (owners.get(id) ?? 0) + 1);
    const names = [...owners].map(([id, n]) => `${nodeView(id)?.name ?? id}: ${n}`).join(', ');
    report('Swarm Render completes', run.status === 'done' && run.done === run.total && run.failed === 0, `${run.done}/${run.total} tiles of ${res} spp ${spp} in ${run.elapsed.toFixed(1)}s`);
    report('Every tile attributed to a device', tileOwner.size === run.total && owners.size >= Math.min(2, N) && [...tileOwner.values()].every((id) => devs.some((d) => d.id === id)), names);
    await sleep(1500);
    report('Console keeps the whole picture after the finish', tileOwner.size === run.total, `${tileOwner.size}/${run.total} tiles on screen`);
    const r = await fetch(`${BASE}/api/render.png`);
    const buf = Buffer.from(await r.arrayBuffer());
    const w = buf.readUInt32BE(16);
    const hgt = buf.readUInt32BE(20);
    const want = res === '8k' ? [7680, 4320] : res === '4k' ? [3840, 2160] : [1920, 1080];
    report('Full-size PNG saved', r.ok && w === want[0] && hgt === want[1], `${r.status} ${w}×${hgt}, ${(buf.length / 1e6).toFixed(1)} MB`);
    fs.mkdirSync('scripts/tmp', { recursive: true });
    fs.writeFileSync('scripts/tmp/render.png', buf);
    const wall = await fetch(`${BASE}/api/render/wall.png`);
    report('Wall picture served to nodes (no key)', wall.ok && wall.headers.get('content-type') === 'image/png', `${wall.status}`);
    if (N >= 2) {
      cmd({ cmd: 'race', lab: 'render', first: devs[0].id, options: { res, spp } });
      const ex = await until(() => S!.experiment?.race && ['done', 'cancelled'].includes(S!.experiment.status) && S!.experiment, 900_000, 'render race');
      for (const row of ex.rows) console.log(`   race: ${row.devices} device(s) ${row.seconds}s → ${row.speedup}×`);
      report('Race: 1 device vs all', ex.status === 'done' && ex.rows.length === 2 && ex.rows[1].speedup > 1.3, ex.rows.map((x) => `${x.devices}: ${x.seconds}s`).join(' vs '));
      const rc = await (await fetch(`${BASE}/api/render.csv`)).text();
      const rl = rc.trim().split(/\r?\n/);
      report('render.csv export (devices,seconds)', rl[0] === 'devices,seconds' && rl.length === 3 && rl[1].startsWith('1,') && rl[2].startsWith(`${N},`), rl.join(' | '));
    }
  }

  // ---------- 8. Screen Wall: slices line up, clocks synced ----------
  // ---------- Pause while in use + "What my device did" (Join mode) ----------
  if (ONLY.has('feedback')) {
    const d = devs[0];
    const local = () => d.page.evaluate(() => (window as any).__recompute.state) as Promise<any>;
    // Idle device: a key press pauses it, and it comes back by itself after 30 s.
    await d.page.keyboard.press('Shift');
    await until(() => nodeView(d.id)?.status.state === 'paused-input', 3000, 'paused-input on the Hub');
    const chip = await d.page.locator('.chip.warn').filter({ hasText: 'Paused' }).first().textContent();
    const t0 = Date.now();
    await until(() => nodeView(d.id)?.status.state === 'idle', 40_000, 'auto resume');
    const back = (Date.now() - t0) / 1000;
    report('Pause on input, auto-resume after ~30 s idle', !!chip && back > 25 && back < 36, `chip “${chip?.trim()}” · resumed after ${back.toFixed(1)} s`);

    // While a job runs: input frees the processor at once, the job still finishes with nothing lost.
    const before = S!.run?.jobId;
    cmd({ cmd: 'start', lab: 'sweep', options: { kind: 'pi', batches: Number(arg('fbBatches', '400')), samples: 10_000_000 } });
    await until(() => S!.run?.jobId !== before && S!.run?.lab === 'sweep', 10_000, 'sweep start');
    const job = S!.run!.jobId;
    await until(() => (nodeView(d.id)?.itemsRun ?? 0) > 0 && nodeView(d.id)?.status.state === 'working', 60_000, 'device working');
    const tp = Date.now();
    await d.page.mouse.click(4, 4);
    const freeMs = await d.page.evaluate(async () => {
      const t = performance.now();
      while ((window as any).__recompute.engine.busy > 0 && performance.now() - t < 5000) await new Promise((r) => setTimeout(r, 10));
      return performance.now() - t;
    });
    await until(() => nodeView(d.id)?.status.state === 'paused-input', 3000, 'paused on the Hub');
    await sleep(1500);
    const a = nodeView(d.id)!.itemsRun;
    await sleep(4000);
    const b = nodeView(d.id)!.itemsRun;
    report('Input stops computing instantly', freeMs < 500 && a === b, `workers free ${Math.round(freeMs)} ms after the click; items during pause: ${a} → ${b} (${((Date.now() - tp) / 1000).toFixed(1)} s)`);
    await d.page.getByRole('button', { name: 'Resume now' }).click();
    await until(() => nodeView(d.id)?.status.state === 'working' || S!.run?.status !== 'running', 10_000, 'resume now');
    const resumed = nodeView(d.id)!.status.state;
    await until(() => S!.run?.jobId === job && S!.run.status !== 'running', 600_000, 'sweep finish');
    const run = S!.run!;
    report('“Resume now”, and the job loses nothing', run.status === 'done' && run.done === run.total && run.failed === 0, `after resume: ${resumed}; ${run.done}/${run.total} batches, ${run.failed} failed, ${run.elapsed.toFixed(1)} s`);

    await sleep(2500);
    const st = await local();
    const txt = (await d.page.locator('.did').textContent()) ?? '';
    report(
      '“What my device did” counts real work, privacy block at 0',
      st.did.jobs >= 1 && (st.did.items.pi ?? 0) > 0 && st.did.sentMsgs > 0 && st.did.blocked === 0 && /0files accessed\s*0accounts touched\s*0photos uploaded\s*0audio saved/.test(txt),
      `jobs ${st.did.jobs}, π batches ${st.did.items.pi}, ${st.did.sentMsgs} messages (${(st.did.sentBytes / 1024).toFixed(0)} KB) checked, ${st.did.blocked} blocked`,
    );
    fs.mkdirSync('scripts/tmp', { recursive: true });
    await d.page.screenshot({ path: 'scripts/tmp/node-did.png', fullPage: true });

    const r = await device('Reborn test', BASE, '&mode=reborn');
    await r.page.keyboard.press('Shift');
    await sleep(1500);
    const rs = nodeView(r.id)?.status.state;
    report('Reborn mode ignores input (compute-only)', rs !== 'paused-input' && (await r.page.locator('.did').count()) === 1, `state ${rs}`);
    await r.page.screenshot({ path: 'scripts/tmp/node-reborn.png' });
    await r.ctx.close();
  }

  if (ONLY.has('wall')) {
    await until(() => devs.every((d) => S!.wall.devices.find((x) => x.id === d.id)?.screen && S!.wall.devices.find((x) => x.id === d.id)?.clock), 30_000, 'screens + clocks reported');
    const order = devs.map((d) => d.id).reverse();
    cmd({ cmd: 'wall', order, gap: 40, scene: 'sweep' });
    await sleep(1500);
    const views = await Promise.all(devs.map((d) => d.page.evaluate(() => (window as any).__recompute.wall)));
    const slots = order.map((id) => views[devs.findIndex((d) => d.id === id)].msg?.slot);
    let x = 0;
    let ok = slots.every(Boolean);
    for (let k = 0; k < slots.length && ok; k++) {
      const s = slots[k];
      if (Math.abs(s.x - x) > 0.5) ok = false;
      x = s.x + s.w + 40;
    }
    const sizes = devs.map((d, k) => {
      const v = views[k].msg?.slot;
      const vp = VIEWPORTS[k % VIEWPORTS.length];
      return v && v.w === vp.width && v.h === vp.height;
    });
    const H = Math.max(...slots.map((s) => s.h));
    const centred = slots.every((s) => Math.abs(s.y - Math.round((H - s.h) / 2)) <= 0.5);
    report('Wall slices tile the canvas left→right in the chosen order', ok && sizes.every(Boolean) && centred, slots.map((s) => `[${s.x},${s.y} ${s.w}×${s.h}]`).join(' '));
    const rtts = views.map((v) => v.rtt);
    const sameAt = new Set(views.map((v) => v.msg?.at)).size === 1;
    report('Clock sync: every screen has an offset, one start time', rtts.every((r) => r !== null && r < 200) && sameAt, `rtt ms ${rtts.map((r) => Math.round(r)).join('/')} · offsets ${views.map((v) => Math.round(v.offset)).join('/')}`);
    // Stitch a screenshot of every device into one picture, in wall order, to eyeball alignment.
    await sleep(1800);
    fs.mkdirSync('scripts/tmp', { recursive: true });
    for (const [k, id] of order.entries()) await devs.find((d) => d.id === id)!.page.screenshot({ path: `scripts/tmp/wall-${k + 1}.png` });
    cmd({ cmd: 'wall', scene: 'off' });
  }

  // ---------- 9. Live Captions from a recorded WAV, offline, reassembled in order ----------
  if (ONLY.has('captions')) {
    const wav = fs.readFileSync(path.resolve('data/speech/sample-en.wav'));
    const fixture = JSON.parse(fs.readFileSync(path.resolve('data/speech/sample-en.json'), 'utf8')) as { text: string };
    let o = 12;
    while (buf4(wav, o) !== 'data') o += 8 + wav.readUInt32LE(o + 4);
    const pcm = wav.subarray(o + 8, o + 8 + wav.readUInt32LE(o + 4));
    cmd({ cmd: 'captions', on: true, translate: true });
    await until(() => S!.captions.on, 10_000, 'captions on');
    await until(() => S!.nodes.filter((n) => n.online && n.status.ready.asr && n.status.ready.mt).length >= Math.min(2, N), 600_000, 'speech models on devices');
    cmd({ cmd: 'captions-clear' });
    // Cut at quiet points like the Console does (here: fixed 3 s pieces, nudged to the quietest 100 ms).
    const rate = 16000;
    const pieces: Buffer[] = [];
    let at = 0;
    while (at < pcm.length / 2) {
      let end = Math.min(pcm.length / 2, at + 3 * rate);
      if (pcm.length / 2 - end < rate) end = pcm.length / 2; // fold a short tail into the last piece
      if (end < pcm.length / 2) {
        let best = end;
        let bestE = Infinity;
        for (let c = end - rate; c <= end + rate && c + 1600 < pcm.length / 2; c += 400) {
          let e = 0;
          for (let i = c; i < c + 1600; i++) e += Math.abs(pcm.readInt16LE(i * 2));
          if (e < bestE) ((bestE = e), (best = c + 800));
        }
        end = pcm.length / 2 - best < rate / 2 ? pcm.length / 2 : best;
      }
      pieces.push(pcm.subarray(at * 2, end * 2));
      at = end;
    }
    const t0 = Date.now();
    for (const [k, p] of pieces.entries()) {
      cmd({ cmd: 'caption-audio', seq: k, pcm: p.toString('base64'), sampleRate: 16000, endedAt: Date.now() });
      await sleep(100); // all at once: forces several devices to work in parallel
    }
    await until(() => S!.captions.lines.length >= pieces.length && S!.captions.pending === 0, 300_000, 'all captions back').catch((e) => {
      console.log(`   captions state: ${JSON.stringify({ ...S!.captions, lines: S!.captions.lines.map((l) => [l.seq, l.en]) })}`);
      console.log(`   devices: ${JSON.stringify(S!.nodes.map((n) => [n.name, n.online, n.status.state, n.status.ready]))}`);
      throw e;
    });
    const lines = S!.captions.lines;
    const text = lines.map((l) => l.en).join(' ');
    const words = (t: string) => t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const want = words(fixture.text);
    const got = new Set(words(text));
    const hit = want.filter((w) => got.has(w)).length / want.length;
    const ordered = lines.every((l, i) => i === 0 || l.seq > lines[i - 1].seq);
    console.log(`   EN: ${text}`);
    console.log(`   ES: ${lines.map((l) => l.es).join(' ')}`);
    report('Captions: speech recognised from the WAV', hit > 0.8, `${Math.round(hit * 100)}% of words, ${pieces.length} pieces in ${((Date.now() - t0) / 1000).toFixed(1)}s, lag ~${S!.captions.lagSec}s`);
    report('Captions: reassembled in order across devices', ordered && lines.length === pieces.length, `seq ${lines.map((l) => l.seq).join(',')} from ${new Set(lines.map((l) => l.node)).size} device(s): ${S!.captions.devices.join(', ')}`);
    const cc = (await (await fetch(`${BASE}/api/captions.csv`)).text()).trim().split(/\r?\n/);
    report('captions.csv export (latency_s)', cc[0].split(',').includes('latency_s') && cc.length === lines.length + 1 && !/today|class/i.test(cc.join()), `${cc.length - 1} rows, header ${cc[0]}`);
    report('Captions: Spanish line + 0 s audio saved', lines.every((l) => (l.es ?? '').length > 0) && S!.captions.audioSecondsSaved === 0, `${S!.captions.audioSecondsHeard.toFixed(1)} s heard, ${S!.captions.audioSecondsSaved} s saved`);
    cmd({ cmd: 'captions', on: false });
  }

  // ---------- 10. Translate a document: paragraphs in parallel ----------
  if (ONLY.has('translate')) {
    const paragraphs = ['The library is open on Saturday morning.', 'Please bring your library card.', 'Students can borrow three books at a time.', 'The computer lab closes at five o’clock.', 'Ask the front desk if you need help.', 'Thank you for visiting.'];
    const run = await runLab('translate', { paragraphs }, 600_000);
    const tr = (run.extra as any).translations as { i: number; en: string; es: string; node: string }[];
    tr.forEach((t) => console.log(`   ${t.i}. ${t.es}  (${t.node})`));
    report('Translate a document', run.status === 'done' && tr.length === paragraphs.length && tr.every((t, k) => t.i === k && t.en === paragraphs[k] && t.es.length > 3), `${tr.length} paragraphs by ${new Set(tr.map((t) => t.node)).size} device(s) in ${run.elapsed.toFixed(1)}s`);
  }

  // ---------- 11. Console pages render without errors ----------
  if (ONLY.has('console')) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    fs.mkdirSync('scripts/tmp', { recursive: true });
    if (!S!.fleet.perDevice.length && S!.fleet.efficiency) {
      // A real measurement for the fleet calculator: the /bench page's render test on a headless device.
      const b = await ctx.newPage();
      await b.goto(`${BASE}/bench`);
      await b.waitForSelector('button.primary.big');
      await b.$$eval('input[type=checkbox]', (els) => els.forEach((e, i) => ((e as HTMLInputElement).checked = false)));
      await b.getByText('Swarm Render (pure CPU').click();
      await b.click('button.primary.big');
      await b.waitForSelector('text=Results are saved on the Hub', { timeout: 120_000 });
      await b.close();
      await until(() => S!.fleet.perDevice.length > 0, 10_000, 'fleet inputs');
    }
    for (const v of ['lab', 'uses', 'wall', 'devices', 'bench', 'setup']) {
      await page.goto(`${BASE}/console?view=${v}`);
      await page.waitForSelector('.c-nav');
      await sleep(1500);
      await page.screenshot({ path: `scripts/tmp/console-${v}.png` });
      if (v === 'uses' && S!.fleet.efficiency && S!.fleet.perDevice.length) {
        const fc = await page.evaluate(async () => {
          const a = document.querySelector('a[download="fleet.csv"]') as HTMLAnchorElement | null;
          return a ? (await fetch(a.href)).text() : '';
        });
        const fl = fc.trim().split(/\r?\n/);
        report('fleet.csv export (fleet_devices,fleet_result)', fl[0].startsWith('fleet_devices,fleet_result,') && fl.length > 1, `${fl.length - 1} rows: ${fl.slice(1, 3).join(' | ')}`);
      }
    }
    report('Console views load without errors', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'lab, uses, wall, devices, bench, setup');
    await ctx.close();
  }
} catch (e) {
  report('e2e run', false, e instanceof Error ? e.message : String(e));
}

report('Devices made no internet requests', externalRequests.length === 0, externalRequests.length ? externalRequests.slice(0, 3).join(' ') : 'every request went to the Hub');
for (const d of devs) if (d.errors.length) console.log(`   page errors on ${d.id}: ${[...new Set(d.errors)].slice(0, 5).join(' | ')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
con.close();
process.exit(failed.length ? 1 : 0);
