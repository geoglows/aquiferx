import { kdTree } from 'kd-tree-javascript';
import { haversineDistance } from '../utils/geo';
import type { IdwNodalFunction, IdwNeighborMode } from '../types';

interface ProjectedPoint {
  x: number; // meters east of centroid
  y: number; // meters north of centroid
  idx: number;
}

// Convert lat/lng to approximate meters relative to centroid (equirectangular projection)
function projectPoints(
  lats: number[], lngs: number[]
): { xs: number[]; ys: number[]; centLat: number; centLng: number } {
  const n = lats.length;
  let centLat = 0, centLng = 0;
  for (let i = 0; i < n; i++) { centLat += lats[i]; centLng += lngs[i]; }
  centLat /= n; centLng /= n;

  const R = 6371000;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(centLat * toRad);

  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (lngs[i] - centLng) * toRad * R * cosLat;
    ys[i] = (lats[i] - centLat) * toRad * R;
  }
  return { xs, ys, centLat, centLng };
}

function projectSingle(
  lat: number, lng: number, centLat: number, centLng: number
): { x: number; y: number } {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(centLat * toRad);
  return {
    x: (lng - centLng) * toRad * R * cosLat,
    y: (lat - centLat) * toRad * R,
  };
}

// Solve small linear system via Gaussian elimination (for nodal function fitting)
function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null; // singular
    if (maxRow !== col) [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) sum -= aug[i][j] * x[j];
    x[i] = sum / aug[i][i];
  }
  return x;
}

// Fit gradient plane: f(x,y) ≈ f_i + fx*(x-xi) + fy*(y-yi)
// Returns [fx, fy] or null if singular
function fitGradientPlane(
  cx: number, cy: number, cv: number,
  nx: number[], ny: number[], nv: number[], nw: number[]
): [number, number] | null {
  // Weighted least squares: minimize sum w_j * (f_j - cv - fx*dx - fy*dy)^2
  // Normal equations: [sum w*dx*dx, sum w*dx*dy] [fx]   [sum w*dx*df]
  //                   [sum w*dx*dy, sum w*dy*dy] [fy] = [sum w*dy*df]
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (let j = 0; j < nx.length; j++) {
    const dx = nx[j] - cx;
    const dy = ny[j] - cy;
    const df = nv[j] - cv;
    const w = nw[j];
    a00 += w * dx * dx;
    a01 += w * dx * dy;
    a11 += w * dy * dy;
    b0 += w * dx * df;
    b1 += w * dy * df;
  }

  const result = solveSmall([[a00, a01], [a01, a11]], [b0, b1]);
  return result ? [result[0], result[1]] : null;
}

// Fit quadratic: f(x,y) ≈ a1 + a2*dx + a3*dy + a4*dx^2 + a5*dx*dy + a6*dy^2
// Returns [a2, a3, a4, a5, a6] or null if singular
function fitQuadratic(
  cx: number, cy: number, cv: number,
  nx: number[], ny: number[], nv: number[], nw: number[]
): [number, number, number, number, number] | null {
  // Need at least 5 neighbors for 5 unknowns (a1=cv is known)
  if (nx.length < 5) return null;

  // Weighted least squares with 5 basis functions
  const m = 5;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);

  for (let j = 0; j < nx.length; j++) {
    const dx = nx[j] - cx;
    const dy = ny[j] - cy;
    const df = nv[j] - cv;
    const w = nw[j];
    const phi = [dx, dy, dx * dx, dx * dy, dy * dy];

    for (let p = 0; p < m; p++) {
      for (let q = 0; q < m; q++) {
        A[p][q] += w * phi[p] * phi[q];
      }
      b[p] += w * phi[p] * df;
    }
  }

  const result = solveSmall(A, b);
  return result ? [result[0], result[1], result[2], result[3], result[4]] : null;
}

export function idwGrid(
  wellLats: number[], wellLngs: number[], wellValues: number[],
  gridLats: number[], gridLngs: number[], mask: (0 | 1)[],
  options: {
    exponent?: number;
    nodalFunction?: IdwNodalFunction;
    neighborMode?: IdwNeighborMode;
    neighborCount?: number;
  } = {}
): (number | null)[] {
  const nWells = wellLats.length;
  if (nWells === 0) return gridLats.map(() => null);
  if (nWells === 1) return mask.map(m => m === 1 ? wellValues[0] : null);

  const exponent = options.exponent ?? 2;
  const nodalFn = options.nodalFunction ?? 'classic';
  const neighborMode = options.neighborMode ?? 'all';
  const neighborCount = options.neighborCount ?? 12;

  // Project all wells to meters
  const { xs: wellXs, ys: wellYs, centLat, centLng } = projectPoints(wellLats, wellLngs);

  // Build kd-tree from wells
  const treePoints: ProjectedPoint[] = wellXs.map((x, i) => ({ x, y: wellYs[i], idx: i }));
  const distFn = (a: ProjectedPoint, b: ProjectedPoint) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const tree = new kdTree<ProjectedPoint>(treePoints, distFn, ['x', 'y']);

  // Pre-compute nodal function coefficients for each scatter point
  // For 'classic', Q_i(x) = f_i (constant)
  // For 'gradient', Q_i(x) = f_i + fx*(x-xi) + fy*(y-yi)
  // For 'quadratic', Q_i(x) = f_i + a2*dx + a3*dy + a4*dx^2 + a5*dx*dy + a6*dy^2
  const nodalCoeffs: (number[] | null)[] = new Array(nWells).fill(null);

  if (nodalFn !== 'classic') {
    // For each well, find its k nearest neighbors and fit nodal function
    const k = Math.min(nWells - 1, Math.max(nodalFn === 'quadratic' ? 8 : 5, neighborCount));
    for (let i = 0; i < nWells; i++) {
      const query = { x: wellXs[i], y: wellYs[i], idx: i };
      const nearest = tree.nearest(query, k + 1); // includes self
      const nx: number[] = [], ny: number[] = [], nv: number[] = [], nw: number[] = [];
      for (const [pt, dist] of nearest) {
        if (pt.idx === i) continue;
        nx.push(wellXs[pt.idx]);
        ny.push(wellYs[pt.idx]);
        nv.push(wellValues[pt.idx]);
        // Weight by 1/dist^exponent for the fitting
        const w = dist > 1e-10 ? 1 / Math.pow(dist, exponent) : 1e10;
        nw.push(w);
      }

      if (nodalFn === 'quadratic') {
        const qCoeffs = fitQuadratic(wellXs[i], wellYs[i], wellValues[i], nx, ny, nv, nw);
        if (qCoeffs) {
          nodalCoeffs[i] = qCoeffs;
        } else {
          // Fall back to gradient
          const gCoeffs = fitGradientPlane(wellXs[i], wellYs[i], wellValues[i], nx, ny, nv, nw);
          nodalCoeffs[i] = gCoeffs ? [...gCoeffs, 0, 0, 0] : null;
        }
      } else {
        const gCoeffs = fitGradientPlane(wellXs[i], wellYs[i], wellValues[i], nx, ny, nv, nw);
        nodalCoeffs[i] = gCoeffs ? [...gCoeffs] : null;
      }
    }
  }

  // Evaluate nodal function Q_i at a point (px, py)
  function evalNodal(i: number, px: number, py: number): number {
    const fi = wellValues[i];
    const coeffs = nodalCoeffs[i];
    if (!coeffs) return fi; // fall back to classic
    const dx = px - wellXs[i];
    const dy = py - wellYs[i];
    if (coeffs.length === 2) {
      // Gradient: fi + fx*dx + fy*dy
      return fi + coeffs[0] * dx + coeffs[1] * dy;
    }
    // Quadratic: fi + a2*dx + a3*dy + a4*dx^2 + a5*dx*dy + a6*dy^2
    return fi + coeffs[0] * dx + coeffs[1] * dy
      + coeffs[2] * dx * dx + coeffs[3] * dx * dy + coeffs[4] * dy * dy;
  }

  // Interpolate each grid cell
  const result: (number | null)[] = new Array(gridLats.length);
  let gridMin = Infinity, gridMax = -Infinity;

  for (let g = 0; g < gridLats.length; g++) {
    if (mask[g] === 0) {
      result[g] = null;
      continue;
    }

    const { x: gx, y: gy } = projectSingle(gridLats[g], gridLngs[g], centLat, centLng);

    // Find neighbors
    let activeIndices: number[];
    let activeDists: number[];

    if (neighborMode === 'nearest') {
      const k = Math.min(nWells, neighborCount);
      const nearest = tree.nearest({ x: gx, y: gy, idx: -1 }, k);
      activeIndices = nearest.map(([pt]) => pt.idx);
      activeDists = nearest.map(([, d]) => d);
    } else {
      // All wells
      activeIndices = [];
      activeDists = [];
      for (let i = 0; i < nWells; i++) {
        const dx = gx - wellXs[i];
        const dy = gy - wellYs[i];
        activeIndices.push(i);
        activeDists.push(Math.sqrt(dx * dx + dy * dy));
      }
    }

    // Check for coincident point
    let coincident = -1;
    for (let k = 0; k < activeDists.length; k++) {
      if (activeDists[k] < 1e-10) { coincident = activeIndices[k]; break; }
    }
    if (coincident >= 0) {
      result[g] = wellValues[coincident];
      if (wellValues[coincident] < gridMin) gridMin = wellValues[coincident];
      if (wellValues[coincident] > gridMax) gridMax = wellValues[coincident];
      continue;
    }

    // R = distance to farthest neighbor in active set
    let R = 0;
    for (const d of activeDists) if (d > R) R = d;
    if (R < 1e-10) R = 1; // safety

    // Modified Shepard weights: ((R - h) / (R * h))^exponent
    let sumW = 0;
    let sumWQ = 0;
    for (let k = 0; k < activeIndices.length; k++) {
      const h = activeDists[k];
      if (h >= R && activeIndices.length > 1) continue; // beyond farthest neighbor
      const w = Math.pow((R - h) / (R * h), exponent);
      const q = evalNodal(activeIndices[k], gx, gy);
      sumW += w;
      sumWQ += w * q;
    }

    const val = sumW > 0 ? sumWQ / sumW : null;
    if (val !== null && isFinite(val)) {
      result[g] = val;
      if (val < gridMin) gridMin = val;
      if (val > gridMax) gridMax = val;
    } else {
      result[g] = null;
    }
  }

  const minVal = Math.min(...wellValues);
  const maxVal = Math.max(...wellValues);
  console.log(`[IDW] Output range: [${gridMin.toFixed(1)}, ${gridMax.toFixed(1)}], well range: [${minVal.toFixed(1)}, ${maxVal.toFixed(1)}]`);

  return result;
}
