import { haversineDistance, COLOCATED_METERS } from '../utils/geo';

/**
 * Wells at one place: wells of one aquifer a few meters apart, mostly nested
 * wells finished at different depths. A region keeps them all, so they can be
 * viewed and charted side by side. A map can use only one at each place:
 * averaging a shallow and a deep water level gives a value that belongs to
 * neither. Spatial Analysis keeps one well per place, by a rule the user picks
 * or by hand, and leaves the others out of that map.
 */

/** A well listed in an import's notice */
export interface PlacedWell {
  id: string;
  name: string;
  lat: number;
  lng: number;
  aquiferId: string;
  /** The file row, numbered as a spreadsheet shows it (header = 1) */
  row?: number;
}

/**
 * Groups of two or more points less than `meters` apart, chained (A near B
 * and B near C puts all three in one group), each in input order. The points
 * are taken to be in one aquifer.
 */
export function findPlaces<T extends { lat: number; lng: number }>(points: T[], meters = COLOCATED_METERS): T[][] {
  const n = points.length;
  if (n < 2 || !(meters > 0)) return [];
  // Grid cells at least `meters` on a side, so a pair that close is in the
  // same cell or a neighboring one
  const dLat = meters / 111_000;
  const maxAbsLat = Math.min(89, Math.max(...points.map(p => Math.abs(p.lat))));
  const dLng = dLat / Math.cos(maxAbsLat * Math.PI / 180);
  const cellOf = (p: T) => [Math.floor(p.lat / dLat), Math.floor(p.lng / dLng)];
  const cells = new Map<string, number[]>();
  points.forEach((p, i) => {
    const [r, c] = cellOf(p);
    const key = `${r}|${c}`;
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(i);
  });

  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  points.forEach((p, i) => {
    const [r, c] = cellOf(p);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const j of cells.get(`${r + dr}|${c + dc}`) ?? []) {
          if (j <= i) continue;
          if (haversineDistance(p.lat, p.lng, points[j].lat, points[j].lng) < meters) parent[find(i)] = find(j);
        }
      }
    }
  });

  const groups = new Map<number, number[]>();
  points.forEach((_, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, g = []);
    g.push(i);
  });
  return [...groups.values()]
    .filter(g => g.length > 1)
    .map(g => g.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .map(g => g.map(i => points[i]));
}

// ---------------------------------------------------------------------------
// Keeping one well at each place
// ---------------------------------------------------------------------------

export interface PlacePoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Depth of the finished well, in the region's length unit */
  depth?: number;
}

/** A measurement as a timestamp (ms) and value; each well's are sorted by time */
export interface Reading { t: number; v: number }

export interface PlaceWell extends PlacePoint {
  /** Readings inside the period */
  count: number;
  /** First and last reading of the whole record, ISO dates */
  first?: string;
  last?: string;
  /** Years of the period that the record covers, first reading to last */
  coverYears: number;
  /** Median difference from the readings of nearby wells, when enough compare */
  medianDiff?: number;
  /** Readings that had enough nearby wells to compare with */
  compared: number;
}

export interface Place {
  /** Wells sorted by ID, so a place has the same key whatever the input order */
  wells: PlaceWell[];
  /** The greatest distance from the first well, meters */
  spanMeters: number;
  key: string;
}

/**
 * How the neighbor comparison works: each reading of a well at a place is
 * compared with an inverse-distance estimate from up to `maxNeighbors` wells
 * within `radiusMeters` that are not at any place and have a reading within
 * `days` of it; a reading needs `minNeighbors` of them, and a well needs
 * `minCompared` compared readings for a score.
 */
export const NEIGHBOR_COMPARISON = {
  radiusMeters: 8000,
  days: 45,
  maxNeighbors: 6,
  minNeighbors: 3,
  minCompared: 5,
  /** Closer neighbors are weighted as if this far, so one very close well can't decide alone */
  minWeightMeters: 50,
};

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

/** The reading nearest in time to t, or undefined when none is within maxMs */
function nearestReading(rs: Reading[], t: number, maxMs: number): Reading | undefined {
  let lo = 0, hi = rs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rs[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best: Reading | undefined;
  for (const k of [lo - 1, lo]) {
    const r = rs[k];
    if (r && Math.abs(r.t - t) <= maxMs && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r;
  }
  return best;
}

/**
 * The facts each rule needs, for every well at every place: readings in the
 * period [start, end] (ms), the years of it the record covers, and how the
 * well's readings compare with those of nearby wells (`neighbors`: wells with
 * readings that are not at any place).
 */
export function describePlaces(
  groups: PlacePoint[][],
  readings: Map<string, Reading[]>,
  neighbors: PlacePoint[],
  start: number,
  end: number,
): Place[] {
  const C = NEIGHBOR_COMPARISON;
  return groups.map(group => {
    const first = group[0];
    const near = neighbors
      .map(p => ({ p, d: haversineDistance(first.lat, first.lng, p.lat, p.lng) }))
      .filter(x => x.d <= C.radiusMeters && (readings.get(x.p.id)?.length ?? 0) > 0)
      .sort((a, b) => a.d - b.d);
    const wells: PlaceWell[] = group.map(w => {
      const rs = readings.get(w.id) ?? [];
      const inPeriod = rs.filter(r => r.t >= start && r.t <= end);
      const t0 = rs.length ? rs[0].t : NaN, t1 = rs.length ? rs[rs.length - 1].t : NaN;
      const cover = rs.length ? Math.max(0, Math.min(t1, end) - Math.max(t0, start)) / MS_PER_YEAR : 0;
      const diffs: number[] = [];
      for (const r of inPeriod) {
        const pts: { d: number; v: number }[] = [];
        for (const { p, d } of near) {
          const hit = nearestReading(readings.get(p.id)!, r.t, C.days * MS_PER_DAY);
          if (hit) pts.push({ d, v: hit.v });
          if (pts.length === C.maxNeighbors) break;
        }
        if (pts.length < C.minNeighbors) continue;
        let sw = 0, sv = 0;
        for (const { d, v } of pts) { const wt = 1 / Math.max(d, C.minWeightMeters) ** 2; sw += wt; sv += wt * v; }
        diffs.push(Math.abs(r.v - sv / sw));
      }
      diffs.sort((a, b) => a - b);
      const median = diffs.length === 0 ? NaN
        : diffs.length % 2 ? diffs[(diffs.length - 1) / 2] : (diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2;
      return {
        ...w,
        count: inPeriod.length,
        first: rs.length ? new Date(t0).toISOString().slice(0, 10) : undefined,
        last: rs.length ? new Date(t1).toISOString().slice(0, 10) : undefined,
        coverYears: cover,
        ...(diffs.length >= C.minCompared ? { medianDiff: median } : {}),
        compared: diffs.length,
      };
    });
    wells.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const spanMeters = Math.max(...group.map(w => haversineDistance(first.lat, first.lng, w.lat, w.lng)));
    return { wells, spanMeters, key: wells.map(w => w.id).join('|') };
  });
}

/** Which well a place keeps */
export type KeepRule = 'neighbors' | 'record' | 'count' | 'shallowest' | 'deepest';

export const KEEP_RULE_LABELS: Record<KeepRule, string> = {
  neighbors: 'Agrees best with nearby wells',
  record: 'Longest record',
  count: 'Most readings',
  shallowest: 'Shallowest well',
  deepest: 'Deepest well',
};

export interface KeepChoice {
  keptId: string;
  /** How the kept well was chosen, for the list */
  how: string;
  /** Why each other well is left out */
  reasons: Map<string, string>;
}

const fmt = (x: number) => (Math.round(x * 10) / 10).toLocaleString();

/**
 * The well a place keeps under a rule. Ties, and places where the rule can't
 * decide (a well with no depth, too few nearby wells to compare with), go to
 * the most readings in the period, then the longest record, then the first
 * well by ID.
 */
export function chooseWell(place: Place, rule: KeepRule): KeepChoice {
  const ws = place.wells;
  const byCount = (pool: PlaceWell[]) => pool.reduce((best, w) =>
    w.count > best.count || (w.count === best.count && w.coverYears > best.coverYears) ? w : best, pool[0]);
  const byRecord = (pool: PlaceWell[]) => pool.reduce((best, w) =>
    w.coverYears > best.coverYears || (w.coverYears === best.coverYears && w.count > best.count) ? w : best, pool[0]);

  let kept: PlaceWell;
  let how: string;
  const reasons = new Map<string, string>();
  const fallback = (why: string, pool = ws) => {
    kept = byCount(pool);
    how = `most readings (${why})`;
    for (const w of ws) if (w !== kept) reasons.set(w.id, pool.includes(w) ? `fewer readings than ${kept.id}` : '');
  };

  if (rule === 'neighbors') {
    if (ws.every(w => w.medianDiff != null)) {
      const best = Math.min(...ws.map(w => w.medianDiff!));
      const pool = ws.filter(w => w.medianDiff === best);
      kept = byCount(pool);
      how = 'agrees best with nearby wells';
      for (const w of ws) if (w !== kept) reasons.set(w.id, `differs more from nearby wells (${fmt(w.medianDiff!)} vs ${fmt(kept.medianDiff!)})`);
    } else {
      fallback('too few nearby wells read at the same times to compare');
    }
  } else if (rule === 'shallowest' || rule === 'deepest') {
    if (ws.every(w => w.depth != null)) {
      const extreme = rule === 'shallowest' ? Math.min(...ws.map(w => w.depth!)) : Math.max(...ws.map(w => w.depth!));
      const pool = ws.filter(w => w.depth === extreme);
      if (pool.length === 1) {
        kept = pool[0];
        how = rule === 'shallowest' ? 'shallowest' : 'deepest';
        for (const w of ws) if (w !== kept) reasons.set(w.id, `${rule === 'shallowest' ? 'deeper' : 'shallower'} than ${kept.id}`);
      } else {
        fallback('wells of the same depth', pool);
        for (const w of ws) if (!pool.includes(w)) reasons.set(w.id, `${rule === 'shallowest' ? 'deeper' : 'shallower'} than ${kept!.id}`);
      }
    } else {
      fallback('a well has no depth');
    }
  } else if (rule === 'record') {
    kept = byRecord(ws);
    how = 'longest record';
    for (const w of ws) if (w !== kept) reasons.set(w.id, `shorter record than ${kept.id}`);
  } else {
    kept = byCount(ws);
    how = 'most readings';
    for (const w of ws) if (w !== kept) reasons.set(w.id, `fewer readings than ${kept.id}`);
  }
  return { keptId: kept!.id, how: how!, reasons };
}

export const PLACE_REPORT_HEADERS = [
  'place', 'well_id', 'well_name', 'latitude', 'longitude', 'meters_from_first', 'well_depth',
  'readings_in_period', 'first_reading', 'last_reading', 'median_difference_from_nearby_wells', 'readings_compared',
  'kept', 'reason',
];

/** One line per well at each place: kept, or left out and why. */
export function placeReportRows(
  places: Place[],
  kept: (place: Place) => { keptId: string; how: string; reasons: Map<string, string> },
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  places.forEach((place, k) => {
    const c = kept(place);
    const first = place.wells[0];
    for (const w of place.wells) {
      rows.push({
        place: String(k + 1),
        well_id: w.id,
        well_name: w.name,
        latitude: String(w.lat),
        longitude: String(w.lng),
        meters_from_first: fmt(haversineDistance(first.lat, first.lng, w.lat, w.lng)),
        well_depth: w.depth != null ? String(w.depth) : '',
        readings_in_period: String(w.count),
        first_reading: w.first ?? '',
        last_reading: w.last ?? '',
        median_difference_from_nearby_wells: w.medianDiff != null ? fmt(w.medianDiff) : '',
        readings_compared: String(w.compared),
        kept: w.id === c.keptId ? 'yes' : 'no',
        reason: w.id === c.keptId ? c.how : c.reasons.get(w.id) || `${c.keptId} kept`,
      });
    }
  });
  return rows;
}
