/**
 * USGS Water Data API integration for wells and measurements.
 * Docs: https://api.waterdata.usgs.gov/ogcapi/v0/
 */

export interface USGSWell {
  siteId: string;
  siteName: string;
  lat: number;
  lng: number;
  gse: number;
}

export interface USGSMeasurement {
  siteId: string;
  date: string;
  value: number;
}

export interface USGSDataQualityReport {
  totalRaw: number;
  kept: number;
  fixed: { count: number; details: string[] };
  dropped: { count: number; details: string[] };
}

const BASE_URL = 'https://api.waterdata.usgs.gov/ogcapi/v0';

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  throw new Error('Max retries exceeded');
}

/**
 * Fetch groundwater monitoring wells within a bounding box.
 */
export async function fetchUSGSWells(
  bbox: [number, number, number, number], // [minLng, minLat, maxLng, maxLat]
  onProgress?: (count: number) => void
): Promise<USGSWell[]> {
  const wells: USGSWell[] = [];
  const bboxStr = bbox.join(',');
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const url = `${BASE_URL}/collections/monitoring-locations/items?bbox=${bboxStr}&site_type_code=GW&limit=${limit}&offset=${offset}&f=json`;
    const res = await fetchWithRetry(url);
    const data = await res.json();

    const features = data.features || [];
    for (const f of features) {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;

      wells.push({
        siteId: props.monitoring_location_identifier || props.site_no || '',
        siteName: props.monitoring_location_name || '',
        lat: coords[1],
        lng: coords[0],
        gse: parseFloat(props.altitude_of_gage_or_measuring_point || '0') || 0,
      });
    }

    onProgress?.(wells.length);

    if (features.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
    }
  }

  return wells;
}

/**
 * Validate and clean USGS measurement data.
 * Fixes obvious date issues, drops unfixable records, and reports what happened.
 */
export function validateUSGSMeasurements(
  raw: USGSMeasurement[]
): { measurements: USGSMeasurement[]; report: USGSDataQualityReport } {
  const report: USGSDataQualityReport = {
    totalRaw: raw.length,
    kept: 0,
    fixed: { count: 0, details: [] },
    dropped: { count: 0, details: [] },
  };

  const seen = new Set<string>();
  const kept: USGSMeasurement[] = [];

  for (const m of raw) {
    const { date, fixDetail, dropReason } = validateDate(m.date, m.siteId);

    if (dropReason) {
      report.dropped.count++;
      addDetail(report.dropped.details, dropReason);
      continue;
    }

    // Validate value — drop clearly nonsensical values
    if (m.value < -10000 || m.value > 100000) {
      report.dropped.count++;
      addDetail(report.dropped.details, `Extreme value (${m.value}) for ${m.siteId} on ${date}`);
      continue;
    }

    // Deduplicate: same site + date → keep first
    const key = `${m.siteId}|${date}`;
    if (seen.has(key)) {
      report.dropped.count++;
      addDetail(report.dropped.details, `Duplicate entry for ${m.siteId} on ${date}`);
      continue;
    }
    seen.add(key);

    if (fixDetail) {
      report.fixed.count++;
      addDetail(report.fixed.details, fixDetail);
    }

    kept.push({ ...m, date });
  }

  report.kept = kept.length;

  // Summarize duplicate detail if many
  const dupCount = report.dropped.details.filter(d => d.startsWith('Duplicate')).length;
  if (dupCount > 3) {
    report.dropped.details = [
      ...report.dropped.details.filter(d => !d.startsWith('Duplicate')),
      `Duplicate entries removed: ${dupCount} total`
    ];
  }

  return { measurements: kept, report };
}

function validateDate(raw: string, siteId: string): { date: string; fixDetail?: string; dropReason?: string } {
  if (!raw || !raw.trim()) {
    return { date: '', dropReason: `Missing date for ${siteId}` };
  }

  const trimmed = raw.trim();

  // Already valid: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { date: trimmed };
    }
    // Month/day out of range
    if (m < 1 || m > 12) {
      return { date: '', dropReason: `Invalid month (${m}) in date "${trimmed}" for ${siteId}` };
    }
    if (d < 1 || d > 31) {
      return { date: '', dropReason: `Invalid day (${d}) in date "${trimmed}" for ${siteId}` };
    }
  }

  // Missing day: YYYY-MM → assume first of month
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const [y, m] = trimmed.split('-').map(Number);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12) {
      const fixed = `${trimmed}-01`;
      return { date: fixed, fixDetail: `Missing day in "${trimmed}" for ${siteId} → set to ${fixed}` };
    }
    return { date: '', dropReason: `Invalid partial date "${trimmed}" for ${siteId}` };
  }

  // Missing month and day: YYYY → assume Jan 1
  if (/^\d{4}$/.test(trimmed)) {
    const y = parseInt(trimmed, 10);
    if (y > 1800 && y < 2100) {
      const fixed = `${trimmed}-01-01`;
      return { date: fixed, fixDetail: `Year-only date "${trimmed}" for ${siteId} → set to ${fixed}` };
    }
    return { date: '', dropReason: `Invalid year-only date "${trimmed}" for ${siteId}` };
  }

  // YYYY-M-D or YYYY-M-DD or YYYY-MM-D → zero-pad
  const dashMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dashMatch) {
    const [, ys, ms, ds] = dashMatch;
    const y = parseInt(ys, 10), m = parseInt(ms, 10), d = parseInt(ds, 10);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const fixed = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (fixed !== trimmed) {
        return { date: fixed, fixDetail: `Zero-padded date "${trimmed}" for ${siteId} → ${fixed}` };
      }
      return { date: fixed };
    }
    return { date: '', dropReason: `Invalid date "${trimmed}" for ${siteId}` };
  }

  // Slash formats: MM/DD/YYYY or M/D/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, ms, ds, ys] = slashMatch;
    const y = parseInt(ys, 10), m = parseInt(ms, 10), d = parseInt(ds, 10);
    if (y > 1800 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const fixed = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { date: fixed, fixDetail: `Converted date format "${trimmed}" for ${siteId} → ${fixed}` };
    }
  }

  // Unrecognizable
  return { date: '', dropReason: `Unrecognized date format "${trimmed}" for ${siteId}` };
}

/** Keep detail lists from growing unbounded — cap at 20 unique entries */
function addDetail(list: string[], detail: string) {
  if (list.length < 20) {
    list.push(detail);
  } else if (list.length === 20) {
    list.push('... and more (truncated)');
  }
}

/**
 * Fetch water level measurements for given well site IDs.
 * Uses parameter_code=72019 (depth to water level below land surface).
 */
export interface USGSDataSpan {
  minDate: string;     // YYYY-MM-DD
  maxDate: string;     // YYYY-MM-DD
  totalRecords: number;
  wellCount: number;   // distinct site IDs
}

export function computeDataSpan(measurements: { siteId: string; date: string }[]): USGSDataSpan {
  if (measurements.length === 0) {
    return { minDate: '', maxDate: '', totalRecords: 0, wellCount: 0 };
  }
  const dates = measurements.map(m => m.date).sort();
  const wells = new Set(measurements.map(m => m.siteId));
  return {
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    totalRecords: measurements.length,
    wellCount: wells.size,
  };
}

export function filterByDateRange(
  measurements: USGSMeasurement[],
  startDate: string | null,
  endDate: string | null
): USGSMeasurement[] {
  return measurements.filter(m => {
    if (startDate && m.date < startDate) return false;
    if (endDate && m.date > endDate) return false;
    return true;
  });
}

export async function fetchUSGSMeasurements(
  wellSiteIds: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<USGSMeasurement[]> {
  const allMeasurements: USGSMeasurement[] = [];
  const concurrency = 3;
  let completed = 0;

  const queue = [...wellSiteIds];

  const fetchOne = async () => {
    while (queue.length > 0) {
      const siteId = queue.shift()!;
      try {
        // Try field measurements collection
        const url = `${BASE_URL}/collections/field-measurements/items?monitoring_location_identifier=${encodeURIComponent(siteId)}&parameter_code=72019&limit=10000&f=json`;
        const res = await fetchWithRetry(url);
        const data = await res.json();

        for (const f of (data.features || [])) {
          const props = f.properties || {};
          const date = props.activity_start_date || '';
          const value = parseFloat(props.result_measure_value || '');

          if (date && !isNaN(value)) {
            allMeasurements.push({
              siteId,
              date,
              value,
            });
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch measurements for ${siteId}:`, err);
      }

      completed++;
      onProgress?.(completed, wellSiteIds.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, wellSiteIds.length) }, () => fetchOne()));

  return allMeasurements;
}
