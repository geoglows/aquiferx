import proj4 from 'proj4';

// Common EPSG definitions
const KNOWN_CRS: Record<string, string> = {
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  'EPSG:32601': '+proj=utm +zone=1 +datum=WGS84 +units=m +no_defs',
};

const WGS84 = 'EPSG:4326';

function isWGS84(crsString: string): boolean {
  if (!crsString) return true;
  const lower = crsString.toLowerCase();
  return lower.includes('4326') || lower.includes('wgs84') || lower.includes('wgs 84');
}

function getProjection(crsIdentifier: string): string | null {
  if (KNOWN_CRS[crsIdentifier]) return KNOWN_CRS[crsIdentifier];
  // If it looks like a proj4 string, use it directly
  if (crsIdentifier.startsWith('+proj=')) return crsIdentifier;
  return null;
}

function transformCoords(coords: any, fromProj: string): any {
  if (!Array.isArray(coords)) return coords;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const [x, y] = proj4(fromProj, KNOWN_CRS[WGS84], [coords[0], coords[1]]);
    return coords.length > 2 ? [x, y, ...coords.slice(2)] : [x, y];
  }
  return coords.map((c: any) => transformCoords(c, fromProj));
}

function transformGeometry(geometry: any, fromProj: string): any {
  if (!geometry) return geometry;
  return {
    ...geometry,
    coordinates: transformCoords(geometry.coordinates, fromProj)
  };
}

/**
 * Detect CRS from GeoJSON `crs` property and reproject to WGS84 if needed.
 * Returns { geojson, reprojected, fromCrs }.
 */
export function reprojectGeoJSON(geojson: any): { geojson: any; reprojected: boolean; fromCrs: string } {
  const crsProperty = geojson.crs;
  let fromCrs = '';

  if (crsProperty) {
    if (crsProperty.type === 'name' && crsProperty.properties?.name) {
      fromCrs = crsProperty.properties.name;
    } else if (crsProperty.type === 'EPSG' && crsProperty.properties?.code) {
      fromCrs = `EPSG:${crsProperty.properties.code}`;
    }
  }

  if (!fromCrs || isWGS84(fromCrs)) {
    return { geojson, reprojected: false, fromCrs: fromCrs || 'WGS84' };
  }

  const projection = getProjection(fromCrs);
  if (!projection) {
    console.warn(`Unknown CRS: ${fromCrs}, assuming WGS84`);
    return { geojson, reprojected: false, fromCrs };
  }

  return reprojectWithProj(geojson, projection, fromCrs);
}

/**
 * Reproject GeoJSON using a WKT string (from .prj file).
 */
export function reprojectFromWKT(geojson: any, wkt: string): { geojson: any; reprojected: boolean; fromCrs: string } {
  if (!wkt || isWGS84(wkt)) {
    return { geojson, reprojected: false, fromCrs: 'WGS84' };
  }

  try {
    const projection = proj4.Proj(wkt);
    return reprojectWithProj(geojson, wkt, 'Custom CRS');
  } catch (err) {
    console.warn('Failed to parse WKT, assuming WGS84:', err);
    return { geojson, reprojected: false, fromCrs: 'Unknown' };
  }
}

function reprojectWithProj(geojson: any, fromProj: string, fromCrs: string): { geojson: any; reprojected: boolean; fromCrs: string } {
  const result = { ...geojson };

  // Remove CRS property (WGS84 is assumed)
  delete result.crs;

  if (result.type === 'FeatureCollection') {
    result.features = result.features.map((f: any) => ({
      ...f,
      geometry: transformGeometry(f.geometry, fromProj)
    }));
  } else if (result.type === 'Feature') {
    result.geometry = transformGeometry(result.geometry, fromProj);
  } else if (result.coordinates) {
    result.coordinates = transformCoords(result.coordinates, fromProj);
  }

  return { geojson: result, reprojected: true, fromCrs };
}
