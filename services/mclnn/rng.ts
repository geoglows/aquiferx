// numpy's PCG64 bit generator and its uniform and standard normal draws, reproduced draw for draw, so the
// reservoirs built here hold the same weights as those of the Python MC+LNN (mc_lnn/core.py, Reservoir).
//   PCG64:   numpy/random/src/pcg64/pcg64.h (128-bit LCG, XSL-RR output; the state steps before each output)
//   double:  numpy/random/_common.pxd uint64_to_double: (r >> 11) * 2^-53
//   uniform: distributions.c random_uniform: lower + range * next_double
//   normal:  distributions.c random_standard_normal (256-layer ziggurat)

import { FI_DOUBLE, KI_DOUBLE, RESERVOIR_RNG, WI_DOUBLE, ZIGGURAT_NOR_INV_R, ZIGGURAT_NOR_R } from './constants';

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULTIPLIER = (2549297995355413924n << 64n) | 4865540595714422341n;
const TWO_M53 = 1 / 9007199254740992;
const MASK52 = 0x000fffffffffffffn;

export class Pcg64 {
  private state: bigint;
  private readonly inc: bigint;

  constructor(state: bigint, inc: bigint) {
    this.state = state;
    this.inc = inc;
  }

  /** The generator numpy.random.default_rng(seed_of(kind, seed, rho)) starts with */
  static forReservoir(kind: 'basin_mf' | 'basin_mb', seed: number, rho: number): Pcg64 {
    const s = RESERVOIR_RNG[`${kind}|${seed}|${rho}`];
    if (!s) throw new Error(`No reservoir seed for ${kind}|${seed}|${rho}`);
    return new Pcg64(BigInt(s.state), BigInt(s.inc));
  }

  nextUint64(): bigint {
    this.state = (this.state * MULTIPLIER + this.inc) & MASK128;
    const hi = this.state >> 64n, lo = this.state & MASK64;
    const x = hi ^ lo, rot = this.state >> 122n;
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & MASK64;
  }

  nextDouble(): number {
    return Number(this.nextUint64() >> 11n) * TWO_M53;
  }

  uniform(low: number, high: number): number {
    return low + (high - low) * this.nextDouble();
  }

  standardNormal(): number {
    for (;;) {
      let r = this.nextUint64();
      const idx = Number(r & 0xffn);
      r >>= 8n;
      const sign = Number(r & 1n);
      const rabsBig = (r >> 1n) & MASK52;
      const rabs = Number(rabsBig);
      let x = rabs * WI_DOUBLE[idx];
      if (sign) x = -x;
      if (rabs < KI_DOUBLE[idx]) return x;
      if (idx === 0) {
        for (;;) {
          const xx = -ZIGGURAT_NOR_INV_R * Math.log1p(-this.nextDouble());
          const yy = -Math.log1p(-this.nextDouble());
          if (yy + yy > xx * xx) return Number((rabsBig >> 8n) & 1n) ? -(ZIGGURAT_NOR_R + xx) : ZIGGURAT_NOR_R + xx;
        }
      } else if ((FI_DOUBLE[idx - 1] - FI_DOUBLE[idx]) * this.nextDouble() + FI_DOUBLE[idx] < Math.exp(-0.5 * x * x)) {
        return x;
      }
    }
  }

  normal(loc: number, scale: number): number {
    return loc + scale * this.standardNormal();
  }
}
