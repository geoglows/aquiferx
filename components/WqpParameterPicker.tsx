import React, { useState, useEffect, useMemo } from 'react';
import { X, Search, ChevronRight, ChevronDown, Loader2, Info } from 'lucide-react';
import { ParameterCatalog, CatalogParameter } from '../types';
import { loadCatalog, groupCatalog, epaLabel, EPA_WHO_NOTE } from '../services/catalog';
import { listWqpDownloadableCodes } from '../services/wqpApi';

interface WqpParameterPickerProps {
  /** Catalog codes that should start out checked. */
  initialSelected?: string[];
  /** Called when the user clicks Apply with the chosen codes. */
  onApply: (codes: string[]) => void;
  onClose: () => void;
}

type GroupEntry = { code: string; param: CatalogParameter };
type Grouped = Record<string, GroupEntry[]>;

const WqpParameterPicker: React.FC<WqpParameterPickerProps> = ({ initialSelected = [], onApply, onClose }) => {
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  useEffect(() => {
    loadCatalog().then(cat => {
      setCatalog(cat);
      setExpandedGroups(new Set(Object.keys(groupCatalog(cat))));
    }).catch(() => setCatalog({ parameters: {} }));
  }, []);

  // Restrict to catalog entries that actually map to a WQP CharacteristicName.
  // Anything else is unreachable from a WQP download.
  const downloadableCodes = useMemo<Set<string>>(
    () => new Set(catalog ? listWqpDownloadableCodes(catalog) : []),
    [catalog]
  );

  const grouped = useMemo<Grouped>(() => {
    if (!catalog) return {};
    const all = groupCatalog(catalog);
    const filtered: Grouped = {};
    for (const group of Object.keys(all)) {
      const entries = all[group].filter(({ code }) => downloadableCodes.has(code));
      if (entries.length > 0) filtered[group] = entries;
    }
    return filtered;
  }, [catalog, downloadableCodes]);

  const normalizedQuery = query.toLowerCase().trim();
  const filteredGroups = useMemo<Grouped>(() => {
    if (!normalizedQuery) return grouped;
    const result: Grouped = {};
    for (const group of Object.keys(grouped)) {
      const matches = grouped[group].filter(({ code, param }) =>
        code.toLowerCase().includes(normalizedQuery) ||
        param.name.toLowerCase().includes(normalizedQuery) ||
        (param.wqp?.characteristicName || '').toLowerCase().includes(normalizedQuery)
      );
      if (matches.length > 0) result[group] = matches;
    }
    return result;
  }, [grouped, normalizedQuery]);

  const totalDownloadable = Object.keys(grouped).reduce((sum, g) => sum + grouped[g].length, 0);
  const totalShown = Object.keys(filteredGroups).reduce((sum, g) => sum + filteredGroups[g].length, 0);

  // Auto-expand matching groups when filtering
  const effectiveExpanded = normalizedQuery ? new Set(Object.keys(filteredGroups)) : expandedGroups;

  const toggleGroup = (g: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  };

  const toggleCode = (code: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const setGroupSelection = (group: string, on: boolean) => {
    const entries = grouped[group] || [];
    setSelected(prev => {
      const next = new Set(prev);
      for (const { code } of entries) {
        if (on) next.add(code); else next.delete(code);
      }
      return next;
    });
  };

  const selectAll = () => {
    const all: string[] = [];
    for (const g of Object.keys(grouped)) for (const e of grouped[g]) all.push(e.code);
    setSelected(new Set(all));
  };
  const selectNone = () => setSelected(new Set());

  const groupNames = Object.keys(filteredGroups).sort();

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Select Water Quality Parameters</h2>
            <p className="text-xs text-slate-500">
              {catalog
                ? `${selected.size} selected · ${totalShown}${normalizedQuery ? ` of ${totalDownloadable}` : ''} parameters available from WQP`
                : 'Loading…'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Info banner */}
        <div className="px-6 pt-3">
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
            <Info size={14} className="mt-0.5 shrink-0" />
            <p>
              Pick the parameters to download from the Water Quality Portal.
              Only catalog entries that map to a WQP characteristic appear here —
              custom (non-catalog) parameters aren't reachable from WQP.
            </p>
          </div>
        </div>

        {/* Search + bulk toggles */}
        <div className="px-6 pt-3 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name, code, or WQP characteristic..."
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">Bulk:</span>
            <button onClick={selectAll}
              className="px-2 py-0.5 bg-white border border-slate-300 rounded hover:bg-slate-50 text-slate-700">
              Select all
            </button>
            <button onClick={selectNone}
              className="px-2 py-0.5 bg-white border border-slate-300 rounded hover:bg-slate-50 text-slate-700">
              None
            </button>
          </div>
        </div>

        {/* Groups */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          <p className="text-[11px] text-slate-500 mb-2">{EPA_WHO_NOTE}</p>
          {!catalog ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : groupNames.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 italic">
              {normalizedQuery
                ? `No parameters match "${query}".`
                : 'No WQP-downloadable parameters in the catalog.'}
            </p>
          ) : (
            <div className="space-y-2">
              {groupNames.map(group => {
                const entries = filteredGroups[group];
                const expanded = effectiveExpanded.has(group);
                const allEntries = grouped[group] || [];
                const selectedInGroup = allEntries.filter(e => selected.has(e.code)).length;
                const groupAllOn = selectedInGroup === allEntries.length && allEntries.length > 0;
                const groupSomeOn = selectedInGroup > 0 && !groupAllOn;
                return (
                  <div key={group} className="border border-slate-200 rounded-lg">
                    <div className="flex items-center px-3 py-2 hover:bg-slate-50">
                      {/* Tri-state group checkbox (toggles entire group, ignores filter) */}
                      <input
                        type="checkbox"
                        checked={groupAllOn}
                        ref={el => { if (el) el.indeterminate = groupSomeOn; }}
                        onChange={e => setGroupSelection(group, e.target.checked)}
                        onClick={e => e.stopPropagation()}
                        className="mr-2 text-blue-600 rounded"
                      />
                      <button
                        onClick={() => toggleGroup(group)}
                        className="flex-1 flex items-center justify-between text-left text-sm font-medium text-slate-700"
                      >
                        <span className="flex items-center gap-1">
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {group}
                        </span>
                        <span className="text-xs text-slate-400">
                          {selectedInGroup > 0 && <span className="text-blue-600 mr-1">{selectedInGroup}/</span>}
                          {entries.length}
                        </span>
                      </button>
                    </div>
                    {expanded && (
                      <table className="w-full text-xs border-t border-slate-100">
                        <thead>
                          <tr className="text-left text-slate-400">
                            <th className="py-1.5 pl-9 pr-2 font-medium">Name</th>
                            <th className="py-1.5 pr-2 font-medium">Code</th>
                            <th className="py-1.5 pr-2 font-medium">Unit</th>
                            <th className="py-1.5 pr-2 font-medium">EPA</th>
                            <th className="py-1.5 pr-3 font-medium">WHO</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map(({ code, param }) => {
                            const isSelected = selected.has(code);
                            return (
                              <tr
                                key={code}
                                onClick={() => toggleCode(code)}
                                className={`border-t border-slate-50 cursor-pointer ${isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                              >
                                <td className="py-1.5 pl-3 pr-2">
                                  <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => toggleCode(code)}
                                      onClick={e => e.stopPropagation()}
                                      className="text-blue-600 rounded"
                                    />
                                    {param.name}
                                  </label>
                                </td>
                                <td className="py-1.5 pr-2 font-mono text-slate-500">{code}</td>
                                <td className="py-1.5 pr-2 text-slate-600">{param.unit || '—'}</td>
                                <td className="py-1.5 pr-2 text-slate-600">{epaLabel(param)}</td>
                                <td className="py-1.5 pr-3 text-slate-600">{param.who ?? '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {selected.size === 0
              ? 'Pick at least one parameter to enable Apply.'
              : `${selected.size} parameter${selected.size === 1 ? '' : 's'} will be downloaded.`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={() => onApply(Array.from(selected))}
              disabled={selected.size === 0}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50">
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WqpParameterPicker;
