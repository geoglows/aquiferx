import React, { useState, useEffect, useMemo } from 'react';
import { X, MapPin, Layers, Navigation, BarChart3, Plus, Settings } from 'lucide-react';
import { RegionMeta, DataType } from '../../types';
import RegionImporter from './RegionImporter';
import AquiferImporter from './AquiferImporter';
import WellImporter from './WellImporter';
import MeasurementImporter from './MeasurementImporter';
import DataTypeEditor from './DataTypeEditor';

interface ImportDataHubProps {
  onClose: () => void;
  onDataChanged: () => void;
}

interface RegionInfo extends RegionMeta {
  aquiferCount: number;
  wellCount: number;
  measurementCounts: Record<string, number>;
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
}

async function fetchRegionList(): Promise<RegionInfo[]> {
  const res = await fetch('/api/regions');
  if (!res.ok) return [];
  const metas: RegionMeta[] = await res.json();

  const infos: RegionInfo[] = [];
  for (const meta of metas) {
    const info: RegionInfo = {
      ...meta,
      aquiferCount: 0,
      wellCount: 0,
      measurementCounts: {},
      bounds: [0, 0, 0, 0]
    };

    // Load region bounds from geojson
    try {
      const gjRes = await fetch(`/data/${meta.id}/region.geojson`);
      if (gjRes.ok) {
        const gj = await gjRes.json();
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        for (const f of features) {
          const coords = f.geometry?.coordinates;
          if (!coords) continue;
          const flat = JSON.stringify(coords).match(/-?\d+\.?\d*/g)?.map(Number) || [];
          for (let i = 0; i < flat.length - 1; i += 2) {
            const lng = flat[i], lat = flat[i + 1];
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
          }
        }
        info.bounds = [minLat, minLng, maxLat, maxLng];
      }
    } catch {}

    // Count aquifers
    try {
      const aqRes = await fetch(`/data/${meta.id}/aquifers.geojson`);
      if (aqRes.ok) {
        const gj = await aqRes.json();
        const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
        const ids = new Set(features.map((f: any) => String(f.properties?.aquifer_id || '')));
        info.aquiferCount = ids.size;
      }
    } catch {}

    // Count wells
    try {
      const wRes = await fetch(`/data/${meta.id}/wells.csv`);
      if (wRes.ok) {
        const text = await wRes.text();
        info.wellCount = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
      }
    } catch {}

    // Count measurements per data type
    for (const dt of meta.dataTypes || []) {
      try {
        const mRes = await fetch(`/data/${meta.id}/data_${dt.code}.csv`);
        if (mRes.ok) {
          const text = await mRes.text();
          info.measurementCounts[dt.code] = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
        }
      } catch {}
    }

    infos.push(info);
  }
  return infos;
}

const ImportDataHub: React.FC<ImportDataHubProps> = ({ onClose, onDataChanged }) => {
  const [regionList, setRegionList] = useState<RegionInfo[]>([]);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const [activeWizard, setActiveWizard] = useState<'region' | 'aquifer' | 'well' | 'measurement' | 'datatypes' | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadRegions = async () => {
    setIsLoading(true);
    const list = await fetchRegionList();
    setRegionList(list);
    setIsLoading(false);
  };

  useEffect(() => { loadRegions(); }, []);

  const activeRegion = useMemo(() =>
    regionList.find(r => r.id === activeRegionId) || null,
  [regionList, activeRegionId]);

  const handleSubWizardComplete = () => {
    setActiveWizard(null);
    loadRegions();
    onDataChanged();
  };

  // Dimming logic
  const noRegion = !activeRegion;
  const isSingleUnit = activeRegion?.singleUnit || false;
  const noAquifers = (activeRegion?.aquiferCount || 0) === 0;
  const noWells = (activeRegion?.wellCount || 0) === 0;

  const dimAquifers = noRegion || isSingleUnit;
  const dimWells = noRegion || (!isSingleUnit && noAquifers);
  const dimMeasurements = noRegion || noWells;

  const totalMeasurements = activeRegion
    ? Object.values(activeRegion.measurementCounts).reduce((a: number, b: number) => a + b, 0)
    : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <header className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Manage Data</h2>
            <p className="text-xs text-slate-500 font-medium">Manage regions and their data</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
            <X size={20} />
          </button>
        </header>

        <div className="p-6 overflow-y-auto flex-1">
          {/* Region selector */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <MapPin size={14} /> Regions
              </h3>
              <button
                onClick={() => setActiveWizard('region')}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md text-xs font-medium hover:bg-blue-100 transition-colors"
              >
                <Plus size={14} /> Add Region
              </button>
            </div>

            {isLoading ? (
              <p className="text-sm text-slate-400 italic">Loading regions...</p>
            ) : regionList.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No regions yet. Add one to get started.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {regionList.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setActiveRegionId(activeRegionId === r.id ? null : r.id)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      activeRegionId === r.id
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50'
                    }`}
                  >
                    {r.name}
                    {r.singleUnit && <span className="ml-1 text-xs opacity-70">(single)</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Data cards */}
          <div className="grid grid-cols-3 gap-4">
            {/* Aquifers */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimAquifers ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-indigo-100 text-indigo-600"><Layers size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Aquifers</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-3">{activeRegion?.aquiferCount || 0}</p>
              {isSingleUnit ? (
                <p className="text-xs text-slate-400 italic">Single-unit mode</p>
              ) : (
                <button
                  onClick={() => setActiveWizard('aquifer')}
                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-md text-xs font-medium hover:bg-indigo-100 transition-colors w-full justify-center"
                >
                  <Plus size={14} /> Add Aquifers
                </button>
              )}
            </div>

            {/* Wells */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimWells ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-green-100 text-green-600"><Navigation size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Wells</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-3">{activeRegion?.wellCount || 0}</p>
              <button
                onClick={() => setActiveWizard('well')}
                className="flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-700 rounded-md text-xs font-medium hover:bg-green-100 transition-colors w-full justify-center"
              >
                <Plus size={14} /> Add Wells
              </button>
            </div>

            {/* Measurements */}
            <div className={`border rounded-xl p-4 transition-opacity ${dimMeasurements ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-cyan-100 text-cyan-600"><BarChart3 size={16} /></div>
                <h4 className="font-semibold text-slate-700 text-sm">Measurements</h4>
              </div>
              <p className="text-2xl font-bold text-slate-800 mb-1">{totalMeasurements}</p>
              {activeRegion && activeRegion.dataTypes.length > 0 && (
                <div className="text-xs text-slate-400 mb-2">
                  {activeRegion.dataTypes.map(dt => (
                    <span key={dt.code} className="mr-2">
                      {dt.code}: {activeRegion.measurementCounts[dt.code] || 0}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveWizard('measurement')}
                  className="flex-1 flex items-center gap-1 px-3 py-1.5 bg-cyan-50 text-cyan-700 rounded-md text-xs font-medium hover:bg-cyan-100 transition-colors justify-center"
                >
                  <Plus size={14} /> Add Measurements
                </button>
                <button
                  onClick={() => setActiveWizard('datatypes')}
                  className="p-1.5 bg-slate-100 text-slate-500 rounded-md hover:bg-slate-200 hover:text-slate-700 transition-colors"
                  title="Manage Data Types"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-slate-800 text-white rounded-lg font-bold text-sm hover:bg-slate-700"
          >
            Done
          </button>
        </footer>
      </div>

      {/* Sub-wizards */}
      {activeWizard === 'region' && (
        <RegionImporter
          existingRegionIds={regionList.map(r => r.id)}
          onComplete={(id) => { setActiveRegionId(id); handleSubWizardComplete(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'aquifer' && activeRegion && (
        <AquiferImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          existingAquiferCount={activeRegion.aquiferCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'well' && activeRegion && (
        <WellImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          singleUnit={activeRegion.singleUnit}
          regionBounds={activeRegion.bounds}
          aquiferCount={activeRegion.aquiferCount}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'measurement' && activeRegion && (
        <MeasurementImporter
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          singleUnit={activeRegion.singleUnit}
          dataTypes={activeRegion.dataTypes}
          regionBounds={activeRegion.bounds}
          existingWellCount={activeRegion.wellCount}
          onComplete={handleSubWizardComplete}
          onClose={() => setActiveWizard(null)}
        />
      )}
      {activeWizard === 'datatypes' && activeRegion && (
        <DataTypeEditor
          regionId={activeRegion.id}
          regionName={activeRegion.name}
          lengthUnit={activeRegion.lengthUnit}
          dataTypes={activeRegion.dataTypes}
          singleUnit={activeRegion.singleUnit}
          onUpdate={() => { loadRegions(); onDataChanged(); }}
          onClose={() => setActiveWizard(null)}
        />
      )}
    </div>
  );
};

export default ImportDataHub;
