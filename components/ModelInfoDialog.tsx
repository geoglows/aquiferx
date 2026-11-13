import React from 'react';
import { X } from 'lucide-react';
import { ImputationModelMeta, isCurrentModel } from '../types';
import { summarizeChecks, CHECK_YEARS } from '../utils/imputationSeries';

interface ModelInfoDialogProps {
  meta: ImputationModelMeta;
  onClose: () => void;
}

const median = (v: number[]) => {
  if (v.length === 0) return null;
  const s = [...v].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const ModelInfoDialog: React.FC<ModelInfoDialogProps> = ({ meta, onClose }) => {
  const rowCls = "flex justify-between gap-4 py-1 border-b border-slate-100 last:border-0";
  const labelCls = "text-slate-400";
  const valueCls = "text-slate-700 font-medium text-right";

  const current = isCurrentModel(meta);
  const metrics = Object.values(meta.wellMetrics ?? {});
  const wellCount = metrics.length;
  const byMcl = current ? metrics.filter(w => w.filled === 'mc-lnn') : [];
  const medR2 = median(byMcl.map(w => w.r2).filter((v): v is number => v != null));
  const medRmse = median(byMcl.map(w => w.rmse).filter((v): v is number => v != null));
  const checks = current ? summarizeChecks(meta.wellMetrics) : null;
  const p = meta.params;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-800">Model Info</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={20} className="text-slate-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 text-xs space-y-4">
          {/* General */}
          <section>
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">General</h3>
            <div className="space-y-0">
              <div className={rowCls}><span className={labelCls}>Title</span><span className={valueCls}>{meta.title}</span></div>
              <div className={rowCls}><span className={labelCls}>Code</span><span className={valueCls}>{meta.code}</span></div>
              <div className={rowCls}><span className={labelCls}>Data Type</span><span className={valueCls}>{meta.dataType.toUpperCase()}</span></div>
              <div className={rowCls}><span className={labelCls}>Aquifer</span><span className={valueCls}>{meta.aquiferName}</span></div>
              <div className={rowCls}><span className={labelCls}>Created</span><span className={valueCls}>{meta.createdAt ? new Date(meta.createdAt).toLocaleString() : 'N/A'}</span></div>
            </div>
          </section>

          {!current ? (
            <p className="text-slate-500 leading-relaxed">
              Made by the ELM, which Impute Gaps no longer uses, so it can't be opened. Delete it and run Impute Gaps again.
            </p>
          ) : (
            <>
              {/* Settings */}
              <section>
                <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Settings</h3>
                <div className="space-y-0">
                  <div className={rowCls}><span className={labelCls}>Months</span><span className={valueCls}>{p.startDate.slice(0, 7)} to {p.endDate.slice(0, 7)}</span></div>
                  <div className={rowCls}><span className={labelCls}>Wells filled</span><span className={valueCls}>{p.minObservations}+ readings over {p.minTimeSpan}+ years</span></div>
                  <div className={rowCls}><span className={labelCls}>Beyond each record</span><span className={valueCls}>up to {p.holdYears} years</span></div>
                  <div className={rowCls}><span className={labelCls}>Gaps under 6 months</span><span className={valueCls}>PCHIP</span></div>
                  <div className={rowCls}><span className={labelCls}>Longer gaps</span><span className={valueCls}>MC+LNN, else PCHIP</span></div>
                </div>
              </section>

              {/* Wells */}
              <section>
                <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Wells</h3>
                <div className="space-y-0">
                  <div className={rowCls}><span className={labelCls}>Wells filled</span><span className={valueCls}>{wellCount}</span></div>
                  <div className={rowCls}><span className={labelCls}>By MC+LNN</span><span className={valueCls}>{byMcl.length}</span></div>
                  <div className={rowCls}><span className={labelCls}>PCHIP and held readings only</span><span className={valueCls}>{wellCount - byMcl.length}</span></div>
                  {medR2 !== null && (
                    <div className={rowCls} title="From MC+LNN's test values: at each month with readings, its value with that sixth of the record hidden, against the readings">
                      <span className={labelCls}>Median R², MC+LNN</span><span className={valueCls}>{medR2.toFixed(3)}</span>
                    </div>
                  )}
                  {medRmse !== null && (
                    <div className={rowCls}><span className={labelCls}>Median RMSE, MC+LNN</span><span className={valueCls}>{medRmse.toFixed(2)}</span></div>
                  )}
                </div>
              </section>

              {/* Hold-out check */}
              <section>
                <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Hidden Readings Check</h3>
                {checks ? (
                  <>
                    <p className="text-slate-500 mb-2 leading-relaxed">
                      {CHECK_YEARS} years from the middle of each well's record were hidden, filled by MC+LNN and by the PCHIP
                      curve, and compared with the hidden readings.
                    </p>
                    <div className="space-y-0">
                      <div className={rowCls}><span className={labelCls}>Wells checked</span><span className={valueCls}>{checks.wells} of {wellCount}</span></div>
                      <div className={rowCls}><span className={labelCls}>MC+LNN closer</span><span className={valueCls}>{checks.modelCloser} wells ({Math.round((100 * checks.modelCloser) / checks.wells)}%)</span></div>
                      <div className={rowCls}><span className={labelCls}>Median RMSE, MC+LNN</span><span className={valueCls}>{checks.medianModel.toFixed(2)}</span></div>
                      <div className={rowCls}><span className={labelCls}>Median RMSE, PCHIP</span><span className={valueCls}>{checks.medianPchip.toFixed(2)}</span></div>
                    </div>
                  </>
                ) : (
                  <p className="text-slate-500 leading-relaxed">
                    {p.check ? 'No well had enough readings around the middle of its record to hide a stretch.' : 'Not run for this model.'}
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end px-6 py-3 border-t border-slate-200 bg-slate-50">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModelInfoDialog;
