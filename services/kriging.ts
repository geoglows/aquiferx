import { haversineDistance } from '../utils/geo';

// Spatial covariance function (does NOT include nugget/measurement-error self-variance)
// C(h) = (sill - nugget) * exp(-(h/range)^2)
// At h=0: C(0+) = sill - nugget
// At h→∞: C(h) → 0
// The diagonal of the kriging matrix is set separately to sill (includes nugget).
function covarianceFunction(dist: number, sill: number, range: number, nugget: number): number {
  const ratio = dist / range;
  return (sill - nugget) * Math.exp(-(ratio * ratio));
}

// Build distance matrix between points using Haversine (returns meters)
function buildDistanceMatrix(lats: number[], lngs: number[]): number[][] {
  const n = lats.length;
  const dists: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineDistance(lats[i], lngs[i], lats[j], lngs[j]);
      dists[i][j] = d;
      dists[j][i] = d;
    }
  }
  return dists;
}

// Build (N+1)x(N+1) ordinary kriging matrix using covariance formulation
// Diagonal = sill (total variance including nugget) → well-conditioned
// Off-diagonal = spatial covariance C(h) (excludes nugget) → proper nugget discontinuity
function buildKrigingMatrix(dists: number[][], sill: number, range: number, nugget: number): number[][] {
  const n = dists.length;
  const size = n + 1;
  const K: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));

  for (let i = 0; i < n; i++) {
    K[i][i] = sill; // diagonal: total variance (spatial + nugget)
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        K[i][j] = covarianceFunction(dists[i][j], sill, range, nugget);
      }
    }
    K[i][n] = 1;
    K[n][i] = 1;
  }
  K[n][n] = 0;

  return K;
}

// Solve linear system Ax=b using Gaussian elimination with partial pivoting
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    const diag = aug[i][i];
    x[i] = Math.abs(diag) < 1e-12 ? 0 : sum / diag;
  }

  return x;
}

// Deduplicate wells within a minimum distance (meters), averaging co-located values
function deduplicateWells(
  lats: number[], lngs: number[], values: number[], minDist: number
): { lats: number[]; lngs: number[]; values: number[] } {
  const n = lats.length;
  const used = new Array(n).fill(false);
  const outLats: number[] = [];
  const outLngs: number[] = [];
  const outValues: number[] = [];

  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    // Find all wells within minDist of well i
    let sumLat = lats[i], sumLng = lngs[i], sumVal = values[i], count = 1;
    used[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (used[j]) continue;
      const d = haversineDistance(lats[i], lngs[i], lats[j], lngs[j]);
      if (d < minDist) {
        sumLat += lats[j];
        sumLng += lngs[j];
        sumVal += values[j];
        count++;
        used[j] = true;
      }
    }
    outLats.push(sumLat / count);
    outLngs.push(sumLng / count);
    outValues.push(sumVal / count);
  }

  if (outLats.length < n) {
    console.log(`[Kriging] Deduplicated ${n} wells → ${outLats.length} (merged co-located within ${minDist}m)`);
  }

  return { lats: outLats, lngs: outLngs, values: outValues };
}

// Estimate variogram parameters heuristically from well data
export function estimateVariogramParams(
  wellLats: number[], wellLngs: number[], wellValues: number[]
): { sill: number; range: number; nugget: number } {
  const n = wellValues.length;

  // Variance (sill)
  let mean = 0;
  for (const v of wellValues) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of wellValues) variance += (v - mean) ** 2;
  variance /= n;

  // Range: 1/3 of the spatial diagonal (in meters)
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (let i = 0; i < n; i++) {
    if (wellLats[i] < minLat) minLat = wellLats[i];
    if (wellLats[i] > maxLat) maxLat = wellLats[i];
    if (wellLngs[i] < minLng) minLng = wellLngs[i];
    if (wellLngs[i] > maxLng) maxLng = wellLngs[i];
  }
  const diagonal = haversineDistance(minLat, minLng, maxLat, maxLng);
  const range = diagonal / 3;

  // Nugget: small fraction of sill (measurement error / micro-scale variability)
  const nugget = variance * 0.05;

  console.log(`[Kriging] Variogram: sill=${variance.toFixed(2)}, range=${range.toFixed(0)}m, nugget=${nugget.toFixed(4)}, mean=${mean.toFixed(2)}, n=${n}`);

  return {
    sill: Math.max(variance, 0.01),
    range: Math.max(range, 100),
    nugget: Math.max(nugget, 0.001),
  };
}

// Main export: interpolate well values to a grid using ordinary kriging (covariance formulation)
export function krigGrid(
  wellLats: number[], wellLngs: number[], wellValues: number[],
  gridLats: number[], gridLngs: number[], mask: (0 | 1)[],
  variogramParams?: { sill: number; range: number; nugget: number }
): (number | null)[] {
  if (wellLats.length === 0) return gridLats.map(() => null);

  // Single well: return constant value for all cells
  if (wellLats.length === 1) {
    return mask.map(m => m === 1 ? wellValues[0] : null);
  }

  // Deduplicate co-located wells (within 10m) to prevent singular matrix
  const deduped = deduplicateWells(wellLats, wellLngs, wellValues, 10);
  const wLats = deduped.lats;
  const wLngs = deduped.lngs;
  const wValues = deduped.values;
  const n = wLats.length;

  if (n === 1) {
    return mask.map(m => m === 1 ? wValues[0] : null);
  }

  // Use provided variogram params or estimate from current data
  const { sill, range, nugget } = variogramParams || estimateVariogramParams(wLats, wLngs, wValues);

  // Build distance matrix between wells
  const wellDists = buildDistanceMatrix(wLats, wLngs);

  // Build the kriging matrix (covariance formulation)
  const K = buildKrigingMatrix(wellDists, sill, range, nugget);

  // For each grid cell, solve for weights and compute interpolated value
  const result: (number | null)[] = new Array(gridLats.length);
  const minVal = Math.min(...wValues);
  const maxVal = Math.max(...wValues);
  let gridMin = Infinity, gridMax = -Infinity;
  let outOfRangeCount = 0;

  for (let g = 0; g < gridLats.length; g++) {
    if (mask[g] === 0) {
      result[g] = null;
      continue;
    }

    // Build right-hand side: spatial covariance from grid cell to each well + Lagrange
    const rhs = new Array(n + 1);
    for (let i = 0; i < n; i++) {
      const d = haversineDistance(gridLats[g], gridLngs[g], wLats[i], wLngs[i]);
      rhs[i] = covarianceFunction(d, sill, range, nugget);
    }
    rhs[n] = 1;

    // Solve for weights (copy K since solver modifies in-place)
    const weights = solveLinearSystem(K.map(row => [...row]), rhs);

    // Interpolated value = weighted sum of well values
    let val = 0;
    for (let i = 0; i < n; i++) {
      val += weights[i] * wValues[i];
    }

    if (!isFinite(val)) {
      result[g] = null;
    } else {
      if (val < minVal || val > maxVal) outOfRangeCount++;
      if (val < gridMin) gridMin = val;
      if (val > gridMax) gridMax = val;
      result[g] = val;
    }
  }

  console.log(`[Kriging] Output range: [${gridMin.toFixed(1)}, ${gridMax.toFixed(1)}], well range: [${minVal.toFixed(1)}, ${maxVal.toFixed(1)}], outside: ${outOfRangeCount}`);

  return result;
}
