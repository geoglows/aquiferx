
import React, { useEffect, useRef, useMemo, useState } from 'react';
import L from 'leaflet';
import { Layers, ChevronRight } from 'lucide-react';
import { Region, Aquifer, Well, Measurement } from '../types';

const BASEMAPS = {
  'Topographic': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/67372ff42cd145319639a99152b15bc3/info/thumbnail/ago_downloaded.png'
  },
  'Imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9/info/thumbnail/ago_downloaded.png'
  },
  'Streets': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/3b93337983e9436f8db950e38a8629af/info/thumbnail/ago_downloaded.png'
  },
  'Light Gray': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/8b3d38c0819547faa83f7b7aca80bd76/info/thumbnail/ago_downloaded.png'
  },
  'Dark Gray': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    thumbnail: 'https://www.arcgis.com/sharing/rest/content/items/358ec1e175ea41c3bf5c68f0da11ae2b/info/thumbnail/ago_downloaded.png'
  },
  'Terrain': {
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
  onRegionClick,
  onAquiferClick,
  onWellClick,
  onWellBoxSelect
}) => {
  // Count measurements per well
  const wellMeasurementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of measurements) {
      counts.set(m.wellId, (counts.get(m.wellId) || 0) + 1);
    }
    return counts;
  }, [measurements]);
  const mapRef = useRef<L.Map | null>(null);
  const basemapLayerRef = useRef<L.TileLayer | null>(null);
  const regionLayerRef = useRef<L.FeatureGroup | null>(null);
  const aquiferLayerRef = useRef<L.FeatureGroup | null>(null);
  const wellLayerRef = useRef<L.FeatureGroup | null>(null);

  const visibleWellsRef = useRef<Well[]>([]);
  const onWellBoxSelectRef = useRef(onWellBoxSelect);
  onWellBoxSelectRef.current = onWellBoxSelect;

  const [currentBasemap, setCurrentBasemap] = useState<keyof typeof BASEMAPS>('Topographic');
  const [isBasemapMenuOpen, setIsBasemapMenuOpen] = useState(false);
  const [minObs, setMinObs] = useState(1);

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
      wellLayerRef.current = L.featureGroup().addTo(mapRef.current);

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

  // Update Aquifer Layer
  useEffect(() => {
    if (!aquiferLayerRef.current || !mapRef.current) return;
    aquiferLayerRef.current.clearLayers();

    if (selectedRegion) {
      aquifers.forEach(a => {
        const isSelected = selectedAquifer?.id === a.id;
        const layer = L.geoJSON(a.geojson, {
          style: {
            color: isSelected ? '#6366f1' : '#475569',
            weight: 2,
            fillOpacity: isSelected ? 0.3 : 0.15,
            fillColor: isSelected ? '#6366f1' : '#64748b'
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
  }, [aquifers, selectedRegion, selectedAquifer]);

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
        const marker = L.circleMarker([w.lat, w.lng], {
          radius: 6,
          fillColor: hasEnoughData ? '#3b82f6' : '#ef4444',
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.8
        });
        marker.bindTooltip(`Well: ${w.name}<br/>ID: ${w.id}<br/>Measurements: ${measurementCount}`, { direction: 'top' });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const shiftKey = (e as any).originalEvent?.shiftKey ?? false;
          onWellClick(w, shiftKey);
        });
        wellLayerRef.current?.addLayer(marker);
        wellMarkerMapRef.current.set(w.id, marker);
      });

      if (wells.length > 0) {
        const bounds = wellLayerRef.current.getBounds();
        if (bounds.isValid()) mapRef.current.flyToBounds(bounds, { padding: [100, 100], duration: 1 });
      } else {
        const aBounds = L.latLngBounds([selectedAquifer.bounds[0], selectedAquifer.bounds[1]], [selectedAquifer.bounds[2], selectedAquifer.bounds[3]]);
        mapRef.current.flyToBounds(aBounds, { padding: [40, 40] });
      }
    }
    visibleWellsRef.current = visible;
  }, [wells, selectedAquifer, wellMeasurementCounts, minObs]);

  // Update marker styles when selection changes — no clearing/recreation
  useEffect(() => {
    const selectedIds = new Set(selectedWells.map(w => w.id));
    wellMarkerMapRef.current.forEach((marker, wellId) => {
      const isSelected = selectedIds.has(wellId);
      marker.setStyle({
        radius: isSelected ? 8 : 6,
        color: isSelected ? '#f59e0b' : '#ffffff',
        weight: isSelected ? 3 : 2,
      });
    });
  }, [selectedWells]);

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

      {/* Min Obs Control */}
      <div className="absolute bottom-6 left-3 z-[1000] flex items-center gap-2 bg-white rounded shadow-md border border-slate-300 px-2 py-1">
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

      {/* Basemap Gallery */}
      <div className="absolute top-3 right-3 z-[1000]">
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
