// Local-first check: a node that has prepared (model + photos saved) keeps working when the Hub disappears,
// and the Hub restarts with --no-download (no internet needed) and the node rejoins.
// Usage: npx tsx scripts/offline-check.ts <room>   (expects the Hub to be started/stopped by the caller via signals file)
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
const room = process.argv[2];
const base = 'https://localhost:8443';
const startHub = (extra: string[] = []) => {
  const p = spawn('npm', ['run', 'hub', '--', '--quiet', ...extra], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.stdout!.on('data', () => {});
  p.stderr!.on('data', () => {});
  return p;
};
const waitUp = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://localhost:8080/api/info')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('hub did not start');
};
const kill = (p: ChildProcess) => process.kill(-p.pid!, 'SIGTERM');

let hub = startHub();
await waitUp();
const b = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const pg = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
await pg.goto(`${base}/join?room=${room}`);
await pg.waitForFunction(() => (window as any).__recompute?.state?.welcomed, null, { timeout: 20000 });
await pg.waitForFunction(() => (window as any).__recompute.engine.modelReady, null, { timeout: 90000 });
await pg.evaluate(() => (window as any).__recompute.preloadImages());
console.log('prepared');
kill(hub);
await pg.waitForFunction(() => !(window as any).__recompute.state.welcomed, null, { timeout: 15000 });
await pg.waitForTimeout(5000);
console.log('solo panel visible', await pg.isVisible('text=Work alone'));
await pg.evaluate(() => (window as any).__recompute.runSolo('swarm-sort', { count: 200 }));
await pg.waitForFunction(() => (window as any).__recompute.solo?.finished, null, { timeout: 120000 });
console.log('solo result', await pg.evaluate(() => { const s = (window as any).__recompute.solo; return { done: s.done, total: s.total, sec: Math.round(s.finished - s.started) / 1000 }; }));
await pg.screenshot({ path: '/tmp/solo.png' });
hub = startHub(['--no-download']);
await waitUp();
await pg.waitForFunction(() => (window as any).__recompute.state.welcomed, null, { timeout: 30000 });
console.log('rejoined after hub restart (--no-download)');
const info = await (await fetch('http://localhost:8080/api/info')).json();
console.log('models ready offline', info.models.map((m: any) => `${m.id}:${m.ready}`).join(' '));
await b.close();
kill(hub);
