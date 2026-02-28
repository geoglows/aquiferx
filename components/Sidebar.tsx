
import React, { useState, useRef, useEffect } from 'react';
import { Region, Aquifer, RasterAnalysisMeta } from '../types';
import { MapPin, Droplets, List, Box, MoreVertical, Pencil, Trash2, Download, AlertTriangle, Plus, Minus, Layers, Loader2, Info, Check, X as XIcon } from 'lucide-react';

interface SidebarProps {
  regions: Region[];
  selectedRegion: Region | null;
  setSelectedRegion: (r: Region | null) => void;
  aquifers: Aquifer[];
  selectedAquifer: Aquifer | null;
  setSelectedAquifer: (a: Aquifer | null) => void;
  visibleRegionIds: Set<string>;
  onToggleRegionVisibility: (id: string) => void;
  openDataManager: () => void;
  onEditRegion: (id: string, newName: string, lengthUnit: 'ft' | 'm', singleUnit?: boolean) => void;
  onDownloadRegion: (id: string) => void;
  onDeleteRegion: (id: string) => void;
  onRenameAquifer: (id: string, newName: string) => void;
  onDeleteAquifer: (id: string) => void;
  rasterMeta: RasterAnalysisMeta[];
  activeRasterCode: string | null;
  compareRasterCodes: string[];
  loadingRasterCode: string | null;
  onLoadRaster: (meta: RasterAnalysisMeta) => void;
  onUnloadRaster: () => void;
  onToggleCompareRaster: (meta: RasterAnalysisMeta) => void;
  onDeleteRaster: (meta: RasterAnalysisMeta) => void;
  onRenameRaster?: (meta: RasterAnalysisMeta, newTitle: string) => void;
  onGetRasterInfo?: (meta: RasterAnalysisMeta) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  regions,
  selectedRegion,
  setSelectedRegion,
  aquifers,
  selectedAquifer,
  setSelectedAquifer,
  visibleRegionIds,
  onToggleRegionVisibility,
  onEditRegion,
  onDownloadRegion,
  onDeleteRegion,
  onRenameAquifer,
  onDeleteAquifer,
  rasterMeta,
  activeRasterCode,
  compareRasterCodes,
  loadingRasterCode,
  onLoadRaster,
  onUnloadRaster,
  onToggleCompareRaster,
  onDeleteRaster,
  onRenameRaster,
  onGetRasterInfo,
}) => {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [expandedAquiferIds, setExpandedAquiferIds] = useState<Set<string>>(new Set());
  const [editValue, setEditValue] = useState('');
  const [editUnit, setEditUnit] = useState<'ft' | 'm'>('ft');
  const [editSingleUnit, setEditSingleUnit] = useState(false);
  const [showSingleUnitConfirm, setShowSingleUnitConfirm] = useState<'to-single' | 'to-multi' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const editModalRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Focus input when editing starts
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  const startEditRegion = (id: string, region: Region) => {
    setMenuOpen(null);
    setEditing(`region-${id}`);
    setEditValue(region.name);
    setEditUnit(region.lengthUnit);
    setEditSingleUnit(region.singleUnit);
    setShowSingleUnitConfirm(null);
  };

  const startEditAquifer = (id: string, currentName: string) => {
    setMenuOpen(null);
    setEditing(`aquifer-${id}`);
    setEditValue(currentName);
  };

  const confirmEditRegion = (id: string) => {
    const trimmed = editValue.trim();
    if (trimmed) {
      const region = regions.find(r => r.id === id);
      if (trimmed !== region?.name || editUnit !== region?.lengthUnit || editSingleUnit !== region?.singleUnit) {
        onEditRegion(id, trimmed, editUnit, editSingleUnit);
      }
    }
    setEditing(null);
  };

  const handleSingleUnitToggle = () => {
    const regionId = editing?.replace('region-', '');
    const region = regions.find(r => r.id === regionId);
    if (!region) return;

    if (!editSingleUnit) {
      // Switching TO single-unit mode — warn about aquifer data
      setShowSingleUnitConfirm('to-single');
    } else {
      // Switching FROM single-unit — warn that user must re-upload aquifers
      setShowSingleUnitConfirm('to-multi');
    }
  };

  const confirmEditAquifer = (id: string) => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== aquifers.find(a => a.id === id)?.name) {
      onRenameAquifer(id, trimmed);
    }
    setEditing(null);
  };

  const startDelete = (id: string) => {
    setMenuOpen(null);
    setConfirmDelete(id);
  };

  const toggleRasterExpand = (aquiferId: string) => {
    setExpandedAquiferIds(prev => {
      const next = new Set(prev);
      if (next.has(aquiferId)) next.delete(aquiferId);
      else next.add(aquiferId);
      return next;
    });
  };

  return (
    <aside className="w-80 bg-white border-r border-slate-200 flex flex-col shadow-xl z-20">
      <div className="p-6 border-b border-slate-100 flex items-center space-x-3 bg-gradient-to-br from-blue-600 to-indigo-700">
        <Droplets className="text-white" size={28} />
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight leading-none">Aquifer Analyst</h1>
          <p className="text-blue-100 text-[10px] font-medium uppercase mt-1">Groundwater Intelligence</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Regions List */}
        <section>
          <div className="flex items-center space-x-2 mb-3 text-slate-400">
            <MapPin size={16} />
            <h2 className="text-xs font-bold uppercase tracking-widest">Regions</h2>
          </div>
          <div className="space-y-1">
            {regions.map(r => {
              const isSelected = selectedRegion?.id === r.id;
              const isEditing = editing === `region-${r.id}`;
              const isConfirming = confirmDelete === `region-${r.id}`;
              const isMenuOpen = menuOpen === `region-${r.id}`;

              if (isConfirming) {
                return (
                  <div key={r.id} className="px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm">
                    <p className="text-red-700 font-medium mb-2">Delete "{r.name}" and all its data?</p>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => { onDeleteRegion(r.id); setConfirmDelete(null); }}
                        className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
                      >
                        Yes, delete
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-3 py-1 bg-white text-slate-600 rounded text-xs font-medium border border-slate-200 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={r.id} className="relative">
                  <button
                    onClick={() => {
                      setSelectedRegion(isSelected ? null : r);
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between group ${
                      isSelected
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-blue-600'
                    }`}
                  >
                    <div className="flex items-center space-x-2 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={visibleRegionIds.has(r.id)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => onToggleRegionVisibility(r.id)}
                        className="flex-shrink-0 w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                      />
                      <span className="font-medium truncate">{r.name}</span>
                    </div>
                    <div className="flex items-center space-x-1 flex-shrink-0">
                      {isSelected && (
                        <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                      )}
                      <div
                        onClick={e => {
                          e.stopPropagation();
                          setMenuOpen(isMenuOpen ? null : `region-${r.id}`);
                          setConfirmDelete(null);
                        }}
                        className={`p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${
                          isSelected ? 'hover:bg-blue-500' : 'hover:bg-slate-200'
                        } ${isMenuOpen ? 'opacity-100' : ''}`}
                      >
                        <MoreVertical size={14} />
                      </div>
                    </div>
                  </button>
                  {isMenuOpen && (
                    <div ref={menuRef} className="absolute right-2 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[120px]">
                      <button
                        onClick={() => startEditRegion(r.id, r)}
                        className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                      >
                        <Pencil size={12} />
                        <span>Edit</span>
                      </button>
                      <button
                        onClick={() => { setMenuOpen(null); onDownloadRegion(r.id); }}
                        className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                      >
                        <Download size={12} />
                        <span>Download</span>
                      </button>
                      <button
                        onClick={() => startDelete(`region-${r.id}`)}
                        className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                      >
                        <Trash2 size={12} />
                        <span>Delete</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {regions.length === 0 && (
              <p className="text-xs text-slate-400 italic px-3">No regions loaded.</p>
            )}
          </div>
        </section>

        {/* Aquifers List (Populated only if region selected and not single-unit) */}
        {selectedRegion && !selectedRegion.singleUnit && (
          <section className="animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center space-x-2 mb-3 text-slate-400">
              <Droplets size={16} />
              <h2 className="text-xs font-bold uppercase tracking-widest">Aquifers</h2>
            </div>
            <div className="space-y-1">
              {aquifers.map(a => {
                const isSelected = selectedAquifer?.id === a.id;
                const isEditing = editing === `aquifer-${a.id}`;
                const isConfirming = confirmDelete === `aquifer-${a.id}`;
                const isMenuOpen = menuOpen === `aquifer-${a.id}`;
                const aquiferRasters = rasterMeta.filter(m => m.aquiferId === a.id && m.regionId === a.regionId);
                const hasRasters = aquiferRasters.length > 0;
                const isExpanded = expandedAquiferIds.has(a.id);

                if (isConfirming) {
                  return (
                    <div key={a.id} className="px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm">
                      <p className="text-red-700 font-medium mb-2">Delete "{a.name}" and its wells?</p>
                      <div className="flex space-x-2">
                        <button
                          onClick={() => { onDeleteAquifer(a.id); setConfirmDelete(null); }}
                          className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
                        >
                          Yes, delete
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-3 py-1 bg-white text-slate-600 rounded text-xs font-medium border border-slate-200 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={a.id}>
                    <div className="relative">
                      <button
                        onClick={() => {
                          if (!isEditing) setSelectedAquifer(isSelected ? null : a);
                        }}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center group ${
                          isSelected
                            ? 'bg-indigo-500 text-white shadow-md'
                            : 'text-slate-600 hover:bg-slate-50 hover:text-indigo-500'
                        }`}
                      >
                        <List size={14} className={`mr-3 flex-shrink-0 ${isSelected ? 'text-indigo-100' : 'text-slate-300'}`} />
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <input
                              ref={editInputRef}
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') confirmEditAquifer(a.id);
                                if (e.key === 'Escape') setEditing(null);
                              }}
                              onBlur={() => confirmEditAquifer(a.id)}
                              onClick={e => e.stopPropagation()}
                              className="bg-white text-slate-800 border border-indigo-400 rounded px-1.5 py-0.5 text-sm font-medium w-full outline-none focus:ring-2 focus:ring-indigo-300"
                            />
                          ) : (
                            <span className="font-medium truncate block">{a.name}</span>
                          )}
                        </div>
                        {hasRasters && !isEditing && (
                          <div
                            onClick={e => {
                              e.stopPropagation();
                              toggleRasterExpand(a.id);
                            }}
                            className={`w-5 h-5 flex items-center justify-center rounded flex-shrink-0 ml-1 transition-colors cursor-pointer ${
                              isSelected
                                ? 'hover:bg-indigo-400 text-indigo-100'
                                : 'hover:bg-slate-200 text-slate-400'
                            }`}
                            title={isExpanded ? 'Collapse storage analyses' : 'Show storage analyses'}
                          >
                            {isExpanded
                              ? <Minus size={12} />
                              : <Plus size={12} />}
                          </div>
                        )}
                        {!isEditing && (
                          <div
                            onClick={e => {
                              e.stopPropagation();
                              setMenuOpen(isMenuOpen ? null : `aquifer-${a.id}`);
                              setConfirmDelete(null);
                            }}
                            className={`p-0.5 rounded ml-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${
                              isSelected ? 'hover:bg-indigo-400' : 'hover:bg-slate-200'
                            } ${isMenuOpen ? 'opacity-100' : ''}`}
                          >
                            <MoreVertical size={14} />
                          </div>
                        )}
                      </button>
                      {isMenuOpen && (
                        <div ref={menuRef} className="absolute right-2 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[120px]">
                          <button
                            onClick={() => startEditAquifer(a.id, a.name)}
                            className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                          >
                            <Pencil size={12} />
                            <span>Rename</span>
                          </button>
                          <button
                            onClick={() => startDelete(`aquifer-${a.id}`)}
                            className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                          >
                            <Trash2 size={12} />
                            <span>Delete</span>
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Expandable storage analyses list */}
                    {isExpanded && aquiferRasters.length > 0 && (
                      <div className="ml-8 mt-0.5 mb-1 space-y-0.5">
                        {aquiferRasters.map(m => {
                          const isActive = activeRasterCode === m.code;
                          const isCompare = compareRasterCodes.includes(m.code);
                          const isLoading = loadingRasterCode === m.code;
                          const rasterMenuKey = `raster-${m.regionId}-${m.code}`;
                          const isRasterMenuOpen = menuOpen === rasterMenuKey;
                          const isRasterConfirming = confirmDelete === rasterMenuKey;
                          const isRasterEditing = editing === `raster-${m.regionId}-${m.code}`;

                          if (isRasterConfirming) {
                            return (
                              <div key={m.code} className="px-2 py-1.5 rounded bg-red-50 border border-red-200 text-xs">
                                <p className="text-red-700 font-medium mb-1.5">Delete "{m.title}"?</p>
                                <div className="flex space-x-2">
                                  <button
                                    onClick={() => { onDeleteRaster(m); setConfirmDelete(null); }}
                                    className="px-2 py-0.5 bg-red-600 text-white rounded text-[10px] font-medium hover:bg-red-700"
                                  >
                                    Delete
                                  </button>
                                  <button
                                    onClick={() => setConfirmDelete(null)}
                                    className="px-2 py-0.5 bg-white text-slate-600 rounded text-[10px] font-medium border border-slate-200 hover:bg-slate-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          if (isRasterEditing) {
                            return (
                              <div key={m.code} className="flex items-center gap-1 px-1 py-1">
                                <input
                                  autoFocus
                                  value={editValue}
                                  onChange={e => setEditValue(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      const trimmed = editValue.trim();
                                      if (trimmed && trimmed !== m.title && onRenameRaster) {
                                        onRenameRaster(m, trimmed);
                                      }
                                      setEditing(null);
                                    }
                                    if (e.key === 'Escape') setEditing(null);
                                  }}
                                  className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border border-emerald-400 rounded outline-none focus:ring-2 focus:ring-emerald-300"
                                />
                                <button
                                  onClick={() => {
                                    const trimmed = editValue.trim();
                                    if (trimmed && trimmed !== m.title && onRenameRaster) {
                                      onRenameRaster(m, trimmed);
                                    }
                                    setEditing(null);
                                  }}
                                  className="p-0.5 text-emerald-600 hover:bg-emerald-50 rounded"
                                >
                                  <Check size={12} />
                                </button>
                                <button
                                  onClick={() => setEditing(null)}
                                  className="p-0.5 text-slate-400 hover:bg-slate-100 rounded"
                                >
                                  <XIcon size={12} />
                                </button>
                              </div>
                            );
                          }

                          return (
                            <div key={m.code} className="relative group/raster">
                              <div className={`flex items-center rounded transition-colors ${
                                isActive
                                  ? 'bg-emerald-50'
                                  : isCompare
                                    ? 'bg-blue-50'
                                    : 'hover:bg-slate-50'
                              }`}>
                                <button
                                  onClick={(e) => {
                                    if (e.shiftKey && activeRasterCode) {
                                      onToggleCompareRaster(m);
                                    } else if (isActive) {
                                      onUnloadRaster();
                                    } else {
                                      onLoadRaster(m);
                                    }
                                  }}
                                  className={`flex-1 text-left pl-2 pr-1 py-1.5 text-xs flex items-center gap-2 min-w-0 ${
                                    isActive
                                      ? 'text-emerald-700 font-medium'
                                      : isCompare
                                        ? 'text-blue-700 font-medium'
                                        : 'text-slate-500 hover:text-slate-700'
                                  }`}
                                >
                                  {isLoading
                                    ? <Loader2 size={12} className="flex-shrink-0 animate-spin" />
                                    : <Layers size={12} className={`flex-shrink-0 ${isActive ? 'text-emerald-500' : isCompare ? 'text-blue-500' : 'text-slate-300'}`} />}
                                  <span className="truncate">{m.title}</span>
                                  {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />}
                                  {isCompare && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
                                </button>
                                <div
                                  onClick={e => {
                                    e.stopPropagation();
                                    setMenuOpen(isRasterMenuOpen ? null : rasterMenuKey);
                                    setConfirmDelete(null);
                                  }}
                                  className={`p-0.5 rounded mr-1 flex-shrink-0 opacity-0 group-hover/raster:opacity-100 transition-opacity cursor-pointer hover:bg-slate-200 ${
                                    isRasterMenuOpen ? 'opacity-100' : ''
                                  }`}
                                >
                                  <MoreVertical size={12} />
                                </div>
                              </div>
                              {isRasterMenuOpen && (
                                <div ref={menuRef} className="absolute right-1 top-full mt-0.5 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[100px]">
                                  {onRenameRaster && (
                                    <button
                                      onClick={() => {
                                        setMenuOpen(null);
                                        setEditing(`raster-${m.regionId}-${m.code}`);
                                        setEditValue(m.title);
                                      }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                                    >
                                      <Pencil size={11} />
                                      <span>Edit</span>
                                    </button>
                                  )}
                                  {onGetRasterInfo && (
                                    <button
                                      onClick={() => { setMenuOpen(null); onGetRasterInfo(m); }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                                    >
                                      <Info size={11} />
                                      <span>Get Info</span>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => { setMenuOpen(null); setConfirmDelete(rasterMenuKey); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center space-x-2"
                                  >
                                    <Trash2 size={11} />
                                    <span>Delete</span>
                                  </button>
                                </div>
                              )}
                              {/* Hover metadata tooltip */}
                              <div className="absolute left-full ml-2 top-0 hidden group-hover/raster:block z-[60] pointer-events-none">
                                <div className="bg-slate-800 text-white text-[11px] rounded-lg p-3 shadow-xl min-w-[220px] leading-relaxed">
                                  <div className="font-semibold text-emerald-300 mb-1.5">{m.title}</div>
                                  <div><span className="text-slate-400">Dates:</span> {m.params.startDate} &mdash; {m.params.endDate}</div>
                                  <div><span className="text-slate-400">Interval:</span> {m.params.interval}</div>
                                  <div><span className="text-slate-400">Resolution:</span> {m.params.resolution}</div>
                                  <div><span className="text-slate-400">Data Type:</span> {m.dataType.toUpperCase()}</div>
                                  <div className="mt-1.5 text-slate-400 text-[10px]">Created {new Date(m.createdAt).toLocaleDateString()}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {aquifers.length === 0 && (
                <p className="text-xs text-slate-400 italic px-3">No aquifers in this region.</p>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="p-4 bg-slate-50 border-t border-slate-100">
        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm text-center">
          <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Status</p>
          <div className="flex items-center justify-center space-x-2">
            <span className="flex h-2 w-2 rounded-full bg-green-500"></span>
            <span className="text-xs font-medium text-slate-600">Sync Active</span>
          </div>
        </div>
      </div>

      {/* Edit Region Modal */}
      {editing && editing.startsWith('region-') && (() => {
        const regionId = editing.replace('region-', '');
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
            <div ref={editModalRef} className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Edit Region</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
                  <input
                    ref={editInputRef}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') confirmEditRegion(regionId);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Length Unit</label>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={() => setEditUnit('ft')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        editUnit === 'ft'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Feet (ft)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditUnit('m')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        editUnit === 'm'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Meters (m)
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Aquifer Mode</label>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (editSingleUnit) handleSingleUnitToggle();
                      }}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        !editSingleUnit
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Multi-aquifer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!editSingleUnit) handleSingleUnitToggle();
                      }}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        editSingleUnit
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Single-unit
                    </button>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    {editSingleUnit
                      ? 'No aquifer boundaries. All data under a single unit.'
                      : 'Wells and measurements are grouped by aquifer.'}
                  </p>
                </div>
              </div>

              {/* Single-unit mode change confirmation */}
              {showSingleUnitConfirm && (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-amber-800">
                        {showSingleUnitConfirm === 'to-single'
                          ? 'Switch to single-unit mode?'
                          : 'Switch to multi-aquifer mode?'}
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        {showSingleUnitConfirm === 'to-single'
                          ? 'All aquifer assignments in wells and measurements will be set to a single default aquifer. The existing aquifer boundaries will be replaced with a single-unit aquifer.'
                          : 'The single-unit aquifer will be cleared. You will need to upload new aquifer boundaries and re-assign wells.'}
                      </p>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => {
                            setEditSingleUnit(showSingleUnitConfirm === 'to-single');
                            setShowSingleUnitConfirm(null);
                          }}
                          className="px-3 py-1 bg-amber-600 text-white rounded text-xs font-medium hover:bg-amber-700"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setShowSingleUnitConfirm(null)}
                          className="px-3 py-1 bg-white text-slate-600 rounded text-xs font-medium border border-slate-200 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => confirmEditRegion(regionId)}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </aside>
  );
};

export default Sidebar;
