
import React, { useState, useMemo, useEffect } from 'react';
import { Layers, Map as MapIcon, Database, ChevronRight, Activity, Upload, Loader2, Download } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from './types';
import { loadAllData } from './services/dataLoader';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import TimeSeriesChart from './components/TimeSeriesChart';
import DataManager from './components/DataManager';

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

  // Filtered views
  const filteredAquifers = useMemo(() => 
    selectedRegion ? aquifers.filter(a => a.regionId === selectedRegion.id) : [],
  [selectedRegion, aquifers]);

  const filteredWells = useMemo(() =>
    selectedAquifer ? wells.filter(w => w.aquiferId === selectedAquifer.id && w.regionId === selectedAquifer.regionId) : [],
  [selectedAquifer, wells]);

  const selectedWellMeasurements = useMemo(() =>
    selectedWells.length > 0
      ? measurements.filter(m => selectedWells.some(w => w.id === m.wellId))
      : [],
  [selectedWells, measurements]);

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

  const handleRenameRegion = async (regionId: string, newName: string) => {
    setRegions(prev => prev.map(r => r.id === regionId ? { ...r, name: newName } : r));
    // Persist updated regions.json manifest
    const updatedManifest = regions.map(r =>
      r.id === regionId
        ? { id: r.id, path: `/data/${r.id}`, name: newName }
        : { id: r.id, path: `/data/${r.id}`, name: r.name }
    );
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'regions.json', content: JSON.stringify(updatedManifest, null, 2) }] }),
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
    // Find the region's folder path from the manifest
    const region = regions.find(r => r.id === regionId);
    const folderName = region ? region.id : regionId;
    // Delete folder on disk
    await fetch('/api/delete-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderName }),
    });
    // Update regions.json manifest
    const updatedManifest = regions
      .filter(r => r.id !== regionId)
      .map(r => ({ id: r.id, path: `/data/${r.id}`, name: r.name }));
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'regions.json', content: JSON.stringify(updatedManifest, null, 2) }] }),
    });
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
    // Water levels CSV
    const wlCsvHeader = 'well_id,well_name,date,wte,aquifer_id';
    const wlCsvRows = regionMeasurements.map(m =>
      `${m.wellId},"${m.wellName}",${m.date},${m.wte},${m.aquiferId}`
    );
    const wlCsvContent = [wlCsvHeader, ...wlCsvRows].join('\n');
    await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { path: `${regionId}/aquifers.geojson`, content: geojsonContent },
          { path: `${regionId}/wells.csv`, content: wellsCsvContent },
          { path: `${regionId}/water_levels.csv`, content: wlCsvContent },
        ],
      }),
    });
  };

  // Export time series data to CSV
  const exportToCSV = () => {
    if (selectedWells.length === 0 || selectedWellMeasurements.length === 0) return;

    const headers = ['Date', 'Water Table Elevation (ft)', 'Well Name', 'Aquifer ID'];
    const rows = selectedWellMeasurements
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(m => [
        new Date(m.date).toLocaleDateString(),
        m.wte.toString(),
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
    link.download = `${firstName}${suffix}_water_levels.csv`;
    link.click();
    URL.revokeObjectURL(url);
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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 font-sans">
      {/* Sidebar */}
      <Sidebar
        regions={regions}
        selectedRegion={selectedRegion}
        setSelectedRegion={(r) => {
          setSelectedRegion(r);
          setSelectedAquifer(null);
          setSelectedWells([]);
        }}
        aquifers={filteredAquifers}
        selectedAquifer={selectedAquifer}
        setSelectedAquifer={(a) => {
          setSelectedAquifer(a);
          setSelectedWells([]);
        }}
        openDataManager={() => setIsDataManagerOpen(true)}
        onRenameRegion={handleRenameRegion}
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
          <button 
            onClick={() => setIsDataManagerOpen(true)}
            className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-100 transition-colors"
          >
            <Database size={16} />
            <span>Manage Data</span>
          </button>
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
              onRegionClick={(r) => {
                setSelectedRegion(r);
                setSelectedAquifer(null);
                setSelectedWells([]);
              }}
              onAquiferClick={setSelectedAquifer}
              onWellClick={handleWellClick}
              onWellBoxSelect={handleWellBoxSelect}
            />
          </div>

          {/* Time Series Section */}
          <div className={`transition-all duration-300 ease-in-out border-t border-slate-200 bg-white ${selectedWells.length > 0 ? 'h-1/3' : 'h-0 overflow-hidden'}`}>
            {selectedWells.length > 0 && (
              <div className="p-4 h-full flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <Activity size={18} className="text-blue-500" />
                    <h3 className="font-bold text-slate-800">
                      Water Table Elevation: {
                        selectedWells.length <= 3
                          ? selectedWells.map(w => w.name).join(', ')
                          : `${selectedWells.length} wells selected`
                      }
                    </h3>
                  </div>
                  <div className="flex items-center space-x-4">
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
                      Units: Feet (WTE)
                    </div>
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  <TimeSeriesChart
                    measurements={selectedWellMeasurements}
                    selectedWells={selectedWells}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Data Management Overlay */}
      {isDataManagerOpen && (
        <DataManager
          onClose={() => setIsDataManagerOpen(false)}
          onUpdateRegions={setRegions}
          onUpdateAquifers={setAquifers}
          onUpdateWells={setWells}
          onUpdateMeasurements={setMeasurements}
          existingRegions={regions.map(r => r.id)}
        />
      )}
    </div>
  );
};

export default App;
