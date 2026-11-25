import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../web/src/shared/scheduler';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function seq(...vals: number[]) {
  let k = 0;
  return () => vals[k++ % vals.length];
}

test('every item is done exactly once and the job finishes', () => {
  const c = clock();
  const done: string[] = [];
  const s = new Scheduler({ now: c.now, rng: () => 0.99 }, { onJobDone: (j) => done.push(j.id) });
  s.createJob({ id: 'j', kernel: 'pi', total: 50 });
  const seen = new Set<number>();
  for (;;) {
    const l = s.request('a', ['pi']);
    if (!l) break;
    c.advance(100);
    l.items.forEach((i) => seen.add(i));
    s.complete(l.id, 'a', l.items.map((i) => i * 2));
  }
  assert.equal(seen.size, 50);
  assert.deepEqual(done, ['j']);
  const job = s.jobs.get('j')!;
  assert.equal(job.doneCount, 50);
  assert.equal(job.results[7], 14);
});

test('chunks adapt: a fast device gets bigger chunks than a slow one', () => {
  const c = clock();
  const s = new Scheduler({ now: c.now, rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'classify', total: 10_000, chunk: { initial: 2, max: 64, targetSec: 2 } });
  for (let r = 0; r < 4; r++) {
    const fast = s.request('fast', ['classify'])!;
    s.complete(fast.id, 'fast', fast.items.map(() => 0), fast.items.length * 50); // 0.05 s per item
    const slow = s.request('slow', ['classify'])!;
    s.complete(slow.id, 'slow', slow.items.map(() => 0), slow.items.length * 1000); // 1 s per item
  }
  const f = s.request('fast', ['classify'])!;
  const sl = s.request('slow', ['classify'])!;
  assert.equal(f.items.length, 40); // 2 s / 0.05 s
  assert.equal(sl.items.length, 2); // 2 s / 1 s
  assert.ok(s.speedOf('fast', 'classify')! < s.speedOf('slow', 'classify')!);
});

test('chunks shrink near the end so nobody is left holding a big one', () => {
  const c = clock();
  const s = new Scheduler({ now: c.now, rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'pi', total: 12, chunk: { initial: 64, max: 64 } });
  const a = s.request('a', ['pi'])!;
  assert.equal(a.items.length, 6); // ceil(12 / (2 * 1))
  const b = s.request('b', ['pi'])!;
  assert.equal(b.items.length, 2); // ceil(6 / (2 * 2))
});

test('a device that leaves mid-job loses nothing: its items go to someone else', () => {
  const c = clock();
  const s = new Scheduler({ now: c.now, rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'pi', total: 20, chunk: { initial: 5 } });
  const lost = s.request('quitter', ['pi'])!;
  assert.equal(lost.items.length, 5);
  s.releaseNode('quitter');
  const got: number[] = [];
  for (;;) {
    const l = s.request('stayer', ['pi']);
    if (!l) break;
    got.push(...l.items);
    s.complete(l.id, 'stayer', l.items.map(() => 1));
  }
  for (const i of lost.items) assert.ok(got.includes(i), `item ${i} was re-issued`);
  const job = s.jobs.get('j')!;
  assert.equal(job.status, 'done');
  assert.equal(job.doneCount, 20);
  assert.equal(job.failed.size, 0);
  // A result arriving from the departed device is ignored (lease no longer exists).
  assert.equal(s.complete(lost.id, 'quitter', lost.items.map(() => 9)).unknown, true);
});

test('leases time out and are retried; a late result is still accepted', () => {
  const c = clock();
  const s = new Scheduler({ now: c.now, rng: () => 0.99, leaseTtlMinMs: 1000, leaseTtlFactor: 1 });
  s.createJob({ id: 'j', kernel: 'pi', total: 4, chunk: { initial: 2, guessSecPerItem: 0.1 } });
  const l = s.request('sleepy', ['pi'])!;
  c.advance(10_000);
  s.tick();
  assert.equal(s.leases.size, 0);
  const job = s.jobs.get('j')!;
  assert.deepEqual(job.pending.slice(0, 2), l.items); // back at the front of the queue
  assert.equal(job.attempts[l.items[0]], 1);
  // The slow device eventually answers: accept it (the work was real) and drop the items from the queue.
  const r = s.complete(l.id, 'sleepy', [1, 1]);
  assert.equal(r.accepted, 2);
  assert.ok(!job.pending.includes(l.items[0]));
});

test('an item that keeps failing is marked failed after 3 attempts, the job still completes', () => {
  const c = clock();
  const failed: number[] = [];
  const s = new Scheduler({ now: c.now, rng: () => 0.99 }, { onItemFailed: (_j, i) => failed.push(i) });
  s.createJob({ id: 'j', kernel: 'pi', total: 1, chunk: { initial: 1 } });
  for (let k = 0; k < 3; k++) {
    const l = s.request(`n${k}`, ['pi'])!;
    s.fail(l.id, `n${k}`, 'boom');
  }
  assert.deepEqual(failed, [0]);
  assert.equal(s.jobs.get('j')!.status, 'done');
  assert.equal(s.request('n9', ['pi']), null);
});

test('about 5% of chunks are spot-checked on a different device, and disagreements are caught', () => {
  const c = clock();
  const checks: boolean[] = [];
  let r = 1;
  const rng = () => ((r = (r * 48271) % 2147483647) / 2147483647);
  const s = new Scheduler({ now: c.now, rng, compare: (_k, a, b) => a === b }, { onSpotCheck: (_j, ch) => checks.push(ch.agree) });
  s.createJob({ id: 'j', kernel: 'pi', total: 4000, chunk: { initial: 1, max: 1 } });
  let verifyLeases = 0;
  let workLeases = 0;
  for (;;) {
    const node = workLeases % 2 ? 'b' : 'a';
    const l = s.request(node, ['pi']);
    if (!l) break;
    if (l.verify) {
      verifyLeases++;
      // Device b is faulty on item multiples of 7 during verification.
      s.complete(l.id, node, l.items.map((i) => (node === 'b' && i % 7 === 0 ? -1 : i)));
    } else {
      workLeases++;
      s.complete(l.id, node, l.items.map((i) => i));
    }
  }
  const rate = verifyLeases / workLeases;
  assert.ok(rate > 0.03 && rate < 0.07, `spot-check rate ${rate}`);
  assert.ok(checks.includes(true));
  const job = s.jobs.get('j')!;
  for (const ch of job.spotChecks) assert.notEqual(ch.nodeA, ch.nodeB);
  assert.equal(job.doneCount, 4000);
});

test('spot-checks are never run by the device that did the original work', () => {
  const c = clock();
  const s = new Scheduler({ now: c.now, rng: () => 0 }); // always spot-check
  s.createJob({ id: 'j', kernel: 'pi', total: 10, chunk: { initial: 1, max: 1 } });
  const l = s.request('a', ['pi'])!;
  s.complete(l.id, 'a', [1]);
  const again = s.request('a', ['pi'])!;
  assert.equal(again.verify, false);
  const other = s.request('b', ['pi'])!;
  assert.equal(other.verify, true);
  assert.deepEqual(other.items, l.items);
});

test('eligible lists restrict which devices may work (used by the speedup experiment)', () => {
  const s = new Scheduler({ rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'pi', total: 10, eligible: ['a'] });
  assert.equal(s.request('b', ['pi']), null);
  assert.ok(s.request('a', ['pi']));
});

test('devices only get kernels they said they can run', () => {
  const s = new Scheduler({ rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'classify', total: 10 });
  assert.equal(s.request('phone', ['pi', 'sir']), null);
  assert.ok(s.request('laptop', ['classify']));
});

test('a restored job (after a Hub restart) only hands out unfinished items', () => {
  const done = new Map([0, 1, 2, 5].map((i) => [i, { output: i, nodeId: 'x' }]));
  const s = new Scheduler({ rng: () => 0.99 });
  const job = s.createJob({ id: 'j', kernel: 'pi', total: 6, done, chunk: { initial: 10, max: 10 } });
  assert.equal(job.doneCount, 4);
  assert.deepEqual(job.pending, [3, 4]);
});

test('cancelled jobs hand out no more work and ignore results', () => {
  const s = new Scheduler({ rng: () => 0.99 });
  s.createJob({ id: 'j', kernel: 'pi', total: 10 });
  const l = s.request('a', ['pi'])!;
  s.cancelJob('j');
  assert.equal(s.request('a', ['pi']), null);
  assert.equal(s.complete(l.id, 'a', l.items.map(() => 1)).accepted, 0);
});

test('throughput grows with devices in a simulated run (pull scheduling, no tuning)', () => {
  // Simulate devices with fixed speed; measure makespan for 1 vs 3 devices.
  function makespan(speeds: number[]) {
    const c = clock(0);
    const s = new Scheduler({ now: c.now, rng: () => 0.99 });
    s.createJob({ id: 'j', kernel: 'classify', total: 600, spotCheck: false });
    const busyUntil = speeds.map(() => 0);
    const current: (ReturnType<Scheduler['request']>)[] = speeds.map(() => null);
    let t = 0;
    while (s.jobs.get('j')!.status === 'running') {
      speeds.forEach((spi, k) => {
        if (current[k] && busyUntil[k] <= t) {
          s.complete(current[k]!.id, `n${k}`, current[k]!.items.map(() => 0), current[k]!.items.length * spi * 1000);
          current[k] = null;
        }
        if (!current[k]) {
          const l = s.request(`n${k}`, ['classify']);
          if (l) {
            current[k] = l;
            busyUntil[k] = t + l.items.length * spi * 1000;
          }
        }
      });
      t += 10;
      c.advance(10);
    }
    return t;
  }
  const one = makespan([0.1]);
  const three = makespan([0.1, 0.1, 0.1]);
  const mixed = makespan([0.1, 0.5]); // a fast and a slow device
  assert.ok(one / three > 2.6, `speedup with 3 equal devices was ${one / three}`);
  assert.ok(mixed < one, 'adding a slow device still helps');
});
