import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:8080';
const room = process.argv[3] ?? '';
const b = await chromium.launch({ args: ['--ignore-certificate-errors'] });
for (const p of ['/console', `/join?room=${room}&workers=2`, '/trust', '/bench']) {
  const pg = await b.newPage();
  const errs: string[] = [];
  pg.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(`${m.type()}: ${m.text()}`));
  pg.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  await pg.goto(base + p);
  await pg.waitForTimeout(6000);
  const txt = (await pg.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  console.log(`\n== ${p}\n${txt}\n${errs.join('\n')}`);
  await pg.screenshot({ path: `/tmp/smoke${p.split('?')[0].replace('/', '-')}.png`, fullPage: false });
}
await b.close();
