import React from 'react';
import { X } from 'lucide-react';
import { ImputationModelMeta, ImputationWellMetrics } from '../types';

interface ModelInfoDialogProps {
  meta: ImputationModelMeta;
  onClose: () => void;
}

const ModelInfoDialog: React.FC<ModelInfoDialogProps> = ({ meta, onClose }) => {
  const rowCls = "flex justify-between py-1 border-b border-slate-100 last:border-0";
  const labelCls = "text-slate-400";
  const valueCls = "text-slate-700 font-medium";

  const wellCount = Object.keys(meta.wellMetrics).length;
  const metrics = Object.values(meta.wellMetrics) as ImputationWellMetrics[];
  const r2Values = metrics.map(w => w.r2);
  const rmseValues = metrics.map(w => w.rmse);
  const avgR2 = r2Values.length > 0 ? (r2Values.reduce((a, b) => a + b, 0) / r2Values.length) : null;
  const avgRmse = rmseValues.length > 0 ? (rmseValues.reduce((a, b) => a + b, 0) / rmseValues.length) : null;

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

          {/* Parameters */}
          <section>
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Parameters</h3>
            <div className="space-y-0">
              <div className={rowCls}><span className={labelCls}>Output Dates</span><span className={valueCls}>{meta.params.startDate} to {meta.params.endDate}</span></div>
              <div className={rowCls}><span className={labelCls}>Model Months</span><span className={valueCls}>{meta.params.gldasStartDate} to {meta.params.gldasEndDate}</span></div>
              <div className={rowCls}><span className={labelCls}>Min Samples</span><span className={valueCls}>{meta.params.minSamples}</span></div>
              <div className={rowCls}><span className={labelCls}>Gap Size</span><span className={valueCls}>{meta.params.gapSize} days</span></div>
              <div className={rowCls}><span className={labelCls}>Pad Size</span><span className={valueCls}>{meta.params.padSize} days</span></div>
              <div className={rowCls}><span className={labelCls}>Hidden Units</span><span className={valueCls}>{meta.params.hiddenUnits}</span></div>
              <div className={rowCls}><span className={labelCls}>Lambda</span><span className={valueCls}>{meta.params.lambda}</span></div>
            </div>
          </section>

          {/* Well Metrics */}
          <section>
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-2">Well Metrics</h3>
            <div className="space-y-0">
              <div className={rowCls}><span className={labelCls}>Wells Modeled</span><span className={valueCls}>{wellCount}</span></div>
              {avgR2 !== null && (
                <div className={rowCls}><span className={labelCls}>Avg R²</span><span className={valueCls}>{avgR2.toFixed(4)}</span></div>
              )}
              {avgRmse !== null && (
                <div className={rowCls}><span className={labelCls}>Avg RMSE</span><span className={valueCls}>{avgRmse.toFixed(4)}</span></div>
              )}
            </div>
          </section>
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
