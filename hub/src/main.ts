// `npm run hub`: start the Recompute Hub on this computer.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { DATASET_DIR, DB_PATH, HTTP_PORT, HTTPS_PORT } from './config';
import { ensureCerts, type CertBundle } from './certs';
import { openDb } from './db';
import { Hub } from './hub';
import { ModelStore } from './models';
import { hostName, lanAddresses, machineName } from './net';
import { attachWebSockets, makeHandler } from './server';
import { buildWeb } from './build-web';

const args = new Set(process.argv.slice(2));
const noDownload = args.has('--no-download') || process.env.RECOMPUTE_NO_DOWNLOAD === '1';
const quiet = args.has('--quiet');

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`Recompute needs Node.js 22.13 or newer (you have ${process.versions.node}). Install the LTS version from https://nodejs.org`);
    process.exit(1);
  }

  await buildWeb();

  const db = openDb(DB_PATH);
  let teacherKey = db.get('teacherKey');
  if (!teacherKey) {
    teacherKey = crypto.randomBytes(5).toString('hex');
    db.set('teacherKey', teacherKey);
  }

  const host = hostName();
  const certNames = () => ['localhost', '127.0.0.1', '::1', host, `${host}.local`, ...lanAddresses().map((a) => a.address)];
  let certs: CertBundle = ensureCerts(certNames());

  const manifest = JSON.parse(fs.readFileSync(path.join(DATASET_DIR, 'manifest.json'), 'utf8'));
  const models = new ModelStore();
  const lan = lanAddresses();
  const hub = new Hub(db, models, {
    hubName: host,
    lanIp: lan[0]?.address ?? null,
    addresses: lan.map((a) => a.address),
    httpsPort: HTTPS_PORT,
    httpPort: HTTP_PORT,
    caFingerprint: certs.caFingerprint,
    teacherKey,
    datasetCount: manifest.count,
    hostName: machineName(),
    cpuThreads: os.availableParallelism?.() ?? os.cpus().length,
  });

  const handler = makeHandler({ hub, models, db, certs: () => certs, teacherKey });
  const httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, handler);
  const httpServer = http.createServer(handler);
  attachWebSockets(httpsServer, hub, teacherKey);
  attachWebSockets(httpServer, hub, teacherKey);
  await listen(httpsServer, HTTPS_PORT);
  await listen(httpServer, HTTP_PORT);

  // If the Wi-Fi address changes (new network, DHCP), re-issue the certificate and update links.
  setInterval(() => {
    const now = lanAddresses();
    const ip = now[0]?.address ?? null;
    if (ip === hub.info.lanIp && now.length === hub.info.addresses.length) return;
    hub.info.lanIp = ip;
    hub.info.addresses = now.map((a) => a.address);
    certs = ensureCerts(certNames());
    httpsServer.setSecureContext({ key: certs.key, cert: certs.cert });
    console.log(`\n  Network changed. New address: ${ip ?? 'none'}. Rescan the QR code on the Console.\n`);
  }, 15_000);

  await banner(hub);

  models.init({ download: !noDownload }).then(() => {
    const missing = models.info().filter((m) => !m.ready && !m.error?.includes('optional'));
    if (missing.length && !quiet) console.log(`  Models still missing: ${missing.map((m) => `${m.title}${m.error ? ` (${m.error})` : ''}`).join(', ')}`);
    else if (!quiet) console.log('  Models ready. From now on Recompute works with the internet unplugged.');
  });

  const shutdown = () => {
    console.log('\n  Stopping the Hub. Bye!');
    hub.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function listen(server: http.Server | https.Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${port} is already in use. Is another Recompute Hub already running? Close it (Ctrl+C in its window) and try again.\n`);
        process.exit(1);
      }
      reject(e);
    });
    server.listen(port, '0.0.0.0', () => resolve());
  });
}

async function banner(hub: Hub) {
  if (quiet) return;
  const u = hub.urls();
  const qr = await QRCode.toString(u.join, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
  const line = '─'.repeat(64);
  console.log(`
  ${line}
   RECOMPUTE HUB is running.   Rethink. Reuse. Recompute.
  ${line}

   On THIS computer, open the Console:   http://localhost:${hub.info.httpPort}/console

   Room code:  ${hub.room.slice(0, 3)} ${hub.room.slice(3)}

   Other devices join by scanning the QR code on the Console, or open:
     ${u.join}
   If that page shows a certificate warning, first open:
     ${u.trust}
   (Plan B, works without the certificate but slower for the Tutor:)
     ${u.joinHttp}

   Teacher Console from another device (keep this link private):
     ${u.console}
${hub.info.addresses.length > 1 ? `\n   Other addresses of this computer: ${hub.info.addresses.slice(1).join(', ')}\n` : ''}${hub.info.lanIp ? '' : '\n   ⚠ No Wi-Fi/network address found. Connect this computer to the router.\n'}
   CA fingerprint (SHA-256): ${hub.info.caFingerprint}

   Press Ctrl+C to stop.
  ${line}
`);
  console.log(qr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
