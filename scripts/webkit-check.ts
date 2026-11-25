// Safari-engine check (Playwright WebKit, iPhone viewport): join, classify, tutor.
import { webkit, devices } from 'playwright';
const base = process.argv[2] ?? 'https://localhost:8443';
const info = await (await fetch('http://localhost:8080/api/info')).json();
const room = process.argv[3];
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
const pg = await ctx.newPage();
const errs: string[] = [];
pg.on('pageerror', (e) => errs.push(e.message));
pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await pg.goto(`${base}/join?room=${room}`);
await pg.waitForFunction(() => (window as any).__recompute?.state?.welcomed, null, { timeout: 20000 });
console.log('env', await pg.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated, ua: navigator.userAgent.slice(0, 80), workers: (window as any).__recompute.engine.size })));
await pg.waitForFunction(() => (window as any).__recompute.engine.modelReady || (window as any).__recompute.engine.modelError, null, { timeout: 90000 });
console.log('model', await pg.evaluate(() => ({ ready: (window as any).__recompute.engine.modelReady, err: (window as any).__recompute.engine.modelError, canDecode: (window as any).__recompute.engine.canDecode })));
const t0 = Date.now();
const out = await pg.evaluate(() => (window as any).__recompute.engine.run('classify', { datasetCount: 1000 }, [0, 1, 2, 3]));
console.log('classify', out.outputs.map((o: any) => o.label), `${Date.now() - t0}ms`);
if (process.argv.includes('--tutor')) {
  await pg.evaluate(() => (window as any).__recompute.loadTutor('smollm2-360m'));
  await pg.waitForFunction(() => (window as any).__recompute.state.tutor.ready || (window as any).__recompute.tutor.error, null, { timeout: 300000 });
  console.log('tutor err', await pg.evaluate(() => (window as any).__recompute.tutor.error));
  const a = await pg.evaluate(() => (window as any).__recompute.ask('What is a cell?', 32));
  console.log('tutor', a.tokens, 'tokens', a.tokPerSec, 'tok/s', a.text.slice(0, 80));
}
await pg.screenshot({ path: '/tmp/webkit-join.png' });
console.log('errors', [...new Set(errs)].slice(0, 6));
await b.close();
