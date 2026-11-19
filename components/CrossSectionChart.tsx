import React, { useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { CrossSectionProfile } from '../types';
import { innerTicks, niceAxis, stepsForHeight } from '../utils/chartAxes';
import { GSE_COLOR } from './TimeSeriesChart';

interface CrossSectionChartProps {
  profile: CrossSectionProfile;
  frameIdx: number;
  lengthUnit: 'ft' | 'm';
  /** The ground surface at each sample along the line (GSE), when shown */
  ground?: (number | null)[];
}

const CrossSectionChart: React.FC<CrossSectionChartProps> = ({ profile, frameIdx, lengthUnit, ground }) => {
  const data = useMemo(() => {
    const values = profile.profiles[frameIdx];
    if (!values) return [];
    return profile.distances.map((d, i) => ({
      distance: d,
      elevation: values[i],
      ground: ground?.[i] ?? null,
    }));
  }, [profile, frameIdx, ground]);

  const unitLabel = lengthUnit === 'm' ? 'm' : 'ft';
  const [chartH, setChartH] = useState(0);
  // Fixed over every date, on round values
  const yAxis = useMemo(() => {
    let [lo, hi] = profile.elevationRange;
    for (const g of ground ?? []) if (g !== null) { lo = Math.min(lo, g); hi = Math.max(hi, g); }
    return niceAxis(lo, hi, stepsForHeight(chartH));
  }, [profile, ground, chartH]);
  // Round distances from A, short of A' (Recharts' own gave 0, 35,000, 70,000, 105,000, 125,847)
  const xTicks = useMemo(() => {
    const end = profile.distances[profile.distances.length - 1] ?? 0;
    return innerTicks(0, end);
  }, [profile]);
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <ResponsiveContainer width="100%" height="100%" onResize={(_, h) => setChartH(h)}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="distance"
          type="number"
          domain={['dataMin', 'dataMax']}
          ticks={xTicks.length > 1 ? xTicks : undefined}
          tickFormatter={fmt}
          stroke="var(--chart-axis)"
          fontSize={10}
          label={{ value: `Distance (${unitLabel})`, position: 'insideBottom', offset: -2, style: { fill: 'var(--chart-text)', fontSize: 10 } }}
        />
        <YAxis
          stroke="var(--chart-axis)"
          fontSize={10}
          domain={yAxis?.domain}
          ticks={yAxis?.ticks}
          allowDataOverflow
          tickFormatter={fmt}
          label={{ value: `Elevation (${unitLabel})`, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--chart-text)', fontSize: 10 } }}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0]?.payload;
            if (!p || (p.elevation === null && p.ground === null)) return null;
            return (
              <div className="rfs-tip px-2 py-1.5 text-[10px]">
                <div className="text-[var(--text-faint)] mb-0.5">{profile.frameDates[frameIdx]}</div>
                <div className="text-[var(--text-dim)]">Distance: {fmt(p.distance)} {unitLabel}</div>
                {p.elevation !== null && <div className="text-blue-700 font-medium">Water table: {p.elevation.toFixed(1)} {unitLabel}</div>}
                {p.ground !== null && <div className="font-medium" style={{ color: GSE_COLOR }}>Ground surface: {p.ground.toFixed(1)} {unitLabel}</div>}
                {p.elevation !== null && p.ground !== null && (
                  <div className="text-[var(--text-dim)]">Depth to water: {(p.ground - p.elevation).toFixed(1)} {unitLabel}</div>
                )}
              </div>
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="elevation"
          stroke="#60a5fa"
          strokeWidth={1.5}
          fill="#93c5fd"
          fillOpacity={0.35}
          dot={false}
          isAnimationActive={false}
          connectNulls={false}
        />
        {ground && (
          <Line type="monotone" dataKey="ground" stroke={GSE_COLOR} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
};

export default CrossSectionChart;
