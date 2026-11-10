// Shared geo utilities — extracted from MapView.tsx and extended

// Ray-casting point-in-polygon test
export function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function isPointInGeoJSON(lat: number, lng: number, geojson: any): boolean {
  const geometries: any[] = [];
  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features) if (f.geometry) geometries.push(f.geometry);
  } else if (geojson.type === 'Feature') {
    if (geojson.geometry) geometries.push(geojson.geometry);
  } else if (geojson.coordinates) {
    geometries.push(geojson);
  }
  for (const geom of geometries) {
    if (geom.type === 'Polygon') {
      if (pointInRing(lng, lat, geom.coordinates[0])) return true;
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (pointInRing(lng, lat, poly[0])) return true;
      }
    }
  }
  return false;
}

// Haversine distance between two lat/lng points, returns meters
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Wells of one aquifer closer together than this are at one place, such as
 * nested wells finished at different depths. Spatial Analysis keeps one of
 * them for a map; the distance can be changed there.
 */
export const COLOCATED_METERS = 20;

/**
 * Splits points into groups: each group is the first point not yet grouped
 * and every later ungrouped point within `minDist` meters of it. Every point
 * is in exactly one group, most of them alone.
 */
export function groupNearbyPoints(lats: number[], lngs: number[], minDist: number): number[][] {
  const n = lats.length;
  const used = new Array<boolean>(n).fill(false);
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [i];
    for (let j = i + 1; j < n; j++) {
      if (!used[j] && haversineDistance(lats[i], lngs[i], lats[j], lngs[j]) < minDist) {
        used[j] = true;
        group.push(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

// Area of one grid cell at a given latitude, in m²
// dx, dy are in degrees
export function cellAreaM2(lat: number, dxDeg: number, dyDeg: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * Math.PI / 180;
  // Width of cell in meters at this latitude
  const widthM = R * toRad(dxDeg) * Math.cos(toRad(lat));
  // Height of cell in meters (constant regardless of latitude)
  const heightM = R * toRad(dyDeg);
  return Math.abs(widthM * heightM);
}
