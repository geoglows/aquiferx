
import React, { useState, useMemo, useEffect } from 'react';
import { Layers, Map as MapIcon, Database, ChevronRight, Activity, Upload, Loader2, Download, Table } from 'lucide-react';
import { Region, Aquifer, Well, Measurement, DataType } from './types';
import { loadAllData } from './services/dataLoader';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import TimeSeriesChart from './components/TimeSeriesChart';
import ImportDataHub from './components/import/ImportDataHub';
import DataEditor from './components/DataEditor';
import JSZip from 'jszip';

const TREND_THRESHOLDS_FT = { extreme: 2.0, moderate: 0.5 };
const TREND_THRESHOLDS_M = { extreme: 0.6, moderate: 0.15 };
const AQUIFER_TREND_THRESHOLDS_FT = { extreme: 1.0, moderate: 0.25 };
const AQUIFER_TREND_THRESHOLDS_M = { extreme: 0.3, moderate: 0.075 };

type TrendThresholds = { extreme: number; moderate: number };

const TREND_CATEGORIES: { label: string; color: string; test: (s: number, t: TrendThresholds) => boolean }[] = [
  { label: 'Extreme Decline', color: '#DC2626', test: (s, t) => s < -t.extreme },
  { label: 'Decline', color: '#FB923C', test: (s, t) => s < -t.moderate },
  { label: 'Static', color: '#FACC15', test: (s, t) => s <= t.moderate },
  { label: 'Increase', color: '#38BDF8', test: (s, t) => s <= t.extreme },
  { label: 'Extreme Increase', color: '#2563EB', test: () => true },
];

const INSUFFICIENT_COLOR = '#1E293B';
const MS_PER_YEAR = 365.25 * 86400000;

function computeSlope(meas: Measurement[]): number | null {
  if (meas.length < 3) return null;
  let n = 0, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const m of meas) {
    const x = new Date(m.date).getTime() / MS_PER_YEAR;
    const y = m.value;
    n++; sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function classifySlope(slope: number | null, thresholds: TrendThresholds): string {
  if (slope === null) return INSUFFICIENT_COLOR;
  for (const cat of TREND_CATEGORIES) {
    if (cat.test(slope, thresholds)) return cat.color;
  }
  return INSUFFICIENT_COLOR;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const App: React.FC = () => {
  const [regions, setRegions] = useState<Region[]>([]);
  const [aquifers, setAquifers] = useState<Aquifer[]>([]);
  const [wells, setWells] = useState<Well[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);
  const [selectedAquifer, setSelectedAquifer] = useState<Aquifer | null>(null);
  const [selectedWells, setSelectedWells] = useState<Well[]>([]);
  const [isDataManagerOpen, setIsDataManagerOpen] = useState(false);
  const [isDataEditorOpen, setIsDataEditorOpen] = useState(false);
  const [showGSE, setShowGSE] = useState(false);
  const [showTrendLine, setShowTrendLine] = useState(false);
  const [trendColors, setTrendColors] = useState<Map<string, string> | null>(null);
  const [aquiferTrendColors, setAquiferTrendColors] = useState<Map<string, string> | null>(null);
  const [showTrends, setShowTrends] = useState(false);
  const [selectedDataType, setSelectedDataType] = useState<string>('wte');

  // Reset selectedDataType when region changes
  useEffect(() => {
    setSelectedDataType('wte');
  }, [selectedRegion?.id]);

  // Clear trend analysis when region or data type changes
  useEffect(() => {
    setTrendColors(null);
    setAquiferTrendColors(null);
    setShowTrends(false);
  }, [selectedRegion?.id, selectedDataType]);

  const analyzeTrends = () => {
    if (showTrends) {
      setTrendColors(null);
      setAquiferTrendColors(null);
      setShowTrends(false);
      setShowTrendLine(false);
      return;
    }
    if (!selectedRegion) return;
    setShowTrendLine(true);

    // Compute both well-level and aquifer-level trends for the entire region
    const regionWells = wells.filter(w => w.regionId === selectedRegion.id);

    // Group measurements by wellId for this data type
    const byWell = new Map<string, Measurement[]>();
    for (const m of measurements) {
      if (m.dataType === selectedDataType) {
        const arr = byWell.get(m.wellId);
        if (arr) arr.push(m);
        else byWell.set(m.wellId, [m]);
      }
    }

    // Per-well colors
    const wellThresholds = selectedRegion.lengthUnit === 'm' ? TREND_THRESHOLDS_M : TREND_THRESHOLDS_FT;
    const wellColorMap = new Map<string, string>();
    for (const w of regionWells) {
      wellColorMap.set(w.id, classifySlope(computeSlope(byWell.get(w.id) || []), wellThresholds));
    }

    // Per-aquifer colors (median of well slopes)
    const aqThresholds = selectedRegion.lengthUnit === 'm' ? AQUIFER_TREND_THRESHOLDS_M : AQUIFER_TREND_THRESHOLDS_FT;
    const wellsByAquifer = new Map<string, Well[]>();
    for (const w of regionWells) {
      const arr = wellsByAquifer.get(w.aquiferId);
      if (arr) arr.push(w);
      else wellsByAquifer.set(w.aquiferId, [w]);
    }
    const aqColorMap = new Map<string, string>();
    for (const a of filteredAquifers) {
      const aqWells = wellsByAquifer.get(a.id) || [];
      const slopes: number[] = [];
      for (const w of aqWells) {
        const s = computeSlope(byWell.get(w.id) || []);
        if (s !== null) slopes.push(s);
      }
      if (slopes.length === 0) {
        aqColorMap.set(a.id, INSUFFICIENT_COLOR);
      } else {
        aqColorMap.set(a.id, classifySlope(median(slopes), aqThresholds));
      }
    }

    setTrendColors(wellColorMap);
    setAquiferTrendColors(aqColorMap);
    setShowTrends(true);
  };

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        setLoadError(null);
        const data = await loadAllData();
        setRegions(data.regions);
        setAquifers(data.aquifers);
        setWells(data.wells);
        setMeasurements(data.measurements);
        console.log(`Loaded: ${data.regions.length} regions, ${data.aquifers.length} aquifers, ${data.wells.length} wells, ${data.measurements.length} measurements`);
      } catch (e) {
        console.error('Failed to load data:', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  // Callback for ImportDataHub / DataManager to refresh data
  const handleDataChanged = async () => {
    try {
      const data = await loadAllData();
      setRegions(data.regions);
      setAquifers(data.aquifers);
      setWells(data.wells);
      setMeasurements(data.measurements);
    } catch (e) {
      console.error('Failed to reload data:', e);
    }
  };

  // Active data type object
  const activeDataType = useMemo<DataType>(() => {
    if (selectedRegion) {
      const dt = selectedRegion.dataTypes.find(d => d.code === selectedDataType);
      if (dt) return dt;
    }
    return { code: 'wte', name: 'Water Table Elevation', unit: 'ft' };
  }, [selectedRegion, selectedDataType]);

  // Filtered views
  const filteredAquifers = useMemo(() =>
    selectedRegion ? aquifers.filter(a => a.regionId === selectedRegion.id) : [],
  [selectedRegion, aquifers]);

  const filteredWells = useMemo(() =>
    selectedAquifer ? wells.filter(w => w.aquiferId === selectedAquifer.id && w.regionId === selectedAquifer.regionId) : [],
  [selectedAquifer, wells]);

  const selectedWellMeasurements = useMemo(() =>
    selectedWells.length > 0
      ? measurements.filter(m => selectedWells.some(w => w.id === m.wellId) && m.dataType === selectedDataType)
      : [],
  [selectedWells, measurements, selectedDataType]);

  const handleWellClick = (well: Well, shiftKey: boolean) => {
    if (shiftKey) {
      setSelectedWells(prev =>
        prev.some(w => w.id === well.id)
          ? prev.filter(w => w.id !== well.id)
          : [...prev, well]
      );
    } else {
      setSelectedWells([well]);
    }
  };

  const handleWellBoxSelect = (wells: Well[]) => {
    setSelectedWells(wells);
  };

  // --- Region/Aquifer rename & delete handlers ---

  const handleEditRegion = async (regionId: string, newName: string, lengthUnit: 'ft' | 'm', singleUnit?: boolean) => {
    const region = regions.find(r => r.id === regionId);
    if (!region) return;
    const newSingleUnit = singleUnit !== undefined ? singleUnit : region.singleUnit;
    const singleUnitChanged = newSingleUnit !== region.singleUnit;

    setRegions(prev => prev.map(r => r.id === regionId ? { ...r, name: newName, lengthUnit, singleUnit: newSingleUnit } : r));

    // Handle single-unit mode change
    if (singleUnitChanged) {
      if (newSingleUnit) {
        // Switching TO single-unit: rewrite aquifers.geojson with single boundary, update wells/measurements aquifer_id to "0"
        try {
          // Create single-unit aquifer from region boundary
          const gjRes = await fetch(`/data/${regionId}/region.geojson`);
          if (gjRes.ok) {
            const regionGj = await gjRes.json();
            const singleAquifer = {
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                properties: { aquifer_id: '0', aquifer_name: newName },
                geometry: regionGj.type === 'FeatureCollection' ? regionGj.features[0]?.geometry : regionGj.geometry
              }]
            };
            const filesToSave: { path: string; content: string }[] = [
              { path: `${regionId}/aquifers.geojson`, content: JSON.stringify(singleAquifer, null, 2) }
            ];

            // Update wells.csv — set all aquifer_id to "0"
            try {
              const wRes = await fetch(`/data/${regionId}/wells.csv`);
              if (wRes.ok) {
                const text = await wRes.text();
                const lines = text.split('\n');
                if (lines.length > 1) {
                  const headers = lines[0];
                  const cols = headers.split(',');
                  const aqIdx = cols.findIndex(c => c.trim() === 'aquifer_id');
                  if (aqIdx >= 0) {
                    const newLines = [headers, ...lines.slice(1).filter(l => l.trim()).map(line => {
                      const parts = line.split(',');
                      parts[aqIdx] = '0';
                      return parts.join(',');
                    })];
                    filesToSave.push({ path: `${regionId}/wells.csv`, content: newLines.join('\n') });
                  }
                }
              }
            } catch {}

            // Update all data_*.csv — set all aquifer_id to "0"
            for (const dt of region.dataTypes) {
              try {
                const mRes = await fetch(`/data/${regionId}/data_${dt.code}.csv`);
                if (mRes.ok) {
                  const text = await mRes.text();
                  const lines = text.split('\n');
                  if (lines.length > 1) {
                    const headers = lines[0];
                    const cols = headers.split(',');
                    const aqIdx = cols.findIndex(c => c.trim() === 'aquifer_id');
                    if (aqIdx >= 0) {
                      const newLines = [headers, ...lines.slice(1).filter(l => l.trim()).map(line => {
                        const parts = line.split(',');
                        parts[aqIdx] = '0';
                        return parts.join(',');
                      })];
                      filesToSave.push({ path: `${regionId}/data_${dt.code}.csv`, content: newLines.join('\n') });
                    }
                  }
                }
              } catch {}
            }

            await fetch('/api/save-data', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ files: filesToSave }),
            });
          }
        } catch (err) {
          console.error('Failed to switch to single-unit mode:', err);
        }
      } else {
        // Switching FROM single-unit: delete the auto-generated aquifer, clear aquifer assignments
        try {
          await fetch('/api/delete-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: `${regionId}/aquifers.geojson` }),
          });
        } catch {}
      }

      // Reload data to reflect changes
      handleDataChanged();
    }

    // Persist updated region.json (per-folder)
    const regionMeta = {
      id: regionId,
      name: newName,
      lengthUnit,
      singleUnit: newSingleUnit,
      dataTypes: region.dataTypes
    };
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: `${regionId}/region.json`, content: JSON.stringify(regionMeta, null, 2) }] }),
    });
  };

  const handleDeleteRegion = async (regionId: string) => {
    // Clear selection if needed
    if (selectedRegion?.id === regionId) {
      setSelectedRegion(null);
      setSelectedAquifer(null);
      setSelectedWells([]);
    }
    // Remove from state
    setRegions(prev => prev.filter(r => r.id !== regionId));
    setAquifers(prev => prev.filter(a => a.regionId !== regionId));
    setWells(prev => prev.filter(w => w.regionId !== regionId));
    setMeasurements(prev => prev.filter(m => {
      const well = wells.find(w => w.id === m.wellId);
      return !well || well.regionId !== regionId;
    }));
    // Delete folder on disk
    await fetch('/api/delete-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: regionId }),
    });
  };

  const handleDownloadRegion = async (regionId: string) => {
    const region = regions.find(r => r.id === regionId);
    if (!region) return;
    const basePath = `/data/${regionId}`;
    const zip = new JSZip();

    // Always include region.json and region.geojson
    const staticFiles = ['region.json', 'region.geojson', 'aquifers.geojson', 'wells.csv'];
    for (const name of staticFiles) {
      try {
        const res = await fetch(`${basePath}/${name}`);
        if (res.ok) {
          zip.file(name, await res.text());
        }
      } catch {
        // skip files that don't exist
      }
    }

    // Dynamically include all data_*.csv files
    for (const dt of region.dataTypes) {
      try {
        const res = await fetch(`${basePath}/data_${dt.code}.csv`);
        if (res.ok) {
          zip.file(`data_${dt.code}.csv`, await res.text());
        }
      } catch {
        // skip
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${region.name.replace(/[^a-z0-9]+/gi, '_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRenameAquifer = async (aquiferId: string, newName: string) => {
    setAquifers(prev => prev.map(a => a.id === aquiferId ? { ...a, name: newName } : a));
    // Rebuild and persist the aquifers.geojson for the affected region
    const aquifer = aquifers.find(a => a.id === aquiferId);
    if (!aquifer) return;
    const regionId = aquifer.regionId;
    const regionAquifers = aquifers
      .filter(a => a.regionId === regionId)
      .map(a => a.id === aquiferId ? { ...a, name: newName } : a);
    const features = regionAquifers.flatMap(a =>
      (a.geojson?.features || []).map((f: any) => ({
        ...f,
        properties: { ...f.properties, aquifer_id: a.id, aquifer_name: a.name },
      }))
    );
    const geojsonContent = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: `${regionId}/aquifers.geojson`, content: geojsonContent }] }),
    });
  };

  const handleDeleteAquifer = async (aquiferId: string) => {
    const aquifer = aquifers.find(a => a.id === aquiferId);
    if (!aquifer) return;
    const regionId = aquifer.regionId;
    const region = regions.find(r => r.id === regionId);
    // Clear selection if needed
    if (selectedAquifer?.id === aquiferId) {
      setSelectedAquifer(null);
      setSelectedWells([]);
    }
    // Compute remaining data for the region before removing from state
    const remainingAquifers = aquifers.filter(a => !(a.id === aquiferId && a.regionId === regionId));
    const remainingWells = wells.filter(w => !(w.aquiferId === aquiferId && w.regionId === regionId));
    const deletedWellIds = new Set(wells.filter(w => w.aquiferId === aquiferId && w.regionId === regionId).map(w => w.id));
    const remainingMeasurements = measurements.filter(m => !deletedWellIds.has(m.wellId));
    // Update state
    setAquifers(remainingAquifers);
    setWells(remainingWells);
    setMeasurements(remainingMeasurements);
    // Rebuild files for the region
    const regionAquifers = remainingAquifers.filter(a => a.regionId === regionId);
    const regionWells = remainingWells.filter(w => w.regionId === regionId);
    const regionMeasurements = remainingMeasurements.filter(m => regionWells.some(w => w.id === m.wellId));
    // Aquifers GeoJSON
    const features = regionAquifers.flatMap(a =>
      (a.geojson?.features || []).map((f: any) => ({
        ...f,
        properties: { ...f.properties, aquifer_id: a.id, aquifer_name: a.name },
      }))
    );
    const geojsonContent = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    // Wells CSV
    const wellsCsvHeader = 'well_id,well_name,lat,long,gse,aquifer_id,aquifer_name';
    const wellsCsvRows = regionWells.map(w =>
      `${w.id},"${w.name}",${w.lat},${w.lng},${w.gse},${w.aquiferId},"${w.aquiferName}"`
    );
    const wellsCsvContent = [wellsCsvHeader, ...wellsCsvRows].join('\n');

    // Rebuild data CSVs per data type
    const dataTypes = region?.dataTypes || [{ code: 'wte', name: 'Water Table Elevation', unit: 'ft' }];
    const dataFiles: { path: string; content: string }[] = [];
    for (const dt of dataTypes) {
      const dtMeasurements = regionMeasurements.filter(m => m.dataType === dt.code);
      const header = 'well_id,well_name,date,value,aquifer_id';
      const rows = dtMeasurements.map(m =>
        `${m.wellId},"${m.wellName}",${m.date},${m.value},${m.aquiferId}`
      );
      dataFiles.push({ path: `${regionId}/data_${dt.code}.csv`, content: [header, ...rows].join('\n') });
    }

    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { path: `${regionId}/aquifers.geojson`, content: geojsonContent },
          { path: `${regionId}/wells.csv`, content: wellsCsvContent },
          ...dataFiles,
        ],
      }),
    });
  };

  // Export time series data to CSV
  const exportToCSV = () => {
    if (selectedWells.length === 0 || selectedWellMeasurements.length === 0) return;

    const unit = activeDataType.unit;
    const headers = ['Date', `${activeDataType.name} (${unit})`, 'Well Name', 'Aquifer ID'];
    const rows = selectedWellMeasurements
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(m => [
        new Date(m.date).toLocaleDateString(),
        m.value.toString(),
        m.wellName,
        m.aquiferId
      ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const firstName = selectedWells[0].name.replace(/[^a-z0-9]/gi, '_');
    const suffix = selectedWells.length > 1 ? `_and_${selectedWells.length - 1}_others` : '';
    link.download = `${firstName}${suffix}_${activeDataType.code}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Chart inline edit/delete handlers
  const handleChartEditMeasurement = async (wellId: string, date: number, newValue: number) => {
    const updatedMeasurements = measurements.map(m =>
      m.wellId === wellId && new Date(m.date).getTime() === date && m.dataType === selectedDataType
        ? { ...m, value: newValue }
        : m
    );
    await handleDataEditorSave(updatedMeasurements);
  };

  const handleChartDeleteMeasurement = async (wellId: string, date: number) => {
    const updatedMeasurements = measurements.filter(m =>
      !(m.wellId === wellId && new Date(m.date).getTime() === date && m.dataType === selectedDataType)
    );
    await handleDataEditorSave(updatedMeasurements);
  };

  // Save handler for DataEditor
  const handleDataEditorSave = async (updatedMeasurements: Measurement[]) => {
    setMeasurements(updatedMeasurements);
    // Rebuild and persist the data CSV for the active data type in this region
    const regionId = selectedWells[0].regionId;
    const region = regions.find(r => r.id === regionId);
    const regionWells = wells.filter(w => w.regionId === regionId);
    const regionWellIds = new Set(regionWells.map(w => w.id));

    // Write the CSV for the active data type
    const dtCode = selectedDataType;
    const regionMeasurements = updatedMeasurements.filter(m => regionWellIds.has(m.wellId) && m.dataType === dtCode);
    const header = 'well_id,well_name,date,value,aquifer_id';
    const rows = regionMeasurements.map(m =>
      `${m.wellId},"${m.wellName}",${m.date},${m.value},${m.aquiferId}`
    );
    const csvContent = [header, ...rows].join('\n');
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: `${regionId}/data_${dtCode}.csv`, content: csvContent }] }),
    });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-slate-600 font-medium">Loading groundwater data...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center max-w-md">
          <div className="text-red-500 text-6xl mb-4">!</div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Failed to Load Data</h2>
          <p className="text-slate-600 mb-4">{loadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const hasMultipleDataTypes = selectedRegion && selectedRegion.dataTypes.length > 1;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 font-sans">
      {/* Sidebar */}
      <Sidebar
        regions={regions}
        selectedRegion={selectedRegion}
        setSelectedRegion={(r) => {
          setSelectedRegion(r);
          setSelectedWells([]);
          // For single-unit regions, auto-select the default aquifer
          if (r && r.singleUnit) {
            const singleAquifer = aquifers.find(a => a.regionId === r.id);
            setSelectedAquifer(singleAquifer || null);
          } else {
            setSelectedAquifer(null);
          }
        }}
        aquifers={filteredAquifers}
        selectedAquifer={selectedAquifer}
        setSelectedAquifer={(a) => {
          setSelectedAquifer(a);
          setSelectedWells([]);
        }}
        openDataManager={() => setIsDataManagerOpen(true)}
        onEditRegion={handleEditRegion}
        onDownloadRegion={handleDownloadRegion}
        onDeleteRegion={handleDeleteRegion}
        onRenameAquifer={handleRenameAquifer}
        onDeleteAquifer={handleDeleteAquifer}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Top Navigation / Breadcrumbs */}
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm z-10">
          <div className="flex items-center space-x-2 text-sm text-slate-600">
            <MapIcon size={16} />
            <button
              onClick={() => {
                setSelectedRegion(null);
                setSelectedAquifer(null);
                setSelectedWells([]);
              }}
              className="font-semibold text-slate-800 hover:text-blue-600 transition-colors"
            >
              Groundwater Explorer
            </button>
            {selectedRegion && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <button
                  onClick={() => {
                    setSelectedAquifer(null);
                    setSelectedWells([]);
                  }}
                  className="hover:text-blue-600 transition-colors"
                >
                  {selectedRegion.name}
                </button>
              </>
            )}
            {selectedAquifer && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <button
                  onClick={() => setSelectedWells([])}
                  className="hover:text-blue-600 transition-colors"
                >
                  {selectedAquifer.name}
                </button>
              </>
            )}
            {selectedWells.length > 0 && (
              <>
                <ChevronRight size={14} className="text-slate-400" />
                <span className="font-medium text-blue-600">
                  {selectedWells[0].name}
                  {selectedWells.length > 1 && ` + ${selectedWells.length - 1} more`}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center space-x-3">
            {hasMultipleDataTypes && (
              <select
                value={selectedDataType}
                onChange={(e) => setSelectedDataType(e.target.value)}
                className="px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {selectedRegion!.dataTypes.map(dt => (
                  <option key={dt.code} value={dt.code}>{dt.name} ({dt.unit})</option>
                ))}
              </select>
            )}
            {selectedRegion && (
              <button
                onClick={analyzeTrends}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  showTrends
                    ? 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                    : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                }`}
              >
                <Activity size={16} />
                <span>Analyze Trends</span>
              </button>
            )}
            <button
              onClick={() => setIsDataManagerOpen(true)}
              className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-100 transition-colors"
            >
              <Database size={16} />
              <span>Manage Data</span>
            </button>
          </div>
        </header>

        {/* Map and Chart Split View */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 relative">
            <MapView
              regions={regions}
              aquifers={filteredAquifers}
              wells={filteredWells}
              measurements={measurements}
              selectedRegion={selectedRegion}
              selectedAquifer={selectedAquifer}
              selectedWells={selectedWells}
              selectedDataType={selectedDataType}
              wellColors={showTrends ? trendColors : null}
              aquiferColors={showTrends && !selectedAquifer ? aquiferTrendColors : null}
              onRegionClick={(r) => {
                setSelectedRegion(r);
                setSelectedAquifer(null);
                setSelectedWells([]);
              }}
              onAquiferClick={setSelectedAquifer}
              onWellClick={handleWellClick}
              onWellBoxSelect={handleWellBoxSelect}
            />
            {showTrends && (trendColors || aquiferTrendColors) && (() => {
              const isAquiferMode = !selectedAquifer && aquiferTrendColors !== null;
              const activeColors = isAquiferMode ? aquiferTrendColors! : trendColors!;
              const unit = selectedRegion?.lengthUnit === 'm' ? 'm' : 'ft';
              const thresholds = isAquiferMode
                ? (unit === 'm' ? AQUIFER_TREND_THRESHOLDS_M : AQUIFER_TREND_THRESHOLDS_FT)
                : (unit === 'm' ? TREND_THRESHOLDS_M : TREND_THRESHOLDS_FT);
              return (
                <div className="absolute top-3 left-3 z-[90] bg-white rounded-lg shadow-lg border border-slate-200 p-3" style={{ width: '210px' }}>
                  <div className="text-xs font-semibold text-slate-700 mb-0.5">
                    {isAquiferMode ? 'Aquifer Trend (median)' : 'Well Trend'} ({unit}/yr)
                  </div>
                  <div className="text-[10px] text-slate-400 mb-2">
                    {thresholds.moderate} / {thresholds.extreme} {unit}/yr
                  </div>
                  {[...TREND_CATEGORIES].reverse().map(cat => {
                    const count = Array.from(activeColors.values()).filter(c => c === cat.color).length;
                    return (
                      <div key={cat.label} className="flex items-center gap-2 py-0.5">
                        <span className="inline-block w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
                        <span className="text-xs text-slate-600">{cat.label} ({count})</span>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 py-0.5">
                    <span className="inline-block w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: INSUFFICIENT_COLOR }} />
                    <span className="text-xs text-slate-600">
                      Insufficient data ({Array.from(activeColors.values()).filter(c => c === INSUFFICIENT_COLOR).length})
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Time Series Section */}
          <div className={`transition-all duration-300 ease-in-out border-t border-slate-200 bg-white ${selectedWells.length > 0 ? 'h-1/3' : 'h-0 overflow-hidden'}`}>
            {selectedWells.length > 0 && (
              <div className="p-4 h-full flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <Activity size={18} className="text-blue-500" />
                    <h3 className="font-bold text-slate-800">
                      {activeDataType.name}: {
                        selectedWells.length <= 3
                          ? selectedWells.map(w => w.name).join(', ')
                          : `${selectedWells.length} wells selected`
                      }
                    </h3>
                  </div>
                  <div className="flex items-center space-x-4">
                    {activeDataType.code === 'wte' && (
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={showGSE}
                          onChange={(e) => setShowGSE(e.target.checked)}
                          className="accent-blue-500"
                        />
                        GSE
                      </label>
                    )}
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showTrendLine}
                        onChange={(e) => setShowTrendLine(e.target.checked)}
                        className="accent-blue-500"
                      />
                      Trend Line
                    </label>
                    <button
                      onClick={() => setIsDataEditorOpen(true)}
                      disabled={selectedWells.length !== 1}
                      className="flex items-center space-x-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={selectedWells.length !== 1 ? 'Select a single well to edit' : 'View/Edit measurement data'}
                    >
                      <Table size={14} />
                      <span>View/Edit</span>
                    </button>
                    <button
                      onClick={exportToCSV}
                      disabled={selectedWellMeasurements.length === 0}
                      className="flex items-center space-x-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-md text-sm font-medium hover:bg-green-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Export data to CSV"
                    >
                      <Download size={14} />
                      <span>Export CSV</span>
                    </button>
                    <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                      Units: {activeDataType.unit === 'm' ? 'Meters' : activeDataType.unit === 'ft' ? 'Feet' : activeDataType.unit} ({activeDataType.code.toUpperCase()})
                    </div>
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  <TimeSeriesChart
                    measurements={selectedWellMeasurements}
                    selectedWells={selectedWells}
                    showGSE={showGSE && activeDataType.code === 'wte'}
                    showTrendLine={showTrendLine}
                    dataType={activeDataType}
                    lengthUnit={selectedRegion?.lengthUnit || 'ft'}
                    onEditMeasurement={handleChartEditMeasurement}
                    onDeleteMeasurement={handleChartDeleteMeasurement}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Import Data Hub */}
      {isDataManagerOpen && (
        <ImportDataHub
          onClose={() => setIsDataManagerOpen(false)}
          onDataChanged={handleDataChanged}
          initialRegionId={selectedRegion?.id || null}
        />
      )}

      {/* Data Editor Modal */}
      {isDataEditorOpen && selectedWells.length === 1 && (
        <DataEditor
          well={selectedWells[0]}
          measurements={selectedWellMeasurements}
          allMeasurements={measurements}
          regionId={selectedWells[0].regionId}
          dataType={activeDataType}
          onClose={() => setIsDataEditorOpen(false)}
          onSave={handleDataEditorSave}
        />
      )}
    </div>
  );
};

export default App;
