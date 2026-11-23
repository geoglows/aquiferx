import shp from 'shpjs';
import JSZip from 'jszip';
import { reprojectGeoJSON, reprojectFromWKT, assertLonLat } from './reprojection';

export interface ColumnMapping {
  [targetColumn: string]: string;
}

export interface UploadedFile {
  name: string;
  data: any;
  columns: string[];
  mapping: ColumnMapping;
  type: 'geojson' | 'csv';
}

// The order of day, month and year. Each reads /, . or - between the parts,
// one or two digits for the day and month, and four or two for the year.
export const DATE_FORMATS = [
  { label: 'YYYY-MM-DD (2024-01-15)', value: 'iso' },
  { label: 'MM/DD/YYYY (01/15/2024)', value: 'us' },
  { label: 'DD/MM/YYYY (15/01/2024, 15.01.2024)', value: 'eu' },
];

// Split a CSV line respecting quoted fields
export function splitCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// Tokenize CSV text into records. Parses character-by-character over the
// whole text (not line-by-line) so quoted fields may contain delimiters
// and newlines. Delimiter (comma vs tab) is detected from the first line.
function parseCsvRecords(text: string): string[][] {
  if (!text) return [];
  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const records: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;

  const pushField = () => { fields.push(current.trim()); current = ''; };
  const pushRecord = () => {
    pushField();
    // Skip blank records (blank lines, trailing newline)
    if (fields.length > 1 || fields[0] !== '') records.push(fields);
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n') {
      pushRecord();
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') pushRecord(); // bare \r is a line break; \r\n handled by \n
    } else {
      current += ch;
    }
  }
  if (current !== '' || fields.length > 0) pushRecord();
  return records;
}

// Parse CSV text into { headers, rows }
export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parseCsvRecords(text);
  if (records.length < 1) return { headers: [], rows: [] };

  const headers = records[0];
  const rows = records.slice(1).map(values => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });

  return { headers, rows };
}

// Quote a field for CSV output when it contains a delimiter, quote, or
// line break
export function escapeCsvField(value: string): string {
  return /[",\t\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Serialize rows to CSV. The single writer for all importers/editors —
// per-component string concatenation is where quoting bugs come from.
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsvField(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

// Canonical wells.csv column set — every writer must use this so the
// schema can't drift between importers
export const WELLS_CSV_HEADERS = ['well_id', 'well_name', 'lat', 'long', 'gse', 'well_depth', 'aquifer_id', 'aquifer_name'];

/** A well depth cell as wells.csv stores it: a number, or '' when the cell
 *  is empty or not a number. A negative depth is read as below the ground,
 *  as depths to water are. */
export function cleanDepth(cell: string | undefined): string {
  const n = parseFloat((cell ?? '').trim());
  return Number.isFinite(n) ? String(Math.abs(n)) : '';
}

/** A column that holds the depth of the well itself (not a depth to water). */
export function isWellDepthColumn(column: string): boolean {
  const s = column.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[_\s.-]+/g, ' ').trim();
  return ['depth', 'well depth', 'welldepth', 'total depth', 'well total depth', 'total well depth', 'depth of well', 'well constructed depth'].includes(s);
}

// A date of three numbers with one separator, and an optional time of day
// after it (dropped: measurements are dated by the day, as the USGS
// download keeps them)
const DATE_PARTS = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})(?:[T\s]+\d{1,2}:\d{2}.*)?$/;

/**
 * A date as YYYY-MM-DD, read in the given order of day, month and year, or
 * '' when it can't be read that way: another layout (15-Jan-2024), a month
 * over 12 or a day the month doesn't have. The importer skips and counts
 * those rows, since a stored date the app can't read loses the measurement.
 */
export function parseDate(dateStr: string, format: string): string {
  const m = DATE_PARTS.exec((dateStr || '').trim());
  if (!m) return '';
  const [, a, , b, c] = m;
  // 'us-short' and 'eu-short' were menu entries once, read the same way
  const order = format.startsWith('us') ? 'mdy' : format.startsWith('eu') ? 'dmy' : 'ymd';
  let [y, mo, d] = order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : [c, b, a];
  // A two-digit year only at the end: 15/01/24 read year first would pass as 2015-01-24
  if (y.length === 2 && order !== 'ymd') y = (parseInt(y, 10) >= 50 ? '19' : '20') + y;
  else if (y.length !== 4) return '';
  const year = parseInt(y, 10), month = parseInt(mo, 10), day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1) return '';
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Guess the order of a date column from all of its values: year first when
 * every date starts with four digits; else day first when any first number
 * is over 12, month first when any second number is; else day first for
 * dates written with points (15.01.2024), the way of the countries that use
 * them, and month first otherwise.
 */
export function detectDateFormat(rows: Record<string, string>[], dateCol: string): string {
  let any = false, allYearFirst = true, firstOver12 = false, secondOver12 = false, dots = false;
  for (const row of rows) {
    const m = DATE_PARTS.exec((row[dateCol] || '').trim());
    if (!m) continue;
    any = true;
    if (m[1].length === 4) continue;
    allYearFirst = false;
    if (parseInt(m[1], 10) > 12) firstOver12 = true;
    if (parseInt(m[3], 10) > 12) secondOver12 = true;
    if (m[2] === '.') dots = true;
  }
  if (!any || allYearFirst) return 'iso';
  if (firstOver12) return 'eu';
  if (secondOver12) return 'us';
  return dots ? 'eu' : 'us';
}

// Generate folder name from region name
export function getFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Check if coordinates fall within US bounding boxes
export function isInUS(lat: number, lng: number): boolean {
  if (lat >= 24.4 && lat <= 49.4 && lng >= -125.0 && lng <= -66.9) return true;
  if (lat >= 51.0 && lat <= 71.5 && lng >= -180.0 && lng <= -129.0) return true;
  if (lat >= 18.9 && lat <= 22.3 && lng >= -160.3 && lng <= -154.8) return true;
  if (lat >= 17.6 && lat <= 18.6 && lng >= -67.3 && lng <= -64.5) return true;
  if (lat >= 13.2 && lat <= 13.7 && lng >= 144.6 && lng <= 145.0) return true;
  return false;
}

// Auto-map columns based on common names
export function autoMapColumns(columns: string[], fileType: string): ColumnMapping {
  const mapping: ColumnMapping = {};
  const lowerColumns = columns.map(c => c.toLowerCase());

  if (fileType === 'aquifer') {
    const idIdx = lowerColumns.findIndex(c =>
      c.includes('aquifer') && c.includes('id') || c === 'aquifer_id' || c === 'id'
    );
    const nameIdx = lowerColumns.findIndex(c =>
      (c.includes('aquifer') && c.includes('name')) || c === 'aquifer_name' || c === 'name' || c === 'full_name'
    );
    if (idIdx >= 0) mapping['aquifer_id'] = columns[idIdx];
    if (nameIdx >= 0) mapping['aquifer_name'] = columns[nameIdx];
  } else if (fileType === 'wells') {
    const wellIdIdx = lowerColumns.findIndex(c => c.includes('well') && c.includes('id') || c === 'well_id');
    const wellNameIdx = lowerColumns.findIndex(c => (c.includes('well') && c.includes('name')) || c === 'well_name' || c === 'name');
    const latIdx = lowerColumns.findIndex(c => c === 'lat' || c.includes('latitude') || c === 'lat_dec' || c === 'northing' || c === 'y');
    const longIdx = lowerColumns.findIndex(c => c === 'long' || c === 'lng' || c.includes('longitude') || c === 'long_dec' || c === 'easting' || c === 'x');
    const gseIdx = lowerColumns.findIndex(c => c === 'gse' || c === 'ground_surface_elevation' || c === 'elevation' || c === 'surface_elevation');
    const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');
    const depthIdx = columns.findIndex(isWellDepthColumn);

    if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
    if (wellNameIdx >= 0) mapping['well_name'] = columns[wellNameIdx];
    if (latIdx >= 0) mapping['lat'] = columns[latIdx];
    if (longIdx >= 0) mapping['long'] = columns[longIdx];
    if (gseIdx >= 0) mapping['gse'] = columns[gseIdx];
    if (depthIdx >= 0) mapping['well_depth'] = columns[depthIdx];
    if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
  } else if (fileType === 'measurements') {
    // Only auto-map structural columns. Data columns (including WTE's
    // "value" column) are handled by the detection panel.
    const wellIdIdx = lowerColumns.findIndex(c => c.includes('well') && c.includes('id') || c === 'well_id');
    const wellNameIdx = lowerColumns.findIndex(c => (c.includes('well') && c.includes('name')) || c === 'well_name' || c === 'name' || c === 'station' || c === 'station_name');
    // Exact match first, then word-boundary match — a bare .includes('date')
    // auto-mapped columns like "updated" or "validated" as the date column
    let dateIdx = lowerColumns.findIndex(c => c === 'date');
    if (dateIdx < 0) dateIdx = lowerColumns.findIndex(c => /(^|[^a-z])date([^a-z]|$)/.test(c));
    const latIdx = lowerColumns.findIndex(c => c === 'lat' || c.includes('latitude') || c === 'lat_dec' || c === 'northing' || c === 'y');
    const longIdx = lowerColumns.findIndex(c => c === 'long' || c === 'lng' || c.includes('longitude') || c === 'long_dec' || c === 'lon' || c === 'easting' || c === 'x');
    const aqIdIdx = lowerColumns.findIndex(c => c.includes('aquifer') && c.includes('id') || c === 'aquifer_id');
    const depthIdx = columns.findIndex(isWellDepthColumn);

    if (wellIdIdx >= 0) mapping['well_id'] = columns[wellIdIdx];
    if (wellNameIdx >= 0) mapping['well_name'] = columns[wellNameIdx];
    if (dateIdx >= 0) mapping['date'] = columns[dateIdx];
    if (latIdx >= 0) mapping['lat'] = columns[latIdx];
    if (longIdx >= 0) mapping['long'] = columns[longIdx];
    if (depthIdx >= 0) mapping['well_depth'] = columns[depthIdx];
    if (aqIdIdx >= 0) mapping['aquifer_id'] = columns[aqIdIdx];
  }

  return mapping;
}

// Process uploaded file (GeoJSON, shapefile zip, or CSV)
// Returns { UploadedFile } with automatic CRS reprojection for spatial files
export async function processUploadedFile(
  file: File,
  fileType: string
): Promise<UploadedFile & { reprojected?: boolean; fromCrs?: string }> {
  const isZip = file.name.endsWith('.zip');
  const isGeoJSON = file.name.endsWith('.geojson') || file.name.endsWith('.json');
  const isCSV = file.name.endsWith('.csv') || file.name.endsWith('.txt');

  if (isZip) {
    const buffer = await file.arrayBuffer();
    let geojson = await shp(buffer);

    // Try to extract .prj file for reprojection
    let reprojected = false;
    let fromCrs = 'WGS84';
    try {
      const zip = await JSZip.loadAsync(buffer);
      let prjPath = '';
      zip.forEach((path, entry) => {
        // Use the first .prj found — without the guard, a zip containing
        // multiple shapefiles would silently reproject with the last one
        if (!prjPath && path.endsWith('.prj') && !entry.dir) {
          prjPath = path;
        }
      });
      if (prjPath) {
        const prjFile = zip.file(prjPath);
        if (prjFile) {
          const wkt = await prjFile.async('text');
          const result = reprojectFromWKT(geojson, wkt);
          geojson = result.geojson;
          reprojected = result.reprojected;
          fromCrs = result.fromCrs;
        }
      }
    } catch {
      // Reprojection not critical, continue with original
    }
    // Without a usable .prj the coordinates are taken as longitude and latitude;
    // stop here when they can't be
    if (!reprojected) assertLonLat(geojson);

    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];
    return {
      name: file.name,
      data: geojson,
      columns,
      mapping: autoMapColumns(columns, fileType),
      type: 'geojson',
      reprojected,
      fromCrs,
    };
  } else if (isGeoJSON) {
    const text = await file.text();
    let geojson = JSON.parse(text);

    // Check for CRS property and reproject if needed
    const { geojson: reprojGj, reprojected, fromCrs } = await reprojectGeoJSON(geojson);
    geojson = reprojGj;
    if (!reprojected) assertLonLat(geojson);

    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const columns = features.length > 0 ? Object.keys(features[0].properties || {}) : [];
    return {
      name: file.name,
      data: geojson,
      columns,
      mapping: autoMapColumns(columns, fileType),
      type: 'geojson',
      reprojected,
      fromCrs,
    };
  } else if (isCSV) {
    const text = await file.text();
    const { headers, rows } = parseCSV(text);
    return {
      name: file.name,
      data: rows,
      columns: headers,
      mapping: autoMapColumns(headers, fileType),
      type: 'csv'
    };
  }

  throw new Error(`Unsupported file type: ${file.name}`);
}

// Saving and deleting go through the data store; re-exported here because
// the importers have always imported them from this module.
export { saveFiles, deleteFile } from './dataStore';
export type { SaveEntry as SaveFileEntry } from './dataStore';

// Point-in-polygon using ray casting
export function pointInPolygon(point: [number, number], polygon: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Assign a well to an aquifer by testing point-in-polygon against all aquifer features
export function assignWellToAquifer(
  lat: number,
  lng: number,
  aquifersGeojson: any
): string | null {
  return aquifersContaining(lat, lng, aquifersGeojson, true)[0] ?? null;
}

/**
 * The IDs of the aquifers whose outlines hold the point, in file order. Two
 * aquifers can share an outline (deep and shallow wells kept apart), and a
 * well inside both can't be placed by its location. With `firstOnly`, stops
 * at the first.
 */
export function aquifersContaining(
  lat: number,
  lng: number,
  aquifersGeojson: any,
  firstOnly = false,
): string[] {
  const features = aquifersGeojson?.type === 'FeatureCollection'
    ? aquifersGeojson.features
    : [aquifersGeojson];
  const ids: string[] = [];

  for (const feature of features) {
    if (!feature?.geometry) continue;
    const geom = feature.geometry;
    const aquiferId = String(feature.properties?.aquifer_id || '');

    // Each polygon is [outerRing, ...holes] — a point inside a hole is
    // NOT inside the polygon (testing only ring [0] mis-assigned wells
    // sitting in donut holes)
    const polygons: number[][][][] = [];
    if (geom.type === 'Polygon') {
      polygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        polygons.push(poly);
      }
    }

    for (const rings of polygons) {
      if (rings.length === 0) continue;
      if (!pointInPolygon([lng, lat], rings[0])) continue;
      const inHole = rings.slice(1).some(hole => pointInPolygon([lng, lat], hole));
      if (!inHole) {
        ids.push(aquiferId);
        if (firstOnly) return ids;
        break;
      }
    }
  }
  return ids;
}

/** Download rows as a CSV file. */
export function downloadCsv(filename: string, headers: string[], rows: Record<string, string>[]): void {
  const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
