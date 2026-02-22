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
 * Fetch water level measurements for given well site IDs.
 * Uses parameter_code=72019 (depth to water level below land surface).
 */
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
