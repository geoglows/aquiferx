import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { X, Play, Loader2, CheckCircle2 } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { Aquifer, Region, Well, Measurement, StorageAnalysisResult, StorageAnalysisParams } from '../types';
import { interpolatePCHIP } from '../utils/interpolation';
import { runStorageAnalysis } from '../services/storageAnalysis';
import { slugify } from '../utils/strings';

const PREVIEW_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48',
  '#a855f7', '#22c55e', '#eab308', '#0ea5e9',
];

interface StorageAnalysisDialogProps {
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
  existingCodes: string[];
  onClose: () => void;
  onComplete: (result: StorageAnalysisResult) => void;
}

type Step = 'options' | 'running' | 'complete';

// Canvas-based PCHIP preview — handles hundreds of wells without crashing
const PchipPreviewCanvas: React.FC<{
  wells: Well[];
  wteMeasurements: Measurement[];
  startTs?: number;
  endTs?: number;
}> = ({ wells, wteMeasurements, startTs, endTs }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute PCHIP series per well (lightweight: just arrays, not Recharts data objects)
  const wellSeries = useMemo(() => {
    const byWell = new Map<string, Measurement[]>();
    for (const m of wteMeasurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    const series: { points: [number, number][]; color: string }[] = [];
    let colorIdx = 0;

    for (const [wellId, meas] of byWell) {
      const sorted = [...meas]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (sorted.length < 2) continue;

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.value);
      const minX = xValues[0];
      const maxX = xValues[xValues.length - 1];
      if (maxX - minX === 0) continue;

      // Use fewer interpolation points per well for performance
      const nPoints = Math.min(50, sorted.length * 3);
      const step = (maxX - minX) / nPoints;
      const targetX: number[] = [];
      for (let x = minX; x <= maxX; x += step) targetX.push(x);

      const interpolatedY = interpolatePCHIP(xValues, yValues, targetX);
      const points: [number, number][] = targetX.map((x, i) => [x, interpolatedY[i]]);

      series.push({ points, color: PREVIEW_COLORS[colorIdx % PREVIEW_COLORS.length] });
      colorIdx++;
    }

    return series;
  }, [wteMeasurements]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const margin = { top: 10, right: 10, bottom: 25, left: 50 };
    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;

    // Find global data bounds
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of wellSeries) {
      for (const [x, y] of s.points) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (xMin >= xMax || yMin >= yMax) return;

    // Add 5% Y padding
    const yPad = (yMax - yMin) * 0.05 || 1;
    yMin -= yPad;
    yMax += yPad;

    const toX = (v: number) => margin.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const toY = (v: number) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = margin.top + (i / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(W - margin.right, y);
      ctx.stroke();
    }

    // Date range markers
    if (startTs !== undefined) {
      const sx = toX(startTs);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, margin.top);
      ctx.lineTo(sx, margin.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (endTs !== undefined) {
      const ex = toX(endTs);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ex, margin.top);
      ctx.lineTo(ex, margin.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw wells
    for (const s of wellSeries) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const px = toX(s.points[i][0]);
        const py = toY(s.points[i][1]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // X-axis labels (years)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const startYear = new Date(xMin).getFullYear();
    const endYear = new Date(xMax).getFullYear();
    const yearStep = Math.max(1, Math.round((endYear - startYear) / 8));
    for (let y = startYear; y <= endYear; y += yearStep) {
      const t = new Date(y, 0, 1).getTime();
      const px = toX(t);
      if (px >= margin.left && px <= W - margin.right) {
        ctx.fillText(String(y), px, H - 5);
      }
    }

    // Y-axis labels
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = yMin + (1 - i / 4) * (yMax - yMin);
      const py = margin.top + (i / 4) * plotH;
      ctx.fillText(val.toFixed(0), margin.left - 4, py + 3);
    }
  }, [wellSeries, startTs, endTs]);

  useEffect(() => {
    // Defer initial draw so the modal has finished layout
    const raf = requestAnimationFrame(() => draw());
    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', handleResize);
    };
  }, [draw]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
};

const StorageAnalysisDialog: React.FC<StorageAnalysisDialogProps> = ({
  aquifer, region, wells, measurements, existingCodes, onClose, onComplete,
}) => {
  const [step, setStep] = useState<Step>('options');
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [result, setResult] = useState<StorageAnalysisResult | null>(null);
  const cancelledRef = useRef(false);

  // Options state
  const [title, setTitle] = useState('');
  const [resolution, setResolution] = useState(50);
  const [storageCoeff, setStorageCoeff] = useState(0.15);
  const [interval, setInterval] = useState<'3months' | '6months' | '1year'>('1year');
  const [volumeUnit, setVolumeUnit] = useState(region.lengthUnit === 'ft' ? 'acre-ft' : 'MCM');
  const [minObs, setMinObs] = useState(5);
  const [minSpanYears, setMinSpanYears] = useState(5);
  const [smoothingMethod, setSmoothingMethod] = useState<'pchip' | 'moving-average'>('pchip');
  const [smoothingMonths, setSmoothingMonths] = useState(12);

  // Build well ID set for fast lookup
  const wellIdSet = useMemo(() => new Set(wells.map(w => w.id)), [wells]);

  // Compute WTE measurements for this aquifer
  const wteMeasurements = useMemo(() =>
    measurements.filter(m => m.dataType === 'wte' && wellIdSet.has(m.wellId)),
  [measurements, wellIdSet]);

  // Data density analysis: 6-month bins
  const { densityData, defaultStartDate, defaultEndDate } = useMemo(() => {
    const byWellDate = new Map<string, Set<string>>();
    for (const m of wteMeasurements) {
      if (!byWellDate.has(m.wellId)) byWellDate.set(m.wellId, new Set());
      byWellDate.get(m.wellId)!.add(m.date);
    }

    // Find overall date range
    let allMin = Infinity, allMax = -Infinity;
    for (const m of wteMeasurements) {
      const t = new Date(m.date).getTime();
      if (!isNaN(t)) {
        if (t < allMin) allMin = t;
        if (t > allMax) allMax = t;
      }
    }

    if (allMin === Infinity) {
      return { densityData: [], defaultStartDate: '', defaultEndDate: '' };
    }

    const minYear = new Date(allMin).getFullYear();
    const maxYear = new Date(allMax).getFullYear();
    const minDateStr = `${minYear}-01-01`;
    const maxDateStr = `${maxYear + 1}-01-01`;

    // Build bins
    const bins: { label: string; start: Date; end: Date }[] = [];
    for (let y = minYear; y <= maxYear; y++) {
      bins.push({ label: `${y} H1`, start: new Date(y, 0, 1), end: new Date(y, 6, 1) });
      bins.push({ label: `${y} H2`, start: new Date(y, 6, 1), end: new Date(y + 1, 0, 1) });
    }

    // Count wells per bin
    const densityData = bins.map(bin => {
      const wellsInBin = new Set<string>();
      for (const [wellId, dates] of byWellDate) {
        for (const d of dates) {
          const t = new Date(d);
          if (t >= bin.start && t < bin.end) {
            wellsInBin.add(wellId);
            break;
          }
        }
      }
      return { label: bin.label, count: wellsInBin.size, startTs: bin.start.getTime() };
    }).filter(b => b.startTs >= allMin - 365 * 86400000 && b.startTs <= allMax + 365 * 86400000);

    // Find default start/end based on 10-well threshold
    const threshold = 10;
    let firstAbove = -1, lastAbove = -1;
    for (let i = 0; i < densityData.length; i++) {
      if (densityData[i].count >= threshold) {
        if (firstAbove === -1) firstAbove = i;
        lastAbove = i;
      }
    }

    let defStart: string, defEnd: string;
    if (firstAbove >= 0) {
      defStart = `${new Date(densityData[firstAbove].startTs).getFullYear()}-01-01`;
      const endBin = densityData[lastAbove];
      const endDate = new Date(endBin.startTs);
      defEnd = endDate.getMonth() >= 6 ? `${endDate.getFullYear() + 1}-01-01` : `${endDate.getFullYear()}-07-01`;
    } else {
      defStart = minDateStr;
      defEnd = maxDateStr;
    }

    return { densityData, defaultStartDate: defStart, defaultEndDate: defEnd };
  }, [wteMeasurements]);

  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);

  const code = slugify(title);
  const hasConflict = existingCodes.includes(code);
  const canRun = title.trim().length > 0 && !hasConflict && startDate && endDate && startDate < endDate && wells.length > 0;

  const volumeOptions = region.lengthUnit === 'ft'
    ? [{ value: 'acre-ft', label: 'acre-ft' }, { value: 'ft3', label: 'ft\u00B3' }]
    : [{ value: 'm3', label: 'm\u00B3' }, { value: 'MCM', label: 'MCM' }, { value: 'km3', label: 'km\u00B3' }];

  const handleRun = async () => {
    cancelledRef.current = false;
    setStep('running');

    const params: StorageAnalysisParams = {
      startDate, endDate, resolution, storageCoefficient: storageCoeff,
      interval, volumeUnit, title,
      minObservations: minObs, minTimeSpanYears: minSpanYears,
      smoothingMethod, smoothingMonths,
    };

    try {
      const result = await runStorageAnalysis(
        params, aquifer, region, wells,
        measurements.filter(m => wellIdSet.has(m.wellId)),
        (stepText, pct) => {
          if (!cancelledRef.current) {
            setProgressText(stepText);
            setProgressPct(pct);
          }
        }
      );
      if (!cancelledRef.current) {
        setResult(result);
        setStep('complete');
      }
    } catch (err) {
      console.error('Storage analysis failed:', err);
      setProgressText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setStep('options');
    setProgressPct(0);
    setProgressText('');
  };

  // Date range markers for charts
  const startTs = startDate ? new Date(startDate).getTime() : undefined;
  const endTs = endDate ? new Date(endDate).getTime() : undefined;

  // Count wells with >= 2 measurements (usable for PCHIP preview)
  const usableWellCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of wteMeasurements) {
      counts.set(m.wellId, (counts.get(m.wellId) || 0) + 1);
    }
    let count = 0;
    for (const c of counts.values()) if (c >= 2) count++;
    return count;
  }, [wteMeasurements]);

  // Well qualification based on minObs and minSpanYears
  const { qualifiedWellCount, omittedWellCount } = useMemo(() => {
    const MS_PER_YEAR = 365.25 * 86400000;
    const byWell = new Map<string, number[]>();
    for (const m of wteMeasurements) {
      const t = new Date(m.date).getTime();
      if (!isNaN(t)) {
        if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
        byWell.get(m.wellId)!.push(t);
      }
    }
    let qualified = 0, omitted = 0;
    for (const [, times] of byWell) {
      if (times.length < 2) { omitted++; continue; } // need >= 2 for PCHIP
      const obsCount = times.length;
      const span = (Math.max(...times) - Math.min(...times)) / MS_PER_YEAR;
      if (obsCount >= minObs && span >= minSpanYears) {
        qualified++;
      } else {
        omitted++;
      }
    }
    return { qualifiedWellCount: qualified, omittedWellCount: omitted };
  }, [wteMeasurements, minObs, minSpanYears]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Analyze Aquifer Storage</h2>
            <p className="text-sm text-slate-500">{aquifer.name} &mdash; {region.name}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={20} className="text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === 'options' && (
            <div className="space-y-5">
              {/* PCHIP Preview — canvas-based for performance with many wells */}
              {wteMeasurements.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">
                    WTE Time Series Preview ({usableWellCount} wells with 2+ observations)
                  </h3>
                  <div className="h-[180px] bg-slate-50 rounded-lg border border-slate-200">
                    <PchipPreviewCanvas
                      wells={wells}
                      wteMeasurements={wteMeasurements}
                      startTs={startTs}
                      endTs={endTs}
                    />
                  </div>
                </div>
              )}

              {/* Data Density Histogram */}
              {densityData.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">Data Density (wells per 6-month bin)</h3>
                  <div className="h-[130px] bg-slate-50 rounded-lg border border-slate-200 p-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={densityData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis dataKey="label" stroke="#94a3b8" fontSize={9} interval="preserveStartEnd" />
                        <YAxis stroke="#94a3b8" fontSize={10} />
                        <ReferenceLine y={10} stroke="#ef4444" strokeDasharray="4 3" strokeWidth={1.5} />
                        <Tooltip
                          content={({ payload }) => {
                            if (!payload || payload.length === 0) return null;
                            const d = payload[0]?.payload;
                            return (
                              <div className="bg-white rounded shadow-md px-2 py-1 text-[10px] border border-slate-200">
                                <div className="text-slate-700 font-medium">{d?.label}</div>
                                <div className="text-slate-500">{d?.count} wells</div>
                              </div>
                            );
                          }}
                        />
                        <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                          {densityData.map((entry, i) => (
                            <Cell
                              key={i}
                              fill={entry.count >= 10 ? '#10b981' : '#94a3b8'}
                              fillOpacity={entry.count >= 10 ? 0.8 : 0.4}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Options Form */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Start Date</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">End Date</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Resolution (columns)</label>
                  <input type="number" value={resolution} min={10} max={500} step={10}
                    onChange={e => setResolution(Math.max(10, parseInt(e.target.value) || 100))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Storage Coefficient</label>
                  <input type="number" value={storageCoeff} min={0.001} max={1} step={0.01}
                    onChange={e => setStorageCoeff(parseFloat(e.target.value) || 0.15)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Min Observations / Well</label>
                  <input type="number" value={minObs} min={2} max={100} step={1}
                    onChange={e => setMinObs(Math.max(2, parseInt(e.target.value) || 5))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Min Time Span / Well (years)</label>
                  <input type="number" value={minSpanYears} min={0} max={50} step={1}
                    onChange={e => setMinSpanYears(Math.max(0, parseFloat(e.target.value) || 5))}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                </div>
                <div className="col-span-2">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-emerald-600 font-medium">{qualifiedWellCount} wells qualify</span>
                    {omittedWellCount > 0 && (
                      <span className="text-slate-400">{omittedWellCount} omitted</span>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Interval</label>
                  <select value={interval} onChange={e => setInterval(e.target.value as any)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                    <option value="3months">3 months</option>
                    <option value="6months">6 months</option>
                    <option value="1year">1 year</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Volume Units</label>
                  <select value={volumeUnit} onChange={e => setVolumeUnit(e.target.value)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                    {volumeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Interpolation Method</label>
                  <select value={smoothingMethod} onChange={e => setSmoothingMethod(e.target.value as any)}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                    <option value="pchip">PCHIP</option>
                    <option value="moving-average">Moving Average</option>
                  </select>
                </div>
                <div>
                  {smoothingMethod === 'moving-average' ? (
                    <>
                      <label className="block text-xs font-medium text-slate-600 mb-1">MA Window (months)</label>
                      <input type="number" value={smoothingMonths} min={1} max={60} step={1}
                        onChange={e => setSmoothingMonths(Math.max(1, Math.min(60, parseInt(e.target.value) || 12)))}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                    </>
                  ) : (
                    <div />
                  )}
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
                  <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Annual Analysis 2024"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                  {title && (
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[10px] text-slate-400">{slugify(aquifer.name)}/raster_wte_{code}.json</span>
                      {hasConflict && <span className="text-[10px] text-red-500 font-medium">Name already exists</span>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'running' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
              <p className="text-sm text-slate-600">{progressText}</p>
              <div className="w-80 bg-slate-200 rounded-full h-2.5">
                <div className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-xs text-slate-400">{Math.round(progressPct)}%</p>
            </div>
          )}

          {step === 'complete' && result && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
              <h3 className="text-lg font-semibold text-slate-800">Analysis Complete</h3>
              <div className="text-sm text-slate-600 text-center space-y-1">
                <p>{result.frames.length} timesteps &bull; {result.params.startDate} to {result.params.endDate}</p>
                <p>{result.aquiferName}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3 border-t border-slate-200 bg-slate-50 gap-3">
          {step === 'options' && (
            <>
              <button onClick={onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleRun} disabled={!canRun}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Play size={16} />
                Run Analysis
              </button>
            </>
          )}
          {step === 'running' && (
            <button onClick={handleCancel}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              Cancel
            </button>
          )}
          {step === 'complete' && result && (
            <button onClick={() => onComplete(result)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors">
              View Results
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default StorageAnalysisDialog;
