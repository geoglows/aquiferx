
import React, { useEffect, useRef, useMemo, useState } from 'react';
import L from 'leaflet';
import { Layers, ChevronRight } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from '../types';

const BASEMAPS = {
  'OpenStreetMap': {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/b834a68d7a484c5fb473d4ba90571f26/info/thumbnail/ago_downloaded.png'
  },
  'Topographic (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/67372ff42cd145319639a99152b15bc3/info/thumbnail/ago_downloaded.png'
  },
  'Imagery (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9/info/thumbnail/ago_downloaded.png'
  },
  'Streets (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/3b93337983e9436f8db950e38a8629af/info/thumbnail/ago_downloaded.png'
  },
  'Light Gray (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/8b3d38c0819547faa83f7b7aca80bd76/info/thumbnail/ago_downloaded.png'
  },
  'Dark Gray (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/358ec1e175ea41c3bf5c68f0da11ae2b/info/thumbnail/ago_downloaded.png'
  },
  'Terrain (Esri)': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/c61ad8ab017d49e1a82f580ee1298571/info/thumbnail/ago_downloaded.png'
  }
};

interface MapViewProps {
  regions: Region[];
  aquifers: Aquifer[];
  wells: Well[];
  measurements: Measurement[];
  selectedRegion: Region | null;
  selectedAquifer: Aquifer | null;
  selectedWells: Well[];
  selectedDataType?: string;
  wellColors?: Map<string, string> | null;
  aquiferColors?: Map<string, string> | null;
  onRegionClick: (r: Region) => void;
  onAquiferClick: (a: Aquifer) => void;
  onWellClick: (w: Well, shiftKey: boolean) => void;
  onWellBoxSelect: (wells: Well[]) => void;
}

const MapView: React.FC<MapViewProps> = ({
  regions,
  aquifers,
  wells,
  measurements,
  selectedRegion,
  selectedAquifer,
  selectedWells,
  selectedDataType = 'wte',
  wellColors,
  aquiferColors,
  onRegionClick,
  onAquiferClick,
  onWellClick,
  onWellBoxSelect
}) => {
  // Count measurements per well for the active data type
  const wellMeasurementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of measurements) {
      if (m.dataType === selectedDataType) {
        counts.set(m.wellId, (counts.get(m.wellId) || 0) + 1);
      }
    }
    return counts;
  }, [measurements, selectedDataType]);
  const mapRef = useRef<L.Map | null>(null);
  const basemapLayerRef = useRef<L.TileLayer | null>(null);
  const regionLayerRef = useRef<L.FeatureGroup | null>(null);
  const aquiferLayerRef = useRef<L.FeatureGroup | null>(null);
  const wellLayerRef = useRef<L.FeatureGroup | null>(null);
  const wellLabelLayerRef = useRef<L.FeatureGroup | null>(null);
  const aquiferLabelLayerRef = useRef<L.FeatureGroup | null>(null);

  const visibleWellsRef = useRef<Well[]>([]);
  const onWellBoxSelectRef = useRef(onWellBoxSelect);
  onWellBoxSelectRef.current = onWellBoxSelect;

  const [currentBasemap, setCurrentBasemap] = useState<keyof typeof BASEMAPS>('OpenStreetMap');
  const [isBasemapMenuOpen, setIsBasemapMenuOpen] = useState(false);
  const [minObs, setMinObs] = useState(1);
  const [showAquiferNames, setShowAquiferNames] = useState(true);
  const [showWellIds, setShowWellIds] = useState(false);
  const [showWellNames, setShowWellNames] = useState(false);
  const [labelFontSize, setLabelFontSize] = useState(9);

  // Box-drag selection state
  const [shiftHeld, setShiftHeld] = useState(false);
  const [boxDrag, setBoxDrag] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map('map-container', { boxZoom: false }).setView([37.1, -113.5], 10);

      const basemap = BASEMAPS[currentBasemap];
      basemapLayerRef.current = L.tileLayer(basemap.url, {
        attribution: basemap.attribution
      }).addTo(mapRef.current);

      regionLayerRef.current = L.featureGroup().addTo(mapRef.current);
      aquiferLayerRef.current = L.featureGroup().addTo(mapRef.current);
      aquiferLabelLayerRef.current = L.featureGroup().addTo(mapRef.current);
      wellLayerRef.current = L.featureGroup().addTo(mapRef.current);
      wellLabelLayerRef.current = L.featureGroup().addTo(mapRef.current);

      // Click on empty map space clears well selection
      mapRef.current.on('click', () => {
        onWellBoxSelectRef.current([]);
      });
    }
  }, []);

  // Handle basemap changes
  const changeBasemap = (name: keyof typeof BASEMAPS) => {
    if (!mapRef.current) return;

    if (basemapLayerRef.current) {
      mapRef.current.removeLayer(basemapLayerRef.current);
    }

    const basemap = BASEMAPS[name];
    basemapLayerRef.current = L.tileLayer(basemap.url, {
      attribution: basemap.attribution
    }).addTo(mapRef.current);

    // Move basemap to back so other layers stay on top
    basemapLayerRef.current.bringToBack();

    setCurrentBasemap(name);
  };

  // Update Region Layer
  useEffect(() => {
    if (!regionLayerRef.current || !mapRef.current) return;
    regionLayerRef.current.clearLayers();

    regions.forEach(r => {
      const isSelected = selectedRegion?.id === r.id;
      const layer = L.geoJSON(r.geojson, {
        style: {
          color: isSelected ? '#2563eb' : '#94a3b8',
          weight: isSelected ? 3 : 1,
          fillOpacity: isSelected ? 0.05 : 0.1,
          fillColor: '#2563eb'
        }
      });
      layer.on('click', () => onRegionClick(r));
      regionLayerRef.current?.addLayer(layer);
    });

    if (!selectedRegion && regions.length > 0) {
      const bounds = regionLayerRef.current.getBounds();
      if (bounds.isValid()) mapRef.current.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [regions, selectedRegion]);

  // Update Aquifer Layer (polygons only)
  useEffect(() => {
    if (!aquiferLayerRef.current || !mapRef.current) return;
    aquiferLayerRef.current.clearLayers();

    if (selectedRegion) {
      aquifers.forEach(a => {
        const isSelected = selectedAquifer?.id === a.id;
        const trendColor = aquiferColors?.get(a.id);
        const layer = L.geoJSON(a.geojson, {
          style: {
            color: isSelected ? '#6366f1' : trendColor ? '#000000' : '#475569',
            weight: isSelected ? 5 : trendColor ? 3 : 2,
            fillOpacity: isSelected ? 0 : trendColor ? 0.45 : 0.15,
            fillColor: trendColor || '#64748b'
          }
        });
        layer.on('click', () => onAquiferClick(a));
        aquiferLayerRef.current?.addLayer(layer);
      });

      if (!selectedAquifer && aquifers.length > 0) {
        const bounds = aquiferLayerRef.current.getBounds();
        if (bounds.isValid()) mapRef.current.flyToBounds(bounds, { padding: [40, 40], duration: 1.5 });
      } else if (!selectedAquifer) {
        // Fallback zoom to region
        const rBounds = L.latLngBounds([selectedRegion.bounds[0], selectedRegion.bounds[1]], [selectedRegion.bounds[2], selectedRegion.bounds[3]]);
        mapRef.current.flyToBounds(rBounds, { padding: [40, 40] });
      }
    }
  }, [aquifers, selectedRegion, selectedAquifer, aquiferColors]);

  // Aquifer name labels (separate from polygons so font size changes don't rebuild polygons)
  useEffect(() => {
    aquiferLabelLayerRef.current?.clearLayers();
    if (!showAquiferNames || !selectedRegion) return;

    aquifers.forEach(a => {
      if (selectedAquifer?.id === a.id) return;
      const [lat, lng] = a.labelPoint;
      const aFontSize = Math.round(labelFontSize * 1.2);
      const label = L.marker([lat, lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="white-space:nowrap;font-size:${aFontSize}px;color:#fff;text-shadow:0 0 3px #000,0 0 6px #000;pointer-events:none;font-weight:600;text-align:center">${a.name} (${a.id})</div>`,
          iconSize: [400, 20],
          iconAnchor: [200, 10],
        }),
        interactive: false,
      });
      aquiferLabelLayerRef.current?.addLayer(label);
    });
  }, [aquifers, selectedRegion, selectedAquifer, showAquiferNames, labelFontSize]);

  // Build well markers — only when wells/aquifer/filter changes, NOT on selection change
  const wellMarkerMapRef = useRef<Map<string, L.CircleMarker>>(new Map());

  useEffect(() => {
    if (!wellLayerRef.current || !mapRef.current) return;
    wellLayerRef.current.clearLayers();
    wellMarkerMapRef.current.clear();

    const visible: Well[] = [];
    if (selectedAquifer) {
      wells.forEach(w => {
        const measurementCount = wellMeasurementCounts.get(w.id) || 0;
        if (measurementCount < minObs) return;
        visible.push(w);
        const hasEnoughData = measurementCount >= 2;
        const trendColor = wellColors?.get(w.id);
        const marker = L.circleMarker([w.lat, w.lng], {
          radius: 6,
          fillColor: trendColor || (hasEnoughData ? '#3b82f6' : '#ef4444'),
          color: trendColor ? '#000000' : '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9
        });
        marker.bindTooltip(`Well: ${w.name}<br/>ID: ${w.id}${w.gse ? `<br/>GSE: ${w.gse}` : ''}<br/>Observations: ${measurementCount}`, { direction: 'top' });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const shiftKey = (e as any).originalEvent?.shiftKey ?? false;
          onWellClick(w, shiftKey);
        });
        wellLayerRef.current?.addLayer(marker);
        wellMarkerMapRef.current.set(w.id, marker);
      });

      const aBounds = L.latLngBounds(
        [selectedAquifer.bounds[0], selectedAquifer.bounds[1]],
        [selectedAquifer.bounds[2], selectedAquifer.bounds[3]]
      );
      mapRef.current.flyToBounds(aBounds, { padding: [40, 40], duration: 1 });
    }
    visibleWellsRef.current = visible;
  }, [wells, selectedAquifer, wellMeasurementCounts, minObs, wellColors]);

  // Update marker styles when selection changes — no clearing/recreation
  useEffect(() => {
    const selectedIds = new Set(selectedWells.map(w => w.id));
    wellMarkerMapRef.current.forEach((marker, wellId) => {
      const isSelected = selectedIds.has(wellId);
      const hasTrend = wellColors?.has(wellId);
      marker.setStyle({
        radius: isSelected ? 8 : 6,
        color: isSelected ? '#f59e0b' : hasTrend ? '#000000' : '#ffffff',
        weight: isSelected ? 3 : 2,
      });
    });
  }, [selectedWells, wellColors]);

  // Well labels
  useEffect(() => {
    wellLabelLayerRef.current?.clearLayers();
    if (!showWellIds && !showWellNames) return;
    if (!selectedAquifer) return;

    wellMarkerMapRef.current.forEach((marker, wellId) => {
      const well = wells.find(w => w.id === wellId);
      if (!well) return;

      let text = '';
      if (showWellIds && showWellNames) {
        text = `${well.name} (${well.id})`;
      } else if (showWellNames) {
        text = well.name;
      } else {
        text = well.id;
      }

      const label = L.marker([well.lat, well.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="white-space:nowrap;font-size:${labelFontSize}px;color:#1e293b;text-shadow:0 0 2px #fff,0 0 4px #fff;pointer-events:none;font-weight:500;margin-left:8px;margin-top:-${labelFontSize + 5}px">${text}</div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        interactive: false,
      });
      wellLabelLayerRef.current?.addLayer(label);
    });
  }, [showWellIds, showWellNames, selectedAquifer, wells, minObs, wellMeasurementCounts, labelFontSize]);

  // Track shift key for box-drag overlay
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    const onBlur = () => setShiftHeld(false);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Overlay pointer handlers for box-drag selection
  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const container = mapRef.current?.getContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setBoxDrag({ startX: x, startY: y, curX: x, curY: y });
  };

  const handleOverlayPointerMove = (e: React.PointerEvent) => {
    if (!boxDrag) return;
    const container = mapRef.current?.getContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setBoxDrag(prev => prev ? { ...prev, curX: e.clientX - rect.left, curY: e.clientY - rect.top } : null);
  };

  const handleOverlayPointerUp = (e: React.PointerEvent) => {
    if (!boxDrag) return;
    const map = mapRef.current;
    if (!map) { setBoxDrag(null); return; }

    const container = map.getContainer();
    const rect = container.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    const dx = Math.abs(endX - boxDrag.startX);
    const dy = Math.abs(endY - boxDrag.startY);

    if (dx > 5 || dy > 5) {
      // It was a drag — box select
      const minPx = L.point(Math.min(boxDrag.startX, endX), Math.min(boxDrag.startY, endY));
      const maxPx = L.point(Math.max(boxDrag.startX, endX), Math.max(boxDrag.startY, endY));
      const sw = map.containerPointToLatLng(L.point(minPx.x, maxPx.y));
      const ne = map.containerPointToLatLng(L.point(maxPx.x, minPx.y));
      const selBounds = L.latLngBounds(sw, ne);
      const matched = visibleWellsRef.current.filter(w =>
        selBounds.contains(L.latLng(w.lat, w.lng))
      );
      if (matched.length > 0) {
        onWellBoxSelect(matched);
      }
    } else {
      // It was a click — find nearest well and toggle it
      let nearest: Well | null = null;
      let nearestDist = Infinity;
      for (const w of visibleWellsRef.current) {
        const wellPx = map.latLngToContainerPoint(L.latLng(w.lat, w.lng));
        const dist = Math.sqrt((wellPx.x - endX) ** 2 + (wellPx.y - endY) ** 2);
        if (dist < 20 && dist < nearestDist) {
          nearest = w;
          nearestDist = dist;
        }
      }
      if (nearest) {
        onWellClick(nearest, true);
      }
    }

    setBoxDrag(null);
  };

  // Show overlay when shift is held (or mid-drag even if shift released)
  const showOverlay = (shiftHeld || boxDrag) && selectedAquifer;

  return (
    <div className="relative w-full h-full">
      <div id="map-container" className="w-full h-full" />

      {/* Shift-drag overlay for box selection */}
      {showOverlay && (
        <div
          className="absolute inset-0 z-[500] cursor-crosshair"
          onPointerDown={handleOverlayPointerDown}
          onPointerMove={handleOverlayPointerMove}
          onPointerUp={handleOverlayPointerUp}
        >
          {boxDrag && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(boxDrag.startX, boxDrag.curX),
                top: Math.min(boxDrag.startY, boxDrag.curY),
                width: Math.abs(boxDrag.curX - boxDrag.startX),
                height: Math.abs(boxDrag.curY - boxDrag.startY),
                border: '2px dashed #3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      )}

      {/* Map Options Panel */}
      <div className="absolute bottom-6 left-3 z-[90] flex flex-col gap-1.5 bg-white rounded shadow-md border border-slate-300 px-2 py-1.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <label htmlFor="min-obs" className="text-xs font-medium text-slate-600 whitespace-nowrap">Min obs</label>
            <input
              id="min-obs"
              type="number"
              min={1}
              step={1}
              value={minObs}
              onChange={(e) => setMinObs(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-14 text-xs text-center border border-slate-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <div className="flex items-center gap-1">
            <label htmlFor="label-font" className="text-xs font-medium text-slate-600 whitespace-nowrap">Font</label>
            <input
              id="label-font"
              type="number"
              min={6}
              max={24}
              step={1}
              value={labelFontSize}
              onChange={(e) => setLabelFontSize(Math.max(6, Math.min(24, parseInt(e.target.value) || 9)))}
              className="w-12 text-xs text-center border border-slate-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showAquiferNames} onChange={(e) => setShowAquiferNames(e.target.checked)} className="w-3 h-3" />
            <span className="text-xs text-slate-600">Aquifer names</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showWellIds} onChange={(e) => setShowWellIds(e.target.checked)} className="w-3 h-3" />
            <span className="text-xs text-slate-600">Well IDs</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showWellNames} onChange={(e) => setShowWellNames(e.target.checked)} className="w-3 h-3" />
            <span className="text-xs text-slate-600">Well names</span>
          </label>
        </div>
      </div>

      {/* Basemap Gallery */}
      <div className="absolute top-3 right-3 z-[90]">
        {!isBasemapMenuOpen ? (
          /* Collapsed - just the icon button */
          <button
            onClick={() => setIsBasemapMenuOpen(true)}
            className="flex items-center justify-center w-8 h-8 bg-white rounded shadow-md border border-slate-300 hover:bg-slate-50 transition-colors"
            title="Basemap Gallery"
          >
            <Layers size={16} className="text-slate-600" />
          </button>
        ) : (
          /* Expanded - gallery panel */
          <div className="bg-white rounded shadow-lg border border-slate-300 overflow-hidden" style={{ width: '260px' }}>
            {/* Header with collapse button */}
            <div className="flex items-center justify-end px-2 py-1 bg-white border-b border-slate-200">
              <button
                onClick={() => setIsBasemapMenuOpen(false)}
                className="flex items-center justify-center w-6 h-6 hover:bg-slate-100 rounded transition-colors"
                title="Collapse"
              >
                <ChevronRight size={16} className="text-slate-500" />
              </button>
            </div>

            {/* Basemap List */}
            <div className="max-h-80 overflow-y-auto">
              {Object.entries(BASEMAPS).map(([name, config]) => (
                <button
                  key={name}
                  onClick={() => changeBasemap(name as keyof typeof BASEMAPS)}
                  className={`w-full flex items-center gap-3 p-2 text-left transition-colors border-2 ${
                    currentBasemap === name
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-transparent hover:bg-slate-50'
                  }`}
                >
                  <img
                    src={config.thumbnail}
                    alt={name}
                    className="w-16 h-16 object-cover rounded flex-shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <span className={`text-sm ${
                    currentBasemap === name ? 'font-medium text-slate-900' : 'text-slate-700'
                  }`}>
                    {name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;
