
import React, { useState, useRef, useEffect } from 'react';
import { Region, Aquifer } from '../types';
import { MapPin, Droplets, List, Box, MoreVertical, Pencil, Trash2 } from 'lucide-react';

interface SidebarProps {
  regions: Region[];
  selectedRegion: Region | null;
  setSelectedRegion: (r: Region | null) => void;
  aquifers: Aquifer[];
  selectedAquifer: Aquifer | null;
  setSelectedAquifer: (a: Aquifer | null) => void;
  openDataManager: () => void;
  onRenameRegion: (id: string, newName: string) => void;
  onDeleteRegion: (id: string) => void;
  onRenameAquifer: (id: string, newName: string) => void;
  onDeleteAquifer: (id: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  regions,
  selectedRegion,
  setSelectedRegion,
  aquifers,
  selectedAquifer,
  setSelectedAquifer,
  onRenameRegion,
  onDeleteRegion,
  onRenameAquifer,
  onDeleteAquifer,
}) => {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

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

  const startEdit = (id: string, currentName: string) => {
    setMenuOpen(null);
    setEditing(id);
    setEditValue(currentName);
  };

  const confirmEditRegion = (id: string) => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== regions.find(r => r.id === id)?.name) {
      onRenameRegion(id, trimmed);
    }
    setEditing(null);
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
                      if (!isEditing) setSelectedRegion(isSelected ? null : r);
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between group ${
                      isSelected
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-blue-600'
                    }`}
                  >
                    <div className="flex items-center space-x-3 min-w-0 flex-1">
                      <Box size={14} className={`flex-shrink-0 ${isSelected ? 'text-blue-100' : 'text-slate-300'}`} />
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') confirmEditRegion(r.id);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          onBlur={() => confirmEditRegion(r.id)}
                          onClick={e => e.stopPropagation()}
                          className="bg-white text-slate-800 border border-blue-400 rounded px-1.5 py-0.5 text-sm font-medium w-full outline-none focus:ring-2 focus:ring-blue-300"
                        />
                      ) : (
                        <span className="font-medium truncate">{r.name}</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 flex-shrink-0">
                      {isSelected && !isEditing && (
                        <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                      )}
                      {!isEditing && (
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
                      )}
                    </div>
                  </button>
                  {isMenuOpen && (
                    <div ref={menuRef} className="absolute right-2 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[120px]">
                      <button
                        onClick={() => startEdit(`region-${r.id}`, r.name)}
                        className="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
                      >
                        <Pencil size={12} />
                        <span>Rename</span>
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

        {/* Aquifers List (Populated only if region selected) */}
        {selectedRegion && (
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
                  <div key={a.id} className="relative">
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
                      {!isEditing && (
                        <div
                          onClick={e => {
                            e.stopPropagation();
                            setMenuOpen(isMenuOpen ? null : `aquifer-${a.id}`);
                            setConfirmDelete(null);
                          }}
                          className={`p-0.5 rounded ml-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${
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
                          onClick={() => startEdit(`aquifer-${a.id}`, a.name)}
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
    </aside>
  );
};

export default Sidebar;
