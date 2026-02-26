import { Aquifer, Region, Well, Measurement, StorageAnalysisParams, StorageAnalysisResult, StorageGrid, StorageFrame } from '../types';
import { isPointInGeoJSON, cellAreaM2 } from '../utils/geo';
import { interpolatePCHIP, kernelSmooth } from '../utils/interpolation';
import { krigGrid, estimateVariogramParams } from './kriging';

// Generate interval dates between start and end (inclusive) as ISO strings
function generateIntervalDates(startDate: string, endDate: string, interval: '3months' | '6months' | '1year'): string[] {
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    if (interval === '1year') {
      current.setFullYear(current.getFullYear() + 1);
    } else if (interval === '6months') {
      current.setMonth(current.getMonth() + 6);
    } else {
      current.setMonth(current.getMonth() + 3);
    }
  }
  return dates;
}

// Convert volume from base units (lengthUnit * m^2) to target volume unit
function convertVolume(volumeBaseM2: number, lengthUnit: 'ft' | 'm', volumeUnit: string): number {
  if (lengthUnit === 'ft') {
    // volumeBaseM2 is in ft * m^2, convert m^2 to ft^2
    const volumeFt3 = volumeBaseM2 * 10.7639;
    if (volumeUnit === 'ft3') return volumeFt3;
    if (volumeUnit === 'acre-ft') return volumeFt3 / 43560;
    return volumeFt3;
  } else {
    // volumeBaseM2 is in m * m^2 = m^3
    const volumeM3 = volumeBaseM2;
    if (volumeUnit === 'm3') return volumeM3;
    if (volumeUnit === 'MCM') return volumeM3 / 1e6;
    if (volumeUnit === 'km3') return volumeM3 / 1e9;
    return volumeM3;
  }
}

export async function runStorageAnalysis(
  params: StorageAnalysisParams,
  aquifer: Aquifer,
  region: Region,
  wells: Well[],
  measurements: Measurement[],
  onProgress: (step: string, pct: number) => void
): Promise<StorageAnalysisResult> {
  const { startDate, endDate, resolution, storageCoefficient, interval, volumeUnit, title } = params;

  // Step 1: Build grid
  onProgress('Building grid...', 0);
  await yieldToUI();

  const [minLat, minLng, maxLat, maxLng] = aquifer.bounds;
  const nx = resolution;
  const dx = (maxLng - minLng) / nx;
  // Adjust dy so cells are square in real-world distance (1° lng is shorter than 1° lat)
  const centerLat = (minLat + maxLat) / 2;
  const dy = dx * Math.cos(centerLat * Math.PI / 180);
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / dy));

  // Build grid cell centers and mask
  const gridLats: number[] = [];
  const gridLngs: number[] = [];
  const mask: (0 | 1)[] = [];

  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < nx; col++) {
      const cellLng = minLng + (col + 0.5) * dx;
      const cellLat = minLat + (row + 0.5) * dy;
      gridLngs.push(cellLng);
      gridLats.push(cellLat);
      mask.push(isPointInGeoJSON(cellLat, cellLng, aquifer.geojson) ? 1 : 0);
    }
  }

  // Step 2: Generate interval dates
  const intervalDates = generateIntervalDates(startDate, endDate, interval);
  const intervalTimestamps = intervalDates.map(d => new Date(d).getTime());

  // Step 3: PCHIP per well
  // Group WTE measurements by well
  const wteMeasurements = measurements.filter(m => m.dataType === 'wte');
  const byWell = new Map<string, Measurement[]>();
  for (const m of wteMeasurements) {
    if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
    byWell.get(m.wellId)!.push(m);
  }

  // For each well, interpolate to interval dates
  const wellInterp = new Map<string, { well: Well; values: (number | null)[] }>();
  const wellIds = wells.map(w => w.id).filter(id => byWell.has(id));

  for (let wi = 0; wi < wellIds.length; wi++) {
    const wellId = wellIds[wi];
    const well = wells.find(w => w.id === wellId)!;
    const meas = byWell.get(wellId)!;

    onProgress(`Interpolating well ${wi + 1}/${wellIds.length}...`, (wi / wellIds.length) * 30);
    if (wi % 5 === 0) await yieldToUI();

    const sorted = [...meas]
      .filter(m => !isNaN(new Date(m.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Filter by min observations and min time span
    if (sorted.length < Math.max(2, params.minObservations)) continue;

    const xValues = sorted.map(m => new Date(m.date).getTime());
    const yValues = sorted.map(m => m.value);
    const minT = xValues[0];
    const maxT = xValues[xValues.length - 1];

    const timeSpanYears = (maxT - minT) / (365.25 * 24 * 60 * 60 * 1000);
    if (timeSpanYears < params.minTimeSpanYears) continue;

    // Only interpolate within the well's data range (no extrapolation)
    const interpValues: (number | null)[] = intervalTimestamps.map(t => {
      if (t < minT || t > maxT) return null;
      return null; // placeholder, filled below
    });

    // Get all valid target timestamps
    const validTargets: number[] = [];
    const validIndices: number[] = [];
    for (let i = 0; i < intervalTimestamps.length; i++) {
      const t = intervalTimestamps[i];
      if (t >= minT && t <= maxT) {
        validTargets.push(t);
        validIndices.push(i);
      }
    }

    if (validTargets.length > 0) {
      const interpolated = interpolatePCHIP(xValues, yValues, validTargets);
      for (let i = 0; i < validIndices.length; i++) {
        interpValues[validIndices[i]] = interpolated[i];
      }
    }

    wellInterp.set(wellId, { well, values: interpValues });
  }

  console.log(`[StorageAnalysis] ${wellInterp.size}/${wellIds.length} wells qualified (minObs=${params.minObservations}, minSpan=${params.minTimeSpanYears}yr)`);

  // Step 3b: Kernel smoothing (when selected)
  if (params.smoothingMethod === 'moving-average') {
    onProgress('Applying kernel smoothing...', 30);
    await yieldToUI();

    for (const [wellId, entry] of wellInterp) {
      const meas = byWell.get(wellId)!;
      const sorted = [...meas]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.value);
      if (xValues.length < 2) continue;
      const minT = xValues[0];
      const maxT = xValues[xValues.length - 1];

      // Smooth at interval timestamps within the well's data range
      const smoothed = kernelSmooth(xValues, yValues, intervalTimestamps, params.smoothingMonths);

      const newValues: (number | null)[] = intervalTimestamps.map((t, i) => {
        if (t < minT || t > maxT) return null;
        return smoothed[i];
      });

      entry.values = newValues;
    }
  }

  // Step 4: Compute a single variogram from all wells' mean PCHIP values
  // This ensures consistent spatial correlation structure across all timesteps
  const allWellLats: number[] = [];
  const allWellLngs: number[] = [];
  const allWellMeanValues: number[] = [];

  for (const [, { well, values }] of wellInterp) {
    const validValues = values.filter((v): v is number => v !== null);
    if (validValues.length > 0) {
      allWellLats.push(well.lat);
      allWellLngs.push(well.lng);
      allWellMeanValues.push(validValues.reduce((a, b) => a + b, 0) / validValues.length);
    }
  }

  const variogramParams = estimateVariogramParams(allWellLats, allWellLngs, allWellMeanValues);
  console.log(`[StorageAnalysis] Using single variogram for all ${intervalDates.length} timesteps, ${allWellLats.length} wells total`);

  // Step 5: Krig per timestep using the shared variogram
  const frames: StorageFrame[] = [];

  for (let ti = 0; ti < intervalDates.length; ti++) {
    onProgress(`Kriging timestep ${ti + 1}/${intervalDates.length}...`, 30 + (ti / intervalDates.length) * 50);
    await yieldToUI();

    // Collect wells that have a value at this timestep
    const activeLats: number[] = [];
    const activeLngs: number[] = [];
    const activeValues: number[] = [];

    for (const [, { well, values }] of wellInterp) {
      const val = values[ti];
      if (val !== null) {
        activeLats.push(well.lat);
        activeLngs.push(well.lng);
        activeValues.push(val);
      }
    }

    console.log(`[StorageAnalysis] Timestep ${intervalDates[ti]}: ${activeValues.length} wells, values [${Math.min(...activeValues).toFixed(1)}, ${Math.max(...activeValues).toFixed(1)}]`);

    let gridValues: (number | null)[];
    if (activeValues.length >= 2) {
      gridValues = krigGrid(activeLats, activeLngs, activeValues, gridLats, gridLngs, mask, variogramParams);
    } else if (activeValues.length === 1) {
      // Single well: constant value for all masked cells
      gridValues = mask.map(m => m === 1 ? activeValues[0] : null);
    } else {
      gridValues = mask.map(() => null);
    }

    frames.push({ date: intervalDates[ti], values: gridValues });
  }

  // Step 5: Compute storage volumes
  onProgress('Computing storage volumes...', 85);
  await yieldToUI();

  const storageSeries: { date: string; value: number }[] = [];
  let cumulativeVolume = 0;

  // First entry: zero change
  if (frames.length > 0) {
    storageSeries.push({ date: frames[0].date, value: 0 });
  }

  for (let fi = 1; fi < frames.length; fi++) {
    const prevFrame = frames[fi - 1];
    const currFrame = frames[fi];
    let volumeChange = 0;

    for (let ci = 0; ci < mask.length; ci++) {
      if (mask[ci] === 0) continue;
      const prevVal = prevFrame.values[ci];
      const currVal = currFrame.values[ci];
      if (prevVal === null || currVal === null) continue;

      const dh = currVal - prevVal; // change in water level
      const row = Math.floor(ci / nx);
      const cellLat = gridLats[ci];
      const areaSqM = cellAreaM2(cellLat, dx, dy);

      // dh is in lengthUnit, area is in m^2
      volumeChange += dh * areaSqM * storageCoefficient;
    }

    // Convert volume units
    cumulativeVolume += convertVolume(volumeChange, region.lengthUnit, volumeUnit);
    storageSeries.push({ date: currFrame.date, value: cumulativeVolume });
  }

  onProgress('Saving results...', 95);
  await yieldToUI();

  // Step 6: Assemble result
  const code = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  const result: StorageAnalysisResult = {
    version: 1,
    title,
    code,
    aquiferId: aquifer.id,
    aquiferName: aquifer.name,
    regionId: region.id,
    params,
    grid: { minLng, minLat, dx, dy, nx, ny, mask },
    frames,
    storageSeries,
    createdAt: new Date().toISOString(),
  };

  // Save to disk via API
  await fetch('/api/save-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{
        path: `${region.id}/storage_${code}.json`,
        content: JSON.stringify(result),
      }]
    }),
  });

  onProgress('Complete!', 100);
  return result;
}

// Yield to UI thread for progress updates
function yieldToUI(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}
