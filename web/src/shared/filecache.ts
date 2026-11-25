// Keep models and images on the device after the first download, so the lab
// keeps working with the internet (and even the Hub) gone.
// Secure pages use the Cache API; plain-HTTP pages fall back to IndexedDB.

import { sha256 } from './sha256';

const CACHE = 'recompute-data-v1';
const IDB = 'recompute-files';

let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    dbp = null;
    throw e;
  });
  return dbp;
}

async function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('files').objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result as ArrayBuffer | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key: string, val: ArrayBuffer) {
  const db = await idb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const hasCaches = () => typeof caches !== 'undefined' && !!globalThis.isSecureContext;

export async function cachedBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    if (hasCaches()) {
      const c = await caches.open(CACHE);
      const r = await c.match(url);
      return r ? await r.arrayBuffer() : null;
    }
    return (await idbGet(url)) ?? null;
  } catch {
    return null;
  }
}

export async function isCached(url: string) {
  try {
    if (hasCaches()) return !!(await (await caches.open(CACHE)).match(url));
    return !!(await idbGet(url));
  } catch {
    return false;
  }
}

/**
 * Get a file: from this device if cached, otherwise from the Hub (then keep it).
 * When `sha` is given the bytes must match it, or the file is refused.
 */
export async function fetchCached(url: string, opts: { sha?: string; onProgress?: (f: number) => void } = {}): Promise<ArrayBuffer> {
  const have = await cachedBytes(url);
  if (have) return have;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await readWithProgress(res, opts.onProgress);
  if (opts.sha) {
    const got = await sha256(buf);
    if (got !== opts.sha) throw new Error(`${url} failed its integrity check (expected ${opts.sha.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  }
  try {
    if (hasCaches()) await (await caches.open(CACHE)).put(url, new Response(buf.slice(0), { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' } }));
    else await idbPut(url, buf.slice(0));
  } catch {
    // storage full or private mode: still usable for this session
  }
  return buf;
}

async function readWithProgress(res: Response, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) return concatFallback(out.subarray(0, got), value, reader);
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out.buffer.slice(0, got);
}

async function concatFallback(head: Uint8Array, next: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>) {
  const parts = [head.slice(), next];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new Blob(parts as BlobPart[]).arrayBuffer();
}

export async function clearCached() {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE);
  } catch {}
  try {
    indexedDB.deleteDatabase(IDB);
  } catch {}
}
