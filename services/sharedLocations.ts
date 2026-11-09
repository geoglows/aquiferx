import { haversineDistance, COLOCATED_METERS } from '../utils/geo';

/**
 * Wells that share a location. Spatial Analysis averages wells within
 * COLOCATED_METERS of each other into one point, so two wells of one aquifer
 * that close (nested wells at different depths, mostly) would be mapped as
 * one value that belongs to neither. Each location in an aquifer may have
 * only one well: a file with more is refused, and a download keeps one by a
 * rule the user picks. Wells at one place in different aquifers are fine,
 * which is how deep and shallow wells are kept apart.
 */

export interface PlacedWell {
  id: string;
  name: string;
  lat: number;
  lng: number;
  aquiferId: string;
  /** Already in the region, not part of this import */
  existing?: boolean;
  /** The file row, numbered as a spreadsheet shows it (header = 1) */
  row?: number;
}

export interface SharedLocation {
  aquiferId: string;
  /** In input order; within COLOCATED_METERS of one another, chained */
  wells: PlacedWell[];
}

/**
 * The locations, aquifer by aquifer, where two or more wells lie within
 * COLOCATED_METERS of each other and at least one of them is new.
 */
export function findSharedLocations(wells: PlacedWell[]): SharedLocation[] {
  const n = wells.length;
  if (n < 2) return [];
  // Grid cells at least COLOCATED_METERS on a side, so a pair that close is
  // in the same cell or a neighboring one
  const dLat = COLOCATED_METERS / 111_000;
  const maxAbsLat = Math.min(89, Math.max(...wells.map(w => Math.abs(w.lat))));
  const dLng = dLat / Math.cos(maxAbsLat * Math.PI / 180);
  const cells = new Map<string, number[]>();
  const cellOf = (w: PlacedWell) => [Math.floor(w.lat / dLat), Math.floor(w.lng / dLng)];
  wells.forEach((w, i) => {
    const [r, c] = cellOf(w);
    const key = `${w.aquiferId}|${r}|${c}`;
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(i);
  });

  const parent = wells.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  wells.forEach((w, i) => {
    const [r, c] = cellOf(w);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const j of cells.get(`${w.aquiferId}|${r + dr}|${c + dc}`) ?? []) {
          if (j <= i) continue;
          if (haversineDistance(w.lat, w.lng, wells[j].lat, wells[j].lng) < COLOCATED_METERS) {
            parent[find(i)] = find(j);
          }
        }
      }
    }
  });

  const groups = new Map<number, number[]>();
  wells.forEach((_, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, g = []);
    g.push(i);
  });
  const out: SharedLocation[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const members = g.sort((a, b) => a - b).map(i => wells[i]);
    if (members.every(w => w.existing)) continue;
    out.push({ aquiferId: members[0].aquiferId, wells: members });
  }
  return out;
}

export const SHARED_LOCATION_HEADERS = [
  'location', 'aquifer_id', 'aquifer_name', 'well_id', 'well_name', 'latitude', 'longitude',
  'meters_from_first', 'row', 'already_in_region',
];

/** One line per well at each shared location, for the list a refused file comes with. */
export function sharedLocationRows(
  locations: SharedLocation[],
  aquiferName: (id: string) => string,
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  locations.forEach((loc, k) => {
    const first = loc.wells[0];
    for (const w of loc.wells) {
      rows.push({
        location: String(k + 1),
        aquifer_id: loc.aquiferId,
        aquifer_name: aquiferName(loc.aquiferId),
        well_id: w.id,
        well_name: w.name,
        latitude: String(w.lat),
        longitude: String(w.lng),
        meters_from_first: (Math.round(haversineDistance(first.lat, first.lng, w.lat, w.lng) * 10) / 10).toString(),
        row: w.row != null ? String(w.row) : '',
        already_in_region: w.existing ? 'yes' : '',
      });
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Keeping one well per location in a download
// ---------------------------------------------------------------------------

/** Which well a download keeps at a location */
export type KeepRule = 'shallowest' | 'deepest' | 'record';

export interface WellRecordFacts {
  /** Depth of the finished well, feet */
  depthFt?: number;
  /** First and last reading, ISO dates (a USGS download) */
  begin?: string;
  end?: string;
  /** Number of samples (a WQP download) */
  samples?: number;
}

export interface KeepChoice {
  location: SharedLocation;
  keptId: string | null;
  /** Why each other new well at the location is left out */
  reasons: Map<string, string>;
}

const days = (iso?: string) => iso ? Date.parse(iso) / 86_400_000 : NaN;
const spanDays = (f?: WellRecordFacts) => {
  const s = days(f?.end) - days(f?.begin);
  return Number.isFinite(s) ? s : -1;
};

/**
 * The well each location keeps. A well already in the region always stays
 * and the new ones there are left out. Otherwise the shallowest or deepest
 * well, when every well there has a depth and one is shallowest (deepest);
 * else, and for 'record', the longest record (a USGS download: first to
 * last reading) or the most samples (WQP), then the latest reading, then
 * the first in the download.
 */
export function chooseWells(
  locations: SharedLocation[],
  rule: KeepRule,
  facts: Map<string, WellRecordFacts>,
  record: 'span' | 'samples',
): KeepChoice[] {
  return locations.map(location => {
    const reasons = new Map<string, string>();
    const existing = location.wells.filter(w => w.existing);
    const fresh = location.wells.filter(w => !w.existing);
    if (existing.length > 0) {
      for (const w of fresh) reasons.set(w.id, `at the location of ${existing[0].id}, already in the region`);
      return { location, keptId: null, reasons };
    }

    const f = (w: PlacedWell) => facts.get(w.id);
    let pool = fresh;
    let byDepth = false;
    if (rule !== 'record' && fresh.every(w => f(w)?.depthFt != null)) {
      const depth = (w: PlacedWell) => f(w)!.depthFt!;
      const extreme = rule === 'shallowest' ? Math.min(...fresh.map(depth)) : Math.max(...fresh.map(depth));
      pool = fresh.filter(w => depth(w) === extreme);
      byDepth = pool.length === 1;
    }
    const score = (w: PlacedWell): number[] => record === 'samples'
      ? [f(w)?.samples ?? 0, spanDays(f(w))]
      : [spanDays(f(w)), days(f(w)?.end) || -Infinity];
    const kept = pool.reduce((best, w) => {
      const a = score(w), b = score(best);
      return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? w : best;
    }, pool[0]);

    const keptScore = score(kept);
    for (const w of fresh) {
      if (w === kept) continue;
      const tie = score(w).every((v, i) => v === keptScore[i]);
      if (byDepth || (!pool.includes(w))) {
        reasons.set(w.id, `${rule === 'shallowest' ? 'deeper' : 'shallower'} than ${kept.id}`);
      } else if (tie) {
        reasons.set(w.id, `${kept.id} is listed first, and depth and record do not decide between them`);
      } else {
        reasons.set(w.id, record === 'samples' ? `fewer samples than ${kept.id}` : `shorter record than ${kept.id}`);
      }
    }
    return { location, keptId: kept.id, reasons };
  });
}

export const KEEP_REPORT_HEADERS = [
  'location', 'aquifer_id', 'aquifer_name', 'well_id', 'well_name', 'latitude', 'longitude',
  'depth_ft', 'first_reading', 'last_reading', 'samples', 'kept', 'reason',
];

/** One line per well at each shared location: kept, or left out and why. */
export function keepReportRows(
  choices: KeepChoice[],
  facts: Map<string, WellRecordFacts>,
  aquiferName: (id: string) => string,
  record: 'span' | 'samples',
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  choices.forEach((c, k) => {
    for (const w of c.location.wells) {
      const f = facts.get(w.id);
      const reason = c.reasons.get(w.id);
      rows.push({
        location: String(k + 1),
        aquifer_id: c.location.aquiferId,
        aquifer_name: aquiferName(c.location.aquiferId),
        well_id: w.id,
        well_name: w.name,
        latitude: String(w.lat),
        longitude: String(w.lng),
        depth_ft: f?.depthFt != null ? String(f.depthFt) : '',
        first_reading: record === 'span' ? (f?.begin ?? '').slice(0, 10) : '',
        last_reading: record === 'span' ? (f?.end ?? '').slice(0, 10) : '',
        samples: record === 'samples' ? String(f?.samples ?? 0) : '',
        kept: reason ? 'no' : 'yes',
        reason: w.existing ? 'already in the region' : reason ?? '',
      });
    }
  });
  return rows;
}

/** The IDs of new wells a set of choices leaves out */
export function leftOutIds(choices: KeepChoice[]): Set<string> {
  const out = new Set<string>();
  for (const c of choices) for (const id of c.reasons.keys()) out.add(id);
  return out;
}
