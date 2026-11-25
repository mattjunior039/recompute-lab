import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunTracker, labJob } from '../src/labs';

function finishedRun() {
  const run = new RunTracker('j1', 'swarm-sort', labJob('swarm-sort', { count: 4 }, 1000), 0);
  run.perDevice.set('a', { items: 2, activeSec: 10 });
  run.perDevice.set('b', { items: 2, activeSec: 10 });
  run.finishedAt = 10_000;
  return run;
}
const name = (id: string) => id.toUpperCase();

test('no energy is shown without measured watts', () => {
  assert.equal(finishedRun().view(10_000, null, name, null, new Map()).energy, null);
});

test('no energy when only devices outside the run were measured', () => {
  assert.equal(finishedRun().view(10_000, null, name, null, new Map([['other', 5]])).energy, null);
});

test('energy uses only measured busy watts', () => {
  const e = finishedRun().view(10_000, null, name, null, new Map([['a', 3.6]])).energy;
  assert.ok(e);
  assert.equal(e.wh, 0.01); // 3.6 W × 10 s = 36 J = 0.01 Wh
  assert.deepEqual(e.devices, ['A']);
  assert.deepEqual(e.missing, ['B']);
});
