import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { fetchGseBatch } from '../services/gseLookup';
import { readFile, saveFiles } from '../services/dataStore';
import { parseCSV, toCsv, WELLS_CSV_HEADERS } from '../services/importUtils';
import { hasGse } from '../utils/geo';

interface MissingElevationsDialogProps {
  regionId: string;
  regionName: string;
  lengthUnit: 'ft' | 'm';
  onClose: () => void;
  /** After elevations were saved, so the app reloads the region */
  onSaved: () => void;
}

type State =
  | { step: 'running'; done: number; total: number }
  | { step: 'finished'; found: number; total: number; source: string }
  | { step: 'failed'; message: string };

/**
 * Looks up the ground surface elevation of every well in a My Data region
 * that has none, as the well importer does for a new file, and writes them
 * into wells.csv. Elevations already there are kept.
 */
const MissingElevationsDialog: React.FC<MissingElevationsDialogProps> = ({ regionId, regionName, lengthUnit, onClose, onSaved }) => {
  const [state, setState] = useState<State>({ step: 'running', done: 0, total: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const path = `${regionId}/wells.csv`;
        const file = await readFile(path);
        if (!file) throw new Error('The region has no wells.');
        const { rows } = parseCSV(file.text);
        const missing = rows
          .filter(r => r.well_id && !hasGse(parseFloat(r.gse)))
          .map(r => ({ id: r.well_id, lat: parseFloat(r.lat), lng: parseFloat(r.long) }))
          .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng));
        if (current) setState({ step: 'running', done: 0, total: missing.length });
        const { values, source } = await fetchGseBatch(missing, {
          lengthUnit,
          onProgress: (done, total) => { if (current) setState({ step: 'running', done, total }); },
        });
        // Closed or retried meanwhile: drop this run's result
        if (!current) return;
        let found = 0;
        const filled = rows.map(r => {
          const v = values.get(r.well_id);
          if (v === undefined || !hasGse(v) || hasGse(parseFloat(r.gse))) return r;
          found++;
          return { ...r, gse: String(v) };
        });
        // Saved against the version read, so a change made meanwhile is not overwritten
        if (found > 0) {
          await saveFiles([{ path, content: toCsv(WELLS_CSV_HEADERS, filled), ifVersion: file.version }]);
          onSaved();
        }
        if (current) setState({ step: 'finished', found, total: missing.length, source });
      } catch (err) {
        if (current) setState({ step: 'failed', message: String(err instanceof Error ? err.message : err) });
      }
    })();
    return () => { current = false; };
  }, [regionId, lengthUnit, attempt]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-slate-800 mb-3">Missing elevations in {regionName}</h3>
        {state.step === 'running' && (
          <p className="text-sm text-slate-600 mb-6 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin shrink-0" />
            {state.total > 0
              ? <>Looking up {state.total.toLocaleString()} well{state.total !== 1 ? 's' : ''}: {state.done.toLocaleString()} done</>
              : 'Reading the wells'}
          </p>
        )}
        {state.step === 'finished' && (
          <div className="text-sm text-slate-600 mb-6 space-y-2">
            {state.total === 0 ? (
              <p>Every well in the region has an elevation.</p>
            ) : (
              <>
                <p className="flex items-start gap-2">
                  {state.found > 0
                    ? <CheckCircle2 size={14} className="text-green-600 mt-0.5 shrink-0" />
                    : <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />}
                  <span>
                    Found {state.found.toLocaleString()} of {state.total.toLocaleString()}
                    {state.source && <>, from {state.source}</>}.
                    {state.found < state.total && ' The rest still have none.'}
                  </span>
                </p>
                {state.found > 0 && (
                  <p className="text-xs text-slate-500">
                    Depths to water skipped earlier for these wells can be added now: add the file of depths again with
                    Add new only.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {state.step === 'failed' && (
          <p className="text-sm text-red-600 mb-6 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>The lookup failed: {state.message}</span>
          </p>
        )}
        <div className="flex justify-end space-x-3">
          {state.step === 'failed' && (
            <button
              onClick={() => { setState({ step: 'running', done: 0, total: 0 }); setAttempt(a => a + 1); }}
              className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Try again
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-blue-600 hover:bg-blue-700"
          >
            {state.step === 'running' ? 'Cancel' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MissingElevationsDialog;
