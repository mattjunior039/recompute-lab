import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fedAvg, FedSession } from '../src/fedavg';
import { evaluate, normalize, trainHead, zeroHead, headSize } from '../../web/src/shared/head';
import { b64ToF32, f32ToB64 } from '../../web/src/shared/protocol';

test('FedAvg is a sample-weighted mean', () => {
  const a = Float32Array.from([1, 2, 3]);
  const b = Float32Array.from([3, 6, 9]);
  const avg = fedAvg([
    { weights: a, n: 1 },
    { weights: b, n: 3 },
  ])!;
  assert.deepEqual([...avg], [2.5, 5, 7.5]);
});

test('FedAvg ignores devices with no data and rejects mismatched sizes', () => {
  assert.equal(fedAvg([{ weights: Float32Array.from([1]), n: 0 }]), null);
  const only = fedAvg([
    { weights: Float32Array.from([5, 5]), n: 0 },
    { weights: Float32Array.from([1, 1]), n: 2 },
  ])!;
  assert.deepEqual([...only], [1, 1]);
  assert.throws(() => fedAvg([{ weights: Float32Array.from([1]), n: 1 }, { weights: Float32Array.from([1, 2]), n: 1 }]));
});

test('weights survive the base64 wire format exactly', () => {
  const w = Float32Array.from({ length: 3843 }, (_, i) => Math.sin(i) * 1e-3);
  assert.deepEqual(b64ToF32(f32ToB64(w)), w);
});

// Synthetic "photos": three clusters in a 1280-d feature space, split across 3 devices
// that each mostly see one class (non-IID, like real classrooms).
function makeData(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const D = 1280;
  const centers = [0, 1, 2].map(() => Float32Array.from({ length: D }, () => rnd()));
  const sample = (c: number) => normalize(Float32Array.from(centers[c], (v) => v + 2.2 * rnd()));
  const devices = [0, 1, 2].map((major) => {
    const xs: Float32Array[] = [];
    const ys: number[] = [];
    for (let k = 0; k < 12; k++) {
      const c = k < 8 ? major : (major + 1 + (k % 2)) % 3;
      xs.push(sample(c));
      ys.push(c);
    }
    return { xs, ys };
  });
  const test = { xs: [] as Float32Array[], ys: [] as number[] };
  for (let k = 0; k < 60; k++) {
    test.xs.push(sample(k % 3));
    test.ys.push(k % 3);
  }
  return { devices, test };
}

test('a softmax head learns separable features', () => {
  const { devices, test: t } = makeData(3);
  const dims = { inDim: 1280, classes: 3 };
  const xs = devices.flatMap((d) => d.xs);
  const ys = devices.flatMap((d) => d.ys);
  const w = trainHead(zeroHead(dims), dims, xs, ys, { epochs: 20 });
  const r = evaluate(w, dims, t.xs, t.ys);
  const acc = r.correct.reduce((a, b) => a + b) / t.xs.length;
  assert.ok(acc > 0.9, `accuracy ${acc}`);
});

test('federated rounds raise accuracy across non-IID devices without sharing data', () => {
  const { devices, test: t } = makeData(11);
  const fed = new FedSession('t');
  const accs: number[] = [];
  for (let round = 0; round < 4; round++) {
    const msg = fed.startRound(['a', 'b', 'c']);
    const global = b64ToF32(msg.weights);
    const ev = evaluate(global, fed.dims, t.xs, t.ys);
    accs.push(ev.correct.reduce((a, b) => a + b) / t.xs.length);
    devices.forEach((d, k) => {
      const w = trainHead(global, fed.dims, d.xs, d.ys, { epochs: msg.epochs, lr: msg.lr, seed: round * 10 + k });
      fed.submit(['a', 'b', 'c'][k], { round: msg.round, weights: f32ToB64(w), n: d.xs.length, evalCorrect: [0, 0, 0], evalTotal: [0, 0, 0] });
    });
    fed.finishRound();
  }
  assert.ok(accs[0] < 0.5, `untrained accuracy ${accs[0]}`);
  assert.ok(accs[3] > 0.85, `accuracy after 3 rounds ${accs[3]} (history ${accs.join(', ')})`);
  assert.equal(fed.weights.length, headSize(fed.dims));
});

test('a round completes with the devices that answered; per-class accuracy is reported', () => {
  const fed = new FedSession('t2');
  const msg = fed.startRound(['a', 'b']);
  assert.equal(fed.submit('a', { round: msg.round, weights: msg.weights, n: 4, evalCorrect: [1, 0, 2], evalTotal: [2, 0, 2] }), false);
  assert.equal(fed.submit('zz', { round: msg.round, weights: msg.weights, n: 4, evalCorrect: [0, 0, 0], evalTotal: [0, 0, 0] }), false);
  assert.equal(fed.dropNode('b'), true); // b left: round can close
  const st = fed.finishRound()!;
  assert.deepEqual(st.perClass, [0.5, null, 1]);
  assert.equal(st.overall, 0.75);
  assert.equal(st.participants, 1);
  assert.equal(fed.roundOpen, false);
});

test('bad weights (NaN or wrong size) from a device are ignored', () => {
  const fed = new FedSession('t3');
  const before = Float32Array.from(fed.weights);
  const msg = fed.startRound(['a']);
  const bad = Float32Array.from(fed.weights).fill(NaN);
  fed.submit('a', { round: msg.round, weights: f32ToB64(bad), n: 10, evalCorrect: [0, 0, 0], evalTotal: [0, 0, 0] });
  fed.finishRound();
  assert.deepEqual(fed.weights, before);
});
