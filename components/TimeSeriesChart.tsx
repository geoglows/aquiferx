
import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import { Measurement, Well, DataType } from '../types';
import { interpolatePCHIP } from '../utils/interpolation';

const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
];

const GSE_COLOR = '#8B4513';

const TREND_THRESHOLDS_FT = { extreme: 2.0, moderate: 0.5 };
const TREND_THRESHOLDS_M = { extreme: 0.6, moderate: 0.15 };

function slopeToColor(slope: number, thresholds: { extreme: number; moderate: number }): string {
  if (slope < -thresholds.extreme) return '#CD233F';
  if (slope < -thresholds.moderate) return '#FFA885';
  if (slope <= thresholds.moderate) return '#E7E2BC';
  if (slope <= thresholds.extreme) return '#8ECEEE';
  return '#2C7DCD';
}

interface TimeSeriesChartProps {
  measurements: Measurement[];
  selectedWells: Well[];
  showGSE: boolean;
  showTrendLine: boolean;
  dataType: DataType;
  lengthUnit?: 'ft' | 'm';
  onEditMeasurement?: (wellId: string, date: number, newValue: number) => void;
  onDeleteMeasurement?: (wellId: string, date: number) => void;
}

interface SelectedPoint {
  wellId: string;
  date: number;
  value: number;
}

interface DotPosition extends SelectedPoint {
  cx: number;
  cy: number;
}

const HIT_RADIUS = 15;

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({ measurements, selectedWells, showGSE, showTrendLine, dataType, lengthUnit = 'ft', onEditMeasurement, onDeleteMeasurement }) => {
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editModal, setEditModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [editValue, setEditValue] = useState('');

  const wrapperRef = useRef<HTMLDivElement>(null);
  const dotPositionsRef = useRef<DotPosition[]>([]);

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editModal) setEditModal(false);
        else if (deleteModal) setDeleteModal(false);
        else if (contextMenu) setContextMenu(null);
        else if (selectedPoint) setSelectedPoint(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editModal, deleteModal, contextMenu, selectedPoint]);

  const { chartData, wellIds } = useMemo(() => {
    if (measurements.length === 0 || selectedWells.length === 0) {
      return { chartData: [], wellIds: [] };
    }

    const byWell = new Map<string, Measurement[]>();
    for (const m of measurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    const orderedWellIds = selectedWells.map(w => w.id).filter(id => byWell.has(id));

    const wellSeries = new Map<string, { interpMap: Map<number, number>; actualSet: Set<number> }>();

    for (const wellId of orderedWellIds) {
      const wellMeasurements = byWell.get(wellId)!;
      const sorted = [...wellMeasurements]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (sorted.length === 0) continue;

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.value);
      const actualSet = new Set(xValues);
      const interpMap = new Map<number, number>();

      if (sorted.length === 1) {
        interpMap.set(xValues[0], yValues[0]);
      } else {
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const range = maxX - minX;

        if (range === 0) {
          xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
        } else {
          const step = range / 100;
          const targetX: number[] = [];
          for (let x = minX; x <= maxX; x += step) {
            targetX.push(x);
          }
          const interpolatedY = interpolatePCHIP(xValues, yValues, targetX);
          targetX.forEach((tx, i) => interpMap.set(tx, interpolatedY[i]));
          xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
        }
      }

      wellSeries.set(wellId, { interpMap, actualSet });
    }

    const allTimestamps = new Set<number>();
    for (const { interpMap } of wellSeries.values()) {
      for (const t of interpMap.keys()) {
        allTimestamps.add(t);
      }
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    const data = sortedTimestamps.map(t => {
      const point: Record<string, any> = { date: t };
      for (const wellId of orderedWellIds) {
        const series = wellSeries.get(wellId);
        if (series) {
          const val = series.interpMap.get(t);
          if (val !== undefined) {
            point[`val_${wellId}`] = val;
          }
          if (series.actualSet.has(t)) {
            point[`dot_${wellId}`] = val;
          }
        }
      }
      return point;
    });

    return { chartData: data, wellIds: orderedWellIds };
  }, [measurements, selectedWells]);

  // Compute linear regression trend lines per well (requires >= 3 measurements)
  const trendData = useMemo(() => {
    if (!showTrendLine || measurements.length === 0 || selectedWells.length === 0) return null;

    const byWell = new Map<string, { x: number; y: number }[]>();
    for (const m of measurements) {
      const t = new Date(m.date).getTime();
      if (isNaN(t)) continue;
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push({ x: t, y: m.value });
    }

    const MS_PER_YEAR = 365.25 * 86400000;
    const lines = new Map<string, { startDate: number; startVal: number; endDate: number; endVal: number; slopePerYear: number }>();

    for (const [wellId, points] of byWell) {
      if (points.length < 3) continue;

      // Linear regression: y = mx + b
      const n = points.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumXX += p.x * p.x;
      }
      const denom = n * sumXX - sumX * sumX;
      if (denom === 0) continue;

      const m = (n * sumXY - sumX * sumY) / denom;
      const b = (sumY - m * sumX) / n;

      const xs = points.map(p => p.x).sort((a, b) => a - b);
      const startDate = xs[0];
      const endDate = xs[xs.length - 1];
      lines.set(wellId, {
        startDate,
        startVal: m * startDate + b,
        endDate,
        endVal: m * endDate + b,
        slopePerYear: m * MS_PER_YEAR,
      });
    }

    if (lines.size === 0) return null;
    return lines;
  }, [showTrendLine, measurements, selectedWells]);

  // Merge trend line endpoints into chart data
  const finalChartData = useMemo(() => {
    if (!trendData) return chartData;

    // Collect all trend timestamps that might not exist in chartData
    const timestamps = new Set<number>();
    for (const { startDate, endDate } of trendData.values()) {
      timestamps.add(startDate);
      timestamps.add(endDate);
    }

    // Index existing chart data by timestamp
    const byTime = new Map<number, Record<string, any>>();
    for (const point of chartData) {
      byTime.set(point.date as number, { ...point });
    }

    // Ensure trend endpoints exist
    for (const t of timestamps) {
      if (!byTime.has(t)) {
        byTime.set(t, { date: t });
      }
    }

    // Inject trend values
    for (const [wellId, line] of trendData) {
      const startPoint = byTime.get(line.startDate);
      const endPoint = byTime.get(line.endDate);
      if (startPoint) startPoint[`trend_${wellId}`] = line.startVal;
      if (endPoint) endPoint[`trend_${wellId}`] = line.endVal;
    }

    return Array.from(byTime.values()).sort((a, b) => (a.date as number) - (b.date as number));
  }, [chartData, trendData]);

  if (measurements.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
        No measurement data available for this well.
      </div>
    );
  }

  const formatXAxis = (tickItem: number) => {
    const d = new Date(tickItem);
    return `${d.getMonth() + 1}/${d.getFullYear()}`;
  };

  const wellNameMap = new Map<string, string>();
  for (const w of selectedWells) {
    wellNameMap.set(w.id, w.name);
  }

  const yAxisLabel = `${dataType.name} (${dataType.unit})`;

  const yDomain = useMemo(() => {
    if (!showGSE) return ['auto', 'auto'] as const;
    const gseValues = selectedWells
      .map(w => w.gse)
      .filter(v => v != null && !isNaN(v));
    if (gseValues.length === 0) return ['auto', 'auto'] as const;

    const allValues: number[] = [];
    for (const point of finalChartData) {
      for (const key of Object.keys(point)) {
        if ((key.startsWith('val_') || key.startsWith('trend_')) && point[key] != null) {
          allValues.push(point[key] as number);
        }
      }
    }
    if (allValues.length === 0) return ['auto', 'auto'] as const;

    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues, ...gseValues);
    const padding = (dataMax - dataMin) * 0.05 || 1;
    return [dataMin - padding, dataMax + padding];
  }, [showGSE, selectedWells, finalChartData]);

  // --- Dot hit-testing ---
  // Clear positions for this render cycle; dot render functions repopulate it
  dotPositionsRef.current = [];

  const findNearestDot = (clientX: number, clientY: number): DotPosition | null => {
    const svg = wrapperRef.current?.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const svgX = clientX - rect.left;
    const svgY = clientY - rect.top;

    let nearest: DotPosition | null = null;
    let minDist = HIT_RADIUS;
    for (const dot of dotPositionsRef.current) {
      const dist = Math.sqrt((dot.cx - svgX) ** 2 + (dot.cy - svgY) ** 2);
      if (dist < minDist) {
        minDist = dist;
        nearest = dot;
      }
    }
    return nearest;
  };

  const handleWrapperClick = (e: React.MouseEvent) => {
    // Don't interfere with context menu backdrop or modal clicks
    if (contextMenu || editModal || deleteModal) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (dot) {
      setSelectedPoint({ wellId: dot.wellId, date: dot.date, value: dot.value });
    } else {
      setSelectedPoint(null);
    }
  };

  const handleWrapperContextMenu = (e: React.MouseEvent) => {
    if (editModal || deleteModal) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (dot) {
      e.preventDefault();
      setSelectedPoint({ wellId: dot.wellId, date: dot.date, value: dot.value });
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const handleWrapperMouseMove = (e: React.MouseEvent) => {
    if (editModal || deleteModal || contextMenu) return;
    const dot = findNearestDot(e.clientX, e.clientY);
    if (wrapperRef.current) {
      wrapperRef.current.style.cursor = dot ? 'pointer' : '';
    }
  };

  const handleSaveEdit = () => {
    if (!selectedPoint || !onEditMeasurement) return;
    const val = parseFloat(editValue);
    if (isNaN(val)) return;
    onEditMeasurement(selectedPoint.wellId, selectedPoint.date, val);
    setEditModal(false);
    setSelectedPoint(null);
  };

  const handleConfirmDelete = () => {
    if (!selectedPoint || !onDeleteMeasurement) return;
    onDeleteMeasurement(selectedPoint.wellId, selectedPoint.date);
    setDeleteModal(false);
    setSelectedPoint(null);
  };

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full relative outline-none"
      onClick={handleWrapperClick}
      onContextMenu={handleWrapperContextMenu}
      onMouseMove={handleWrapperMouseMove}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={finalChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#94a3b8" />
          <XAxis
            dataKey="date"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={formatXAxis}
            stroke="#475569"
            fontSize={11}
            tick={{ fill: '#334155' }}
          />
          <YAxis
            domain={yDomain as any}
            stroke="#475569"
            fontSize={11}
            tick={{ fill: '#334155' }}
            tickFormatter={(val) => val.toLocaleString()}
            label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#64748b', fontSize: 11 } }}
          />
          <Tooltip
            content={({ label, payload }) => {
              if (!payload || payload.length === 0 || label == null) return null;
              const entries = (payload as any[]).filter(p => p.dataKey?.startsWith('val_'));
              if (entries.length === 0) return null;
              return (
                <div className="bg-white rounded-lg shadow-md px-2.5 py-1.5 text-xs border border-slate-200">
                  <div className="text-slate-500">{new Date(label as number).toLocaleDateString()}</div>
                  {entries.map((entry: any) => {
                    const wellId = entry.dataKey.replace('val_', '');
                    return (
                      <div key={entry.dataKey} className="flex items-center gap-1.5 text-slate-700">
                        <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: entry.color }} />
                        <span>{entry.value?.toFixed(2)}</span>
                        {selectedWells.length > 1 && (
                          <span className="text-slate-400">{wellNameMap.get(wellId)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {selectedWells.length > 1 && (
            <Legend
              formatter={(value: string) => {
                const wellId = value.replace(/^val_/, '');
                return wellNameMap.get(wellId) || wellId;
              }}
            />
          )}
          {wellIds.map((wellId, i) => {
            const color = SERIES_COLORS[i % SERIES_COLORS.length];
            const isMulti = selectedWells.length > 1;
            return (
              <React.Fragment key={wellId}>
                {/* Interpolated curve */}
                <Line
                  type="linear"
                  dataKey={`val_${wellId}`}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={!isMulti}
                  animationDuration={400}
                  activeDot={{ r: 6, strokeWidth: 0, fill: color }}
                  name={`val_${wellId}`}
                />
                {/* Actual measurement dots */}
                <Line
                  type="linear"
                  dataKey={`dot_${wellId}`}
                  stroke="transparent"
                  connectNulls={false}
                  isAnimationActive={!isMulti}
                  animationDuration={400}
                  legendType="none"
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    if (payload[`dot_${wellId}`] === undefined) return <React.Fragment key={`empty-${wellId}-${payload.date}`} />;

                    // Record pixel position for hit-testing
                    dotPositionsRef.current.push({ cx, cy, wellId, date: payload.date, value: payload[`dot_${wellId}`] });

                    const isSelected = selectedPoint?.wellId === wellId && selectedPoint?.date === payload.date;
                    return (
                      <g key={`${wellId}-${payload.date}`}>
                        {isSelected && (
                          <circle cx={cx} cy={cy} r={7} fill="none" stroke="#facc15" strokeWidth={2.5} />
                        )}
                        <circle
                          cx={cx} cy={cy}
                          r={isMulti ? 3 : 4}
                          fill={color}
                          stroke={isMulti ? "transparent" : "#fff"}
                          strokeWidth={isMulti ? 0 : 2}
                        />
                      </g>
                    );
                  }}
                  name={`dot_${wellId}`}
                />
              </React.Fragment>
            );
          })}
          {showGSE && dataType.code === 'wte' && selectedWells.map((well) => {
            if (well.gse == null || isNaN(well.gse)) return null;
            return (
              <ReferenceLine
                key={`gse_${well.id}`}
                y={well.gse}
                stroke={GSE_COLOR}
                strokeDasharray="6 3"
                strokeWidth={1.5}
                label={{
                  value: selectedWells.length > 1 ? `GSE ${well.name}` : 'GSE',
                  position: 'right',
                  fill: GSE_COLOR,
                  fontSize: 11,
                }}
              />
            );
          })}
          {showTrendLine && trendData && wellIds.map((wellId) => {
            const line = trendData.get(wellId);
            if (!line) return null;
            const thresholds = lengthUnit === 'm' ? TREND_THRESHOLDS_M : TREND_THRESHOLDS_FT;
            const color = slopeToColor(line.slopePerYear, thresholds);
            return (
              <Line
                key={`trend_${wellId}`}
                type="linear"
                dataKey={`trend_${wellId}`}
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="8 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
                legendType="none"
                name={`trend_${wellId}`}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      {/* Context Menu */}
      {contextMenu && selectedPoint && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => { e.stopPropagation(); setContextMenu(null); setSelectedPoint(null); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu(null); setSelectedPoint(null); }}
          />
          <div
            className="fixed z-50 bg-white rounded-lg shadow-lg border border-slate-200 py-1 min-w-[120px]"
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - 100),
              left: Math.min(contextMenu.x, window.innerWidth - 140),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              onClick={() => {
                setEditValue(selectedPoint.value.toString());
                setEditModal(true);
                setContextMenu(null);
              }}
            >
              Edit
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
              onClick={() => {
                setDeleteModal(true);
                setContextMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}

      {/* Edit Modal */}
      {editModal && selectedPoint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={(e) => { e.stopPropagation(); setEditModal(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Date</span>
                <span className="text-xs text-slate-700">{new Date(selectedPoint.date).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">{dataType.name}</span>
                <input
                  type="number"
                  step="any"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-32 border border-slate-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 mt-3">
              <button
                className="px-3 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
                onClick={() => setEditModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
                disabled={isNaN(parseFloat(editValue))}
                onClick={handleSaveEdit}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal && selectedPoint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={(e) => { e.stopPropagation(); setDeleteModal(false); }}
        >
          <div className="bg-white rounded-lg shadow-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs text-slate-600 mb-3">
              Delete measurement on <span className="font-medium">{new Date(selectedPoint.date).toLocaleDateString()}</span>?
            </p>
            <div className="flex justify-end space-x-2">
              <button
                className="px-3 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition-colors"
                onClick={() => setDeleteModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TimeSeriesChart;
