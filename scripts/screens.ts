// Capture Console screenshots during a short Swarm Sort run + Teach round (for checking on-camera legibility).
// Usage: npx tsx scripts/screens.ts <room> [outDir]
import { chromium } from 'playwright';
const room = process.argv[2];
const out = process.argv[3] ?? '/tmp';
const b = await chromium.launch({ args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const con = await ctx.newPage();
await con.setViewportSize({ width: 1920, height: 1080 });
await con.goto('http://localhost:8080/console');
await con.waitForTimeout(1500);
await con.screenshot({ path: `${out}/console-idle.png` });
const nodes = [];
for (let i = 0; i < 3; i++) {
  const c = await b.newContext({ ignoreHTTPSErrors: true });
  const p = await c.newPage();
  await p.goto(`https://localhost:8443/join?room=${room}&workers=1`);
  await p.waitForFunction(() => (window as any).__recompute?.engine?.modelReady, null, { timeout: 60000 });
  nodes.push(p);
}
await con.waitForTimeout(1000);
await con.screenshot({ path: `${out}/console-devices.png` });
// Tapping a lab card launches it.
await con.getByText('Swarm Sort', { exact: false }).first().click();
await con.waitForTimeout(6000);
await con.screenshot({ path: `${out}/console-sort-running.png` });
await con.waitForTimeout(15000);
await con.screenshot({ path: `${out}/console-sort-later.png`, fullPage: true });
await nodes[0].screenshot({ path: `${out}/node-running.png` });
await con.getByText('Teach the Swarm', { exact: false }).first().click();
await con.waitForTimeout(1500);
await con.screenshot({ path: `${out}/console-teach.png` });
await con.getByText('Setup', { exact: true }).click();
con.on('dialog', (d) => d.accept());
await con.getByText('Start fresh', { exact: false }).click();
await con.waitForTimeout(1500);
await con.getByText('Lab', { exact: true }).click();
await con.waitForTimeout(800);
await con.screenshot({ path: `${out}/console-fresh.png` });
await b.close();
