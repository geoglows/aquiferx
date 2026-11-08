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
  // Wells in a US batch the terrain tiles did not answer and Open-Meteo filled in
  fallbackCount: number;
}

// Wells in the US are read from Terrain Tiles on AWS (Registry of Open Data, originally Mapzen's), which
// in the US are built from USGS 3DEP. One 256-pixel tile covers many wells, so a batch takes a few
// requests where 3DEP's point service took one per well, at 10-30 s each when it was busy. At zoom 13
// the tiles matched DWR's surveyed ground elevations at 363 Monterey County wells to within 5.7 ft for
// 90% of them; coarser zooms are used only when the wells would need more than MAX_TILES tiles.
export const GSE_SOURCE_US = 'USGS 3DEP via AWS Terrain Tiles';
export const GSE_SOURCE_GLOBAL = 'Copernicus DEM via Open-Meteo (~90 m)';
const tileUrl = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TILE_ZOOM = 13, MIN_TILE_ZOOM = 11, MAX_TILES = 500, TILE_WORKERS = 6;
const TILE_TIMEOUT_MS = 20000;
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

// The well's pixel in the world at zoom z, in Web Mercator tile pixels
function worldPixel(lat: number, lng: number, z: number): { x: number; y: number } {
  const size = 256 * 2 ** z;
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: Math.floor((lng + 180) / 360 * size),
    y: Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size),
  };
}

interface TileWell { well: GseFetchInput; px: number; py: number }

function groupByTile(wells: GseFetchInput[], z: number): Map<string, TileWell[]> {
  const tiles = new Map<string, TileWell[]>();
  for (const well of wells) {
    const { x, y } = worldPixel(well.lat, well.lng, z);
    const key = `${Math.floor(x / 256)}/${Math.floor(y / 256)}`;
    let list = tiles.get(key);
    if (!list) tiles.set(key, list = []);
    list.push({ well, px: x % 256, py: y % 256 });
  }
  return tiles;
}

// The tile's RGBA pixels. The PNG's bytes are the data, so no color conversion.
async function decodeTile(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number }> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bmp;
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { data: ctx.getImageData(0, 0, width, height).data, width };
}

// Batched elevation fetch. A batch entirely in the US is read from the terrain
// tiles, and any well they do not answer goes to Open-Meteo; other batches go
// straight to Open-Meteo. Returns a map keyed by input id.
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
    return { values, source: GSE_SOURCE_GLOBAL, fallbackCount: 0 };
  }

  let z = TILE_ZOOM;
  let tiles = groupByTile(wells, z);
  while (tiles.size > MAX_TILES && z > MIN_TILE_ZOOM) tiles = groupByTile(wells, --z);

  let completed = 0;
  const queue = [...tiles.entries()];
  const unanswered: GseFetchInput[] = [];
  const worker = async () => {
    while (queue.length > 0) {
      const [key, members] = queue.shift()!;
      let pixels: { data: Uint8ClampedArray; width: number } | null = null;
      try {
        const res = await fetchWithTimeout(tileUrl(z, ...(key.split('/').map(Number) as [number, number])), {}, TILE_TIMEOUT_MS);
        if (res.ok) pixels = await decodeTile(await res.blob());
      } catch {
        // timed out, refused or undecodable: Open-Meteo gets these wells below
      }
      for (const { well, px, py } of members) {
        let found = false;
        if (pixels) {
          const i = (py * pixels.width + px) * 4;
          // Terrarium encoding: meters = R * 256 + G + B / 256 - 32768
          const m = pixels.data[i] * 256 + pixels.data[i + 1] + pixels.data[i + 2] / 256 - 32768;
          if (m > -100) {
            values.set(well.id, round2(m * factor));
            found = true;
          }
        }
        if (!found) unanswered.push(well);
      }
      completed += members.length;
      opts.onProgress?.(completed, wells.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILE_WORKERS, tiles.size) }, () => worker()));

  let fallbackCount = 0;
  if (unanswered.length > 0) {
    const before = values.size;
    await fetchOpenMeteo(unanswered, factor, values);
    fallbackCount = values.size - before;
  }
  // The tile pixel's ground size at the wells' mean latitude, to the nearest 5 m
  const meanLat = wells.reduce((s, w) => s + w.lat, 0) / wells.length;
  const pixelM = 2 * Math.PI * 6378137 * Math.cos(meanLat * Math.PI / 180) / (256 * 2 ** z);
  return { values, source: `${GSE_SOURCE_US} (~${Math.max(5, Math.round(pixelM / 5) * 5)} m)`, fallbackCount };
}
