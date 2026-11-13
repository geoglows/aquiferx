import React, { useState, useMemo, useRef, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, Play, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Aquifer, Region, Well, Measurement, ImputationModelResult } from '../types';
import { ImputationPipelineInput } from '../services/imputationPipeline';
import { startImputation, AnalysisRun } from '../services/analysisClient';
import { isPipelineCancelled } from '../services/pipelineCancel';
import { slugify } from '../utils/strings';
import PchipPreviewCanvas from './PchipPreviewCanvas';
import { summarizeChecks, CHECK_YEARS } from '../utils/imputationSeries';

interface ImputationWizardProps {
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
  existingModelCodes: string[];
  onClose: () => void;
  onComplete: (result: ImputationModelResult) => void;
}

type Step = 1 | 2 | 'running' | 'complete';

const STEP_LABELS = ['Wells & Options', 'Title & Run'];
const MS_PER_YEAR = 365.25 * 86400000;

const ImputationWizard: React.FC<ImputationWizardProps> = ({
  aquifer, region, wells, measurements, existingModelCodes, onClose, onComplete,
}) => {
  const [step, setStep] = useState<Step>(1);
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [result, setResult] = useState<ImputationModelResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const runRef = useRef<AnalysisRun<ImputationModelResult> | null>(null);

  // --- Log state ---
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [logMessages]);

  // --- Step 1 options: the same two well settings as Spatial Analysis (decision 100a) ---
  const [minObs, setMinObs] = useState(5);
  const [minSpanYears, setMinSpanYears] = useState(5);
  const [holdYears, setHoldYears] = useState(10);
  const [runCheck, setRunCheck] = useState(true);

  // --- Step 2 ---
  const [title, setTitle] = useState('');
  const code = slugify(title);
  const hasConflict = existingModelCodes.includes(code);

  const wellKeySet = useMemo(() => new Set(wells.map(w => `${w.regionId}:${w.aquiferId}:${w.id}`)), [wells]);
  const wteMeasurements = useMemo(() =>
    measurements.filter(m => m.dataType === 'wte' && wellKeySet.has(`${m.regionId}:${m.aquiferId}:${m.wellId}`)),
  [measurements, wellKeySet]);

  // Each well's reading times
  const readingTimes = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const m of wteMeasurements) {
      const t = new Date(m.date).getTime();
      if (isNaN(t) || !Number.isFinite(m.value)) continue;
      let list = out.get(m.wellId);
      if (!list) out.set(m.wellId, list = []);
      list.push(t);
    }
    for (const list of out.values()) list.sort((a, b) => a - b);
    return out;
  }, [wteMeasurements]);

  const usableWellCount = useMemo(() => [...readingTimes.values()].filter(l => l.length >= 2).length, [readingTimes]);

  // The wells the run fills (the pipeline applies the same rule)
  const qualifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, list] of readingTimes) {
      if (list.length >= Math.max(2, minObs) && (list[list.length - 1] - list[0]) / MS_PER_YEAR >= minSpanYears) ids.add(id);
    }
    return ids;
  }, [readingTimes, minObs, minSpanYears]);

  // The model's months: the aquifer's first reading to its last
  const span = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const list of readingTimes.values()) { lo = Math.min(lo, list[0]); hi = Math.max(hi, list[list.length - 1]); }
    return lo === Infinity ? null : { from: new Date(lo).toISOString().slice(0, 7), to: new Date(hi).toISOString().slice(0, 7) };
  }, [readingTimes]);

  // Wells read in each half-year, split into the wells the run fills and the rest
  const densityData = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const list of readingTimes.values()) { lo = Math.min(lo, list[0]); hi = Math.max(hi, list[list.length - 1]); }
    if (lo === Infinity) return [];
    const y0 = new Date(lo).getUTCFullYear(), y1 = new Date(hi).getUTCFullYear();
    const nBins = (y1 - y0 + 1) * 2;
    const filled = new Array(nBins).fill(0), other = new Array(nBins).fill(0);
    for (const [id, list] of readingTimes) {
      const bins = new Set<number>();
      for (const t of list) { const d = new Date(t); bins.add((d.getUTCFullYear() - y0) * 2 + (d.getUTCMonth() < 6 ? 0 : 1)); }
      const into = qualifiedIds.has(id) ? filled : other;
      for (const b of bins) into[b]++;
    }
    return Array.from({ length: nBins }, (_, b) => ({ label: `${y0 + (b >> 1)} ${b & 1 ? 'H2' : 'H1'}`, filled: filled[b], other: other[b] }));
  }, [readingTimes, qualifiedIds]);

  const step1Valid = qualifiedIds.size > 0 && holdYears >= 0;
  const step2Valid = title.trim().length > 0 && !hasConflict;

  const handleRun = async () => {
    if (step === 'running') return; // a run is already in flight
    cancelledRef.current = false;
    setStep('running');
    setErrorMessage(null);
    setLogMessages([]);

    const input: ImputationPipelineInput = { title, minObservations: minObs, minTimeSpan: minSpanYears, holdYears, check: runCheck };

    try {
      // Batch log updates per animation frame — copying the accumulator and re-rendering per message is O(n²) over the run
      const logAccumulator: string[] = [];
      let logFlushScheduled = false;
      const pushLog = (msg: string) => {
        if (cancelledRef.current) return;
        logAccumulator.push(msg);
        if (logFlushScheduled) return;
        logFlushScheduled = true;
        requestAnimationFrame(() => {
          logFlushScheduled = false;
          if (!cancelledRef.current) setLogMessages([...logAccumulator]);
        });
      };

      const run = startImputation(
        { input, aquifer, region, wells, measurements: measurements.filter(m => wellKeySet.has(`${m.regionId}:${m.aquiferId}:${m.wellId}`)) },
        pushLog,
        (stepText, pct) => {
          if (!cancelledRef.current) { setProgressText(stepText); setProgressPct(pct); }
        },
      );
      runRef.current = run;
      const res = await run.promise;
      if (!cancelledRef.current) {
        setLogMessages([...logAccumulator]);
        setResult(res);
        setStep('complete');
      }
    } catch (err) {
      // Cancellation throws to stop the compute — it isn't an error
      if (isPipelineCancelled(err)) return;
      console.error('Imputation failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStep(2);
    } finally {
      runRef.current = null;
    }
  };

  const handleCancel = () => {
    if (step === 'running') {
      cancelledRef.current = true;
      runRef.current?.cancel();
    }
    setStep(1);
    setProgressPct(0);
    setProgressText('');
    setErrorMessage(null);
  };

  const stepNumber = typeof step === 'number' ? step : null;
  const inputCls = "w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500";
  const labelCls = "block text-xs font-medium text-slate-600 mb-1";
  const omitted = readingTimes.size - qualifiedIds.size;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Impute WTE Gaps</h2>
            <p className="text-sm text-slate-500">{aquifer.name} &mdash; {region.name}</p>
          </div>
          <div className="flex items-center gap-4">
            {stepNumber && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {STEP_LABELS.map((label, i) => {
                  const sn = i + 1;
                  const isActive = sn === stepNumber;
                  const isDone = sn < stepNumber;
                  return (
                    <React.Fragment key={i}>
                      {i > 0 && <div className="w-4 h-px bg-slate-300" />}
                      <div className={`flex items-center gap-1 ${isActive ? 'text-amber-600 font-semibold' : isDone ? 'text-amber-500' : 'text-slate-400'}`}>
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                          isActive ? 'bg-amber-600 text-white' : isDone ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-400'
                        }`}>{sn}</div>
                        <span className="hidden sm:inline">{label}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => { cancelledRef.current = true; runRef.current?.cancel(); onClose(); }}
              className="p-1 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X size={20} className="text-slate-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* ===== STEP 1: Wells & Options ===== */}
          {step === 1 && (
            <div className="space-y-5">
              {wteMeasurements.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">
                    Water levels: {qualifiedIds.size} wells to fill (of {usableWellCount} with 2 or more readings)
                  </h3>
                  <div className="h-[180px] bg-slate-50 rounded-lg border border-slate-200">
                    <PchipPreviewCanvas wells={wells} wteMeasurements={wteMeasurements} highlightIds={qualifiedIds} />
                  </div>
                </div>
              )}

              {densityData.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">Wells read in each half-year</h3>
                  <div className="rfs-chart h-[130px] bg-slate-50 rounded-lg border border-slate-200 p-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={densityData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                        <XAxis dataKey="label" stroke="var(--chart-axis)" fontSize={9} interval="preserveStartEnd" />
                        <YAxis stroke="var(--chart-axis)" fontSize={10} />
                        <Tooltip
                          content={({ payload }) => {
                            if (!payload || payload.length === 0) return null;
                            const d = payload[0]?.payload;
                            return (
                              <div className="bg-white rounded shadow-md px-2 py-1 text-[10px] border border-slate-200">
                                <div className="text-slate-700 font-medium">{d?.label}</div>
                                <div className="text-amber-700">{d?.filled} wells to fill</div>
                                <div className="text-slate-500">{d?.other} other wells</div>
                              </div>
                            );
                          }}
                        />
                        <Bar dataKey="filled" stackId="wells" fill="#d97706" fillOpacity={0.8} />
                        <Bar dataKey="other" stackId="wells" fill="#94a3b8" fillOpacity={0.4} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Min Observations / Well</label>
                  <input type="number" value={minObs} min={2} max={500} step={1}
                    onChange={e => setMinObs(Math.max(2, parseInt(e.target.value) || 5))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Min Time Span / Well (years)</label>
                  <input type="number" value={minSpanYears} min={0} max={50} step={1}
                    onChange={e => setMinSpanYears(Math.max(0, parseFloat(e.target.value) || 0))} className={inputCls} />
                </div>
                <div className="col-span-2 flex items-center gap-3 text-xs">
                  <span className="text-amber-600 font-medium">{qualifiedIds.size} wells will be filled</span>
                  {omitted > 0 && <span className="text-slate-400">{omitted} left out</span>}
                </div>
                <div>
                  <label className={labelCls}>Fill beyond each record for up to (years)</label>
                  <input type="number" value={holdYears} min={0} max={50} step={1}
                    onChange={e => setHoldYears(Math.max(0, Math.min(50, parseInt(e.target.value) || 0)))} className={inputCls} />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                    <input type="checkbox" checked={runCheck} onChange={e => setRunCheck(e.target.checked)} className="w-3.5 h-3.5 rounded accent-amber-600" />
                    Check: hide {CHECK_YEARS} years of each well and fill them again (about twice as long)
                  </label>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-start gap-2">
                <Info size={14} className="text-blue-500 mt-0.5 shrink-0" />
                <div className="text-xs text-blue-700 space-y-1">
                  <p>
                    Every month {span ? `from ${span.from} to ${span.to}` : ''} is filled. PCHIP fills gaps under 6 months. MC+LNN fills
                    longer gaps and the years before and after each record, from nearby wells whose readings track the well.
                  </p>
                  <p>
                    A well with fewer than 12 months of readings, or with no such nearby wells, gets PCHIP across all its gaps, and its
                    first and last readings are held before and after its record.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ===== STEP 2: Title & Summary ===== */}
          {step === 2 && (
            <div className="space-y-5">
              {errorMessage && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle size={16} className="text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-800">Imputation Failed</p>
                    <p className="text-xs text-red-600 mt-1">{errorMessage}</p>
                  </div>
                </div>
              )}

              <div>
                <label className={labelCls}>Title</label>
                <input type="text" value={title} onChange={e => setTitle(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
                  placeholder="e.g. Gap filling 2026" className={inputCls} />
                {title && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">{slugify(aquifer.name)}/model_wte_{code}.json</span>
                    {hasConflict && <span className="text-[10px] text-red-500 font-medium">Name already exists</span>}
                  </div>
                )}
              </div>

              <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Options Summary</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600">
                  <div><span className="text-slate-400">Months:</span> {span ? `${span.from} to ${span.to}` : '—'}</div>
                  <div><span className="text-slate-400">Wells:</span> {qualifiedIds.size}, with {minObs}+ readings over {minSpanYears}+ years</div>
                  <div><span className="text-slate-400">Gaps under 6 months:</span> PCHIP</div>
                  <div><span className="text-slate-400">Longer gaps:</span> MC+LNN, else PCHIP</div>
                  <div><span className="text-slate-400">Beyond each record:</span> up to {holdYears} years</div>
                  <div><span className="text-slate-400">Check:</span> {runCheck ? `${CHECK_YEARS} years hidden per well` : 'off'}</div>
                </div>
              </div>
            </div>
          )}

          {/* ===== RUNNING ===== */}
          {step === 'running' && (
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center py-6 space-y-3">
                <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
                <p className="text-sm text-slate-600">{progressText}</p>
                <div className="w-80 bg-slate-200 rounded-full h-2.5">
                  <div className="bg-amber-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
                </div>
                <p className="text-xs text-slate-400">{Math.round(progressPct)}%</p>
              </div>
              <div className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-slate-100 text-[10px] text-slate-500 font-mono">Log</div>
                <div ref={logContainerRef} className="h-[200px] overflow-y-auto px-3 py-2 font-mono text-[11px] text-slate-600 space-y-0.5">
                  {logMessages.map((msg, i) => <div key={i} className={msg.startsWith('ERROR') ? 'text-red-600' : ''}>{msg}</div>)}
                </div>
              </div>
            </div>
          )}

          {/* ===== COMPLETE ===== */}
          {step === 'complete' && result && (
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center py-8 space-y-3">
                <CheckCircle2 className="w-12 h-12 text-amber-500" />
                <h3 className="text-lg font-semibold text-slate-800">Imputation Complete</h3>
                <div className="text-sm text-slate-600 text-center space-y-1">
                  {(() => {
                    const metrics = Object.values(result.wellMetrics);
                    const byMcl = metrics.filter(m => m.filled === 'mc-lnn').length;
                    return <p>{metrics.length} wells filled, {byMcl} by MC+LNN and {metrics.length - byMcl} by PCHIP and held readings only</p>;
                  })()}
                  {(() => {
                    const c = summarizeChecks(result.wellMetrics);
                    return c && (
                      <p>
                        Hidden readings check: MC+LNN was closer than PCHIP at {c.modelCloser} of {c.wells} wells
                        (median RMSE {c.medianModel.toFixed(2)} vs {c.medianPchip.toFixed(2)})
                      </p>
                    );
                  })()}
                  <p>{result.params.startDate.slice(0, 7)} to {result.params.endDate.slice(0, 7)}</p>
                  <p>{result.aquiferName}</p>
                </div>
              </div>
              <details className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                <summary className="px-3 py-1.5 bg-slate-100 text-[10px] text-slate-500 font-mono cursor-pointer hover:bg-slate-200">
                  Processing Log ({logMessages.length} entries)
                </summary>
                <div className="h-[150px] overflow-y-auto px-3 py-2 font-mono text-[11px] text-slate-600 space-y-0.5">
                  {logMessages.map((msg, i) => <div key={i} className={msg.startsWith('ERROR') ? 'text-red-600' : ''}>{msg}</div>)}
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-slate-50">
          <div>
            {(stepNumber || step === 'running') && (
              <button onClick={step === 'running' ? handleCancel : onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Cancel
              </button>
            )}
          </div>
          <div>
            {stepNumber && stepNumber > 1 && (
              <button onClick={() => setStep((stepNumber - 1) as Step)}
                className="flex items-center gap-1 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                <ChevronLeft size={16} />
                Back
              </button>
            )}
          </div>
          <div>
            {step === 1 && (
              <button onClick={() => setStep(2)} disabled={!step1Valid}
                className="flex items-center gap-1 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Next
                <ChevronRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button onClick={handleRun} disabled={!step2Valid}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Play size={16} />
                Run Imputation
              </button>
            )}
            {step === 'running' && <div />}
            {step === 'complete' && result && (
              <button onClick={() => onComplete(result)}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors">
                View Results
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImputationWizard;
