import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, CheckCircle2, Loader2, AlertTriangle, Download, Upload, RefreshCw } from 'lucide-react';
import { processUploadedFile, UploadedFile, saveFiles, deleteFile, isInUS, assignWellToAquifer, aquifersContaining, parseCSV, toCsv, downloadCsv, WELLS_CSV_HEADERS } from '../../services/importUtils';
import { fetchUSGSWells, fetchUSGSLevelRecords, getUSGSApiKey, setUSGSApiKey } from '../../services/usgsApi';
import {
  PlacedWell, KeepRule, WellRecordFacts, findSharedLocations, sharedLocationRows, SHARED_LOCATION_HEADERS,
  chooseWells, keepReportRows, KEEP_REPORT_HEADERS, leftOutIds,
} from '../../services/sharedLocations';
import { COLOCATED_METERS } from '../../utils/geo';
import { fetchGseBatch, GSE_SOURCE_US, GSE_SOURCE_GLOBAL } from '../../services/gseLookup';
import { compareNames } from '../../utils/strings';
import { SampleCoord } from '../../services/reprojection';
import { useCrsPicker } from '../../hooks/useCrsPicker';
import CrsPickerPanel from './CrsPickerPanel';
import ColumnMapperModal from './ColumnMapperModal';
import ConfirmDialog from './ConfirmDialog';
import { listRegions, readJson, readText } from '../../services/dataStore';

interface WellImporterProps {
  regionId: string;
  regionName: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  regionBounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
  aquiferCount: number;
  existingWellCount: number;
  onComplete: () => void;
  onClose: () => void;
}

type ImportMode = 'append' | 'replace';
type DataSource = 'upload' | 'usgs';
type AquiferAssignment = 'single' | 'csv-field' | 'by-location';

const WellImporter: React.FC<WellImporterProps> = ({
  regionId, regionName, lengthUnit, singleUnit, regionBounds, aquiferCount, existingWellCount, onComplete, onClose
}) => {
  const [dataSource, setDataSource] = useState<DataSource>('upload');
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [showMapper, setShowMapper] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>(existingWellCount > 0 ? 'append' : 'replace');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);

  // Aquifer assignment
  const [aquiferAssignment, setAquiferAssignment] = useState<AquiferAssignment>(
    singleUnit ? 'single' : 'csv-field'
  );
  const [selectedAquiferId, setSelectedAquiferId] = useState('');
  const [aquiferList, setAquiferList] = useState<{ id: string; name: string }[]>([]);
  const [aquifersGeojson, setAquifersGeojson] = useState<any>(null);

  // Ground surface elevation lookup, for a file without a GSE column. It
  // runs by itself once the well ID and coordinates are mapped, and Save
  // doesn't wait for it: wells without a value are saved with a blank one.
  const gseRunRef = useRef(0);
  const [gseError, setGseError] = useState('');
  const [gseValues, setGseValues] = useState<Map<string, number>>(new Map());
  const [gseInterpolated, setGseInterpolated] = useState(false);
  const [gseProgress, setGseProgress] = useState({ current: 0, total: 0 });
  const [gseSource, setGseSource] = useState('');
  const [gseFallback, setGseFallback] = useState(0);
  const [gseIsRunning, setGseIsRunning] = useState(false);

  // USGS download
  const [usgsWells, setUsgsWells] = useState<any[] | null>(null);
  // Where wells share a location: each downloaded well's depth (ft), the
  // bounding box to ask USGS for their record dates, and the rule
  const [usgsDepths, setUsgsDepths] = useState<Map<string, number>>(new Map());
  const [usgsBbox, setUsgsBbox] = useState<[number, number, number, number] | null>(null);
  const [usgsRecords, setUsgsRecords] = useState<Map<string, { begin: string; end: string }> | null>(null);
  const [usgsRecordsState, setUsgsRecordsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [keepRule, setKeepRule] = useState<KeepRule>('shallowest');
  const [usgsProgress, setUsgsProgress] = useState({ count: 0, done: false });
  const [usgsIsLoading, setUsgsIsLoading] = useState(false);

  // USGS scope
  const [usgsScope, setUsgsScope] = useState<'region' | 'aquifer'>('region');
  const [usgsScopeAquiferId, setUsgsScopeAquiferId] = useState('');
  const [apiKey, setApiKey] = useState(getUSGSApiKey());

  // Per-aquifer well counts for scope-aware import mode
  const [wellCountsByAquifer, setWellCountsByAquifer] = useState<Record<string, number>>({});
  // The region's wells, to check new wells against
  const [existingRows, setExistingRows] = useState<Record<string, string>[]>([]);

  // USGS well refresh
  const [existingUsgsIds, setExistingUsgsIds] = useState<Set<string>>(new Set());
  const [hasExistingUsgsWells, setHasExistingUsgsWells] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState<{ newCount: number; existingCount: number } | null>(null);
  const [usgsRefreshLoading, setUsgsRefreshLoading] = useState(false);

  // Check if region overlaps US for USGS option
  const regionOverlapsUS = isInUS(
    (regionBounds[0] + regionBounds[2]) / 2,
    (regionBounds[1] + regionBounds[3]) / 2
  );

  // Sample coordinates for CRS picker preview / auto-detect. Pull up to 5
  // parseable (x, y) pairs from the mapped lat/long columns.
  const crsSamples = useMemo<SampleCoord[]>(() => {
    if (!file) return [];
    const latCol = file.mapping['lat'];
    const longCol = file.mapping['long'];
    if (!latCol || !longCol) return [];
    const out: SampleCoord[] = [];
    for (const r of file.data as Record<string, string>[]) {
      const x = parseFloat(r[longCol]);
      const y = parseFloat(r[latCol]);
      if (!isNaN(x) && !isNaN(y)) out.push({ x, y });
      if (out.length >= 5) break;
    }
    return out;
  }, [file?.mapping, file?.data]);

  const crs = useCrsPicker({ regionBounds, samples: crsSamples });
  const { parseRowCoords } = crs;

  // Load existing USGS well IDs for refresh feature
  useEffect(() => {
    (async () => {
      try {
        const text = await readText(`${regionId}/wells.csv`);
        if (text !== null) {
          const { rows } = parseCSV(text);
          setExistingRows(rows);
          const usgsIds = new Set<string>();
          for (const r of rows) {
            const id = r.well_id;
            if (!id) continue;
            if (id.startsWith('USGS-')) {
              usgsIds.add(id);
            } else if (/^\d{8,15}$/.test(id)) {
              // Bare numeric USGS site IDs — store with prefix so refresh dedup works
              usgsIds.add(`USGS-${id}`);
            }
          }
          setExistingUsgsIds(usgsIds);
          setHasExistingUsgsWells(usgsIds.size > 0);
          // Build per-aquifer well counts
          const counts: Record<string, number> = {};
          for (const r of rows) {
            if (r.aquifer_id) counts[r.aquifer_id] = (counts[r.aquifer_id] || 0) + 1;
          }
          setWellCountsByAquifer(counts);
        }
      } catch {}
    })();
  }, [regionId]);

  // Load the aquifer outlines: for assignment, and to keep a USGS download to
  // wells inside them (a single-unit region's one aquifer is its outline)
  useEffect(() => {
    (async () => {
      try {
        const gj = await readJson(`${regionId}/aquifers.geojson`);
        if (gj) {
          setAquifersGeojson(gj);
          if (singleUnit) return;
          const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
          const list = features.map((f: any) => ({
            id: String(f.properties?.aquifer_id || ''),
            name: f.properties?.aquifer_name || ''
          }));
          list.sort((a: { id: string; name: string }, b: { id: string; name: string }) =>
            compareNames(a.name || a.id, b.name || b.id));
          setAquiferList(list);
          if (list.length === 1) {
            setAquiferAssignment('single');
            setSelectedAquiferId(list[0].id);
          }
        }
      } catch {}
    })();
  }, [regionId, singleUnit]);

  // Effective well count based on scope (for import mode visibility)
  const effectiveExistingCount = dataSource === 'usgs' && usgsScope === 'aquifer' && usgsScopeAquiferId
    ? (wellCountsByAquifer[usgsScopeAquiferId] || 0)
    : existingWellCount;

  const fieldDefs = [
    { key: 'well_id', label: 'Well ID', required: true },
    { key: 'well_name', label: 'Well Name', required: false },
    { key: 'lat', label: 'Latitude', required: true },
    { key: 'long', label: 'Longitude', required: true },
    { key: 'gse', label: 'Ground surface elevation (GSE)', required: false },
    ...(!singleUnit && aquiferAssignment === 'csv-field'
      ? [{ key: 'aquifer_id', label: 'Aquifer ID', required: false }] : []),
  ];

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const uploaded = await processUploadedFile(f, 'wells');
      setFile(uploaded);
      setShowMapper(true);
      setGseValues(new Map());
      setGseInterpolated(false);
      setUsgsWells(null);
    } catch (err) {
      setError(`Failed to process: ${err}`);
    }
  };

  const updateMapping = (key: string, value: string) => {
    if (!file) return;
    setFile({ ...file, mapping: { ...file.mapping, [key]: value } });
  };

  // Compute bounding box from aquifer geojson features
  const computeGeojsonBounds = (geojson: any, aquiferId?: string): [number, number, number, number] | null => {
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const targets = aquiferId
      ? features.filter((f: any) => String(f.properties?.aquifer_id) === aquiferId)
      : features;
    if (targets.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    const walk = (coords: any) => {
      if (typeof coords[0] === 'number') {
        minLng = Math.min(minLng, coords[0]); maxLng = Math.max(maxLng, coords[0]);
        minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
      } else {
        for (const c of coords) walk(c);
      }
    };
    for (const f of targets) walk(f.geometry.coordinates);
    return [minLat, minLng, maxLat, maxLng];
  };

  const noteUsgsDownload = (wells: { siteId: string; depthFt?: number }[], bbox: [number, number, number, number]) => {
    const depths = new Map<string, number>();
    for (const w of wells) if (w.depthFt != null) depths.set(w.siteId, w.depthFt);
    setUsgsDepths(depths);
    setUsgsBbox(bbox);
    setUsgsRecords(null);
    setUsgsRecordsState('idle');
  };

  // USGS well download
  const handleUSGSDownload = async () => {
    setUsgsIsLoading(true);
    setError('');
    setUsgsProgress({ count: 0, done: false });
    try {
      // Compute bbox based on scope
      let bounds: [number, number, number, number] | null = null;
      if (aquifersGeojson) {
        bounds = usgsScope === 'aquifer'
          ? computeGeojsonBounds(aquifersGeojson, usgsScopeAquiferId)
          : computeGeojsonBounds(aquifersGeojson);
      }
      if (!bounds) bounds = regionBounds;

      // Convert bounds to USGS bbox format: [minLng, minLat, maxLng, maxLat]
      const bbox: [number, number, number, number] = [
        bounds[1], bounds[0], bounds[3], bounds[2]
      ];
      const wells = await fetchUSGSWells(bbox, (count) => {
        setUsgsProgress({ count, done: false });
      });

      // Filter to aquifer boundaries and capture aquifer_id via point-in-polygon
      let wellsWithAquifer: { well: typeof wells[0]; aquiferId: string }[];
      if (aquifersGeojson) {
        wellsWithAquifer = [];
        if (usgsScope === 'aquifer') {
          // Only match to the selected aquifer
          const features = aquifersGeojson.type === 'FeatureCollection' ? aquifersGeojson.features : [aquifersGeojson];
          const targetFeature = features.find((f: any) => String(f.properties?.aquifer_id) === usgsScopeAquiferId);
          if (targetFeature) {
            const scopedGj = { type: 'FeatureCollection', features: [targetFeature] };
            for (const w of wells) {
              const aqId = assignWellToAquifer(w.lat, w.lng, scopedGj);
              if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
            }
          }
        } else {
          for (const w of wells) {
            const aqId = assignWellToAquifer(w.lat, w.lng, aquifersGeojson);
            if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
          }
        }
      } else {
        wellsWithAquifer = wells.map(w => ({ well: w, aquiferId: singleUnit ? '0' : '' }));
      }

      setUsgsWells(wellsWithAquifer.map(x => x.well));
      setUsgsProgress({ count: wellsWithAquifer.length, done: true });
      noteUsgsDownload(wellsWithAquifer.map(x => x.well), bbox);

      // Convert to UploadedFile format for the save flow
      const rows = wellsWithAquifer.map(({ well: w, aquiferId }) => ({
        well_id: w.siteId,
        well_name: w.siteName,
        lat: String(w.lat),
        long: String(w.lng),
        gse: w.gse ? String(lengthUnit === 'ft' ? Math.round(w.gse * 3.28084 * 100) / 100 : Math.round(w.gse * 100) / 100) : '',
        aquifer_id: aquiferId,
      }));
      const columns = ['well_id', 'well_name', 'lat', 'long', 'gse', 'aquifer_id'];
      setFile({
        name: 'USGS Wells',
        data: rows,
        columns,
        mapping: { well_id: 'well_id', well_name: 'well_name', lat: 'lat', long: 'long', gse: 'gse', aquifer_id: 'aquifer_id' },
        type: 'csv'
      });
    } catch (err) {
      setError(`USGS download failed: ${err}`);
    }
    setUsgsIsLoading(false);
  };

  // USGS well refresh — diff against existing wells, show only new ones
  const handleUSGSRefresh = async () => {
    setUsgsRefreshLoading(true);
    setError('');
    setRefreshSummary(null);
    try {
      // Compute bbox based on scope
      let bounds: [number, number, number, number] | null = null;
      if (aquifersGeojson) {
        bounds = usgsScope === 'aquifer'
          ? computeGeojsonBounds(aquifersGeojson, usgsScopeAquiferId)
          : computeGeojsonBounds(aquifersGeojson);
      }
      if (!bounds) bounds = regionBounds;

      const bbox: [number, number, number, number] = [
        bounds[1], bounds[0], bounds[3], bounds[2]
      ];
      const wells = await fetchUSGSWells(bbox, (count) => {
        setUsgsProgress({ count, done: false });
      });

      // Filter to aquifer boundaries and capture aquifer_id
      let wellsWithAquifer: { well: typeof wells[0]; aquiferId: string }[];
      if (aquifersGeojson) {
        wellsWithAquifer = [];
        if (usgsScope === 'aquifer') {
          const features = aquifersGeojson.type === 'FeatureCollection' ? aquifersGeojson.features : [aquifersGeojson];
          const targetFeature = features.find((f: any) => String(f.properties?.aquifer_id) === usgsScopeAquiferId);
          if (targetFeature) {
            const scopedGj = { type: 'FeatureCollection', features: [targetFeature] };
            for (const w of wells) {
              const aqId = assignWellToAquifer(w.lat, w.lng, scopedGj);
              if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
            }
          }
        } else {
          for (const w of wells) {
            const aqId = assignWellToAquifer(w.lat, w.lng, aquifersGeojson);
            if (aqId !== null) wellsWithAquifer.push({ well: w, aquiferId: aqId });
          }
        }
      } else {
        wellsWithAquifer = wells.map(w => ({ well: w, aquiferId: singleUnit ? '0' : '' }));
      }

      // Diff against existing USGS wells
      const newWells = wellsWithAquifer.filter(x => !existingUsgsIds.has(x.well.siteId));
      const existingCount = wellsWithAquifer.length - newWells.length;

      setRefreshSummary({ newCount: newWells.length, existingCount });
      setUsgsProgress({ count: wellsWithAquifer.length, done: true });
      noteUsgsDownload(newWells.map(x => x.well), bbox);

      if (newWells.length > 0) {
        // Populate file with only new wells, force append
        const rows = newWells.map(({ well: w, aquiferId }) => ({
          well_id: w.siteId,
          well_name: w.siteName,
          lat: String(w.lat),
          long: String(w.lng),
          gse: w.gse ? String(lengthUnit === 'ft' ? Math.round(w.gse * 3.28084 * 100) / 100 : Math.round(w.gse * 100) / 100) : '',
          aquifer_id: aquiferId,
        }));
        const columns = ['well_id', 'well_name', 'lat', 'long', 'gse', 'aquifer_id'];
        setFile({
          name: 'USGS Wells (New)',
          data: rows,
          columns,
          mapping: { well_id: 'well_id', well_name: 'well_name', lat: 'lat', long: 'long', gse: 'gse', aquifer_id: 'aquifer_id' },
          type: 'csv'
        });
        setImportMode('append');
      } else {
        setFile(null);
      }
    } catch (err) {
      setError(`USGS refresh failed: ${err}`);
    }
    setUsgsRefreshLoading(false);
  };

  const needsGseInterpolation = file !== null && !file.mapping['gse'] && dataSource === 'upload';

  const interpolateGSE = async () => {
    if (!file) return;
    const run = ++gseRunRef.current;
    setGseIsRunning(true);
    setGseInterpolated(false);
    setGseError('');
    setGseValues(new Map());

    const wellIdCol = file.mapping['well_id'];
    const latCol = file.mapping['lat'];
    const longCol = file.mapping['long'];
    // Reproject via the selected CRS so elevation queries land at real
    // lat/lng, not raw easting/northing values.
    const wells = (file.data as Record<string, string>[])
      .map(w => {
        const { lat, lng } = parseRowCoords(w[latCol], w[longCol]);
        return { id: w[wellIdCol], lat, lng };
      })
      .filter((w): w is { id: string; lat: number; lng: number } =>
        !!w.id && w.lat !== undefined && w.lng !== undefined
      );

    setGseProgress({ current: 0, total: wells.length });
    const allInUS = wells.every(w => isInUS(w.lat, w.lng));
    setGseSource(allInUS ? GSE_SOURCE_US : GSE_SOURCE_GLOBAL);

    try {
      const { values, source, fallbackCount } = await fetchGseBatch(wells, {
        lengthUnit,
        onProgress: (current, total) => { if (run === gseRunRef.current) setGseProgress({ current, total }); },
      });
      if (run !== gseRunRef.current) return;
      setGseValues(values);
      setGseSource(source);
      setGseFallback(fallbackCount);
      setGseInterpolated(true);
    } catch (err) {
      if (run === gseRunRef.current) setGseError(String(err instanceof Error ? err.message : err));
    } finally {
      if (run === gseRunRef.current) setGseIsRunning(false);
    }
  };

  // Look up again whenever what the lookup depends on changes; a run whose
  // inputs are stale is ignored when it returns
  const gseKey = needsGseInterpolation && file && file.mapping['well_id'] && file.mapping['lat'] && file.mapping['long'] &&
    crs.crsPreview?.ok !== false
    ? [file.name, file.mapping['well_id'], file.mapping['lat'], file.mapping['long'], crs.coordinateCrs].join('|')
    : '';
  useEffect(() => {
    if (!gseKey) {
      gseRunRef.current++;
      setGseIsRunning(false);
      return;
    }
    const t = setTimeout(interpolateGSE, 400);
    return () => clearTimeout(t);
  }, [gseKey]);

  const resolveAquiferId = (row: Record<string, string>): string => {
    if (singleUnit) return '0';
    switch (aquiferAssignment) {
      case 'single':
        return selectedAquiferId;
      case 'csv-field': {
        const col = file?.mapping['aquifer_id'];
        return col ? row[col] || '' : '';
      }
      case 'by-location': {
        const latCol = file?.mapping['lat'] || '';
        const longCol = file?.mapping['long'] || '';
        const { lat, lng } = parseRowCoords(row[latCol], row[longCol]);
        if (lat !== undefined && lng !== undefined && aquifersGeojson) {
          return assignWellToAquifer(lat, lng, aquifersGeojson) || '';
        }
        return '';
      }
      default: return '';
    }
  };

  // In a region with aquifers, a well that ends up in none of them would be
  // saved but never shown, so it is skipped, and counted here first
  const aquiferIds = useMemo(() => new Set(aquiferList.map(a => a.id)), [aquiferList]);
  const keepsWell = (aquiferId: string) => singleUnit || aquiferIds.size === 0 || aquiferIds.has(aquiferId);
  const skippedOutside = useMemo(() => {
    if (!file || singleUnit || aquiferIds.size === 0) return 0;
    const idCol = file.mapping['well_id'], latCol = file.mapping['lat'], longCol = file.mapping['long'];
    if (!idCol || !latCol || !longCol) return 0;
    let n = 0;
    for (const r of file.data as Record<string, string>[]) {
      if (!r[idCol]) continue;
      const { lat, lng } = parseRowCoords(r[latCol], r[longCol]);
      if (lat === undefined || lng === undefined) continue;
      if (!keepsWell(resolveAquiferId(r))) n++;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, singleUnit, aquiferIds, aquiferAssignment, selectedAquiferId, parseRowCoords, aquifersGeojson]);

  // The wells already in the region that stay after this save
  const isAquiferScopedUsgs = dataSource === 'usgs' && usgsScope === 'aquifer' && !!usgsScopeAquiferId;
  const remainingRows = useMemo(() => {
    if (isAquiferScopedUsgs) {
      return importMode === 'replace' ? existingRows.filter(r => r.aquifer_id !== usgsScopeAquiferId) : existingRows;
    }
    return importMode === 'append' && existingWellCount > 0 ? existingRows : [];
  }, [isAquiferScopedUsgs, importMode, existingRows, usgsScopeAquiferId, existingWellCount]);

  // Wells of one aquifer within COLOCATED_METERS of each other, among the
  // new wells and the ones that stay; and, placed by location, wells inside
  // more than one aquifer's outline
  const placement = useMemo(() => {
    const empty = { shared: [] as ReturnType<typeof findSharedLocations>, ambiguous: [] as PlacedWell[] };
    if (!file) return empty;
    const idCol = file.mapping['well_id'], nameCol = file.mapping['well_name'];
    const latCol = file.mapping['lat'], longCol = file.mapping['long'];
    if (!idCol || !latCol || !longCol) return empty;
    if (dataSource === 'upload' && crs.crsPreview?.ok === false) return empty;
    const staying = new Set(remainingRows.map(r => r.well_id));
    const seen = new Set<string>();
    const fresh: PlacedWell[] = [];
    const ambiguous: PlacedWell[] = [];
    (file.data as Record<string, string>[]).forEach((r, i) => {
      const id = (r[idCol] || '').trim();
      if (!id || seen.has(id) || staying.has(id)) return;
      const { lat, lng } = parseRowCoords(r[latCol], r[longCol]);
      if (lat === undefined || lng === undefined) return;
      const aquiferId = resolveAquiferId(r);
      if (!keepsWell(aquiferId)) return;
      seen.add(id);
      const w: PlacedWell = { id, name: nameCol ? r[nameCol] || '' : '', lat, lng, aquiferId, row: dataSource === 'upload' ? i + 2 : undefined };
      if (dataSource === 'upload' && !singleUnit && aquiferAssignment === 'by-location' && aquifersGeojson &&
        aquifersContaining(lat, lng, aquifersGeojson).length > 1) {
        ambiguous.push(w);
        return;
      }
      fresh.push(w);
    });
    const staying_: PlacedWell[] = remainingRows
      .map(r => ({ id: r.well_id, name: r.well_name || '', lat: parseFloat(r.lat), lng: parseFloat(r.long), aquiferId: singleUnit ? '0' : r.aquifer_id || '', existing: true }))
      .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng));
    return { shared: findSharedLocations([...fresh, ...staying_]), ambiguous };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, dataSource, remainingRows, singleUnit, aquiferAssignment, selectedAquiferId, aquifersGeojson, parseRowCoords, crs.crsPreview?.ok, aquiferIds]);

  const aquiferNameOf = (id: string) => singleUnit ? regionName : (aquiferList.find(a => a.id === id)?.name || '');
  const sharedWellCount = placement.shared.reduce((n, g) => n + g.wells.length, 0);
  const fileRefused = dataSource === 'upload' && (placement.shared.length > 0 || placement.ambiguous.length > 0);

  // A USGS download with shared locations: read the wells' record dates
  // (first and last water level), which decide where depth can't
  const needsRecords = dataSource === 'usgs' && placement.shared.length > 0;
  useEffect(() => {
    if (!needsRecords || !usgsBbox || usgsRecords || usgsRecordsState !== 'idle') return;
    let live = true;
    setUsgsRecordsState('loading');
    fetchUSGSLevelRecords(usgsBbox)
      .then(r => { if (live) { setUsgsRecords(r); setUsgsRecordsState('idle'); } })
      .catch(() => { if (live) setUsgsRecordsState('error'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRecords, usgsBbox]);

  const usgsFacts = useMemo(() => {
    const facts = new Map<string, WellRecordFacts>();
    for (const g of placement.shared) {
      for (const w of g.wells) {
        const rec = usgsRecords?.get(w.id);
        facts.set(w.id, { depthFt: usgsDepths.get(w.id), begin: rec?.begin, end: rec?.end });
      }
    }
    return facts;
  }, [placement.shared, usgsDepths, usgsRecords]);
  const usgsChoices = useMemo(
    () => needsRecords ? chooseWells(placement.shared, keepRule, usgsFacts, 'span') : [],
    [needsRecords, placement.shared, keepRule, usgsFacts]);
  const usgsLeftOut = useMemo(() => leftOutIds(usgsChoices), [usgsChoices]);

  const downloadSharedList = () => {
    const rows: Record<string, string>[] = sharedLocationRows(placement.shared, aquiferNameOf).map(r => ({ problem: 'more than one well at this location', ...r }));
    for (const w of placement.ambiguous) {
      rows.push({
        problem: 'inside more than one aquifer outline', location: '',
        aquifer_id: aquifersContaining(w.lat, w.lng, aquifersGeojson).join('; '), aquifer_name: '',
        well_id: w.id, well_name: w.name, latitude: String(w.lat), longitude: String(w.lng),
        meters_from_first: '', row: w.row != null ? String(w.row) : '', already_in_region: '',
      });
    }
    downloadCsv(`wells-to-fix-${regionId}.csv`, ['problem', ...SHARED_LOCATION_HEADERS], rows);
  };

  const doSave = async () => {
    if (!file) return;
    setIsSaving(true);
    setError('');
    try {
      const rows = file.data as Record<string, string>[];
      const wellIdCol = file.mapping['well_id'];
      const wellNameCol = file.mapping['well_name'];
      const latCol = file.mapping['lat'];
      const longCol = file.mapping['long'];
      const gseCol = file.mapping['gse'];

      // Reproject lat/long through the selected CRS so the CSV always
      // stores WGS84 values, even when the user's source data was in a
      // projected coordinate system (e.g. JAD2001 Jamaica Metric Grid).
      const aquiferNameById = new Map<string, string>(aquiferList.map(a => [a.id, String(a.name || '')]));
      const processedWells = rows.map(w => {
        const { lat, lng } = parseRowCoords(w[latCol], w[longCol]);
        const aquiferId = resolveAquiferId(w);
        return {
          well_id: w[wellIdCol] || '',
          well_name: wellNameCol ? w[wellNameCol] || '' : '',
          lat: lat !== undefined ? String(lat) : '',
          long: lng !== undefined ? String(lng) : '',
          gse: gseCol ? w[gseCol] || '' : (gseValues.get(w[wellIdCol])?.toString() ?? ''),
          aquifer_id: aquiferId,
          aquifer_name: aquiferNameById.get(aquiferId) || '',
        };
      }).filter(w => w.well_id && w.lat && w.long && keepsWell(w.aquifer_id) &&
        !(dataSource === 'usgs' && usgsLeftOut.has(w.well_id)));

      const isAquiferScoped = dataSource === 'usgs' && usgsScope === 'aquifer' && usgsScopeAquiferId;

      if (isAquiferScoped) {
        // Aquifer-scoped: always merge with other aquifers' wells
        let existingRows: Record<string, string>[] = [];
        try {
          const text = await readText(`${regionId}/wells.csv`);
          if (text !== null) existingRows = parseCSV(text).rows;
        } catch {}

        let keptExisting: Record<string, string>[];
        if (importMode === 'replace') {
          // Remove wells from selected aquifer, keep everything else
          keptExisting = existingRows.filter(r => r.aquifer_id !== usgsScopeAquiferId);
        } else {
          // Append: keep all existing, skip duplicates
          keptExisting = existingRows;
        }

        const existingIds = new Set(keptExisting.map(r => r.well_id));
        const toAdd = processedWells.filter(w => !existingIds.has(w.well_id));

        const csv = toCsv(WELLS_CSV_HEADERS, [...keptExisting, ...toAdd]);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      } else if (importMode === 'append' && existingWellCount > 0) {
        // Load existing wells, skip duplicates
        let existingRows: Record<string, string>[] = [];
        try {
          const text = await readText(`${regionId}/wells.csv`);
          if (text !== null) existingRows = parseCSV(text).rows;
        } catch {}

        const existingIds = new Set(existingRows.map(r => r.well_id));
        const toAdd = processedWells.filter(w => !existingIds.has(w.well_id));

        // Merge: keep existing + add new
        const csv = toCsv(WELLS_CSV_HEADERS, [...existingRows, ...toAdd]);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      } else {
        // Region-wide replace: delete measurements then write
        if (importMode === 'replace' && existingWellCount > 0) {
          try {
            const me = (await listRegions()).find(r => r.id === regionId);
            for (const f of me?.dataFiles ?? []) {
              try { await deleteFile(`${regionId}/${f}`); } catch {}
            }
          } catch {}
        }

        const csv = toCsv(WELLS_CSV_HEADERS, processedWells);
        await saveFiles([{ path: `${regionId}/wells.csv`, content: csv }]);
      }
      onComplete();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const handleSave = () => {
    if (importMode === 'replace' && effectiveExistingCount > 0) {
      setShowReplaceConfirm(true);
    } else {
      doSave();
    }
  };

  const isReady = file && file.mapping['well_id'] && file.mapping['lat'] && file.mapping['long'] &&
    (singleUnit || aquiferAssignment !== 'single' || selectedAquiferId) &&
    !fileRefused && !(needsRecords && usgsRecordsState === 'loading');

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Add Wells</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Data source selector */}
        {regionOverlapsUS && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Data Source</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setDataSource('upload'); setFile(null); setUsgsWells(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'upload' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Upload size={14} /> Upload CSV
              </button>
              <button
                onClick={() => { setDataSource('usgs'); setFile(null); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  dataSource === 'usgs' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Download size={14} /> USGS Download
              </button>
            </div>
          </div>
        )}

        {/* Import mode */}
        {effectiveExistingCount > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Import Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => setImportMode('append')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'append' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                Append
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  importMode === 'replace' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer' : 'Replace All'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {importMode === 'append'
                ? 'New wells will be added. Duplicates (by ID) are skipped.'
                : usgsScope === 'aquifer' && usgsScopeAquiferId
                  ? 'Existing wells in this aquifer will be replaced. Other aquifers are not affected.'
                  : 'All existing wells and measurements will be deleted first.'}
            </p>
            {importMode === 'replace' && !(usgsScope === 'aquifer' && usgsScopeAquiferId) && (
              <div className="flex items-start gap-2 mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700">This will also delete all measurement data for this region.</p>
              </div>
            )}
          </div>
        )}

        {/* Aquifer assignment (not for singleUnit) */}
        {!singleUnit && aquiferList.length > 0 && dataSource === 'upload' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Aquifer Assignment</label>
            <div className="space-y-2">
              {aquiferList.length === 1 ? (
                <div className="text-sm text-slate-600 p-2 bg-slate-50 rounded-lg">
                  All wells assigned to: <span className="font-medium">{aquiferList[0].name || aquiferList[0].id}</span>
                </div>
              ) : (
                <>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'csv-field'}
                      onChange={() => setAquiferAssignment('csv-field')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Use aquifer_id column from CSV</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'single'}
                      onChange={() => setAquiferAssignment('single')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Assign all to one aquifer</span>
                  </label>
                  {aquiferAssignment === 'single' && (
                    <select value={selectedAquiferId} onChange={e => setSelectedAquiferId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ml-6">
                      <option value="">-- Select Aquifer --</option>
                      {aquiferList.map(a => (
                        <option key={a.id} value={a.id}>{a.name || a.id}</option>
                      ))}
                    </select>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="aq-assign" checked={aquiferAssignment === 'by-location'}
                      onChange={() => setAquiferAssignment('by-location')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Assign by location (the aquifer each well falls inside)</span>
                  </label>
                </>
              )}
            </div>
          </div>
        )}

        {/* Upload flow */}
        {dataSource === 'upload' && (
          <>
            <p className="text-sm text-slate-500 mb-4">Upload a CSV file with well locations.</p>
            <label className="block mb-4">
              <input type="file" accept=".csv,.txt" onChange={handleUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </label>
          </>
        )}

        {/* USGS download flow */}
        {dataSource === 'usgs' && !file && (
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-3">
              Download groundwater monitoring wells from USGS within this region's bounding box.
            </p>
            {/* Scope selector — only when multiple aquifers */}
            {aquiferList.length > 1 && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-slate-700 mb-2">Download Scope</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-scope" checked={usgsScope === 'region'}
                      onChange={() => { setUsgsScope('region'); setUsgsScopeAquiferId(''); }}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">Entire Region</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="usgs-scope" checked={usgsScope === 'aquifer'}
                      onChange={() => setUsgsScope('aquifer')}
                      className="text-blue-600" />
                    <span className="text-sm text-slate-700">Selected Aquifer</span>
                  </label>
                  {usgsScope === 'aquifer' && (
                    <select value={usgsScopeAquiferId} onChange={e => setUsgsScopeAquiferId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ml-6">
                      <option value="">-- Select Aquifer --</option>
                      {aquiferList.map(a => (
                        <option key={a.id} value={a.id}>{a.name || a.id}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}
            {/* API key */}
            <div className="mb-3">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                API Key {!apiKey && <span className="text-amber-600 font-normal">(required for bulk downloads)</span>}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  onBlur={() => setUSGSApiKey(apiKey)}
                  placeholder="Paste your api.data.gov key"
                  className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </div>
              {!apiKey && (
                <p className="text-xs text-slate-400 mt-1">
                  Without a key: 30 req/hour. With a key: 1,000 req/hour.{' '}
                  <a href="https://api.waterdata.usgs.gov/signup/" target="_blank" rel="noopener noreferrer"
                    className="text-blue-600 underline hover:text-blue-700">Get a free key</a>
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleUSGSDownload}
                disabled={usgsIsLoading || usgsRefreshLoading || (usgsScope === 'aquifer' && !usgsScopeAquiferId)}
                className={`${hasExistingUsgsWells ? 'flex-1' : 'w-full'} px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2`}
              >
                {usgsIsLoading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Downloading... ({usgsProgress.count} found)
                  </>
                ) : (
                  <>
                    <Download size={14} /> Download All
                  </>
                )}
              </button>
              {hasExistingUsgsWells && (
                <button
                  onClick={handleUSGSRefresh}
                  disabled={usgsIsLoading || usgsRefreshLoading || (usgsScope === 'aquifer' && !usgsScopeAquiferId)}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {usgsRefreshLoading ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Checking... ({usgsProgress.count} found)
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} /> Refresh
                    </>
                  )}
                </button>
              )}
            </div>
            {refreshSummary && (
              <div className={`mt-3 p-3 rounded-lg text-sm ${refreshSummary.newCount > 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-slate-50 border border-slate-200 text-slate-700'}`}>
                {refreshSummary.newCount > 0
                  ? `Found ${refreshSummary.newCount} new well(s) (${refreshSummary.existingCount} already existed)`
                  : `Your wells are up to date (${refreshSummary.existingCount} wells checked)`}
              </div>
            )}
          </div>
        )}

        {/* File / USGS result display */}
        {file && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
              <CheckCircle2 size={16} />
              {dataSource === 'usgs'
                ? `${(file.data as any[]).length} USGS wells loaded`
                : `${file.name} (${(file.data as any[]).length} rows)`}
            </div>
            {dataSource === 'upload' && (
              <button onClick={() => setShowMapper(true)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                Edit Column Mapping
              </button>
            )}
          </div>
        )}

        {/* Coordinate reference system — upload flow with mapped lat/long */}
        {file && dataSource === 'upload' && file.mapping['lat'] && file.mapping['long'] && (
          <div className="mb-4 p-4 bg-sky-50 border border-sky-200 rounded-lg">
            <CrsPickerPanel crs={crs} />
          </div>
        )}

        {skippedOutside > 0 && (
          <div className="flex items-start gap-2 p-3 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              {skippedOutside} well{skippedOutside === 1 ? '' : 's'}{' '}
              {aquiferAssignment === 'by-location'
                ? `${skippedOutside === 1 ? 'falls' : 'fall'} outside every aquifer`
                : `${skippedOutside === 1 ? 'has' : 'have'} no aquifer ID this region has`}
              {' '}and will be skipped.
            </span>
          </div>
        )}

        {/* A file with wells at one location, or placed by location inside two outlines, is refused */}
        {fileRefused && (
          <div className="p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 space-y-2">
            {placement.shared.length > 0 && (
              <p className="flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  {placement.shared.length} location{placement.shared.length === 1 ? ' has' : 's have'} more than one well in the same
                  aquifer ({sharedWellCount} wells within {COLOCATED_METERS} m of each other). A map would average them into one
                  value that belongs to none of them, so each location in an aquifer can have only one well. Keep one well at
                  each location, or put wells at different depths in separate aquifers with an Aquifer ID column, and import
                  the file again.
                </span>
              </p>
            )}
            {placement.ambiguous.length > 0 && (
              <p className="flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  {placement.ambiguous.length} well{placement.ambiguous.length === 1 ? ' falls' : 's fall'} inside more than one
                  aquifer's outline, so {placement.ambiguous.length === 1 ? 'its aquifer' : 'their aquifers'} can't be told from
                  the location. Give the file an Aquifer ID column and use it.
                </span>
              </p>
            )}
            <button onClick={downloadSharedList} className="flex items-center gap-1.5 font-medium text-blue-700 hover:text-blue-900 hover:underline">
              <Download size={13} /> Download the list of wells (CSV)
            </button>
          </div>
        )}

        {/* A USGS download keeps one well at each shared location */}
        {needsRecords && (
          <div className="p-3 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
            <p className="mb-2">
              {placement.shared.length} location{placement.shared.length === 1 ? ' has' : 's have'} more than one well in the same
              aquifer ({sharedWellCount} wells within {COLOCATED_METERS} m of each other). A map would average them into one
              value, so one well is kept at each.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
              {([['shallowest', 'Shallowest well'], ['deepest', 'Deepest well'], ['record', 'Longest record']] as [KeepRule, string][]).map(([rule, label]) => (
                <label key={rule} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="keep-rule" checked={keepRule === rule} onChange={() => setKeepRule(rule)} className="text-blue-600" />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <p className="text-amber-800 mb-2">
              {keepRule === 'record'
                ? 'The record runs from the first water level reading to the last.'
                : 'Where the depths are missing or the same, the well with the longest record, from its first water level reading to its last, is kept.'}
              {placement.shared.some(g => g.wells.some(w => w.existing)) && ' Where a well is already in the region, it stays and the downloaded ones are left out.'}
            </p>
            {usgsRecordsState === 'loading' && (
              <p className="flex items-center gap-2 mb-2"><Loader2 size={12} className="animate-spin" /> Reading the wells' record dates from USGS...</p>
            )}
            {usgsRecordsState === 'error' && (
              <p className="flex items-center gap-2 mb-2 text-red-700">
                <AlertTriangle size={12} className="shrink-0" />
                USGS did not return the record dates, so where depth can't decide, the first well listed is kept.
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{usgsLeftOut.size} well{usgsLeftOut.size === 1 ? '' : 's'} will be left out.</span>
              <button
                onClick={() => downloadCsv(`wells-left-out-${regionId}.csv`, KEEP_REPORT_HEADERS, keepReportRows(usgsChoices, usgsFacts, aquiferNameOf, 'span'))}
                className="flex items-center gap-1.5 font-medium text-blue-700 hover:text-blue-900 hover:underline"
              >
                <Download size={13} /> Download the list (CSV)
              </button>
            </div>
          </div>
        )}

        {/* Ground surface elevation lookup */}
        {needsGseInterpolation && file && (() => {
          const missing = gseProgress.total - gseValues.size;
          return (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg mb-4 text-sm text-slate-600">
              <p className="font-medium text-slate-700 mb-1">Ground surface elevation (GSE)</p>
              {!gseKey && !gseIsRunning && (
                <p className="text-xs">
                  The file has no GSE column, so it will be looked up from an elevation model once the well ID and
                  coordinates are mapped{crs.crsPreview?.ok === false ? ' and the coordinates land inside the region' : ''}.
                </p>
              )}
              {gseIsRunning && (
                <p className="text-xs flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin shrink-0" />
                  Looking up from {gseSource}: {gseProgress.current} / {gseProgress.total}. You can save now; wells
                  not looked up yet are saved without an elevation.
                </p>
              )}
              {gseInterpolated && !gseIsRunning && (
                <>
                  <p className="text-xs flex items-center gap-2 text-green-700">
                    <CheckCircle2 size={14} className="shrink-0" /> Found for {gseValues.size} well{gseValues.size === 1 ? '' : 's'}, from {gseSource}.
                  </p>
                  {gseFallback > 0 && (
                    <p className="text-xs mt-1 text-slate-600">
                      The terrain tiles did not answer for {gseFallback} of them, which have the Copernicus DEM value via Open-Meteo (~90 m) instead.
                    </p>
                  )}
                  {missing > 0 && (
                    <p className="text-xs flex items-center gap-2 mt-1 text-amber-700">
                      <AlertTriangle size={14} className="shrink-0" />
                      {missing} well{missing === 1 ? '' : 's'} got no elevation and will be saved without one.
                    </p>
                  )}
                </>
              )}
              {gseError && !gseIsRunning && (
                <div className="text-xs text-amber-700">
                  <p className="flex items-center gap-2">
                    <AlertTriangle size={14} className="shrink-0" />
                    The lookup failed ({gseError}). Wells will be saved without an elevation.
                  </p>
                  <button onClick={interpolateGSE} className="mt-2 inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium">
                    <RefreshCw size={12} /> Try again
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={!isReady || isSaving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            {isSaving ? 'Saving...' : 'Save Wells'}
          </button>
        </div>
      </div>

      {showMapper && file && (
        <ColumnMapperModal
          file={file}
          fieldDefinitions={fieldDefs}
          onUpdateMapping={updateMapping}
          onClose={() => setShowMapper(false)}
          title="Map Well Columns"
        />
      )}

      {showReplaceConfirm && (
        <ConfirmDialog
          title={usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer Wells?' : 'Replace All Wells?'}
          message={usgsScope === 'aquifer' && usgsScopeAquiferId
            ? `This will replace ${effectiveExistingCount} well(s) in the selected aquifer. Wells in other aquifers are not affected.`
            : `This will delete all ${existingWellCount} existing well(s) and all measurement data. This cannot be undone.`}
          confirmLabel={usgsScope === 'aquifer' && usgsScopeAquiferId ? 'Replace Aquifer' : 'Replace All'}
          variant="danger"
          onConfirm={() => { setShowReplaceConfirm(false); doSave(); }}
          onCancel={() => setShowReplaceConfirm(false)}
        />
      )}
    </div>
  );
};

export default WellImporter;
