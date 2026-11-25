// The Hub downloads each model ONCE from its pinned URL, checks the SHA-256,
// and from then on serves it to every device over the local Wi-Fi. After that
// first download the internet can be unplugged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR, MODELS, type PinnedModel } from './config';
import { addFeatureOutput } from './onnx-surgery';
import type { ModelInfo } from '../../web/src/shared/protocol';

interface State {
  ready: boolean;
  progress: number;
  error?: string;
  downloading: boolean;
  served: { name: string; sha256: string; size: number }[];
}

export class ModelStore {
  private state = new Map<string, State>();
  onChange: () => void = () => {};

  constructor(private dir = MODEL_DIR, private models: PinnedModel[] = MODELS) {
    for (const m of models) this.state.set(m.id, { ready: false, progress: 0, downloading: false, served: [] });
  }

  /** Check what is already on disk; download required models that are missing. */
  async init(opts: { download: boolean }) {
    for (const m of this.models) {
      if (this.checkLocal(m)) continue;
      if (opts.download && !m.optional) await this.download(m.id).catch(() => {});
    }
  }

  private fileDir(id: string) {
    return path.join(this.dir, id);
  }

  filePath(id: string, name: string): string | null {
    const st = this.state.get(id);
    if (!st?.ready || !st.served.some((f) => f.name === name)) return null;
    return path.join(this.fileDir(id), name);
  }

  private checkLocal(m: PinnedModel): boolean {
    const st = this.state.get(m.id)!;
    for (const f of m.files) {
      const p = path.join(this.fileDir(m.id), f.name);
      const mark = `${p}.sha256`;
      if (!fs.existsSync(p) || !fs.existsSync(mark)) return false;
      const [sha, size] = fs.readFileSync(mark, 'utf8').trim().split(' ');
      if (sha !== f.sha256 || Number(size) !== f.size || fs.statSync(p).size !== f.size) return false;
    }
    this.derive(m);
    st.ready = true;
    st.progress = 1;
    st.error = undefined;
    return true;
  }

  /** Files we serve to devices. For MobileNet: a features+logits model and a labels list. */
  private derive(m: PinnedModel) {
    const st = this.state.get(m.id)!;
    const d = this.fileDir(m.id);
    if (m.id === 'mobilenetv3') {
      const feat = path.join(d, 'features.onnx');
      if (!fs.existsSync(feat)) {
        const out = addFeatureOutput(new Uint8Array(fs.readFileSync(path.join(d, 'model.onnx'))));
        fs.writeFileSync(feat, out);
      }
      const labels = path.join(d, 'labels.json');
      if (!fs.existsSync(labels)) {
        const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
        const arr: string[] = [];
        for (const [k, v] of Object.entries(cfg.id2label as Record<string, string>)) arr[Number(k)] = String(v).split(',')[0].trim();
        fs.writeFileSync(labels, JSON.stringify(arr));
      }
      st.served = ['features.onnx', 'labels.json'].map((name) => describe(path.join(d, name), name));
    } else {
      st.served = m.files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size }));
    }
  }

  async download(id: string) {
    const m = this.models.find((x) => x.id === id);
    const st = this.state.get(id);
    if (!m || !st || st.downloading || st.ready) return;
    st.downloading = true;
    st.error = undefined;
    this.onChange();
    const total = m.files.reduce((s, f) => s + f.size, 0);
    let doneBytes = 0;
    try {
      fs.mkdirSync(this.fileDir(id), { recursive: true });
      for (const f of m.files) {
        const p = path.join(this.fileDir(id), f.name);
        await fetchVerified(f.url, p, f.sha256, f.size, (n) => {
          st.progress = (doneBytes + n) / total;
          this.onChange();
        });
        fs.writeFileSync(`${p}.sha256`, `${f.sha256} ${f.size}\n`);
        doneBytes += f.size;
      }
      this.checkLocal(m);
    } catch (e) {
      st.error = e instanceof Error ? e.message : String(e);
    } finally {
      st.downloading = false;
      this.onChange();
    }
  }

  info(): ModelInfo[] {
    return this.models.map((m) => {
      const st = this.state.get(m.id)!;
      return {
        id: m.id,
        title: m.title,
        kind: m.kind,
        license: m.license,
        ready: st.ready,
        progress: st.progress,
        sizeBytes: m.files.reduce((s, f) => s + f.size, 0),
        files: st.served.map((f) => ({ ...f, url: `/models/${m.id}/${f.name}` })),
        error: st.error ?? (st.downloading ? undefined : !st.ready && m.optional ? 'not downloaded (optional)' : undefined),
      };
    });
  }
}

function describe(p: string, name: string) {
  const buf = fs.readFileSync(p);
  return { name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

async function fetchVerified(url: string, dest: string, sha256: string, size: number, progress: (n: number) => void) {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let n = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      n += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      if (n - lastReport > 1 << 20) {
        lastReport = n;
        progress(n);
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  const got = hash.digest('hex');
  if (n !== size || got !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`checksum mismatch for ${path.basename(dest)} (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…, ${n} bytes)`);
  }
  fs.renameSync(part, dest);
  progress(n);
}
