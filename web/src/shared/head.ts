// "Teach the Swarm" model: a small softmax-regression head trained on frozen
// MobileNetV3 features (1280 numbers per photo). Tiny enough to train in
// milliseconds on a Chromebook; only these weights ever leave a device.

export interface HeadDims {
  inDim: number;
  classes: number;
}

/** Weights layout: [classes x inDim] row-major, followed by [classes] biases. */
export function headSize(d: HeadDims) {
  return d.classes * d.inDim + d.classes;
}

export function zeroHead(d: HeadDims) {
  return new Float32Array(headSize(d));
}

export function normalize(f: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  const inv = 1 / Math.sqrt(s || 1);
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] * inv;
  return out;
}

export function predict(w: Float32Array, d: HeadDims, x: Float32Array): Float32Array {
  const { inDim, classes } = d;
  const logits = new Float32Array(classes);
  let max = -Infinity;
  for (let c = 0; c < classes; c++) {
    let z = w[classes * inDim + c];
    const off = c * inDim;
    for (let i = 0; i < inDim; i++) z += w[off + i] * x[i];
    logits[c] = z;
    if (z > max) max = z;
  }
  let sum = 0;
  for (let c = 0; c < classes; c++) sum += logits[c] = Math.exp(logits[c] - max);
  for (let c = 0; c < classes; c++) logits[c] /= sum;
  return logits;
}

export function argmax(p: ArrayLike<number>) {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
}

/**
 * Local training: a few epochs of mini-batch SGD with cross-entropy and a
 * little L2. `xs` should already be normalized. Deterministic for a given seed.
 */
export function trainHead(
  start: Float32Array,
  d: HeadDims,
  xs: Float32Array[],
  ys: number[],
  opts: { epochs?: number; lr?: number; l2?: number; batch?: number; seed?: number } = {},
): Float32Array {
  const { epochs = 20, lr = 0.5, l2 = 1e-4, batch = 8 } = opts;
  const w = new Float32Array(start);
  const { inDim, classes } = d;
  const n = xs.length;
  if (!n) return w;
  const order = xs.map((_, i) => i);
  let seed = opts.seed ?? 1;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const grad = new Float32Array(w.length);
  for (let e = 0; e < epochs; e++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let b0 = 0; b0 < n; b0 += batch) {
      grad.fill(0);
      const idx = order.slice(b0, b0 + batch);
      for (const k of idx) {
        const x = xs[k];
        const p = predict(w, d, x);
        p[ys[k]] -= 1;
        for (let c = 0; c < classes; c++) {
          const g = p[c];
          if (g === 0) continue;
          const off = c * inDim;
          for (let i = 0; i < inDim; i++) grad[off + i] += g * x[i];
          grad[classes * inDim + c] += g;
        }
      }
      const scale = lr / idx.length;
      for (let i = 0; i < w.length; i++) w[i] -= scale * grad[i] + lr * l2 * w[i];
    }
  }
  return w;
}

/** Per-class correct / total counts of a model on some labeled features. */
export function evaluate(w: Float32Array, d: HeadDims, xs: Float32Array[], ys: number[]) {
  const correct = new Array(d.classes).fill(0);
  const total = new Array(d.classes).fill(0);
  xs.forEach((x, k) => {
    total[ys[k]]++;
    if (argmax(predict(w, d, x)) === ys[k]) correct[ys[k]]++;
  });
  return { correct, total };
}
