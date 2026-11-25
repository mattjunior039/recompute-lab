// Minimal protobuf editing so one MobileNetV3 file gives both the ImageNet
// logits (Swarm Sort) and the 1280-number feature vector (Teach the Swarm).
// We append one extra graph output; nothing else in the model changes.

export const FEATURES_TENSOR = '/flatten/Flatten_output_0';

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const byte = b[pos++];
    v += (byte & 0x7f) * mul;
    if (byte < 0x80) return [v, pos];
    mul *= 128;
    if (mul > 2 ** 63) throw new Error('bad varint');
  }
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const enc = new TextEncoder();

function field(num: number, payload: Uint8Array | number[]): Uint8Array {
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  return concat([Uint8Array.from(varint((num << 3) | 2)), Uint8Array.from(varint(p.length)), p]);
}
function intField(num: number, v: number): Uint8Array {
  return Uint8Array.from([...varint(num << 3), ...varint(v)]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** ValueInfoProto for a float tensor shaped [dimParam, size]. */
export function valueInfo(name: string, dimParam: string, size: number): Uint8Array {
  const dims = concat([field(1, field(2, enc.encode(dimParam))), field(1, intField(1, size))]);
  const tensorType = concat([intField(1, 1 /* FLOAT */), field(2, dims)]);
  return concat([field(1, enc.encode(name)), field(2, field(1, tensorType))]);
}

interface Field {
  num: number;
  wire: number;
  start: number; // start of tag
  dataStart: number; // start of payload (for wire 2: after length)
  end: number;
}

function scan(b: Uint8Array, from = 0, to = b.length): Field[] {
  const out: Field[] = [];
  let pos = from;
  while (pos < to) {
    const start = pos;
    let tag: number;
    [tag, pos] = readVarint(b, pos);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    let dataStart = pos;
    if (wire === 0) [, pos] = readVarint(b, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len: number;
      [len, dataStart] = readVarint(b, pos);
      pos = dataStart + len;
    } else throw new Error(`unsupported wire type ${wire}`);
    out.push({ num, wire, start, dataStart, end: pos });
  }
  if (pos !== to) throw new Error('protobuf overrun');
  return out;
}

const dec = new TextDecoder();

/** Names of a graph's outputs. */
export function graphOutputs(model: Uint8Array): string[] {
  const g = scan(model).find((f) => f.num === 7 && f.wire === 2);
  if (!g) throw new Error('no graph in model');
  return scan(model, g.dataStart, g.end)
    .filter((f) => f.num === 12 && f.wire === 2)
    .map((f) => {
      const name = scan(model, f.dataStart, f.end).find((x) => x.num === 1);
      return name ? dec.decode(model.subarray(name.dataStart, name.end)) : '';
    });
}

/** Return a copy of the model with `tensor` added as an extra output. */
export function addFeatureOutput(model: Uint8Array, tensor = FEATURES_TENSOR, size = 1280): Uint8Array {
  if (graphOutputs(model).includes(tensor)) return model;
  // Make sure the tensor really exists inside the graph (as some node's output).
  const needle = enc.encode(tensor);
  const g = scan(model).find((f) => f.num === 7 && f.wire === 2)!;
  const graph = model.subarray(g.dataStart, g.end);
  if (!containsBytes(graph, needle)) throw new Error(`tensor ${tensor} not found in graph`);
  const newGraph = concat([graph, field(12, valueInfo(tensor, 'batch_size', size))]);
  return concat([model.subarray(0, g.start), field(7, newGraph), model.subarray(g.end)]);
}

function containsBytes(hay: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
