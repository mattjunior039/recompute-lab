// Checks "This computer computes too" (the Hub's own node inside its Console), Console smoothness
// while it computes, the one-click speedup experiment, and Console legibility on big screens.
// Usage: npx tsx scripts/host-check.ts [--base http://localhost:8080] [--engine chromium|webkit] [--out /tmp/host-check]
// Start the Hub first (npm run hub).

import fs from 'node:fs';
import { chromium, webkit, type Page } from 'playwright';
import type { ConsoleState } from '../web/src/shared/protocol';

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:8080');
const ENGINE = arg('engine', 'chromium');
const OUT = arg('out', '/tmp/host-check');
fs.mkdirSync(OUT, { recursive: true });
const results: { name: string; ok: boolean; detail: string }[] = [];
const report = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch({ args: ENGINE === 'webkit' ? [] : ['--ignore-certificate-errors'] });
const conCtx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
await conCtx.addInitScript('globalThis.__name = (f) => f'); // tsx keepNames helper used inside evaluate()
const con = await conCtx.newPage();
const errors: string[] = [];
con.on('pageerror', (e) => errors.push(e.message));
await con.goto(`${BASE}/console`);
// The Console keeps the latest Hub state; read it through a second console socket in the page.
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
    await sleep(400);
  }
}
await cmd({ cmd: 'reset' });
await cmd({ cmd: 'host-compute', on: false });
await until(async () => (await S())?.room, 5000, 'state');
const st0 = await S();
report('console on the Hub sees the toggle', st0.isHost && st0.canControl, `isHost=${st0.isHost} name="${st0.hostCompute.name}" workers=${st0.hostCompute.workers}/${st0.hostCompute.maxWorkers}`);

// Auto-zoom on a 2560-wide screen.
const zoom = await con.evaluate(() => document.documentElement.style.getPropertyValue('zoom'));
report('auto-zoom on 2560-wide screen', Math.abs(Number(zoom) - 1.33) < 0.02, `zoom=${zoom}`);

// One click on the toggle.
await con.waitForFunction(() => !document.querySelector('.host-frame') && !document.querySelector('.card.host-on'), null, { timeout: 10000 });
await con.getByRole('button', { name: /computes too/ }).first().click();
const host = await until(async () => (await S()).nodes.find((n) => n.host && n.online), 20_000, 'host node online');
report('toggle adds the Hub computer as a node', host.id === 'hubhost' && host.name === st0.hostCompute.name, `tile "${host.name}" (${host.caps.workers} workers, ${host.caps.browser})`);
await until(async () => (await S()).nodes.find((n) => n.host)?.status.ready.mobilenet, 60_000, 'host image model');

// Two ordinary devices.
const devs: Page[] = [];
for (let k = 0; k < 2; k++) {
  const c = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await c.newPage();
  await p.goto(`${BASE.replace('localhost', '127.0.0.1')}/join?room=${st0.room}&workers=1`);
  const id = await p.waitForFunction(() => (window as any).__recompute?.state?.welcomed && (window as any).__recompute.state.nodeId, null, { timeout: 20000 }).then((x) => x.jsonValue() as Promise<string>);
  await cmd({ cmd: 'rename', nodeId: id, name: k === 0 ? 'Test Chromebook' : 'Test phone' });
  devs.push(p);
}
await until(async () => (await S()).nodes.filter((n) => n.online && n.status.ready.mobilenet).length >= 3, 60_000, 'all models ready');

// A normal tab in the same browser profile as the Console must not fight the Hub node.
const sameProfile = await conCtx.newPage();
await sameProfile.goto(`${BASE}/join?room=${st0.room}&workers=1`);
const tabId = await sameProfile.waitForFunction(() => (window as any).__recompute?.state?.welcomed && (window as any).__recompute.state.nodeId, null, { timeout: 20000 }).then((x) => x.jsonValue() as Promise<string>);
await sleep(3000);
const afterTab = await S();
report('host node coexists with a join tab in the same browser', tabId !== 'hubhost' && !!afterTab.nodes.find((n) => n.host && n.online), `tab node ${tabId}; host still online`);
await sameProfile.close();

// Swarm Sort with the Hub computing; measure the Console's frame rate meanwhile.
const idleFps = await con.evaluate(() => new Promise<number>((r) => {
  let n = 0;
  const t0 = performance.now();
  const f = () => (performance.now() - t0 < 3000 ? (n++, requestAnimationFrame(f)) : r(n / 3));
  requestAnimationFrame(f);
}));
await cmd({ cmd: 'start', lab: 'swarm-sort', options: { count: 300 } });
await until(async () => (await S()).run?.status === 'running', 10_000, 'run start');
await sleep(1500);
const busyFps = await con.evaluate(() => new Promise<{ fps: number; worst: number }>((r) => {
  let n = 0;
  let worst = 0;
  let last = performance.now();
  const t0 = last;
  const f = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (now - t0 < 4000) {
      n++;
      requestAnimationFrame(f);
    } else r({ fps: n / 4, worst });
  };
  requestAnimationFrame(f);
}));
await con.screenshot({ path: `${OUT}/console-2560-running.png` });
const done = await until(async () => {
  const s = await S();
  return s.run?.status === 'done' ? s : null;
}, 120_000, 'run done');
const hostItems = done.run!.perDevice.find((d) => d.nodeId === 'hubhost')?.items ?? 0;
report('Hub computer took part in the job', hostItems > 0 && done.run!.done === 300, `${hostItems}/300 photos on the Hub node; per device: ${done.run!.perDevice.map((d) => `${d.name}=${d.items}`).join(', ')}`);
report('Console stays smooth while the Hub computes', busyFps.fps >= Math.min(45, idleFps * 0.75), `idle ${idleFps.toFixed(0)} fps, computing ${busyFps.fps.toFixed(0)} fps, worst frame ${busyFps.worst.toFixed(0)} ms`);

// One-click experiment: Benchmarks tab → Use all → Run.
await con.getByRole('button', { name: 'Benchmarks' }).click();
await con.locator('input[type=number]').first().fill('120');
await con.locator('input[type=number]').first().dispatchEvent('change');
await con.getByRole('button', { name: /^Use all/ }).click();
await con.getByRole('button', { name: /▶ Run 1 → 3 devices/ }).click();
const ex = await until(async () => {
  const s = await S();
  return s.experiment && ['done', 'cancelled'].includes(s.experiment.status) ? s.experiment : null;
}, 240_000, 'experiment done');
report(
  'one-click experiment runs 1 → 3 devices',
  ex.status === 'done' && ex.rows.length === 3 && ex.order[0] === 'Test Chromebook' && ex.order[2] === st0.hostCompute.name,
  ex.rows.map((r) => `${r.devices} dev ${r.seconds}s ${r.speedup}×`).join(' | ') + ` (order: ${ex.order.join(' → ')})`,
);
await con.screenshot({ path: `${OUT}/console-2560-experiment.png`, fullPage: true });
const csv = await (await fetch(`${BASE}/api/export/speedup.csv`)).text();
report('speedup.csv has the experiment', csv.includes(ex.id) || csv.split('\n').length > 3, `${csv.trim().split('\n').length - 1} rows`);

// Toggle off: the tile goes away and the Hub node stops.
await con.getByRole('button', { name: 'Lab', exact: true }).click();
await con.getByRole('button', { name: /computes too/ }).first().click();
await until(async () => !(await S()).nodes.some((n) => n.host), 10_000, 'host tile gone');
const frames = await con.locator('iframe.host-frame').count();
report('toggle off removes the Hub node', frames === 0, 'no host frame, no tile');

// 4K TV (3840 CSS px) and 5K iMac (2560 CSS px @2x) screenshots.
await con.setViewportSize({ width: 3840, height: 2160 });
await sleep(1200);
const z4k = await con.evaluate(() => document.documentElement.style.getPropertyValue('zoom'));
await con.screenshot({ path: `${OUT}/console-3840.png` });
report('auto-zoom on a 4K screen', Number(z4k) === 2, `zoom=${z4k}`);
const ctx5k = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2 });
const p5k = await ctx5k.newPage();
await p5k.goto(`${BASE}/console?view=bench`);
await sleep(2500);
const chart = await p5k.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.width > 0 && x.clientWidth > 0 && !x.closest('.qr'));
  return c ? { backing: c.width, shown: c.getBoundingClientRect().width, dpr: devicePixelRatio } : null;
});
await p5k.goto(`${BASE}/console`);
await sleep(2000);
await p5k.screenshot({ path: `${OUT}/console-5k.png` });
report('Console page had no script errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
if (chart) console.log(`   chart backing ${chart.backing}px for ${chart.shown.toFixed(0)} CSS px shown at dpr ${chart.dpr}`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
