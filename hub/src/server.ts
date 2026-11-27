import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { WebSocketServer } from 'ws';
import { DATASET_DIR, DIST_DIR, ROOT, SPEECH_DIR, WEB_DIR } from './config';
import type { Hub } from './hub';
import type { ModelStore } from './models';
import type { DB } from './db';
import type { CertBundle } from './certs';
import type { BenchRecord } from '../../web/src/shared/protocol';
import { fleetCsvRows } from '../../web/src/shared/fleet';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.gguf': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.wav': 'audio/wav',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'", // only the Console on the Hub computer frames its own node page
].join('; ');

const ORT_DIR = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
// Transformers.js (speech worker) pins its own onnxruntime-web build; npm nests it unless the versions match.
const ORT_TJS_DIR = [path.join(ROOT, 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'), ORT_DIR].find((d) => fs.existsSync(d))!;
const WLLAMA_WASM = path.join(ROOT, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm');
const WLLAMA_COMPAT_WASM = path.join(ROOT, 'node_modules/@wllama/wllama-compat/wasm/wllama.wasm');

export interface ServerDeps {
  hub: Hub;
  models: ModelStore;
  db: DB;
  certs: () => CertBundle;
  teacherKey: string;
}

export function isLoopback(addr: string | undefined) {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

export function makeHandler(deps: ServerDeps) {
  const { hub, models, db } = deps;

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = decodeURIComponent(url.pathname);
    const local = isLoopback(req.socket.remoteAddress);
    const control = local || url.searchParams.get('key') === deps.teacherKey;
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');

    try {
      if (req.method === 'POST' && p === '/api/bench') return postBench(req, res, db, local);
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');

      if (p === '/') return redirect(res, (local ? '/console' : '/join') + url.search);
      if (p === '/join' || p === '/node') return page(res, 'node.html');
      if (p === '/console') return page(res, 'console.html');
      if (p === '/bench') return page(res, 'bench.html');
      if (p === '/trust') return page(res, 'trust.html');
      if (p === '/manifest.webmanifest') return file(req, res, path.join(WEB_DIR, 'public/manifest.webmanifest'), 'no-cache');
      if (p === '/sw.js') {
        res.setHeader('Service-Worker-Allowed', '/');
        return file(req, res, path.join(DIST_DIR, 'sw.js'), 'no-cache');
      }
      if (p.startsWith('/dist/')) return file(req, res, safeJoin(DIST_DIR, p.slice(6)), 'no-cache');
      if (p.startsWith('/static/')) return file(req, res, safeJoin(path.join(WEB_DIR, 'public'), p.slice(8)), 'no-cache');
      if (p.startsWith('/vendor/ort/')) {
        const name = p.slice('/vendor/ort/'.length);
        if (!/^ort[\w.-]*\.(mjs|wasm)$/.test(name)) return text(res, 404, 'Not found');
        return file(req, res, safeJoin(ORT_DIR, name), 'public, max-age=86400');
      }
      if (p.startsWith('/vendor/ort-tjs/')) {
        const name = p.slice('/vendor/ort-tjs/'.length);
        if (!/^ort-wasm[\w.-]*\.(mjs|wasm)$/.test(name)) return text(res, 404, 'Not found');
        return file(req, res, safeJoin(ORT_TJS_DIR, name), 'public, max-age=86400');
      }
      if (p === '/vendor/wllama/wllama.wasm') return file(req, res, WLLAMA_WASM, 'public, max-age=86400');
      if (p === '/vendor/wllama-compat/wllama.wasm') return file(req, res, WLLAMA_COMPAT_WASM, 'public, max-age=86400');
      if (p.startsWith('/models/')) {
        const [, , id, name] = p.split('/');
        const fp = id && name ? models.filePath(id, name) : null;
        if (!fp) return text(res, 404, 'That model is not on the Hub yet.');
        return file(req, res, fp, 'public, max-age=31536000, immutable');
      }
      if (p === '/data/swarmsort/manifest.json') return file(req, res, path.join(DATASET_DIR, 'manifest.json'), 'no-cache');
      if (p.startsWith('/data/swarmsort/images/')) {
        const name = p.slice('/data/swarmsort/images/'.length);
        if (!/^\d{4}\.jpg$/.test(name)) return text(res, 404, 'Not found');
        return file(req, res, path.join(DATASET_DIR, 'images', name), 'public, max-age=31536000, immutable');
      }
      if (p.startsWith('/data/speech/')) {
        const name = p.slice('/data/speech/'.length);
        if (!/^[\w-]+\.(wav|json)$/.test(name)) return text(res, 404, 'Not found');
        return file(req, res, path.join(SPEECH_DIR, name), 'public, max-age=86400');
      }
      if (p === '/recompute-ca.crt' || p === '/recompute-ca.cer') {
        const c = deps.certs();
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="recompute-ca.crt"',
          'Content-Length': c.caCertDer.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(req.method === 'HEAD' ? undefined : c.caCertDer);
      }
      if (p === '/recompute-ca.pem') {
        const c = deps.certs();
        res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="recompute-ca.pem"', 'Cache-Control': 'no-cache' });
        return res.end(c.caCertPem);
      }
      if (p === '/api/info') {
        return json(res, {
          name: 'Recompute Hub',
          hubName: hub.info.hubName,
          caFingerprint: hub.info.caFingerprint,
          httpsPort: hub.info.httpsPort,
          httpPort: hub.info.httpPort,
          lanIp: hub.info.lanIp,
          datasetCount: hub.info.datasetCount,
          models: models.info(),
        });
      }
      // The finished picture at wall size: every device on the Screen Wall loads it, so it is not teacher-only.
      if (p === '/api/render/wall.png') {
        hub.render
          .wallImage()
          .then((png) => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : png);
          })
          .catch((e) => text(res, 500, e instanceof Error ? e.message : 'error'));
        return;
      }
      if (p.startsWith('/api/')) {
        if (!control) return text(res, 403, 'Teacher only: open this from the Console link.');
        if (p === '/api/bench') return json(res, db.q.allBench.all());
        if (p === '/api/internet') {
          internetCheck().then((r) => json(res, r));
          return;
        }
        if (p === '/api/export/bench.csv') return csv(res, 'recompute-benchmarks.csv', db.q.allBench.all() as Record<string, unknown>[]);
        if (p === '/api/export/speedup.csv') return csv(res, 'recompute-speedup-experiments.csv', db.q.allSpeedup.all() as Record<string, unknown>[]);
        if (p === '/api/export/watts.csv') return csv(res, 'recompute-measured-watts.csv', db.q.allWatts.all() as Record<string, unknown>[]);
        if (p === '/api/export/fed.csv')
          return csv(
            res,
            'recompute-teach-the-swarm.csv',
            (db.q.allFed.all() as { session_id: string; round: number; stats: string; at: number }[]).map((r) => {
              const s = JSON.parse(r.stats);
              const row: Record<string, unknown> = { session: r.session_id, round: r.round, at: new Date(r.at).toISOString(), overall_accuracy: s.overall };
              (hub.fed.classes as string[]).forEach((c, k) => (row[`acc_${c}`] = s.perClass[k]));
              Object.assign(row, { eval_photos: s.evalPhotos, train_photos: s.trainPhotos, devices: s.participants, weight_bytes: s.weightBytes, photos_uploaded: 0 });
              return row;
            }),
          );
        if (p === '/api/render.png') {
          const fp = hub.render.pngFile;
          if (!fp) return text(res, 404, 'No finished render yet (the full picture is saved a few seconds after the last tile).');
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fp)}"`);
          return file(req, res, fp, 'no-cache', 'image/png');
        }
        if (p === '/api/render/tiles.csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="recompute-render-tiles.csv"', 'Cache-Control': 'no-cache' });
          return res.end(hub.render.csv((id) => hub.nameOf(id)));
        }
        if (p === '/api/render.csv') {
          if (!hub.renderRace) return text(res, 404, 'No Swarm Render race yet: run "1 device vs all" first.');
          return csv(res, 'render.csv', hub.renderRace.rows, ['devices', 'seconds']);
        }
        if (p === '/api/fleet.csv') {
          const f = hub.fleetInputs();
          if (!f.efficiency || !f.perDevice.length) return text(res, 404, 'Nothing measured yet: the fleet calculator needs a benchmark and a speedup run.');
          return csv(res, 'fleet.csv', fleetCsvRows(f, [Math.round(Number(url.searchParams.get('n')))]), ['fleet_devices', 'fleet_result', 'metric', 'unit', 'scaling_efficiency', 'measured_from']);
        }
        if (p === '/api/captions.csv')
          return csv(
            res,
            'captions.csv',
            hub.captions.timing.map((t) => ({ seq: t.seq, audio_s: t.audioSec, latency_s: t.lagSec, device: t.node, translated: t.translated ? 1 : 0 })),
            ['seq', 'audio_s', 'latency_s', 'device', 'translated'],
          );
        if (p === '/api/export/runs.csv') {
          const rows = (db.raw.prepare('SELECT id, lab, kernel, total, status, created_at, finished_at, summary FROM jobs ORDER BY created_at').all() as Record<string, unknown>[]).map((j) => {
            const s = j.summary ? JSON.parse(String(j.summary)) : {};
            return { job: j.id, lab: j.lab, kernel: j.kernel, items: j.total, status: j.status, started: new Date(Number(j.created_at)).toISOString(), seconds: s.seconds ?? '', devices: s.devices ?? '' };
          });
          return csv(res, 'recompute-runs.csv', rows);
        }
        return text(res, 404, 'Not found');
      }
      if (p === '/favicon.ico') return file(req, res, path.join(WEB_DIR, 'public/icon.svg'), 'public, max-age=86400', 'image/svg+xml');
      return text(res, 404, 'Not found');
    } catch (e) {
      return text(res, 500, e instanceof Error ? e.message : 'error');
    }
  };
}

export function attachWebSockets(server: http.Server, hub: Hub, teacherKey: string) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get('role');
      const ip = req.socket.remoteAddress ?? '';
      if (role === 'probe') return ws.close(1000, 'ok'); // the trust page's "is the certificate trusted?" test
      if (role === 'console') hub.attachConsole(ws, isLoopback(ip) || url.searchParams.get('key') === teacherKey, isLoopback(ip));
      else hub.attachNode(ws, ip, isLoopback(ip));
    });
  });
  return wss;
}

function safeJoin(base: string, rel: string) {
  const p = path.resolve(base, '.' + path.sep + rel);
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error('bad path');
  return p;
}

function page(res: http.ServerResponse, name: string) {
  const fp = path.join(WEB_DIR, 'public', name);
  const body = fs.readFileSync(fp);
  res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'Content-Length': body.length });
  res.end(body);
}

function file(req: http.IncomingMessage, res: http.ServerResponse, fp: string, cache: string, type?: string) {
  let st: fs.Stats;
  try {
    st = fs.statSync(fp);
    if (!st.isFile()) throw new Error();
  } catch {
    return text(res, 404, 'Not found');
  }
  const headers: Record<string, string | number> = {
    'Content-Type': type ?? TYPES[path.extname(fp)] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
  };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : st.size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, st.size - end);
      end = st.size - 1;
    }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

function text(res: http.ServerResponse, code: number, msg: string) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(msg);
}

function json(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

function redirect(res: http.ServerResponse, to: string) {
  res.writeHead(302, { Location: to });
  res.end();
}

function csvCell(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
}

function csv(res: http.ServerResponse, name: string, rows: Record<string, unknown>[], header?: string[]) {
  const cols = header ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-cache' });
  res.end(body);
}

function postBench(req: http.IncomingMessage, res: http.ServerResponse, db: DB, fromHub = false) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => {
    body += d;
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    try {
      const recs: BenchRecord[] = [].concat(JSON.parse(body));
      const now = Date.now();
      db.tx(() => {
        for (const r of recs.slice(0, 50)) {
          const v = Number(r.value);
          if (!Number.isFinite(v) || !r.test) continue;
          const c = r.caps ?? ({} as BenchRecord['caps']);
          const s = (x: unknown, n = 120) => (x === null || x === undefined ? null : String(x).slice(0, n));
          db.q.insertBench.run(
            // A benchmark run on the Hub computer itself is marked, so it never counts as an "old device" number.
            now, s(r.nodeId, 40), fromHub && !/\(Hub\)/.test(String(r.device ?? '')) ? `${s(r.device, 50) ?? 'This computer'} (Hub)` : s(r.device, 60), s(c.deviceType, 20), s(c.browser, 60),
            Number(c.cores) || null, c.memoryGB === null || c.memoryGB === undefined ? null : Number(c.memoryGB), s(c.webgpu),
            c.isolated ? 1 : 0, c.secure ? 1 : 0, s(c.ua, 300),
            s(r.test, 60), s(r.backend, 30), Number(r.threads) || null, v, s(r.unit, 20), s(r.detail, 300),
          );
        }
      });
      json(res, { ok: true });
    } catch (e) {
      text(res, 400, 'bad benchmark data');
    }
  });
}

/** Is the internet reachable from the Hub? Checked by the Hub itself (a page can't reliably test this). */
let lastNet: { at: number; online: boolean; checked: string[] } | null = null;
let netBusy: Promise<{ at: number; online: boolean; checked: string[] }> | null = null;
const NET_PROBES = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.apple.com/library/test/success.html', 'https://1.1.1.1/'];
export function internetCheck() {
  if (lastNet && Date.now() - lastNet.at < 4000) return Promise.resolve(lastNet);
  netBusy ??= Promise.all(
    NET_PROBES.map((u) =>
      fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(3000), redirect: 'manual' })
        .then(() => true)
        .catch(() => false),
    ),
  )
    .then((ok) => (lastNet = { at: Date.now(), online: ok.some(Boolean), checked: NET_PROBES.map((u) => new URL(u).host) }))
    .finally(() => (netBusy = null));
  return netBusy;
}
