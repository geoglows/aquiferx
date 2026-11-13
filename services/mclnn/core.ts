// MC+LNN gap filling, ported from ~/papers_git/2026_gated-mc-lnn (mc_lnn/core.py and mc_lnn/softimpute.py), in the form
// the app uses: no climate forcing (the repo's neighbours_only setting). A well's record is filled from its best-correlated
// neighbours (completed jointly with the basin's most complete wells by SoftImpute), fed through fixed random reservoirs
// whose states a cross-fitted ridge regression maps onto the well's measured months.
//
// A basin is a matrix of monthly levels: one row per well, one column per month, NaN where the well was not read. The
// reservoir weights come from the same random draws as the Python (rng.ts); SoftImpute's shrinkage uses the exact largest
// singular value where the Python estimates it, and the ridge solves use the dual form when there are fewer measured months
// than features, so results agree with the Python to rounding, not bit for bit.

import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import { Pcg64 } from './rng';

export const RHOS = [0.5, 0.9, 0.99] as const;  // reservoir memory settings
export const SEEDS = 3;                          // reservoir draws, averaged
export const N_UNITS = 64;                       // units per reservoir
export const ALPHAS = [1, 10, 100, 1e3, 1e4];    // ridge penalties tried for the readout
export const N_XFIT = 6;                         // contiguous blocks for cross-fitting the readout
export const GAP_SIZE = 24;                      // donor matrix: PCHIP fills gaps of up to 24 months
export const PAD_SIZE = 6;                       //   and puts 6-month shoulders on longer ones
export const MIN_MEAS = 2 * N_XFIT;              // measured months a readout needs
export const MIN_MATRIX_MONTHS = 10;             // measured months for a well to enter the basin matrix (mc_lnn.cli)
export const MIN_EXTRAP_OBS = 60;                // wells with fewer measured months are filled at most
export const SPARSE_EXTRAP = 12;                 //   12 months beyond their record
export const N_DONORS = 15;                      // neighbours per target
export const N_ANCHORS = 60;                     // most complete wells completed with them
const MIN_SHARED = 8;                            // shared measured months for a correlation
const F32PREC = 1.1920928955078125e-7;           // np.finfo(np.float32).eps (SoftImpute's convergence edge case)

// ---------------------------------------------------------------------------------------------------------------------
// 1. Per-well preparation
// ---------------------------------------------------------------------------------------------------------------------

/** scipy.interpolate.PchipInterpolator's derivatives (_find_derivatives, _edge_case) */
function pchipDerivatives(x: number[], y: number[]): number[] {
  const n = x.length;
  const h: number[] = [], m: number[] = [];
  for (let k = 0; k < n - 1; k++) { h.push(x[k + 1] - x[k]); m.push((y[k + 1] - y[k]) / h[k]); }
  const d = new Array(n).fill(0);
  if (n === 2) { d[0] = m[0]; d[1] = m[0]; return d; }
  for (let k = 1; k < n - 1; k++) {
    const m0 = m[k - 1], m1 = m[k];
    if (Math.sign(m0) !== Math.sign(m1) || m0 === 0 || m1 === 0) { d[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    d[k] = 1 / ((w1 / m0 + w2 / m1) / (w1 + w2));
  }
  const edge = (h0: number, h1: number, m0: number, m1: number) => {
    let e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (Math.sign(e) !== Math.sign(m0)) e = 0;
    else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > 3 * Math.abs(m0)) e = 3 * m0;
    return e;
  };
  d[0] = edge(h[0], h[1], m[0], m[1]);
  d[n - 1] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  return d;
}

/** PCHIP through (x, y) evaluated at xi, which lies within [x[k], x[k+1]] */
function hermite(x: number[], y: number[], d: number[], k: number, xi: number): number {
  const hk = x[k + 1] - x[k], t = (xi - x[k]) / hk, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * hk * d[k] + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * hk * d[k + 1];
}

/**
 * core.prep_well: `own` is the series with gaps of up to gapSize months filled by PCHIP (through the measured months) and
 * NaN over longer gaps and outside the record; `longGap` marks those months, plus any in forceGap.
 */
export function prepWell(series: Float64Array, gapSize: number, forceGap?: Iterable<number>): { own: Float64Array; longGap: Uint8Array } {
  const T = series.length;
  const obs: number[] = [];
  for (let t = 0; t < T; t++) if (!Number.isNaN(series[t])) obs.push(t);
  const own = Float64Array.from(series);
  const longGap = new Uint8Array(T);
  if (obs.length === 0) {
    longGap.fill(1);
  } else {
    for (let t = 0; t < obs[0]; t++) longGap[t] = 1;
    for (let t = obs[obs.length - 1] + 1; t < T; t++) longGap[t] = 1;
    const ys = obs.map(t => series[t]);
    const d = obs.length >= 2 ? pchipDerivatives(obs, ys) : [];
    for (let k = 0; k < obs.length - 1; k++) {
      const a = obs[k], b = obs[k + 1], L = b - a - 1;
      if (L <= 0) continue;
      if (L > gapSize) { for (let t = a + 1; t < b; t++) longGap[t] = 1; continue; }
      for (let t = a + 1; t < b; t++) own[t] = hermite(obs, ys, d, k, t);
    }
  }
  if (forceGap) for (const t of forceGap) longGap[t] = 1;
  for (let t = 0; t < T; t++) if (longGap[t]) own[t] = NaN;
  return { own, longGap };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Neighbours: matrix completion
// ---------------------------------------------------------------------------------------------------------------------

/** core.zscore_rows: each row less its mean, over its standard deviation (NaN ignored; 1 where it is 0) */
function zscoreRows(rows: Float64Array[]): Float64Array[] {
  return rows.map(r => {
    let n = 0, s = 0;
    for (const v of r) if (!Number.isNaN(v)) { n++; s += v; }
    const mu = s / n;
    let ss = 0;
    for (const v of r) if (!Number.isNaN(v)) ss += (v - mu) * (v - mu);
    let sd = Math.sqrt(ss / n);
    if (!(sd > 0) || !Number.isFinite(sd)) sd = 1;
    return r.map(v => (v - mu) / sd);
  });
}

/** Population standard deviation (np.std) */
function std(v: number[]): number {
  const mu = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - mu) * (b - mu), 0) / v.length);
}

/** core.rank_neighbours: the k wells with the highest |r| with the target over at least 8 shared measured months */
export function rankNeighbours(series: Float64Array, raw: Float64Array[], ok: Uint8Array, i: number, k = N_DONORS): number[] {
  const cand: [number, number][] = [];
  const T = series.length;
  for (let j = 0; j < raw.length; j++) {
    if (j === i || !ok[j]) continue;
    const rj = raw[j];
    const a: number[] = [], b: number[] = [];
    for (let t = 0; t < T; t++) if (!Number.isNaN(series[t]) && !Number.isNaN(rj[t])) { a.push(series[t]); b.push(rj[t]); }
    if (a.length < MIN_SHARED || !(std(b) > 1e-9)) continue;
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let q = 0; q < a.length; q++) { const da = a[q] - ma, db = b[q] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    let r = sab / Math.sqrt(saa * sbb);
    if (r > 1) r = 1; else if (r < -1) r = -1;   // np.corrcoef clips
    if (Number.isFinite(r)) cand.push([Math.abs(r), j]);
  }
  cand.sort((p, q) => (q[0] - p[0]) || (q[1] - p[1]));   // Python: sort(reverse=True) on (|r|, j)
  return cand.slice(0, k).map(c => c[1]);
}

/** core.completeness_order: wells with data, most measured (or PCHIP-filled) months first, ties in row order */
function completenessOrder(own: Float64Array[]): number[] {
  const cnt = own.map(r => r.reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0));
  return cnt.map((c, j) => [c, j] as [number, number]).filter(([c]) => c > 0).sort((p, q) => (q[0] - p[0]) || (p[1] - q[1])).map(p => p[1]);
}

/** Eigenvalues (ascending) and eigenvectors (columns, row-major n×n) of a symmetric matrix */
function symEig(A: Float64Array, n: number): { values: number[]; vectors: Float64Array } {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push(Array.from(A.subarray(i * n, i * n + n)));
  const e = new EigenvalueDecomposition(new Matrix(rows), { assumeSymmetric: true });
  const V = e.eigenvectorMatrix;
  const vectors = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) vectors[i * n + j] = V.get(i, j);
  return { values: e.realEigenvalues, vectors };
}

/**
 * SoftImpute (softimpute.py, as core.anchored_completion calls it: zero start, shrinkage = largest singular value / 50,
 * convergence 0.001, at most 100 iterations, full-rank SVD). X is T×n, row-major, NaN where missing; returns it completed.
 * The SVD comes from the n×n Gram matrix, n being at most 75 (15 neighbours and 60 anchors).
 */
export function softImpute(X: Float64Array, T: number, n: number, maxIters = 100, threshold = 0.001): Float64Array {
  const missing = new Uint8Array(T * n);
  const Xf = new Float64Array(T * n);
  for (let q = 0; q < T * n; q++) { if (Number.isNaN(X[q])) missing[q] = 1; else Xf[q] = X[q]; }
  const G = new Float64Array(n * n);
  const gram = () => {
    G.fill(0);
    for (let t = 0; t < T; t++) {
      const o = t * n;
      for (let a = 0; a < n; a++) { const xa = Xf[o + a]; if (xa === 0) continue; for (let b = a; b < n; b++) G[a * n + b] += xa * Xf[o + b]; }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) G[a * n + b] = G[b * n + a];
    return symEig(G, n);
  };
  let { values, vectors } = gram();
  const shrink = Math.sqrt(Math.max(0, ...values)) / 50;
  const recon = new Float64Array(T * n);
  for (let it = 0; it < maxIters; it++) {
    if (it > 0) ({ values, vectors } = gram());
    // X ≈ U S Vᵀ with U = X V / s: the thresholded reconstruction is X · Σ_k v_k (1 - shrink / s_k) v_kᵀ over s_k > shrink
    const keep: number[] = [], fac: number[] = [];
    for (let k = 0; k < n; k++) {
      const s = Math.sqrt(Math.max(0, values[k]));
      if (s > shrink) { keep.push(k); fac.push(1 - shrink / s); }
    }
    const r = keep.length;
    const V = new Float64Array(n * r), Vf = new Float64Array(n * r);   // kept eigenvectors, and scaled by (1 - shrink / s)
    for (let a = 0; a < n; a++) for (let q = 0; q < r; q++) { const v = vectors[a * n + keep[q]]; V[a * r + q] = v; Vf[a * r + q] = v * fac[q]; }
    const XV = new Float64Array(r);
    for (let t = 0; t < T; t++) {
      const o = t * n;
      XV.fill(0);
      for (let a = 0; a < n; a++) { const xa = Xf[o + a]; if (xa === 0) continue; const va = a * r; for (let q = 0; q < r; q++) XV[q] += xa * V[va + q]; }
      for (let b = 0; b < n; b++) { let v = 0; const vb = b * r; for (let q = 0; q < r; q++) v += XV[q] * Vf[vb + q]; recon[o + b] = v; }
    }
    let ssd = 0, oldSq = 0;
    for (let q = 0; q < T * n; q++) if (missing[q]) { const dv = Xf[q] - recon[q]; ssd += dv * dv; oldSq += Xf[q] * Xf[q]; }
    const oldNorm = Math.sqrt(oldSq), diff = Math.sqrt(ssd);
    const converged = oldNorm === 0 || (oldNorm < F32PREC && diff > F32PREC) ? false : diff / oldNorm < threshold;
    for (let q = 0; q < T * n; q++) if (missing[q]) Xf[q] = recon[q];
    if (converged) break;
  }
  return Xf;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Fixed reservoirs and the cross-fitted ridge readout
// ---------------------------------------------------------------------------------------------------------------------

interface Reservoir { d: number; Win: Float64Array; Wh: Float64Array; b: Float64Array; Ta: Float64Array; tb: Float64Array }

const reservoirCache = new Map<string, Reservoir>();

/** core.Reservoir (cell "simple"), drawn in the Python's order so the weights match */
function reservoir(kind: 'basin_mf' | 'basin_mb', seed: number, rho: number, d: number): Reservoir {
  const key = `${kind}|${seed}|${rho}|${d}`;
  const hit = reservoirCache.get(key);
  if (hit) return hit;
  const N = N_UNITS, g = Pcg64.forReservoir(kind, seed, rho);
  const Win = new Float64Array(N * d);
  for (let q = 0; q < N * d; q++) Win[q] = g.uniform(-0.5, 0.5);
  const Wh = new Float64Array(N * N);
  for (let q = 0; q < N * N; q++) Wh[q] = g.normal(0, 1);
  const rows: number[][] = [];
  for (let i = 0; i < N; i++) rows.push(Array.from(Wh.subarray(i * N, i * N + N)));
  const e = new EigenvalueDecomposition(new Matrix(rows));
  let radius = 0;
  for (let k = 0; k < N; k++) radius = Math.max(radius, Math.hypot(e.realEigenvalues[k], e.imaginaryEigenvalues[k]));
  for (let q = 0; q < N * N; q++) Wh[q] *= rho / radius;
  const b = new Float64Array(N);
  for (let q = 0; q < N; q++) b[q] = g.uniform(-0.2, 0.2);
  const s = 1 / Math.sqrt(N);
  for (let q = 0; q < 2 * N * N; q++) g.normal(0, s);   // A1, A2: drawn, unused by the simple cell
  const Ta = new Float64Array(N * N);
  for (let q = 0; q < N * N; q++) Ta[q] = g.normal(0, s);
  const tb = new Float64Array(N);
  const logit = Math.log(rho / (1 - rho));
  for (let q = 0; q < N; q++) tb[q] = logit + 0.5 * g.uniform(-1, 1);
  const r = { d, Win, Wh, b, Ta, tb };
  reservoirCache.set(key, r);
  return r;
}

/** Reservoir.run over U (T×d, row-major), backwards in time when `reverse`; writes states into H (T×width) at column c0 */
function runReservoir(res: Reservoir, U: Float64Array, T: number, reverse: boolean, H: Float64Array, width: number, c0: number) {
  const N = N_UNITS, d = res.d;
  let h = new Float64Array(N);
  const z = new Float64Array(N), next = new Float64Array(N);
  for (let step = 0; step < T; step++) {
    const t = reverse ? T - 1 - step : step;
    const u = t * d;
    for (let i = 0; i < N; i++) {
      let a = res.b[i];
      const wi = i * d, wh = i * N;
      for (let j = 0; j < d; j++) a += res.Win[wi + j] * U[u + j];
      for (let j = 0; j < N; j++) a += res.Wh[wh + j] * h[j];
      z[i] = Math.tanh(a);
    }
    for (let i = 0; i < N; i++) {
      let a = res.tb[i];
      const wt = i * N;
      for (let j = 0; j < N; j++) a += res.Ta[wt + j] * z[j];
      const gate = 1 / (1 + Math.exp(-a));
      next[i] = gate * h[i] + (1 - gate) * z[i];
    }
    h = Float64Array.from(next);
    H.set(h, t * width + c0);
  }
}

/** core.reservoir_features: per seed, [3 memories × (forward, backward)] states and the inputs, T × (6·64 + d) */
function reservoirFeatures(U: Float64Array, T: number, d: number): { X: Float64Array; p: number }[] {
  const p = 6 * N_UNITS + d;
  const out: { X: Float64Array; p: number }[] = [];
  for (let sd = 0; sd < SEEDS; sd++) {
    const X = new Float64Array(T * p);
    let c = 0;
    for (const rho of RHOS) {
      runReservoir(reservoir('basin_mf', sd, rho, d), U, T, false, X, p, c); c += N_UNITS;
      runReservoir(reservoir('basin_mb', sd, rho, d), U, T, true, X, p, c); c += N_UNITS;
    }
    for (let t = 0; t < T; t++) for (let j = 0; j < d; j++) X[t * p + c + j] = U[t * d + j];
    out.push({ X, p });
  }
  return out;
}

/** Solves A x = b in place for symmetric positive definite A (n×n, row-major; A is overwritten by its Cholesky factor) */
function cholSolve(A: Float64Array, n: number, b: Float64Array): Float64Array {
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j];
    for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k];
    const djj = Math.sqrt(Math.max(s, 1e-300));
    A[j * n + j] = djj;
    for (let i = j + 1; i < n; i++) {
      let v = A[i * n + j];
      for (let k = 0; k < j; k++) v -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = v / djj;
    }
  }
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) { let v = x[i]; for (let k = 0; k < i; k++) v -= A[i * n + k] * x[k]; x[i] = v / A[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let v = x[i]; for (let k = i + 1; k < n; k++) v -= A[k * n + i] * x[k]; x[i] = v / A[i * n + i]; }
  return x;
}

/**
 * core.ridge_fit on rows `train` of X (T×p) with targets y, for each penalty in `alphas`; returns, per penalty, the
 * predictions at rows `at`. Features are standardised on the training rows (np.std; 1 where under 1e-9), y is centred.
 * The dual form (n×n) is used when there are fewer training rows than features; it gives the same weights.
 */
function ridgePredict(X: Float64Array, p: number, train: number[], y: number[], at: number[], alphas: number[]): Float64Array[] {
  const n = train.length;
  const mx = new Float64Array(p), sx = new Float64Array(p);
  for (const r of train) for (let j = 0; j < p; j++) mx[j] += X[r * p + j];
  for (let j = 0; j < p; j++) mx[j] /= n;
  for (const r of train) for (let j = 0; j < p; j++) { const dv = X[r * p + j] - mx[j]; sx[j] += dv * dv; }
  for (let j = 0; j < p; j++) { sx[j] = Math.sqrt(sx[j] / n); if (sx[j] < 1e-9) sx[j] = 1; }
  const my = y.reduce((a, b) => a + b, 0) / n;
  const yc = new Float64Array(n);
  for (let i = 0; i < n; i++) yc[i] = y[i] - my;
  const Z = new Float64Array(n * p);
  for (let i = 0; i < n; i++) { const r = train[i]; for (let j = 0; j < p; j++) Z[i * p + j] = (X[r * p + j] - mx[j]) / sx[j]; }
  const m = at.length;
  const Za = new Float64Array(m * p);
  for (let i = 0; i < m; i++) { const r = at[i]; for (let j = 0; j < p; j++) Za[i * p + j] = (X[r * p + j] - mx[j]) / sx[j]; }
  const out: Float64Array[] = [];
  if (n <= p) {
    const K = new Float64Array(n * n);
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) {
      let s = 0; const oa = a * p, ob = b * p;
      for (let j = 0; j < p; j++) s += Z[oa + j] * Z[ob + j];
      K[a * n + b] = s; K[b * n + a] = s;
    }
    for (const alpha of alphas) {
      const A = Float64Array.from(K);
      for (let i = 0; i < n; i++) A[i * n + i] += alpha;
      const coef = cholSolve(A, n, yc);
      const w = new Float64Array(p);   // the primal weights, Zᵀ coef
      for (let b = 0; b < n; b++) { const cb = coef[b], o = b * p; for (let j = 0; j < p; j++) w[j] += cb * Z[o + j]; }
      const pred = new Float64Array(m);
      for (let a = 0; a < m; a++) { let s = my; const o = a * p; for (let j = 0; j < p; j++) s += Za[o + j] * w[j]; pred[a] = s; }
      out.push(pred);
    }
  } else {
    const G = new Float64Array(p * p);
    for (let i = 0; i < n; i++) {
      const o = i * p;
      for (let a = 0; a < p; a++) { const za = Z[o + a]; if (za === 0) continue; for (let b = a; b < p; b++) G[a * p + b] += za * Z[o + b]; }
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) G[a * p + b] = G[b * p + a];
    const zy = new Float64Array(p);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) zy[j] += Z[i * p + j] * yc[i];
    for (const alpha of alphas) {
      const A = Float64Array.from(G);
      for (let i = 0; i < p; i++) A[i * p + i] += alpha;
      const w = cholSolve(A, p, zy);
      const pred = new Float64Array(m);
      for (let a = 0; a < m; a++) { let s = my; for (let j = 0; j < p; j++) s += Za[a * p + j] * w[j]; pred[a] = s; }
      out.push(pred);
    }
  }
  return out;
}

/**
 * core.readout: the penalty is chosen by 6-block contiguous cross-validation over the measured months. `full` is the fit on
 * every measured month, predicting every month; `test` holds, at the measured months, the cross-fitted (out-of-block)
 * predictions. (The Python returns one array: `full` with `test` written over the measured months.) Null under MIN_MEAS.
 */
function readout(X: Float64Array, p: number, T: number, ret: number[], yv: number[]): { full: Float64Array; test: Float64Array } | null {
  const n = ret.length;
  if (n < MIN_MEAS) return null;
  const gid = new Array(n);
  const base = Math.floor(n / N_XFIT), extra = n % N_XFIT;   // np.array_split: the first n % 6 blocks are one longer
  for (let k = 0, i = 0; k < N_XFIT; k++) for (let c = 0; c < base + (k < extra ? 1 : 0); c++) gid[i++] = k;
  const preds = ALPHAS.map(() => new Float64Array(n));
  for (let k = 0; k < N_XFIT; k++) {
    const tr: number[] = [], ytr: number[] = [], te: number[] = [], teIdx: number[] = [];
    for (let i = 0; i < n; i++) { if (gid[i] === k) { te.push(ret[i]); teIdx.push(i); } else { tr.push(ret[i]); ytr.push(yv[i]); } }
    const byAlpha = ridgePredict(X, p, tr, ytr, te, ALPHAS);
    byAlpha.forEach((pr, a) => teIdx.forEach((i, q) => { preds[a][i] = pr[q]; }));
  }
  let best = 0, bestErr = Infinity;
  preds.forEach((pr, a) => {
    let e = 0;
    for (let i = 0; i < n; i++) e += (pr[i] - yv[i]) * (pr[i] - yv[i]);
    e /= n;
    if (e < bestErr) { bestErr = e; best = a; }
  });
  const all = Array.from({ length: T }, (_, t) => t);
  const full = ridgePredict(X, p, ret, yv, all, [ALPHAS[best]])[0];
  const test = new Float64Array(T).fill(NaN);
  ret.forEach((t, i) => { test[t] = preds[best][i]; });
  return { full, test };
}

/** core.climate_series: the mean over the seeds of the readouts, `full` and `test` kept apart; null under MIN_MEAS */
function climateSeries(U: Float64Array, T: number, d: number, series: Float64Array): { full: Float64Array; test: Float64Array } | null {
  const ret: number[] = [], yv: number[] = [];
  for (let t = 0; t < T; t++) if (!Number.isNaN(series[t])) { ret.push(t); yv.push(series[t]); }
  if (ret.length < MIN_MEAS) return null;
  const full = new Float64Array(T), test = new Float64Array(T);
  for (const { X, p } of reservoirFeatures(U, T, d)) {
    const r = readout(X, p, T, ret, yv);
    if (!r) return null;
    for (let t = 0; t < T; t++) { full[t] += r.full[t]; test[t] += r.test[t]; }
  }
  for (let t = 0; t < T; t++) { full[t] /= SEEDS; test[t] /= SEEDS; }
  return { full, test };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Basin context and one target
// ---------------------------------------------------------------------------------------------------------------------

export interface Basin {
  T: number;
  raw: Float64Array[];     // monthly levels per matrix well, NaN where not read
  Z: Float64Array[];       // the donor matrix (gaps of up to 24 months PCHIP-filled), z-scored per well
  ok: Uint8Array;          // wells with any donor data
  order: number[];         // wells by completeness, most complete first
  season: Float64Array;    // T×2: sin, cos of the calendar month
  trend: Float64Array;     // T: np.linspace(-1, 1, T)
}

/** core.prepare_basin without the climate forcing. calendarMonth[t] is 1-12. */
export function prepareBasin(raw: Float64Array[], calendarMonth: number[]): Basin {
  const T = calendarMonth.length;
  const own = raw.map(r => prepWell(r, GAP_SIZE).own);
  const ok = new Uint8Array(raw.length);
  own.forEach((r, j) => { ok[j] = r.some(v => !Number.isNaN(v)) ? 1 : 0; });
  const season = new Float64Array(2 * T);
  calendarMonth.forEach((mo, t) => { season[2 * t] = Math.sin((2 * Math.PI * mo) / 12); season[2 * t + 1] = Math.cos((2 * Math.PI * mo) / 12); });
  const trend = new Float64Array(T);
  const step = T > 1 ? 2 / (T - 1) : 0;
  for (let t = 0; t < T; t++) trend[t] = -1 + t * step;
  if (T > 1) trend[T - 1] = 1;
  return { T, raw, Z: zscoreRows(own), ok, order: completenessOrder(own), season, trend };
}

export interface TargetFill {
  /** Inside the record: neighbours, season and trend (core.mc_lnn_predict on U[:, -3:]), fitted on every measured month */
  inside: Float64Array;
  /** The same readout's test values: at each measured month, predicted with that sixth of the record left out; NaN elsewhere */
  insideTest: Float64Array;
  /** Outside the record: neighbours and season (core.extrap_predict) */
  outside: Float64Array | null;
  neighbours: number;
}

/**
 * MC+LNN for matrix well i, its series replaced by `series` (months hidden for a check already NaN). The neighbour
 * completion never sees the target. Null when the well has no correlated neighbours or under MIN_MEAS measured months.
 */
export function fillTarget(basin: Basin, i: number, series: Float64Array): TargetFill | null {
  const { T } = basin;
  let measured = 0;
  for (let t = 0; t < T; t++) if (!Number.isNaN(series[t])) measured++;
  if (measured < MIN_MEAS) return null;
  const ok = Uint8Array.from(basin.ok); ok[i] = 0;
  const nb = rankNeighbours(series, basin.raw, ok, i);
  if (nb.length === 0) return null;
  const anchors = basin.order.filter(a => a !== i && ok[a]).slice(0, N_ANCHORS);
  const rows = [...new Set([...nb, ...anchors])];
  const n = rows.length;
  const X = new Float64Array(T * n);
  rows.forEach((r, c) => { const z = basin.Z[r]; for (let t = 0; t < T; t++) X[t * n + c] = z[t]; });
  const C = softImpute(X, T, n);
  const k = nb.length;
  // Inputs: [sin, cos, trend, neighbours] inside the record; [sin, cos, neighbours] outside it
  const dIn = 3 + k, dOut = 2 + k;
  const Uin = new Float64Array(T * dIn), Uout = new Float64Array(T * dOut);
  for (let t = 0; t < T; t++) {
    Uin[t * dIn] = basin.season[2 * t]; Uin[t * dIn + 1] = basin.season[2 * t + 1]; Uin[t * dIn + 2] = basin.trend[t];
    Uout[t * dOut] = basin.season[2 * t]; Uout[t * dOut + 1] = basin.season[2 * t + 1];
    for (let q = 0; q < k; q++) { const v = C[t * n + q]; Uin[t * dIn + 3 + q] = v; Uout[t * dOut + 2 + q] = v; }
  }
  const inside = climateSeries(Uin, T, dIn, series);
  if (!inside) return null;
  return { inside: inside.full, insideTest: inside.test, outside: climateSeries(Uout, T, dOut, series)?.full ?? null, neighbours: k };
}
