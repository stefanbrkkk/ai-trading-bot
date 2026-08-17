/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic component of Aurelius (the market simulator, the Monte-Carlo
 * copula sampler, the neural weight initialisers, the paper-broker slippage
 * model) draws from a seeded generator so that identical inputs always produce
 * identical outputs. This is a hard requirement: the forensic ledger has to be
 * reproducible, and the test suite asserts on exact numbers.
 *
 * Algorithm: xoshiro128** — 128-bit state, 2^128-1 period, passes BigCrush,
 * ~1ns/draw. Seeded through splitmix32 so that a single integer seed expands to
 * a well-distributed state vector.
 */

export interface Rng {
  /** Uniform on [0, 1). */
  next(): number;
  /** Uniform integer on [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Standard normal via Marsaglia polar method (cached pair). */
  normal(): number;
  /** Normal with mean `mu` and standard deviation `sigma`. */
  gaussian(mu: number, sigma: number): number;
  /** Exponential with rate `lambda`. */
  exponential(lambda: number): number;
  /** Student-t with `nu` degrees of freedom (Bailey's polar method). */
  studentT(nu: number): number;
  /** True with probability `p`. */
  bernoulli(p: number): boolean;
  /** Uniformly picks one element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Forks an independent stream — used to keep sub-simulations decoupled. */
  fork(salt: string | number): Rng;
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Stable 32-bit string hash (FNV-1a) so string seeds are reproducible. */
export function hashSeed(input: string | number): number {
  if (typeof input === 'number') return Math.trunc(input) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: string | number = 0x9e3779b9): Rng {
  const sm = splitmix32(hashSeed(seed));
  let s0 = sm();
  let s1 = sm();
  let s2 = sm();
  let s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  let spare: number | null = null;

  const next = (): number => {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) / 4294967296;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };

  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    normal,
    gaussian: (mu, sigma) => mu + sigma * normal(),
    exponential: (lambda) => -Math.log(1 - next()) / lambda,
    studentT: (nu) => {
      // Bailey (1994): z / sqrt(chi2_nu / nu), chi2 built from nu/2 gammas.
      let sum = 0;
      const halfNu = nu / 2;
      const wholeGammas = Math.floor(halfNu);
      for (let i = 0; i < wholeGammas; i += 1) sum += -2 * Math.log(1 - next());
      if (halfNu !== wholeGammas) {
        const g = normal();
        sum += g * g;
      }
      const chi2 = sum;
      return chi2 <= 0 ? normal() : normal() / Math.sqrt(chi2 / nu);
    },
    bernoulli: (p) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[Math.floor(next() * items.length)] as T;
    },
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    fork: (salt) => createRng(`${hashSeed(salt)}:${Math.floor(next() * 0xffffffff)}`),
  };

  return rng;
}
