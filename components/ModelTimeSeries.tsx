import React, { useMemo, useState } from 'react';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart, ReferenceLine,
} from 'recharts';
import { ImputationModelResult, Well, Measurement } from '../types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { interpolatePCHIP, smoothModelCombined } from '../utils/interpolation';
import { niceDomain, yearTicks as yearTicksBetween } from '../utils/chartAxes';
import { summarizeChecks } from '../utils/imputationSeries';

interface ModelTimeSeriesProps {
  model: ImputationModelResult;
  well: Well;
  measurements: Measurement[];
  /** Combined: the filled series, coloured by how each month was filled. Otherwise MC+LNN's own estimate beside the readings. */
  showCombined: boolean;
  onToggleCombined: () => void;
  lengthUnit: 'ft' | 'm';
  showSmooth?: boolean;
  smoothMonths?: number;
  showGSE?: boolean;
}

const COLORS = { pchip: '#ef4444', mcl: '#3b82f6', held: '#94a3b8', reading: '#22c55e', smooth: '#f97316' };
const KEY_OF: Record<string, 'pchip' | 'mcl' | 'held'> = { p: 'pchip', m: 'mcl', h: 'held' };
const NAMES: Record<string, string> = {
  pchip: 'PCHIP', mcl: 'MC+LNN', held: 'Held reading', measurement: 'Reading', estimate: 'MC+LNN estimate',
  curve: 'PCHIP', smooth: 'MAvg', test: 'Test value',
};
const MS_PER_YEAR = 365.25 * 864e5;

const ModelTimeSeries: React.FC<ModelTimeSeriesProps> = ({
  model, well, measurements, showCombined, onToggleCombined, lengthUnit,
  showSmooth = false, smoothMonths = 3, showGSE = false,
}) => {
  const [logExpanded, setLogExpanded] = useState(false);
  // MC+LNN's test values as dots beside its estimate; off to start with
  const [showTests, setShowTests] = useState(false);

  const wellMetrics = model.wellMetrics[well.id];
  const series = model.data[well.id];
  const modelHasChecks = useMemo(() => summarizeChecks(model.wellMetrics) !== null, [model.wellMetrics]);

  // The well's water level readings
  const readings = useMemo(() =>
    measurements.filter(m => m.wellId === well.id && m.dataType === 'wte' && !isNaN(new Date(m.date).getTime()))
      .map(m => ({ ts: new Date(m.date).getTime(), value: m.value }))
      .sort((a, b) => a.ts - b.ts),
  [measurements, well.id]);

  // The model's months for this well
  const monthTs = useMemo(() => {
    if (!series) return [];
    const y = parseInt(series.start.slice(0, 4)), mo = parseInt(series.start.slice(5, 7)) - 1;
    return series.values.map((_, k) => Date.UTC(y, mo + k, 1));
  }, [series]);

  const smoothed = useMemo(() => {
    if (!series || !showCombined || !showSmooth || series.values.length < 2) return null;
    const rows = series.values.map((combined, k) => ({ date: new Date(monthTs[k]).toISOString().slice(0, 10), combined }));
    const { dates, values } = smoothModelCombined(rows, smoothMonths);
    return new Map(dates.map((d, i) => [d, values[i]]));
  }, [series, monthTs, showCombined, showSmooth, smoothMonths]);

  const chartData = useMemo(() => {
    if (!series) return [];
    const rows: Record<string, number | null>[] = monthTs.map(ts => ({ date: ts }));
    if (showCombined) {
      // Each month under the key of how it was filled; a month where the source changes also carries the next source,
      // so the coloured pieces join
      series.values.forEach((v, k) => {
        const key = KEY_OF[series.source[k]];
        rows[k][key] = v;
        const next = KEY_OF[series.source[k + 1]];
        if (next && next !== key) rows[k][next] = v;
        if (smoothed) rows[k].smooth = smoothed.get(monthTs[k]) ?? null;
      });
    } else {
      // MC+LNN's estimate for every month, and its test values as dots if asked for
      if (series.test) {
        series.model?.forEach((v, k) => { rows[k].estimate = v; });
        if (showTests) series.test.forEach(([k, v]) => { if (rows[k]) rows[k].test = v; });
      } else if (series.model) {
        // Older models kept the test values in place of the estimate in the months with readings: draw the line without them
        const y0 = parseInt(series.start.slice(0, 4)), m0 = parseInt(series.start.slice(5, 7)) - 1;
        const readK = new Set(readings.map(r => { const d = new Date(r.ts); return (d.getUTCFullYear() - y0) * 12 + d.getUTCMonth() - m0; }));
        series.model.forEach((v, k) => {
          if (!readK.has(k)) rows[k].estimate = v;
          else if (showTests) rows[k].test = v;
        });
      }
      // The PCHIP curve through the readings
      if (readings.length >= 2) {
        const first = readings[0].ts, last = readings[readings.length - 1].ts;
        const inside = monthTs.map((ts, k) => [ts, k] as const).filter(([ts]) => ts >= first && ts <= last);
        const curve = interpolatePCHIP(readings.map(r => r.ts), readings.map(r => r.value), inside.map(([ts]) => ts));
        inside.forEach(([, k], i) => { rows[k].curve = curve[i]; });
      }
    }
    // Readings sit on the nearest model month, so they do not split the lines; those outside the model's months keep their dates
    const lo = monthTs[0], hi = monthTs[monthTs.length - 1];
    const extra: Record<string, number | null>[] = [];
    for (const r of readings) {
      if (r.ts < lo || r.ts > hi) { extra.push({ date: r.ts, measurement: r.value }); continue; }
      let k = Math.round((r.ts - lo) / (30.4375 * 864e5));
      k = Math.min(monthTs.length - 1, Math.max(0, k));
      while (k > 0 && Math.abs(monthTs[k - 1] - r.ts) < Math.abs(monthTs[k] - r.ts)) k--;
      while (k < monthTs.length - 1 && Math.abs(monthTs[k + 1] - r.ts) < Math.abs(monthTs[k] - r.ts)) k++;
      rows[k].measurement = r.value;
    }
    return [...rows, ...extra].sort((a, b) => (a.date as number) - (b.date as number));
  }, [series, monthTs, readings, showCombined, smoothed, showTests]);

  const yDomain = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const d of chartData) {
      for (const [key, v] of Object.entries(d)) {
        if (key === 'date' || v == null || !isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (showGSE && well.gse != null && !isNaN(well.gse)) {
      if (well.gse < min) min = well.gse;
      if (well.gse > max) max = well.gse;
    }
    if (!isFinite(min)) return [0, 1];
    const pad = (max - min) * 0.05 || 1;
    return niceDomain(min - pad, max + pad);
  }, [chartData, showGSE, well.gse]);

  // Model months are UTC dates, so dates are read in UTC; in local time west of Greenwich the first of a month falls on the
  // last day of the month before.
  const formatDate = (ts: number) => new Date(ts).getUTCFullYear().toString();
  const yearTicks = useMemo(() =>
    chartData.length === 0 ? [] : yearTicksBetween(chartData[0].date as number, chartData[chartData.length - 1].date as number),
  [chartData]);

  if (!series) {
    // Which of the two settings the well misses (readings at the same time count once, as in Impute Gaps)
    const times = [...new Set(readings.map(r => r.ts))];
    const { minObservations: minObs, minTimeSpan: minSpan } = model.params;
    const span = times.length ? (times[times.length - 1] - times[0]) / MS_PER_YEAR : 0;
    const reason = times.length < Math.max(2, minObs)
      ? `it has ${times.length} reading${times.length === 1 ? '' : 's'}, fewer than ${minObs}`
      : `its readings span ${span.toFixed(1)} years, less than ${minSpan}`;
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--text-faint)] px-4 text-center">
        This well is not in the model: {reason}.
      </div>
    );
  }

  const line = (key: string, color: string, width = 1.5, dash?: string, connect = false) => (
    <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={width} strokeDasharray={dash}
      dot={false} connectNulls={connect} name={NAMES[key]} isAnimationActive={false} />
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle and metrics */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-200">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-amber-800">Model: {model.title}</span>
          <label className="flex items-center gap-1 text-[10px] text-amber-800 cursor-pointer select-none"
            title="Ticked: the filled series, coloured by how each month was filled. Unticked: MC+LNN's own estimate for every month beside the readings.">
            <input type="checkbox" checked={showCombined} onChange={onToggleCombined} className="accent-amber-600" />
            Combined
          </label>
          {!showCombined && wellMetrics?.filled === 'mc-lnn' && (
            <label className="flex items-center gap-1 text-[10px] text-amber-800 cursor-pointer select-none"
              title="MC+LNN's test values: at each month with readings, its value with that sixth of the well's record hidden. R² and RMSE compare them with the readings.">
              <input type="checkbox" checked={showTests} onChange={e => setShowTests(e.target.checked)} className="accent-amber-600" />
              Test values
            </label>
          )}
        </div>
        {wellMetrics && (
          <div className="flex items-center gap-2">
            {wellMetrics.filled === 'mc-lnn' ? (
              <>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium cursor-help"
                  title="MC+LNN's test values against the readings: at each month with readings, its value with that sixth of the record hidden (tick Test values to see them)">
                  R² = {wellMetrics.r2?.toFixed(3)}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium cursor-help"
                  title="MC+LNN's test values against the readings: at each month with readings, its value with that sixth of the record hidden (tick Test values to see them)">
                  RMSE = {wellMetrics.rmse?.toFixed(2)} {lengthUnit}
                </span>
              </>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium cursor-help"
                title={`MC+LNN could not fill this well: ${wellMetrics.reason}. PCHIP fills its gaps and its first and last readings are held.`}>
                PCHIP and held readings only
              </span>
            )}
            {wellMetrics.check ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium cursor-help"
                title={`Readings from ${wellMetrics.check.from} to ${wellMetrics.check.to} were hidden, MC+LNN filled the well again without them, and the PCHIP curve was drawn across the stretch. RMSE of each against the ${wellMetrics.check.n} hidden readings.`}
              >
                Hidden readings: MC+LNN {wellMetrics.check.model.toFixed(2)} · PCHIP {wellMetrics.check.pchip.toFixed(2)} {lengthUnit}
              </span>
            ) : modelHasChecks && wellMetrics.filled === 'mc-lnn' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 font-medium cursor-help"
                title="This well has too few readings around the middle of its record to hide a stretch of them and fill it again."
              >
                No hidden-reading check
              </span>
            )}
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis dataKey="date" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={yearTicks}
              tickFormatter={formatDate} stroke="var(--chart-axis)" fontSize={10} />
            <YAxis stroke="var(--chart-axis)" fontSize={10} domain={yDomain} tickFormatter={(v: number) => v.toLocaleString()} />
            <Tooltip
              labelFormatter={(ts: number) => { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }}
              formatter={(value: number, name: string) => [value?.toFixed(2) ?? 'N/A', name]}
            />

            {showCombined
              ? [line('pchip', COLORS.pchip), line('mcl', COLORS.mcl), line('held', COLORS.held, 1.5, '4 3'),
                 ...(smoothed ? [line('smooth', COLORS.smooth, 2, '6 3')] : [])]
              : [line('curve', COLORS.pchip, 1.5), line('estimate', COLORS.mcl, 1.5, undefined, true),
                 ...(showTests ? [
                   <Line key="test" type="monotone" dataKey="test" stroke={COLORS.mcl} strokeWidth={0} connectNulls={false}
                     dot={{ r: 3, fill: 'var(--surface)', stroke: COLORS.mcl, strokeWidth: 1.5 }} name={NAMES.test} isAnimationActive={false} />,
                 ] : [])]}
            <Line type="monotone" dataKey="measurement" stroke={COLORS.reading} strokeWidth={0}
              dot={{ fill: COLORS.reading, r: 3, strokeWidth: 0 }} connectNulls={false} name="Reading" isAnimationActive={false} />

            <Legend
              content={({ payload }: any) => (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 16, fontSize: 11 }}>
                  {payload?.map((entry: any) => (
                    <span key={entry.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: entry.color || '#666' }}>
                      {entry.value === 'Reading' ? (
                        <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill={COLORS.reading} /></svg>
                      ) : entry.value === NAMES.test ? (
                        <svg width="9" height="9"><circle cx="4.5" cy="4.5" r="3.5" fill="none" stroke={COLORS.mcl} strokeWidth="1.5" /></svg>
                      ) : entry.value === 'MAvg' || entry.value === 'Held reading' ? (
                        <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" stroke={entry.color} strokeWidth="2" strokeDasharray="3 2" /></svg>
                      ) : (
                        <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" stroke={entry.color} strokeWidth="2" /></svg>
                      )}
                      {entry.value}
                    </span>
                  ))}
                </div>
              )}
            />
            {showGSE && well.gse != null && !isNaN(well.gse) && (
              <ReferenceLine y={well.gse} stroke="#8B4513" strokeDasharray="6 3" strokeWidth={1.5}
                label={{ value: 'GSE', position: 'right', fill: '#8B4513', fontSize: 10 }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Collapsible log */}
      {model.log && model.log.length > 0 && (
        <div className="border-t border-[var(--border)]">
          <button
            onClick={() => setLogExpanded(!logExpanded)}
            className="w-full flex items-center gap-1 px-3 py-1 text-[10px] text-[var(--text-faint)] hover:bg-[var(--surface2)]"
          >
            {logExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Processing Log ({model.log.length} entries)
          </button>
          {logExpanded && (
            <div className="rfs-scroll max-h-[120px] overflow-y-auto px-3 py-1 bg-[var(--bg)] font-mono text-[10px] text-[var(--text-dim)] space-y-0.5">
              {model.log.map((msg, i) => (
                <div key={i} className={msg.startsWith('ERROR') ? 'text-red-600' : ''}>{msg}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelTimeSeries;
