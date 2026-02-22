import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, Loader2, AlertTriangle, Download, Upload, Calendar } from 'lucide-react';
import { processUploadedFile, UploadedFile, saveFiles, parseDate, detectDateFormat, parseCSV, isInUS } from '../../services/importUtils';
import { fetchUSGSMeasurements, validateUSGSMeasurements, USGSDataQualityReport, USGSMeasurement, USGSDataSpan, computeDataSpan, filterByDateRange } from '../../services/usgsApi';
import ColumnMapperModal from './ColumnMapperModal';
import ConfirmDialog from './ConfirmDialog';
import { DataType } from '../../types';

interface MeasurementImporterProps {
  regionId: string;
  regionName: string;
  singleUnit: boolean;
  dataTypes: DataType[];
  regionBounds: [number, number, number, number];
  existingWellCount: number;
  onComplete: () => void;
  onClose: () => void;
}

type ImportMode = 'append' | 'replace';
type DataSource = 'upload' | 'usgs';
type USGSMode = 'fresh' | 'quick-refresh' | 'full-refresh';
type AquiferAssignment = 'from-wells' | 'single' | 'csv-field';

const MeasurementImporter: React.FC<MeasurementImporterProps> = ({
  regionId, regionName, singleUnit, dataTypes, regionBounds, existingWellCount, onComplete, onClose
}) => {
  const [dataSource, setDataSource] = useState<DataSource>('upload');
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [showMapper, setShowMapper] = useState(false);
  const [dateFormat, setDateFormat] = useState('iso');
  const [importMode, setImportMode] = useState<ImportMode>('append');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);

  // Multi-type selection
  const [selectedTypes, setSelectedTypes] = useState<string[]>([dataTypes[0]?.code || 'wte']);
  const [isMultiType, setIsMultiType] = useState(false);
  const [typeColumnMapping, setTypeColumnMapping] = useState<Record<string, string>>({});

  // WTE depth-below-GSE option
  const [wteIsDepth, setWteIsDepth] = useState(false);
  const [wellGseMap, setWellGseMap] = useState<Record<string, number>>({});

  // Aquifer assignment
  const [aquiferAssignment, setAquiferAssignment] = useState<AquiferAssignment>('from-wells');
  const [selectedAquiferId, setSelectedAquiferId] = useState('');
  const [aquiferList, setAquiferList] = useState<{ id: string; name: string }[]>([]);
  const [wellAquiferMap, setWellAquiferMap] = useState<Record<string, string>>({});

  // USGS download
  const [usgsMode, setUsgsMode] = useState<USGSMode>('fresh');
  const [usgsIsLoading, setUsgsIsLoading] = useState(false);
  const [usgsProgress, setUsgsProgress] = useState({ completed: 0, total: 0, done: false });
  const [qualityReport, setQualityReport] = useState<USGSDataQualityReport | null>(null);
  const [dataSpan, setDataSpan] = useState<USGSDataSpan | null>(null);
  const [trimStartDate, setTrimStartDate] = useState('');
  const [trimEndDate, setTrimEndDate] = useState('');
  const [isTrimmed, setIsTrimmed] = useState(false);
  const [quickRefreshCutoff, setQuickRefreshCutoff] = useState('');
  const [rawUSGSMeasurements, setRawUSGSMeasurements] = useState<USGSMeasurement[]>([]);

  const regionOverlapsUS = isInUS(
    (regionBounds[0] + regionBounds[2]) / 2,
    (regionBounds[1] + regionBounds[3]) / 2
  );

  // Load aquifer list and well->aquifer mapping
  useEffect(() => {
    (async () => {
      // Load aquifers
      if (!singleUnit) {
        try {
          const res = await fetch(`/data/${regionId}/aquifers.geojson`);
          if (res.ok) {
            const gj = await res.json();
            const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
            setAquiferList(features.map((f: any) => ({
              id: String(f.properties?.aquifer_id || ''),
              name: f.properties?.aquifer_name || ''
            })));
          }
        } catch {}
      }

      // Load wells for aquifer lookup and GSE
      try {
        const res = await fetch(`/data/${regionId}/wells.csv`);
        if (res.ok) {
          const text = await res.text();
          const { rows } = parseCSV(text);
          const aqMap: Record<string, string> = {};
          const gseMap: Record<string, number> = {};
          for (const r of rows) {
            if (r.well_id) {
              aqMap[r.well_id] = r.aquifer_id || '0';
              const gse = parseFloat(r.gse);
              if (!isNaN(gse)) gseMap[r.well_id] = gse;
            }
          }
          setWellAquiferMap(aqMap);
          setWellGseMap(gseMap);
        }
      } catch {}
    })();
  }, [regionId, singleUnit]);

  // Check if any selected types already have data
  const [existingCounts, setExistingCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    (async () => {
      const counts: Record<string, number> = {};
      for (const dt of dataTypes) {
        try {
          const res = await fetch(`/data/${regionId}/data_${dt.code}.csv`);
          if (res.ok) {
            const text = await res.text();
            counts[dt.code] = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
          }
        } catch {}
      }
      setExistingCounts(counts);
    })();
  }, [regionId, dataTypes]);

  const hasExistingData = selectedTypes.some(code => (existingCounts[code] || 0) > 0);

  const fieldDefs = isMultiType
    ? [
        { key: 'well_id', label: 'Well ID', required: true },
        { key: 'date', label: 'Date', required: true },
        ...(!singleUnit && aquiferAssignment === 'csv-field'
          ? [{ key: 'aquifer_id', label: 'Aquifer ID', required: false }] : []),
      ]
    : [
        { key: 'well_id', label: 'Well ID', required: true },
        { key: 'date', label: 'Date', required: true },
        { key: 'value', label: 'Value', required: true },
        ...(!singleUnit && aquiferAssignment === 'csv-field'
          ? [{ key: 'aquifer_id', label: 'Aquifer ID', required: false }] : []),
      ];

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const uploaded = await processUploadedFile(f, 'measurements');
      setFile(uploaded);

      if (uploaded.mapping['date'] && Array.isArray(uploaded.data)) {
        const detected = detectDateFormat(uploaded.data as Record<string, string>[], uploaded.mapping['date']);
        setDateFormat(detected);
      }

      setShowMapper(true);
    } catch (err) {
      setError(`Failed to process: ${err}`);
    }
  };

  const updateMapping = (key: string, value: string) => {
    if (!file) return;
    setFile({ ...file, mapping: { ...file.mapping, [key]: value } });
  };

  // Build an UploadedFile from validated USGS measurements
  const buildUSGSFile = (measurements: USGSMeasurement[], label: string) => {
    const rows = measurements.map(m => {
      const gse = wellGseMap[m.siteId] || 0;
      const wteValue = gse > 0 ? Math.round((gse - Math.abs(m.value)) * 100) / 100 : m.value;
      return {
        well_id: m.siteId,
        date: m.date,
        value: String(wteValue),
        aquifer_id: singleUnit ? '0' : (wellAquiferMap[m.siteId] || '')
      };
    });
    setFile({
      name: label,
      data: rows,
      columns: ['well_id', 'date', 'value', 'aquifer_id'],
      mapping: { well_id: 'well_id', date: 'date', value: 'value', aquifer_id: 'aquifer_id' },
      type: 'csv'
    });
    const span = computeDataSpan(measurements);
    setDataSpan(span);
    setTrimStartDate(span.minDate);
    setTrimEndDate(span.maxDate);
    setIsTrimmed(false);
  };

  // USGS measurement download — shared across all three modes
  const handleUSGSDownload = async () => {
    setUsgsIsLoading(true);
    setError('');
    setFile(null);
    setDataSpan(null);
    setIsTrimmed(false);
    setQuickRefreshCutoff('');
    setUsgsProgress({ completed: 0, total: 0, done: false });
    try {
      // Get well IDs from wells.csv
      const wellRes = await fetch(`/data/${regionId}/wells.csv`);
      if (!wellRes.ok) throw new Error('No wells found. Import wells first.');
      const wellText = await wellRes.text();
      const { rows: wellRows } = parseCSV(wellText);
      const wellIds = wellRows.map(r => r.well_id).filter(Boolean);

      if (wellIds.length === 0) throw new Error('No well IDs found in wells.csv');

      // Filter to USGS site IDs (they contain "USGS-" prefix typically)
      const usgsSiteIds = wellIds.filter(id => id.startsWith('USGS-'));
      if (usgsSiteIds.length === 0) throw new Error('No USGS site IDs found. USGS well IDs start with "USGS-".');

      setUsgsProgress({ completed: 0, total: usgsSiteIds.length, done: false });

      const rawMeasurements = await fetchUSGSMeasurements(usgsSiteIds, (completed, total) => {
        setUsgsProgress({ completed, total, done: false });
      });

      // Validate and clean data
      const { measurements, report } = validateUSGSMeasurements(rawMeasurements);
      setQualityReport(report);
      setRawUSGSMeasurements(measurements);

      // Mode-specific post-processing
      let filtered = measurements;

      if (usgsMode === 'quick-refresh') {
        // Find max existing date for USGS wells
        try {
          const dataRes = await fetch(`/data/${regionId}/data_wte.csv`);
          if (dataRes.ok) {
            const dataText = await dataRes.text();
            const { rows: dataRows } = parseCSV(dataText);
            const usgsDateSet = new Set(usgsSiteIds);
            const usgsRows = dataRows.filter(r => usgsDateSet.has(r.well_id));
            if (usgsRows.length > 0) {
              const dates = usgsRows.map(r => r.date).filter(Boolean).sort();
              const cutoff = dates[dates.length - 1];
              setQuickRefreshCutoff(cutoff);
              filtered = measurements.filter(m => m.date > cutoff);
            }
          }
        } catch {}
      }
      // full-refresh: no filtering — all records go to merge at save time
      // fresh: no filtering

      buildUSGSFile(filtered, usgsMode === 'fresh' ? 'USGS Measurements' : `USGS ${usgsMode === 'quick-refresh' ? 'Quick' : 'Full'} Refresh`);
      setSelectedTypes(['wte']);
      setIsMultiType(false);
      setUsgsProgress({ completed: usgsSiteIds.length, total: usgsSiteIds.length, done: true });
    } catch (err) {
      setError(`USGS download failed: ${err}`);
    }
    setUsgsIsLoading(false);
  };

  // Apply date range trim to USGS data
  const handleTrim = () => {
    if (rawUSGSMeasurements.length === 0) return;
    let filtered = rawUSGSMeasurements;

    // Re-apply mode filter first (quick-refresh cutoff)
    if (usgsMode === 'quick-refresh' && quickRefreshCutoff) {
      filtered = filtered.filter(m => m.date > quickRefreshCutoff);
    }

    // Then apply date range
    filtered = filterByDateRange(filtered, trimStartDate || null, trimEndDate || null);

    buildUSGSFile(filtered, 'USGS Measurements (Trimmed)');
    setIsTrimmed(true);
  };

  const resolveAquiferId = (row: Record<string, string>): string => {
    if (singleUnit) return '0';
    switch (aquiferAssignment) {
      case 'from-wells': {
        const wellId = row[file?.mapping['well_id'] || 'well_id'];
        return wellAquiferMap[wellId] || '';
      }
      case 'single':
        return selectedAquiferId;
      case 'csv-field': {
        const col = file?.mapping['aquifer_id'];
        return col ? row[col] || '' : '';
      }
      default: return '';
    }
  };

  const doSave = async () => {
    if (!file) return;
    setIsSaving(true);
    setError('');
    try {
      const rows = file.data as Record<string, string>[];
      const wellIdCol = file.mapping['well_id'];
      const dateCol = file.mapping['date'];

      if (isMultiType && selectedTypes.length > 1) {
        // Multi-type: one value column per type
        const filesToSave: { path: string; content: string }[] = [];

        for (const typeCode of selectedTypes) {
          const valueCol = typeColumnMapping[typeCode];
          if (!valueCol) continue;

          const dt = dataTypes.find(d => d.code === typeCode);
          const isWteDepth = typeCode === 'wte' && wteIsDepth;

          let processed = rows
            .filter(r => r[wellIdCol] && r[dateCol] && r[valueCol])
            .map(r => {
              let val = r[valueCol];
              if (isWteDepth) {
                const wellId = r[wellIdCol];
                const gse = wellGseMap[wellId] || 0;
                const raw = parseFloat(val);
                if (!isNaN(raw) && gse > 0) {
                  val = String(Math.round((gse - Math.abs(raw)) * 100) / 100);
                }
              }
              return {
                well_id: r[wellIdCol],
                date: parseDate(r[dateCol], dateFormat),
                value: val,
                aquifer_id: resolveAquiferId(r)
              };
            });

          if (importMode === 'append') {
            processed = await mergeWithExisting(typeCode, processed);
          }

          const csv = 'well_id,date,value,aquifer_id\n' +
            processed.map(m => `${m.well_id},${m.date},${m.value},${m.aquifer_id}`).join('\n');
          filesToSave.push({ path: `${regionId}/data_${typeCode}.csv`, content: csv });
        }

        await saveFiles(filesToSave);
      } else {
        // Single type
        const typeCode = selectedTypes[0] || 'wte';
        const valueCol = file.mapping['value'];
        const isWteDepth = typeCode === 'wte' && wteIsDepth;

        let processed = rows
          .filter(r => r[wellIdCol] && r[dateCol] && r[valueCol])
          .map(r => {
            let val = r[valueCol];
            if (isWteDepth) {
              const wellId = r[wellIdCol];
              const gse = wellGseMap[wellId] || 0;
              const raw = parseFloat(val);
              if (!isNaN(raw) && gse > 0) {
                val = String(Math.round((gse - Math.abs(raw)) * 100) / 100);
              }
            }
            return {
              well_id: r[wellIdCol],
              date: parseDate(r[dateCol], dateFormat),
              value: val,
              aquifer_id: resolveAquiferId(r)
            };
          });

        // Merge/overwrite logic depends on source and mode
        if (dataSource === 'usgs') {
          if (usgsMode === 'fresh' && importMode === 'replace') {
            // Overwrite — no merge needed
          } else if (usgsMode === 'full-refresh') {
            processed = await mergeWithExistingFullRefresh(typeCode, processed);
          } else {
            // fresh+append, quick-refresh: standard merge (skip dupes)
            processed = await mergeWithExisting(typeCode, processed);
          }
        } else if (importMode === 'append') {
          processed = await mergeWithExisting(typeCode, processed);
        }

        const csv = 'well_id,date,value,aquifer_id\n' +
          processed.map(m => `${m.well_id},${m.date},${m.value},${m.aquifer_id}`).join('\n');
        await saveFiles([{ path: `${regionId}/data_${typeCode}.csv`, content: csv }]);
      }
      onComplete();
    } catch (err) {
      setError(`Failed to save: ${err}`);
    }
    setIsSaving(false);
  };

  const mergeWithExisting = async (
    typeCode: string,
    newRows: { well_id: string; date: string; value: string; aquifer_id: string }[]
  ) => {
    try {
      const res = await fetch(`/data/${regionId}/data_${typeCode}.csv`);
      if (res.ok) {
        const text = await res.text();
        const { rows: existingRows } = parseCSV(text);
        const existingKeys = new Set(
          existingRows.map(r => `${r.well_id}|${r.date}|${r.aquifer_id}`)
        );
        const toAdd = newRows.filter(r => !existingKeys.has(`${r.well_id}|${r.date}|${r.aquifer_id}`));

        return [
          ...existingRows.map(r => ({
            well_id: r.well_id,
            date: r.date,
            value: r.value,
            aquifer_id: r.aquifer_id || ''
          })),
          ...toAdd
        ];
      }
    } catch {}
    return newRows;
  };

  const mergeWithExistingFullRefresh = async (
    typeCode: string,
    newRows: { well_id: string; date: string; value: string; aquifer_id: string }[]
  ) => {
    try {
      const res = await fetch(`/data/${regionId}/data_${typeCode}.csv`);
      if (res.ok) {
        const text = await res.text();
        const { rows: existingRows } = parseCSV(text);

        // Build lookup from new data for fast matching
        const newLookup = new Map<string, { value: string; aquifer_id: string }>();
        for (const r of newRows) {
          newLookup.set(`${r.well_id}|${r.date}`, { value: r.value, aquifer_id: r.aquifer_id });
        }

        // Update existing rows if matching key found in new data
        const usedKeys = new Set<string>();
        const merged = existingRows.map(r => {
          const key = `${r.well_id}|${r.date}`;
          const update = newLookup.get(key);
          if (update) {
            usedKeys.add(key);
            return { well_id: r.well_id, date: r.date, value: update.value, aquifer_id: r.aquifer_id || update.aquifer_id };
          }
          return { well_id: r.well_id, date: r.date, value: r.value, aquifer_id: r.aquifer_id || '' };
        });

        // Append new rows not already in existing data (backfills)
        for (const r of newRows) {
          const key = `${r.well_id}|${r.date}`;
          if (!usedKeys.has(key)) {
            merged.push(r);
          }
        }

        return merged;
      }
    } catch {}
    return newRows;
  };

  const handleSave = () => {
    if (importMode === 'replace' && hasExistingData) {
      setShowReplaceConfirm(true);
    } else {
      doSave();
    }
  };

  const toggleType = (code: string) => {
    setSelectedTypes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    );
  };

  const isReady = file && file.mapping['well_id'] && file.mapping['date'] &&
    (isMultiType ? selectedTypes.every(code => typeColumnMapping[code]) : file.mapping['value']) &&
    selectedTypes.length > 0 &&
    (singleUnit || aquiferAssignment !== 'single' || selectedAquiferId);

  return (
    <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Add Measurements</h2>
            <p className="text-sm text-slate-500">{regionName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Data source */}
        {regionOverlapsUS && existingWellCount > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Data Source</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setDataSource('upload'); setFile(null); }}
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

        {/* Data type selection */}
        {dataSource === 'upload' && dataTypes.length > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Data Type(s)</label>
            {dataTypes.length > 1 && (
              <label className="flex items-center gap-2 mb-2 cursor-pointer">
                <input type="checkbox" checked={isMultiType}
                  onChange={e => {
                    setIsMultiType(e.target.checked);
                    if (!e.target.checked) setSelectedTypes([selectedTypes[0] || dataTypes[0]?.code || 'wte']);
                  }}
                  className="text-blue-600 rounded" />
                <span className="text-xs text-slate-600">Import multiple data types from one CSV</span>
              </label>
            )}
            {isMultiType ? (
              <div className="space-y-2">
                {dataTypes.map(dt => (
                  <div key={dt.code}>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={selectedTypes.includes(dt.code)}
                        onChange={() => toggleType(dt.code)} className="text-blue-600 rounded" />
                      <span className="text-sm text-slate-700">{dt.name} ({dt.unit})</span>
                    </label>
                    {selectedTypes.includes(dt.code) && file && (
                      <select
                        value={typeColumnMapping[dt.code] || ''}
                        onChange={e => setTypeColumnMapping(prev => ({ ...prev, [dt.code]: e.target.value }))}
                        className="ml-6 mt-1 w-[calc(100%-1.5rem)] px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                      >
                        <option value="">-- Value column for {dt.code} --</option>
                        {file.columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {dataTypes.map(dt => (
                  <button
                    key={dt.code}
                    onClick={() => setSelectedTypes([dt.code])}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      selectedTypes[0] === dt.code
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {dt.name} ({dt.unit})
                  </button>
                ))}
              </div>
            )}

            {/* WTE depth option */}
            {selectedTypes.includes('wte') && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={wteIsDepth}
                  onChange={e => setWteIsDepth(e.target.checked)}
                  className="text-blue-600 rounded" />
                <span className="text-xs text-slate-600">Values are depth below ground surface (will convert to WTE using GSE)</span>
              </label>
            )}
          </div>
        )}

        {/* Import mode — show for upload, and for USGS fresh mode */}
        {hasExistingData && (dataSource === 'upload' || (dataSource === 'usgs' && usgsMode === 'fresh')) && (
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
                Replace
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {importMode === 'append'
                ? 'New measurements will be added. Duplicates (by well_id + date) are skipped.'
                : `Replaces data for selected type(s): ${selectedTypes.join(', ')}`}
            </p>
          </div>
        )}

        {/* Aquifer assignment */}
        {!singleUnit && aquiferList.length > 0 && dataSource === 'upload' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Aquifer Assignment</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="meas-aq" checked={aquiferAssignment === 'from-wells'}
                  onChange={() => setAquiferAssignment('from-wells')} className="text-blue-600" />
                <span className="text-sm text-slate-700">Look up from wells (by well_id)</span>
              </label>
              {aquiferList.length > 1 && (
                <>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="meas-aq" checked={aquiferAssignment === 'single'}
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
                    <input type="radio" name="meas-aq" checked={aquiferAssignment === 'csv-field'}
                      onChange={() => setAquiferAssignment('csv-field')} className="text-blue-600" />
                    <span className="text-sm text-slate-700">Use aquifer_id column from CSV</span>
                  </label>
                </>
              )}
            </div>
          </div>
        )}

        {/* Upload flow */}
        {dataSource === 'upload' && (
          <>
            <p className="text-sm text-slate-500 mb-4">Upload a CSV file with measurement data.</p>
            <label className="block mb-4">
              <input type="file" accept=".csv,.txt" onChange={handleUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </label>
          </>
        )}

        {/* USGS mode selector */}
        {dataSource === 'usgs' && !file && (
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-3">
              Download water level measurements from USGS for wells with USGS site IDs. Depth values will be converted to water table elevation using GSE.
            </p>
            <label className="block text-sm font-medium text-slate-700 mb-2">Download Mode</label>
            <div className="space-y-2 mb-4">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="usgs-mode" checked={usgsMode === 'fresh'}
                  onChange={() => setUsgsMode('fresh')} className="text-blue-600 mt-0.5" />
                <div>
                  <span className="text-sm text-slate-700 font-medium">Fresh Download</span>
                  <p className="text-xs text-slate-500">Fetch all measurements. Choose append or replace.</p>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="usgs-mode" checked={usgsMode === 'quick-refresh'}
                  onChange={() => setUsgsMode('quick-refresh')} className="text-blue-600 mt-0.5" />
                <div>
                  <span className="text-sm text-slate-700 font-medium">Quick Refresh</span>
                  <p className="text-xs text-slate-500">Fetch all, keep only records newer than latest existing date. Always appends.</p>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="usgs-mode" checked={usgsMode === 'full-refresh'}
                  onChange={() => setUsgsMode('full-refresh')} className="text-blue-600 mt-0.5" />
                <div>
                  <span className="text-sm text-slate-700 font-medium">Full Refresh</span>
                  <p className="text-xs text-slate-500">Fetch all, merge/deduplicate with existing data. Catches backfills. Always appends.</p>
                </div>
              </label>
            </div>
            <button
              onClick={handleUSGSDownload}
              disabled={usgsIsLoading}
              className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {usgsIsLoading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Downloading... ({usgsProgress.completed}/{usgsProgress.total} wells)
                </>
              ) : (
                <>
                  <Download size={14} /> Download USGS Measurements
                </>
              )}
            </button>
          </div>
        )}

        {file && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm text-green-700 mb-2">
              <CheckCircle2 size={16} />
              {dataSource === 'usgs'
                ? `${(file.data as any[]).length} USGS measurements loaded`
                : `${file.name} (${(file.data as any[]).length} rows)`}
            </div>
            {dataSource === 'upload' && (
              <button onClick={() => setShowMapper(true)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                Edit Column Mapping
              </button>
            )}
          </div>
        )}

        {/* Data Span Preview + Date Trimmer */}
        {dataSpan && dataSource === 'usgs' && file && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={14} className="text-blue-600" />
              <span className="text-sm font-medium text-blue-800">Data Range</span>
            </div>
            <p className="text-sm text-slate-700 mb-1">
              {dataSpan.minDate} to {dataSpan.maxDate} — {dataSpan.totalRecords.toLocaleString()} measurements across {dataSpan.wellCount} wells
            </p>
            {usgsMode === 'quick-refresh' && quickRefreshCutoff && (
              <p className="text-xs text-amber-700 mb-2">Cutoff: showing only records after {quickRefreshCutoff}</p>
            )}
            <div className="flex items-end gap-2 mt-2">
              <div className="flex-1">
                <label className="block text-xs text-slate-500 mb-1">Start Date</label>
                <input type="date" value={trimStartDate} onChange={e => setTrimStartDate(e.target.value)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-slate-500 mb-1">End Date</label>
                <input type="date" value={trimEndDate} onChange={e => setTrimEndDate(e.target.value)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <button onClick={handleTrim}
                className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">
                Trim
              </button>
            </div>
            {isTrimmed && (
              <p className="text-xs text-green-700 mt-2">Trimmed to {(file.data as any[]).length.toLocaleString()} measurements</p>
            )}
          </div>
        )}

        {/* USGS Data Quality Report */}
        {qualityReport && dataSource === 'usgs' && (
          <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm">
            <h4 className="font-semibold text-slate-700 mb-2">Data Quality Report</h4>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center p-2 bg-white rounded border">
                <p className="text-lg font-bold text-slate-800">{qualityReport.totalRaw}</p>
                <p className="text-xs text-slate-500">Raw records</p>
              </div>
              <div className="text-center p-2 bg-white rounded border">
                <p className="text-lg font-bold text-green-600">{qualityReport.kept}</p>
                <p className="text-xs text-slate-500">Kept</p>
              </div>
              <div className="text-center p-2 bg-white rounded border">
                <p className={`text-lg font-bold ${qualityReport.dropped.count > 0 ? 'text-red-600' : 'text-slate-400'}`}>{qualityReport.dropped.count}</p>
                <p className="text-xs text-slate-500">Dropped</p>
              </div>
            </div>
            {qualityReport.fixed.count > 0 && (
              <div className="mb-2">
                <p className="text-xs font-medium text-amber-700 mb-1">
                  Fixed {qualityReport.fixed.count} record(s):
                </p>
                <ul className="text-xs text-slate-600 space-y-0.5 max-h-24 overflow-y-auto">
                  {qualityReport.fixed.details.map((d, i) => (
                    <li key={i} className="pl-2 border-l-2 border-amber-300">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {qualityReport.dropped.count > 0 && (
              <div>
                <p className="text-xs font-medium text-red-700 mb-1">
                  Dropped {qualityReport.dropped.count} record(s):
                </p>
                <ul className="text-xs text-slate-600 space-y-0.5 max-h-24 overflow-y-auto">
                  {qualityReport.dropped.details.map((d, i) => (
                    <li key={i} className="pl-2 border-l-2 border-red-300">{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {qualityReport.fixed.count === 0 && qualityReport.dropped.count === 0 && (
              <p className="text-xs text-green-600">All records passed validation.</p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={!isReady || isSaving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving && <Loader2 size={14} className="animate-spin" />}
            {isSaving ? 'Saving...' : 'Save Measurements'}
          </button>
        </div>
      </div>

      {showMapper && file && (
        <ColumnMapperModal
          file={file}
          fieldDefinitions={fieldDefs}
          onUpdateMapping={updateMapping}
          onClose={() => setShowMapper(false)}
          dateFormat={dateFormat}
          onDateFormatChange={setDateFormat}
          title="Map Measurement Columns"
        />
      )}

      {showReplaceConfirm && (
        <ConfirmDialog
          title="Replace Measurements?"
          message={`This will replace all existing measurement data for: ${selectedTypes.join(', ')}. This cannot be undone.`}
          confirmLabel="Replace"
          variant="danger"
          onConfirm={() => { setShowReplaceConfirm(false); doSave(); }}
          onCancel={() => setShowReplaceConfirm(false)}
        />
      )}
    </div>
  );
};

export default MeasurementImporter;
