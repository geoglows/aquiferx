
import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Measurement, Well } from '../types';
import { interpolatePCHIP } from '../utils/interpolation';

const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
];

interface TimeSeriesChartProps {
  measurements: Measurement[];
  selectedWells: Well[];
}

const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({ measurements, selectedWells }) => {
  const { chartData, wellIds } = useMemo(() => {
    if (measurements.length === 0 || selectedWells.length === 0) {
      return { chartData: [], wellIds: [] };
    }

    // Group measurements by wellId
    const byWell = new Map<string, Measurement[]>();
    for (const m of measurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    // Preserve selection order for consistent color assignment
    const orderedWellIds = selectedWells.map(w => w.id).filter(id => byWell.has(id));

    // For each well, compute interpolated points and actual measurement timestamps
    const wellSeries = new Map<string, { interpMap: Map<number, number>; actualSet: Set<number> }>();

    for (const wellId of orderedWellIds) {
      const wellMeasurements = byWell.get(wellId)!;
      const sorted = [...wellMeasurements]
        .filter(m => !isNaN(new Date(m.date).getTime()))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (sorted.length === 0) continue;

      const xValues = sorted.map(m => new Date(m.date).getTime());
      const yValues = sorted.map(m => m.wte);
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
          // Also include actual measurement points for dot rendering
          xValues.forEach((x, i) => interpMap.set(x, yValues[i]));
        }
      }

      wellSeries.set(wellId, { interpMap, actualSet });
    }

    // Collect all timestamps into a sorted union
    const allTimestamps = new Set<number>();
    for (const { interpMap } of wellSeries.values()) {
      for (const t of interpMap.keys()) {
        allTimestamps.add(t);
      }
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    // Build merged data array
    const data = sortedTimestamps.map(t => {
      const point: Record<string, any> = { date: t };
      for (const wellId of orderedWellIds) {
        const series = wellSeries.get(wellId);
        if (series) {
          const val = series.interpMap.get(t);
          if (val !== undefined) {
            point[`wte_${wellId}`] = val;
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

  // Build a wellId -> name map for legend/tooltip
  const wellNameMap = new Map<string, string>();
  for (const w of selectedWells) {
    wellNameMap.set(w.id, w.name);
  }

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis
            dataKey="date"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={formatXAxis}
            stroke="#94a3b8"
            fontSize={11}
          />
          <YAxis
            domain={['auto', 'auto']}
            stroke="#94a3b8"
            fontSize={11}
            tickFormatter={(val) => val.toLocaleString()}
          />
          <Tooltip
            labelFormatter={(label) => new Date(label).toLocaleDateString()}
            formatter={(value: number, name: string) => {
              const wellId = name.replace(/^(wte_|dot_)/, '');
              const wellName = wellNameMap.get(wellId) || wellId;
              return [`${value.toFixed(2)} ft`, wellName];
            }}
            contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
          />
          {selectedWells.length > 1 && (
            <Legend
              formatter={(value: string) => {
                const wellId = value.replace(/^wte_/, '');
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
                  dataKey={`wte_${wellId}`}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={!isMulti}
                  animationDuration={400}
                  activeDot={{ r: 6, strokeWidth: 0, fill: color }}
                  name={`wte_${wellId}`}
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
                    return (
                      <circle key={`${wellId}-${payload.date}`} cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={2} />
                    );
                  }}
                  name={`dot_${wellId}`}
                />
              </React.Fragment>
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TimeSeriesChart;
