// Built-in Science Sweep kernels. Deterministic: the same item and seed give the
// same answer on every device, which is what makes spot-checks meaningful.

import type { PiOutput, SirOutput } from './protocol';

/** xoshiro128** seeded via splitmix32: fast, good quality, integer-only (bit-identical everywhere). */
export function rng32(seed: number) {
  let s = seed >>> 0;
  const split = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split(), b = split(), c = split(), d = split();
  return () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return r;
  };
}

function rotl(x: number, k: number) {
  return (x << k) | (x >>> (32 - k));
}

export function mixSeed(seed: number, i: number) {
  return (Math.imul(seed ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(i + 1, 0x165667b1)) >>> 0;
}

const INV32 = 1 / 4294967296;

/** Throw `samples` random darts at a unit square; count those inside the quarter circle. */
export function piBatch(i: number, params: { samples: number; seed: number }): PiOutput {
  const next = rng32(mixSeed(params.seed, i));
  const n = params.samples;
  let inside = 0;
  for (let k = 0; k < n; k++) {
    const x = next() * INV32;
    const y = next() * INV32;
    if (x * x + y * y < 1) inside++;
  }
  return { inside, samples: n };
}

export interface SirParams {
  grid: number;
  n: number;
  runs: number;
  days: number;
  betaMin: number;
  betaMax: number;
  gammaMin: number;
  gammaMax: number;
  seed: number;
}

export function sirCell(i: number, grid: number, p: Pick<SirParams, 'betaMin' | 'betaMax' | 'gammaMin' | 'gammaMax'>) {
  const bi = Math.floor(i / grid);
  const gi = i % grid;
  const f = (k: number) => (grid > 1 ? k / (grid - 1) : 0);
  return { beta: p.betaMin + (p.betaMax - p.betaMin) * f(bi), gamma: p.gammaMin + (p.gammaMax - p.gammaMin) * f(gi) };
}

/**
 * Stochastic SIR epidemic (chain binomial), averaged over `runs` simulated towns.
 * Item i is one (infection rate β, recovery rate γ) cell of the sweep grid.
 */
export function sirScenario(i: number, p: SirParams): SirOutput {
  const { beta, gamma } = sirCell(i, p.grid, p);
  const next = rng32(mixSeed(p.seed, i));
  const N = p.n;
  const i0 = Math.max(1, Math.round(N * 0.005));
  const pRec = 1 - Math.exp(-gamma);
  let peakSum = 0;
  let attackSum = 0;
  for (let r = 0; r < p.runs; r++) {
    let S = N - i0;
    let I = i0;
    let peak = I;
    for (let day = 0; day < p.days && I > 0; day++) {
      const pInf = 1 - Math.exp((-beta * I) / N);
      const thrInf = pInf * 4294967296;
      const thrRec = pRec * 4294967296;
      let newI = 0;
      for (let k = 0; k < S; k++) if (next() < thrInf) newI++;
      let newR = 0;
      for (let k = 0; k < I; k++) if (next() < thrRec) newR++;
      S -= newI;
      I += newI - newR;
      if (I > peak) peak = I;
    }
    peakSum += peak / N;
    attackSum += (N - S) / N;
  }
  return { beta: round4(beta), gamma: round4(gamma), peak: round4(peakSum / p.runs), attack: round4(attackSum / p.runs) };
}

function round4(x: number) {
  return Math.round(x * 1e4) / 1e4;
}
