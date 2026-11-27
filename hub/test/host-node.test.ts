import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db';
import { Hub, HOST_NODE_ID } from '../src/hub';

class FakeWs extends EventEmitter {
  sent: any[] = [];
  closed: number | null = null;
  readyState = 1;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code: number) {
    this.closed = code;
    this.readyState = 3;
    this.emit('close');
  }
}

function makeHub() {
  const db = openDb(':memory:');
  const models = { info: () => [], download: async () => {}, onChange: null } as any;
  const hub = new Hub(db, models, { lanUrl: 'https://x', httpUrl: 'http://x', hostName: 'MacBook Pro (Hub)', cpuThreads: 8 } as any, { tickMs: 60_000 });
  return { hub, room: (hub as any).room as string };
}

const hello = (room: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'hello', room, mode: 'join', caps: { cores: 4, workers: 3, deviceType: 'mac' }, status: {}, ...extra });

test('only the Hub computer itself (loopback) may join as the Hub node', () => {
  const { hub, room } = makeHub();
  const remote = new FakeWs();
  hub.attachNode(remote as any, '192.168.1.20', false);
  remote.emit('message', hello(room, { host: true }));
  assert.equal(remote.closed, 4003);
  assert.equal((hub as any).nodes.has(HOST_NODE_ID), false);
  hub.stop();
});

test('the Hub node gets the fixed id and machine name; other devices cannot take that id', () => {
  const { hub, room } = makeHub();
  const local = new FakeWs();
  hub.attachNode(local as any, '127.0.0.1', true);
  local.emit('message', hello(room, { host: true, nodeId: 'abcdef123456' }));
  const welcome = local.sent.find((m) => m.type === 'welcome');
  assert.equal(welcome.nodeId, HOST_NODE_ID);
  assert.equal((hub as any).nodes.get(HOST_NODE_ID).name, 'MacBook Pro (Hub)');

  const spoof = new FakeWs();
  hub.attachNode(spoof as any, '192.168.1.21', false);
  spoof.emit('message', hello(room, { nodeId: HOST_NODE_ID }));
  const w2 = spoof.sent.find((m) => m.type === 'welcome');
  assert.notEqual(w2.nodeId, HOST_NODE_ID);
  assert.equal(local.closed, null, 'the real Hub node was not kicked off');
  hub.stop();
});

test('measured runs (1→N experiment, race, fleet) use the old devices only, never the Hub computer', () => {
  const { hub, room } = makeHub();
  const local = new FakeWs();
  hub.attachNode(local as any, '127.0.0.1', true);
  local.emit('message', hello(room, { host: true }));
  const ids: string[] = [];
  for (const ip of ['192.168.1.30', '192.168.1.31']) {
    const ws = new FakeWs();
    hub.attachNode(ws as any, ip, false);
    ws.emit('message', hello(room));
    ids.push(ws.sent.find((m) => m.type === 'welcome').nodeId);
  }
  (hub as any).onConsoleCmd({ cmd: 'experiment', lab: 'sweep', items: 20, order: [HOST_NODE_ID, ...ids] });
  assert.deepEqual((hub as any).experiment.order, ids);
  (hub as any).onConsoleCmd({ cmd: 'cancel' });

  const db = (hub as any).db;
  const bench = (node: string, device: string, value: number) =>
    db.q.insertBench.run(Date.now(), node, device, 'mac', 'Chrome', 4, 8, 'no', 1, 1, 'ua', 'classify mobilenetv3', 'wasm', 3, value, 'images/s', '');
  bench(HOST_NODE_ID, 'MacBook Pro (Hub)', 300);
  bench('abc123def', 'MacBook Pro (Hub)', 250); // a benchmark tab opened on the Hub computer itself
  bench(ids[0], 'Chromebook', 4);
  db.q.insertSpeedup.run('e1', Date.now(), 'j1', 'swarm-sort', 2, 'Chromebook + iPhone', 100, 10, 10, 1.8);
  db.q.insertSpeedup.run('e2', Date.now() + 1, 'j2', 'swarm-sort', 3, 'Chromebook + iPhone + MacBook Pro (Hub)', 100, 2, 50, 9);
  const f = hub.fleetInputs();
  assert.equal(f.perDevice[0].rate, 4);
  assert.equal(f.perDevice[0].device, 'Chromebook');
  assert.equal(f.efficiency?.devices, 2);
  hub.stop();
});
