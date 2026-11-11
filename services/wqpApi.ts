/**
 * Water Quality Portal (WQP) API integration.
 * Docs: https://www.waterqualitydata.us/webservices_documentation/
 *
 * WQP aggregates USGS NWIS, EPA STORET/WQX, USDA STEWARDS, and 400+
 * other agencies. No API key required, CORS enabled, no per-IP rate
 * limits published. Date format in queries is MM-DD-YYYY; CSV
 * responses use YYYY-MM-DD.
 *
 * Counts for the size preview come from the POST /search/count
 * endpoints, which return them as a JSON body. The same numbers ride on
 * every search response as headers, but WQP does not expose those to
 * browser scripts.
 */

import { ParameterCatalog } from '../types';
import { parseCSV } from './importUtils';
import { fetchWithTimeout } from './http';

const WQP_ORIGIN = 'https://www.waterqualitydata.us/data';

// ============================================================================
// Types
// ============================================================================

export interface WqpQueryParams {
  /** [minLng, minLat, maxLng, maxLat] in WGS84. */
  bBox: [number, number, number, number];
  /** WQP `characteristicName` values. Each call should pass the
   *  full set of names the user picked; WQP joins them with `;`. */
  characteristicNames?: string[];
  /** Inclusive lower bound, ISO `YYYY-MM-DD`. */
  startDateLo?: string;
  /** Inclusive upper bound, ISO `YYYY-MM-DD`. */
  startDateHi?: string;
  /** `NWIS` for USGS-only, `STORET` for EPA-only, etc. Omit for all. */
  providers?: string;
  /** Defaults to `Well`. */
  siteType?: string;
}

export interface WqpStation {
  /** `MonitoringLocationIdentifier`, e.g. `USGS-06137570`. */
  siteId: string;
  /** `MonitoringLocationName`. */
  siteName: string;
  lat: number;
  lng: number;
  /** `MonitoringLocationTypeName`, e.g. `Well`. */
  siteType: string;
  /** `OrganizationFormalName`. */
  organization: string;
  /** `WellDepthMeasure`, in feet, when the station gives it */
  depthFt?: number;
}

export interface WqpResult {
  /** `MonitoringLocationIdentifier`. */
  siteId: string;
  /** ISO `YYYY-MM-DD` from `ActivityStartDate`. */
  date: string;
  /** WQP `CharacteristicName` (e.g. `Nitrate`). Map to a catalog code
   *  via `buildCharacteristicMap`. */
  characteristicName: string;
  value: number;
  /** `ResultMeasure/MeasureUnitCode`, e.g. `mg/l`, `ug/l`. */
  unit: string;
  /** `ResultSampleFractionText`, e.g. `Dissolved`, `Total`, or `''`. */
  sampleFraction: string;
  /** `OrganizationFormalName`. */
  organization: string;
}

export interface WqpCounts {
  resultCount: number;
  siteCount: number;
}

export interface WqpDataQualityReport {
  totalRaw: number;
  kept: number;
  droppedNonNumeric: number;
  droppedFractionMismatch: number;
  /** Results in a unit that could not be converted to the catalog's */
  droppedUnits: number;
  droppedDuplicates: number;
  details: string[];
}

/** Catalog → WQP mapping: characteristicName (lowercased) →
 *  `{ code, preferredFraction }`. Only includes catalog entries that
 *  actually carry a `wqp` block. */
export type CharacteristicMap = Map<string, { code: string; preferredFraction: string | null; unit: string }>;

// ============================================================================
// Units
// ============================================================================

const norm = (u: string) => (u || '').toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, ' ').trim();

// Molar-mass ratios from a species to its nitrogen or phosphorus content
const TO_N: Record<string, number> = { n: 1, no3: 14.0067 / 62.0049, no2: 14.0067 / 46.0055, nh4: 14.0067 / 18.0385, nh3: 14.0067 / 17.0305 };
const TO_P: Record<string, number> = { p: 1, po4: 30.9738 / 94.9714 };
// Parameters whose amount is conventionally reported as N or P even without saying so
const IMPLIED_BASIS = new Set(['phosphorus', 'total_phosphorus', 'total_nitrogen']);
// A unit may name the parameter's own species ("mg/l as CaCO3" for hardness); that is no conversion
const OWN_BASIS: Record<string, string[]> = {
  hardness: ['caco3'], alkalinity: ['caco3'], silica: ['sio2'], sulfate: ['so4'], bicarbonate: ['hco3'],
  carbonate: ['co3'], chloride: ['cl'], fluoride: ['f'], calcium: ['ca'], magnesium: ['mg'], sodium: ['na'], potassium: ['k'],
};
const MASS: Record<string, number> = { ng: 1e-6, ug: 1e-3, mg: 1, g: 1000 };   // relative to mg

/**
 * A function that converts a value in the Water Quality Portal's unit to the
 * catalog's unit for `code`, or null when the conversion isn't certain (an
 * unknown unit, or nitrate in "mg/l" without saying as N or as NO3).
 */
export function wqpUnitConverter(code: string, wqpUnit: string, catalogUnit: string): ((v: number) => number) | null {
  const src = norm(wqpUnit), tgt = norm(catalogUnit);
  if (src === tgt) return v => v;
  // pH and other unitless values
  if (tgt === '') return ['', 'none', 'std units', 'su', 'ph units', 'units'].includes(src) ? v => v : null;
  if (tgt === 'deg c') {
    if (src === 'deg c') return v => v;
    if (src === 'deg f') return v => Math.round((v - 32) * 5 / 9 * 100) / 100;
    return null;
  }
  if (tgt === 'us/cm') {
    const m = /^(us|umho|ms|mmho)\/cm/.exec(src);
    return m ? (m[1].startsWith('m') ? v => v * 1000 : v => v) : null;
  }
  if (tgt === 'ntu') return /^(ntu|fnu|ntru|fnru)$/.test(src) ? v => v : null;
  if (tgt === 'cfu/100ml') return /^(cfu|mpn|#)\s*\/\s*100\s*ml$/.test(src) ? v => v : null;

  // Concentrations: mass per liter, perhaps "as" some species
  const parse = (u: string) => {
    const m = /^(ng|ug|mg|g)\/l(?:\s*(?:as\s*)?([a-z0-9]+))?$/.exec(u);
    return m ? { mass: MASS[m[1]], basis: m[2] || '' } : null;
  };
  const s = parse(src), t = parse(tgt);
  if (!s || !t) return null;
  const scale = s.mass / t.mass;
  if (t.basis === 'n' || t.basis === 'p') {
    const table = t.basis === 'n' ? TO_N : TO_P;
    const basis = s.basis || (IMPLIED_BASIS.has(code) ? t.basis : '');
    const ratio = table[basis];
    return ratio === undefined ? null : v => v * scale * ratio;
  }
  if (s.basis && !(OWN_BASIS[code] || []).includes(s.basis)) return null;
  return scale === 1 ? v => v : v => v * scale;
}

// ============================================================================
// URL building & HTTP
// ============================================================================

/** Convert ISO `YYYY-MM-DD` to WQP's required `MM-DD-YYYY`. */
function isoToWqpDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  return `${m[2]}-${m[3]}-${m[1]}`;
}

function buildQueryString(params: WqpQueryParams, extra: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(`bBox=${params.bBox.join(',')}`);
  parts.push(`siteType=${encodeURIComponent(params.siteType || 'Well')}`);
  if (params.characteristicNames && params.characteristicNames.length > 0) {
    parts.push(`characteristicName=${params.characteristicNames.map(encodeURIComponent).join(';')}`);
  }
  if (params.startDateLo) parts.push(`startDateLo=${isoToWqpDate(params.startDateLo)}`);
  if (params.startDateHi) parts.push(`startDateHi=${isoToWqpDate(params.startDateHi)}`);
  if (params.providers) parts.push(`providers=${encodeURIComponent(params.providers)}`);
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${encodeURIComponent(v)}`);
  return parts.join('&');
}

// A stalled response must never hang the import flow. Large CSV bodies
// can take a while, hence the generous limit.
const WQP_TIMEOUT_MS = 180000;

async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetchWithTimeout(url, init ?? {}, WQP_TIMEOUT_MS);
    if (res.ok) return res;
    if (res.status >= 500 || res.status === 429) {
      const wait = Math.pow(2, attempt) * 1500 + Math.random() * 800;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  throw new Error('WQP request failed after retries — check your connection or narrow the query');
}

// ============================================================================
// Counts (HEAD requests, headers only)
// ============================================================================

/** Estimate download size before the user commits. The count endpoint
 *  takes the query as a JSON body (it answers a GET with 500), with
 *  list-valued parameters as arrays and dates as MM-DD-YYYY. */
async function postCount(endpoint: 'Result' | 'Station', params: WqpQueryParams): Promise<Record<string, string>> {
  const body: Record<string, unknown> = {
    bBox: params.bBox.join(','),
    siteType: [params.siteType || 'Well'],
  };
  if (params.characteristicNames?.length) body.characteristicName = params.characteristicNames;
  if (params.startDateLo) body.startDateLo = isoToWqpDate(params.startDateLo);
  if (params.startDateHi) body.startDateHi = isoToWqpDate(params.startDateHi);
  if (params.providers) body.providers = params.providers.split(';');
  const res = await fetchWithRetry(`${WQP_ORIGIN}/${endpoint}/search/count?mimeType=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function fetchWqpCounts(params: WqpQueryParams): Promise<WqpCounts> {
  const [results, stations] = await Promise.all([postCount('Result', params), postCount('Station', params)]);
  return {
    resultCount: parseInt(results['Total-Result-Count'] || '0', 10) || 0,
    siteCount: parseInt(stations['Total-Site-Count'] || '0', 10) || 0,
  };
}

// ============================================================================
// Stations
// ============================================================================

export async function fetchWqpStations(params: WqpQueryParams): Promise<WqpStation[]> {
  const qs = buildQueryString(params, { mimeType: 'csv', zip: 'no' });
  const res = await fetchWithRetry(`${WQP_ORIGIN}/Station/search?${qs}`);
  const text = await res.text();
  if (!text.trim()) return [];

  const { headers, rows } = parseCSV(text);
  if (!headers.length) return [];

  // Cache header positions (CSV has 30+ columns; row-by-row indexOf is wasteful)
  const idx = (name: string) => headers.indexOf(name);
  const iSiteId = idx('MonitoringLocationIdentifier');
  const iName = idx('MonitoringLocationName');
  const iLat = idx('LatitudeMeasure');
  const iLng = idx('LongitudeMeasure');
  const iType = idx('MonitoringLocationTypeName');
  const iOrg = idx('OrganizationFormalName');
  const iDepth = idx('WellDepthMeasure/MeasureValue');
  const iDepthUnit = idx('WellDepthMeasure/MeasureUnitCode');

  const stations: WqpStation[] = [];
  for (const row of rows) {
    const siteId = iSiteId >= 0 ? row[headers[iSiteId]] : '';
    const lat = iLat >= 0 ? parseFloat(row[headers[iLat]]) : NaN;
    const lng = iLng >= 0 ? parseFloat(row[headers[iLng]]) : NaN;
    if (!siteId || isNaN(lat) || isNaN(lng)) continue;
    const depth = iDepth >= 0 ? parseFloat(row[headers[iDepth]]) : NaN;
    const depthUnit = iDepthUnit >= 0 ? (row[headers[iDepthUnit]] || '').trim().toLowerCase() : '';
    const depthFt = !Number.isFinite(depth) ? undefined
      : depthUnit === 'm' || depthUnit === 'meters' ? depth / 0.3048
      : depthUnit === 'ft' || depthUnit === 'feet' || depthUnit === '' ? depth
      : undefined;
    stations.push({
      siteId,
      siteName: iName >= 0 ? row[headers[iName]] || '' : '',
      lat,
      lng,
      siteType: iType >= 0 ? row[headers[iType]] || '' : '',
      organization: iOrg >= 0 ? row[headers[iOrg]] || '' : '',
      ...(depthFt != null ? { depthFt: Math.abs(depthFt) } : {}),
    });
  }
  return stations;
}

// ============================================================================
// Results
// ============================================================================

export async function fetchWqpResults(params: WqpQueryParams): Promise<WqpResult[]> {
  const qs = buildQueryString(params, { mimeType: 'csv', zip: 'no' });
  const res = await fetchWithRetry(`${WQP_ORIGIN}/Result/search?${qs}`);
  const text = await res.text();
  if (!text.trim()) return [];

  const { headers, rows } = parseCSV(text);
  if (!headers.length) return [];

  const iSite = headers.indexOf('MonitoringLocationIdentifier');
  const iDate = headers.indexOf('ActivityStartDate');
  const iChar = headers.indexOf('CharacteristicName');
  const iValue = headers.indexOf('ResultMeasureValue');
  const iUnit = headers.indexOf('ResultMeasure/MeasureUnitCode');
  const iFrac = headers.indexOf('ResultSampleFractionText');
  const iOrg = headers.indexOf('OrganizationFormalName');

  const results: WqpResult[] = [];
  for (const row of rows) {
    const siteId = iSite >= 0 ? row[headers[iSite]] : '';
    const date = iDate >= 0 ? row[headers[iDate]] : '';
    const charName = iChar >= 0 ? row[headers[iChar]] : '';
    const rawVal = iValue >= 0 ? row[headers[iValue]] : '';
    if (!siteId || !date || !charName || rawVal === undefined || rawVal === '') continue;
    const value = parseFloat(rawVal);
    if (isNaN(value)) continue; // censored / non-numeric values like "<0.05" — drop
    results.push({
      siteId,
      date,
      characteristicName: charName,
      value,
      unit: iUnit >= 0 ? row[headers[iUnit]] || '' : '',
      sampleFraction: iFrac >= 0 ? row[headers[iFrac]] || '' : '',
      organization: iOrg >= 0 ? row[headers[iOrg]] || '' : '',
    });
  }
  return results;
}

// ============================================================================
// Catalog mapping & dedup
// ============================================================================

/** Build a lookup from `CharacteristicName` (case-insensitive) to the
 *  catalog code + preferred sample fraction. Catalog entries without a
 *  `wqp` block are skipped. */
export function buildCharacteristicMap(catalog: ParameterCatalog): CharacteristicMap {
  const map: CharacteristicMap = new Map();
  for (const [code, param] of Object.entries(catalog.parameters)) {
    const cn = param.wqp?.characteristicName;
    if (!cn) continue;
    map.set(cn.toLowerCase(), { code, preferredFraction: param.wqp.sampleFraction, unit: param.unit });
  }
  return map;
}

/** Convenience: list every catalog code that's downloadable from WQP
 *  (i.e. has a `wqp.characteristicName`). Used by the parameter picker
 *  in 4b to know which catalog rows to expose. */
export function listWqpDownloadableCodes(catalog: ParameterCatalog): string[] {
  return Object.entries(catalog.parameters)
    .filter(([, p]) => !!p.wqp?.characteristicName)
    .map(([code]) => code);
}

/**
 * Whether a WQX sample fraction is a filtered or an unfiltered sample. The
 * catalog says `Filtered` or `Unfiltered`; the portal's results use the WQX 2
 * terms, `Dissolved` and `Total`, and WQX 3 others, `Filtered field and/or
 * lab` and `Unfiltered`. Any other fraction, or none, is neither.
 */
export function fractionKind(text: string | null | undefined): 'filtered' | 'unfiltered' | null {
  const s = (text || '').trim().toLowerCase();
  if (s === 'dissolved' || s === 'filtered' || s.startsWith('filtered ') || s.startsWith('filtered,')) return 'filtered';
  if (s === 'total' || s === 'total recoverable' || s === 'unfiltered' || s.startsWith('unfiltered ') || s.startsWith('unfiltered,')) return 'unfiltered';
  return null;
}

/** Per-WQP-row deduplication. A single sampling event can produce
 *  multiple rows for the same site+date+characteristic (different labs,
 *  filtered vs. unfiltered, lab vs. field). Strategy:
 *    1. Filter by the catalog's `wqp.sampleFraction` when set
 *       (e.g. Nitrate prefers `Filtered`, which the portal labels
 *       `Dissolved`; see fractionKind). If a row's fraction doesn't
 *       match, drop it. Catalog entries with `sampleFraction: null`
 *       (pH, temperature) accept any row.
 *    2. Of what remains, take the first row per (siteId, date,
 *       characteristic) — deterministic, no ordering assumption beyond
 *       what WQP returned. */
export function dedupWqpResults(
  results: WqpResult[],
  charMap: CharacteristicMap
): { kept: WqpResult[]; report: WqpDataQualityReport } {
  const report: WqpDataQualityReport = {
    totalRaw: results.length,
    kept: 0,
    droppedNonNumeric: 0,
    droppedFractionMismatch: 0,
    droppedUnits: 0,
    droppedDuplicates: 0,
    details: [],
  };
  // Counted per parameter and unit, for the details list
  const unitDrops = new Map<string, number>();
  const unitConversions = new Map<string, number>();

  const kept: WqpResult[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const entry = charMap.get(r.characteristicName.toLowerCase());
    // No catalog entry → caller shouldn't have queried for this; drop it
    // and report so the user can see the mismatch.
    if (!entry) {
      report.droppedFractionMismatch++;
      addDetail(report.details, `No catalog entry for "${r.characteristicName}"`);
      continue;
    }

    // Step 1: fraction filter (only when catalog specifies a preference).
    // A result with no fraction, or another one, doesn't match
    if (entry.preferredFraction) {
      const want = fractionKind(entry.preferredFraction);
      const got = fractionKind(r.sampleFraction);
      if (!want || got !== want) {
        report.droppedFractionMismatch++;
        continue;
      }
    }

    // Step 2: the catalog's unit
    const convert = wqpUnitConverter(entry.code, r.unit, entry.unit);
    if (!convert) {
      report.droppedUnits++;
      const k = `${entry.code}|${r.unit || '(none)'}|${entry.unit}`;
      unitDrops.set(k, (unitDrops.get(k) || 0) + 1);
      continue;
    }
    if (norm(r.unit) !== norm(entry.unit)) {
      const k = `${entry.code}|${r.unit}|${entry.unit}`;
      unitConversions.set(k, (unitConversions.get(k) || 0) + 1);
    }

    // Step 3: take-first dedup
    const key = `${r.siteId}|${r.date}|${entry.code}`;
    if (seen.has(key)) {
      report.droppedDuplicates++;
      continue;
    }
    seen.add(key);
    kept.push({ ...r, value: Math.round(convert(r.value) * 1e6) / 1e6, unit: entry.unit });
  }

  for (const [k, n] of unitDrops) {
    const [code, from, to] = k.split('|');
    addDetail(report.details, `${n} ${code} result${n === 1 ? '' : 's'} in "${from}" dropped: no certain conversion to ${to}`);
  }
  for (const [k, n] of unitConversions) {
    const [code, from, to] = k.split('|');
    addDetail(report.details, `${n} ${code} result${n === 1 ? '' : 's'} converted from ${from} to ${to}`);
  }
  report.kept = kept.length;
  return { kept, report };
}

function addDetail(list: string[], detail: string) {
  if (list.length < 20) list.push(detail);
  else if (list.length === 20) list.push('... and more (truncated)');
}
