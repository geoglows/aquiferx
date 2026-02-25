import { StorageGrid, StorageFrame, CrossSectionProfile } from '../types';
import { haversineDistance } from './geo';

const NUM_SAMPLES = 200;

/**
 * Sample a cross-section line across all raster frames using bilinear interpolation.
 */
export function sampleCrossSection(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
  grid: StorageGrid,
  frames: StorageFrame[],
  lengthUnit: 'ft' | 'm'
): CrossSectionProfile {
  const totalMeters = haversineDistance(start.lat, start.lng, end.lat, end.lng);
  const totalLength = lengthUnit === 'ft' ? totalMeters * 3.28084 : totalMeters;

  const distances: number[] = [];
  const samplePoints: { lat: number; lng: number }[] = [];

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t = i / (NUM_SAMPLES - 1);
    const lat = start.lat + t * (end.lat - start.lat);
    const lng = start.lng + t * (end.lng - start.lng);
    samplePoints.push({ lat, lng });
    distances.push(t * totalLength);
  }

  const { minLng, minLat, dx, dy, nx, ny, mask } = grid;

  const profiles: (number | null)[][] = frames.map(frame => {
    return samplePoints.map(pt => {
      // Convert to fractional grid coordinates
      const col = (pt.lng - minLng) / dx;
      const row = (pt.lat - minLat) / dy;

      // Check bounds (with 0.5-cell margin for interpolation)
      if (col < 0 || col > nx - 1 || row < 0 || row > ny - 1) return null;

      // Bilinear interpolation indices
      const c0 = Math.floor(col);
      const r0 = Math.floor(row);
      const c1 = Math.min(c0 + 1, nx - 1);
      const r1 = Math.min(r0 + 1, ny - 1);

      const fc = col - c0;
      const fr = row - r0;

      // Get 4 surrounding cell values
      const idx00 = r0 * nx + c0;
      const idx01 = r0 * nx + c1;
      const idx10 = r1 * nx + c0;
      const idx11 = r1 * nx + c1;

      // Check mask
      if (mask[idx00] === 0 || mask[idx01] === 0 || mask[idx10] === 0 || mask[idx11] === 0) return null;

      const v00 = frame.values[idx00];
      const v01 = frame.values[idx01];
      const v10 = frame.values[idx10];
      const v11 = frame.values[idx11];

      if (v00 === null || v01 === null || v10 === null || v11 === null) return null;

      // Bilinear interpolation
      const v0 = v00 + fc * (v01 - v00);
      const v1 = v10 + fc * (v11 - v10);
      return v0 + fr * (v1 - v0);
    });
  });

  // Precompute elevation range across all frames
  let eMin = Infinity;
  let eMax = -Infinity;
  for (const profile of profiles) {
    for (const v of profile) {
      if (v !== null) {
        if (v < eMin) eMin = v;
        if (v > eMax) eMax = v;
      }
    }
  }
  if (!isFinite(eMin)) { eMin = 0; eMax = 1; }

  // Add small padding (2%) for visual breathing room
  const pad = (eMax - eMin) * 0.02 || 0.5;

  return {
    start,
    end,
    totalLength,
    distances,
    profiles,
    frameDates: frames.map(f => f.date),
    elevationRange: [eMin - pad, eMax + pad],
  };
}
