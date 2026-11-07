import { isInUS } from './importUtils';
import { fetchWithTimeout } from './http';

export interface GseFetchInput {
  id: string;
  lat: number;
  lng: number;
}

export interface GseFetchOptions {
  lengthUnit: 'ft' | 'm';
  onProgress?: (completed: number, total: number) => void;
}

export interface GseFetchResult {
  values: Map<string, number>;
  source: string;
  // Wells in a US batch that 3DEP did not answer and Open-Meteo filled in
  fallbackCount: number;
}

// 3DEP answers one point per request and can take well over 10 s a point when
// it is busy, so wait up to 30 s before giving the well to Open-Meteo
const EPQS_TIMEOUT_MS = 30000;
const OPEN_METEO_TIMEOUT_MS = 15000;

const round2 = (x: number) => Math.round(x * 100) / 100;

// Copernicus DEM through Open-Meteo, 100 points per request. Adds what it finds
// to `values` and calls onBatch with the number of wells each request covered.
async function fetchOpenMeteo(
  wells: GseFetchInput[],
  factor: number,
  values: Map<string, number>,
  onBatch?: (n: number) => void,
): Promise<void> {
  for (let i = 0; i < wells.length; i += 100) {
    const batch = wells.slice(i, i + 100);
    try {
      const lats = batch.map(w => w.lat).join(',');
      const lngs = batch.map(w => w.lng).join(',');
      const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`, {}, OPEN_METEO_TIMEOUT_MS);
      if (res.ok) {
        const data = await res.json();
        batch.forEach((well, idx) => {
          const m = data.elevation?.[idx];
          if (m !== undefined && m !== null && !isNaN(m) && m > -1000) {
            values.set(well.id, round2(m * factor));
          }
        });
      }
    } catch {
      // leaving the wells without an elevation is acceptable
    }
    onBatch?.(batch.length);
  }
}

// Batched elevation fetch. A batch entirely in the US goes to USGS 3DEP, and
// any well 3DEP does not answer goes to Open-Meteo; other batches go straight
// to Open-Meteo. Returns a map keyed by input id.
export async function fetchGseBatch(wells: GseFetchInput[], opts: GseFetchOptions): Promise<GseFetchResult> {
  const values = new Map<string, number>();
  if (wells.length === 0) return { values, source: '', fallbackCount: 0 };

  const allInUS = wells.every(w => isInUS(w.lat, w.lng));
  const factor = opts.lengthUnit === 'ft' ? 3.28084 : 1;

  if (!allInUS) {
    let completed = 0;
    await fetchOpenMeteo(wells, factor, values, n => {
      completed += n;
      opts.onProgress?.(completed, wells.length);
    });
    return { values, source: 'Open-Meteo Copernicus DEM (~90m resolution)', fallbackCount: 0 };
  }

  let completed = 0;
  const queue = [...wells];
  const unanswered: GseFetchInput[] = [];
  const worker = async () => {
    while (queue.length > 0) {
      const well = queue.shift()!;
      let found = false;
      try {
        const url = `https://epqs.nationalmap.gov/v1/json?x=${well.lng}&y=${well.lat}&units=Meters&wkid=4326`;
        const res = await fetchWithTimeout(url, {}, EPQS_TIMEOUT_MS);
        if (res.ok) {
          const data = await res.json();
          const m = parseFloat(data.value);
          if (!isNaN(m) && m > -100) {
            values.set(well.id, round2(m * factor));
            found = true;
          }
        }
      } catch {
        // timed out or refused: Open-Meteo gets it below
      }
      if (!found) unanswered.push(well);
      completed++;
      opts.onProgress?.(completed, wells.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, wells.length) }, () => worker()));

  let fallbackCount = 0;
  if (unanswered.length > 0) {
    const before = values.size;
    await fetchOpenMeteo(unanswered, factor, values);
    fallbackCount = values.size - before;
  }
  return { values, source: 'USGS 3DEP (~10m resolution)', fallbackCount };
}
