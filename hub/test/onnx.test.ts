import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFeatureOutput, graphOutputs, valueInfo } from '../src/onnx-surgery';

// A tiny hand-made ModelProto: { ir_version: 7, graph: { node: {output: "feat"}, output: {name: "logits"} } }
function tinyModel() {
  const enc = new TextEncoder();
  const ld = (num: number, bytes: number[]) => [(num << 3) | 2, bytes.length, ...bytes];
  const nodeProto = ld(2, [...enc.encode('feat')]); // NodeProto.output
  const outVi = ld(1, [...enc.encode('logits')]); // ValueInfoProto.name
  const graph = [...ld(1, nodeProto), ...ld(12, outVi)];
  return Uint8Array.from([0x08, 7, ...ld(7, graph), 0x42, 0x02, 0x08, 0x0c]); // + opset_import
}

test('adds the feature tensor as a second graph output and keeps everything else', () => {
  const m = tinyModel();
  assert.deepEqual(graphOutputs(m), ['logits']);
  const out = addFeatureOutput(m, 'feat', 1280);
  assert.deepEqual(graphOutputs(out), ['logits', 'feat']);
  assert.deepEqual([...out.subarray(0, 2)], [0x08, 7]); // ir_version untouched
  assert.deepEqual([...out.subarray(out.length - 4)], [0x42, 0x02, 0x08, 0x0c]); // trailing fields untouched
  assert.equal(addFeatureOutput(out, 'feat', 1280), out); // idempotent
});

test('refuses to add a tensor the graph does not have', () => {
  assert.throws(() => addFeatureOutput(tinyModel(), 'nope', 3), /not found/);
});

test('encodes a [batch_size, N] float ValueInfo', () => {
  const vi = valueInfo('x', 'batch_size', 1280);
  const s = Buffer.from(vi).toString('latin1');
  assert.ok(s.includes('batch_size'));
  assert.ok(vi.includes(0x80) && vi.includes(0x0a)); // varint 1280 = 0x80 0x0a
});
