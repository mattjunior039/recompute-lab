import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileGrid, tileRect } from '../../web/src/shared/render';
import { wallLayout, clockOffset } from '../../web/src/shared/wall';
import { fleetRows, fleetCsvRows } from '../../web/src/shared/fleet';
import { CaptionOrderer } from '../src/captions';

test('render tiles cover the picture exactly once, edge tiles clipped', () => {
  const p = { width: 1000, height: 330, tile: 160 };
  const { count } = tileGrid(p);
  assert.equal(count, 7 * 3);
  const px = new Uint8Array(p.width * p.height);
  for (let i = 0; i < count; i++) {
    const r = tileRect(i, p);
    assert.ok(r.w > 0 && r.h > 0 && r.x + r.w <= p.width && r.y + r.h <= p.height);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) px[y * p.width + x]++;
  }
  assert.ok(px.every((v) => v === 1));
});

test('wall slices sit left to right with the bezel gap, vertically centred', () => {
  const { canvas, slots } = wallLayout([{ id: 'a', w: 1366, h: 768 }, { id: 'b', w: 390, h: 844 }, { id: 'c', w: 1280, h: 720 }], 40);
  assert.deepEqual(canvas, { w: 1366 + 40 + 390 + 40 + 1280, h: 844 });
  assert.deepEqual(slots.get('a'), { x: 0, y: 38, w: 1366, h: 768 });
  assert.deepEqual(slots.get('b'), { x: 1406, y: 0, w: 390, h: 844 });
  assert.deepEqual(slots.get('c'), { x: 1836, y: 62, w: 1280, h: 720 });
});

test('clock offset uses the fastest round trip', () => {
  // Hub clock is 5000 ms ahead; the second ping has the shortest round trip.
  const r = clockOffset([
    { sent: 0, hub: 5100, recv: 200 },
    { sent: 1000, hub: 6010, recv: 1020 },
    { sent: 2000, hub: 7050, recv: 2100 },
  ])!;
  assert.equal(r.rtt, 20);
  assert.equal(r.offset, 5000);
  assert.equal(clockOffset([]), null);
});

test('captions come back in order; delay is measured to when each line is shown', () => {
  const o = new CaptionOrderer();
  for (let s = 0; s < 3; s++) o.add(s, 1000 * s, 3);
  assert.deepEqual(o.complete(2, { en: 'three', es: 'tres', node: 'B' }, 5000), []);
  assert.deepEqual(o.complete(1, { en: 'two', es: null, node: 'A' }, 5000), []);
  const lines = o.complete(0, { en: ' one ', es: 'uno', node: 'C' }, 6000);
  assert.deepEqual(lines.map((l) => [l.seq, l.en, l.lagSec]), [[0, 'one', 6], [1, 'two', 5], [2, 'three', 4]]);
  assert.equal(o.pending, 0);
});

test('a failed or stuck caption piece is skipped so captions never freeze', () => {
  const o = new CaptionOrderer(10_000);
  o.add(0, 0, 3);
  o.add(1, 0, 3);
  o.add(2, 0, 3);
  assert.deepEqual(o.complete(0, null, 100), []); // failed: skipped
  assert.deepEqual(o.complete(2, { en: 'later', es: null, node: 'A' }, 200), []); // waits for 1
  assert.deepEqual(o.release(10_001).map((l) => l.seq), [2]); // 1 timed out
});

test('fleet projection uses only measured numbers, and shows nothing without them', () => {
  const measured = {
    perDevice: [{ kernel: 'classify', label: 'Image sorting', unit: 'images/s', rate: 10, device: 'x', source: 'bench' }],
    efficiency: { value: 0.8, devices: 3, source: 'speedup' },
    captionRtf: null,
  };
  assert.deepEqual(fleetRows({ ...measured, efficiency: null }, 30), []);
  assert.deepEqual(fleetRows({ perDevice: [], efficiency: measured.efficiency, captionRtf: null }, 30), []);
  const [r] = fleetRows(measured, 30);
  assert.equal(r.value, 10 * 3600 * 30 * 0.8);
  const rows = fleetCsvRows(measured, [5]);
  assert.deepEqual(rows.map((x) => x.fleet_devices), [5, 30, 9483]);
  assert.equal(rows[0].fleet_result, 144000);
});

test('a node never sends anything that looks like a photo or sound file', async () => {
  const { DeviceLog } = await import('../../web/src/node/did');
  let saved = '';
  const log = new DeviceLog(() => null, (v) => (saved = v));
  const ok = JSON.stringify({ type: 'result', leaseId: 'l', outputs: [{ x: 0, rgb: 'UklGRgAAAA', sum: 9 }], ms: 5 });
  assert.equal(log.checkOutgoing(ok), ok); // rendered pixels may start with any bytes
  assert.equal(log.checkOutgoing(JSON.stringify({ type: 'result', outputs: [{ img: '/9j/4AAQSkZJRg' }] })), null);
  assert.equal(log.checkOutgoing(JSON.stringify({ type: 'fail', error: 'data:audio/wav;base64,AAAA' })), null);
  assert.deepEqual([log.c.sentMsgs, log.c.sentBytes, log.c.blocked], [1, ok.length, 2]);
  log.work('j1', 'render', 4, 100);
  log.work('j1', 'render', 2, 50);
  log.work('j2', 'caption', 1, 900, 3);
  assert.deepEqual([log.c.jobs, log.c.items.render, log.c.items.caption, log.c.audioSec, log.c.computeMs], [2, 6, 1, 3, 1050]);
  assert.equal(JSON.parse(saved).blocked, 2);
});
