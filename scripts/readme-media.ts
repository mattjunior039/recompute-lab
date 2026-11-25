// Capture the README screenshots and GIF from the real running app (never mocked).
// Every "device" here is a headless browser on ONE computer, so the numbers in these images
// are not device performance numbers. Real numbers come from /bench and the speedup experiment.
//
// Usage (Hub running): npx tsx scripts/readme-media.ts [--base http://localhost:8080] [--out opensource/docs/images]
// Needs ffmpeg on PATH for the GIF (skipped otherwise).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { ConsoleState } from '../web/src/shared/protocol';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:8080');
const OUT = path.resolve(arg('out', 'opensource/docs/images'));
const WORKERS = Number(arg('workers', '1'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const vidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recompute-vid-'));
const conCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: vidDir, size: { width: 1920, height: 1080 } } });
await conCtx.addInitScript('globalThis.__name = (f) => f');
const con = await conCtx.newPage();
const tVideo0 = Date.now();
con.on('dialog', (d) => d.accept());
await con.goto(`${BASE}/console`);
await con.addStyleTag({ content: '.toasts { display: none !important; }' });
await con.evaluate(() => {
  const w = window as any;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=console`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') w.__S = m.state;
  };
  w.__cmd = (c: unknown) => ws.send(JSON.stringify(c));
  w.__ready = new Promise((r) => (ws.onopen = r));
});
await con.evaluate(() => (window as any).__ready);
const S = () => con.evaluate(() => (window as any).__S as ConsoleState);
const cmd = (c: Record<string, unknown>) => con.evaluate((x) => (window as any).__cmd(x), c);
async function until<T>(f: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}
const shot = async (p: Page, name: string, full = false) => {
  await p.screenshot({ path: path.join(OUT, name), fullPage: full });
  console.log('  saved', name);
};
const tab = async (name: string) => {
  await con.locator('nav.c-nav').getByRole('button', { name, exact: true }).click();
  await sleep(700);
};

await until(S, 5000, 'state');
await cmd({ cmd: 'host-compute', on: false });
await cmd({ cmd: 'demo', on: false });
await cmd({ cmd: 'clear', what: 'history' });
await cmd({ cmd: 'clear', what: 'speedup' });
await sleep(1000);
const room = (await S()).room;

// Four test devices. The last one has a phone-sized screen for the node screenshot.
interface Dev {
  ctx: BrowserContext;
  page: Page | null;
  id: string;
  name: string;
}
const names = ['Test device A', 'Test device B', 'Test device C', 'Test device D (phone-sized)'];
const devs: Dev[] = [];
async function open(d: Dev) {
  d.page = await d.ctx.newPage();
  await d.page.goto(`${BASE}/join?room=${room}&workers=${WORKERS}`);
  d.id = await d.page
    .waitForFunction(() => (window as any).__recompute?.state?.welcomed && (window as any).__recompute.state.nodeId, null, { timeout: 30000 })
    .then((x) => x.jsonValue() as Promise<string>);
}
for (const [k, name] of names.entries()) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: k === 3 ? { width: 390, height: 844 } : { width: 1280, height: 800 }, deviceScaleFactor: k === 3 ? 2 : 1 });
  await ctx.addInitScript('globalThis.__name = (f) => f');
  const d: Dev = { ctx, page: null, id: '', name };
  await open(d);
  await cmd({ cmd: 'rename', nodeId: d.id, name });
  devs.push(d);
}
console.log('preparing models + photos on 4 test devices…');
await cmd({ cmd: 'node', nodeId: '*', action: 'prepare', args: { mobilenet: true, images: true } });
await until(async () => (await S()).nodes.filter((n) => n.online && n.status.ready.mobilenet && n.status.ready.dataset >= 1000).length >= 4, 300_000, 'devices ready');

// Devices B-D leave, so the run starts on one device and the others visibly join.
for (const d of devs.slice(1)) {
  await d.page!.close();
  d.page = null;
}
await sleep(2500);
await tab('Lab');
console.log('Swarm Sort 1 → 4 devices…');
const tGif0 = Date.now();
await cmd({ cmd: 'start', lab: 'swarm-sort', options: { count: 3000 } });
await sleep(8000);
for (const d of devs.slice(1)) {
  await open(d);
  await sleep(3000);
}
await shot(devs[3].page!, 'node-phone.png');
await sleep(2500);
const tGif1 = Date.now();
await shot(con, 'console-swarm-sort-running.png');
await until(async () => {
  const r = (await S()).run;
  return r?.lab === 'swarm-sort' && r.status === 'done';
}, 300_000, 'swarm sort done');
await sleep(1500);
await shot(con, 'console-swarm-sort.png');

// Teach the Swarm: each device holds its own share of labelled photos; only weights travel.
console.log('Teach the Swarm…');
const manifest = JSON.parse(fs.readFileSync('data/swarmsort/manifest.json', 'utf8')) as { items: { file: string; category: string }[] };
const groups = [
  ['Motorbikes', 'car_side', 'wheelchair'],
  ['cougar_face', 'Leopards', 'dalmatian'],
  ['sunflower', 'lotus', 'water_lilly'],
];
const byClass = groups.map((cats) => manifest.items.filter((it) => cats.includes(it.category)).map((it) => `/data/swarmsort/images/${it.file}`));
await con.getByText('Teach the Swarm', { exact: false }).first().click();
await sleep(1500);
for (let c = 0; c < 3; c++)
  for (let i = 0; i < byClass[c].length; i++) {
    const d = devs[i % devs.length];
    await d.page!.evaluate(([u, l]) => (window as any).__recompute.addPhotoFromUrl(u, l), [byClass[c][i], c] as const);
  }
for (let r = 1; r <= 4; r++) {
  await cmd({ cmd: 'fed-round' });
  await until(async () => {
    const s = await S();
    return s.fed.round >= r && !s.fed.roundOpen;
  }, 180_000, `round ${r}`);
}
await sleep(1500);
await shot(con, 'console-teach.png');

// Science Sweep (Monte Carlo pi).
console.log('Science Sweep…');
await con.getByText('Science Sweep', { exact: false }).first().click();
await until(async () => {
  const r = (await S()).run;
  return r?.lab === 'sweep' && r.status === 'done';
}, 300_000, 'sweep done');
await sleep(1500);
await shot(con, 'console-science-sweep.png');

// Private Tutor on the phone-sized device, typed into the real UI.
console.log('Private Tutor…');
const phone = devs[3].page!;
const tm = (await S()).models.find((m) => m.kind === 'gguf' && m.ready);
if (tm) {
  await phone.getByRole('button', { name: /Tutor/ }).first().click();
  await phone.evaluate((id) => (window as any).__recompute.loadTutor(id), tm.id);
  await phone.waitForFunction(() => (window as any).__recompute.state.tutor.ready, null, { timeout: 300_000 });
  await phone.locator('textarea').fill('Why should old electronics be repaired instead of thrown away?');
  await phone.getByRole('button', { name: /^Ask$/ }).click();
  await phone.waitForFunction(() => !document.querySelector('button.primary[disabled]') && /tok\/s/.test(document.body.innerText), null, { timeout: 180_000 }).catch(() => {});
  await sleep(1000);
  await shot(phone, 'node-tutor.png', true);
}

// Automated speedup experiment 1 → 4 (Benchmarks tab).
console.log('Speedup experiment…');
await tab('Benchmarks');
await con.locator('input[type=number]').first().fill('300');
await con.locator('input[type=number]').first().dispatchEvent('change');
await con.getByRole('button', { name: /^Use all/ }).click();
await con.getByRole('button', { name: /Run 1 → 4/ }).click();
await until(async () => (await S()).experiment?.status === 'done', 600_000, 'experiment done');
await sleep(1500);
const exp = con.locator('.card', { hasText: 'Speedup experiment ·' }).first();
await exp.scrollIntoViewIfNeeded();
await exp.screenshot({ path: path.join(OUT, 'console-speedup-experiment.png') });
console.log('  saved console-speedup-experiment.png');

await tab('Lab');
await cmd({ cmd: 'reset' });
const vid = await con.video()!.path();
await conCtx.close();
await browser.close();

// GIF: the Swarm Sort run from one device to four.
try {
  const ss = ((tGif0 - tVideo0) / 1000).toFixed(1);
  const dur = ((tGif1 - tGif0) / 1000).toFixed(1);
  const gif = path.join(OUT, 'swarm-sort-join.gif');
  const filter = 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', ss, '-t', dur, '-i', vid, '-vf', filter, gif]);
  console.log('  saved swarm-sort-join.gif', (fs.statSync(gif).size / 1e6).toFixed(1), 'MB');
} catch (e) {
  console.log('  GIF skipped:', e instanceof Error ? e.message : e);
}
fs.rmSync(vidDir, { recursive: true, force: true });
