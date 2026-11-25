// Bundles the browser code (Node page, Console, Benchmark page, compute worker,
// service worker) with esbuild. Runs automatically when the Hub starts.

import esbuild from 'esbuild';
import path from 'node:path';
import { DIST_DIR, ROOT } from './config';

export async function buildWeb(opts: { minify?: boolean } = {}) {
  const src = path.join(ROOT, 'web/src');
  await esbuild.build({
    entryPoints: {
      node: path.join(src, 'node/main.ts'),
      console: path.join(src, 'console/main.ts'),
      bench: path.join(src, 'bench/main.ts'),
      trust: path.join(src, 'node/trust.ts'),
      compute: path.join(src, 'workers/compute.ts'),
    },
    outdir: DIST_DIR,
    bundle: true,
    format: 'esm',
    target: ['chrome100', 'safari15', 'firefox110'],
    platform: 'browser',
    sourcemap: true,
    minify: opts.minify ?? true,
    legalComments: 'none',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await esbuild.build({
    entryPoints: [path.join(src, 'sw.ts')],
    outfile: path.join(DIST_DIR, 'sw.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome100', 'safari15'],
    minify: opts.minify ?? true,
    logLevel: 'warning',
    define: { __BUILD__: JSON.stringify(Date.now().toString(36)) },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildWeb().then(
    () => console.log('web build ok'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
