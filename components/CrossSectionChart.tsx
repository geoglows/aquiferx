import React, { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { CrossSectionProfile } from '../types';
import { niceDomain } from '../utils/chartAxes';

interface CrossSectionChartProps {
  profile: CrossSectionProfile;
  frameIdx: number;
  lengthUnit: 'ft' | 'm';
}

const CrossSectionChart: React.FC<CrossSectionChartProps> = ({ profile, frameIdx, lengthUnit }) => {
  const data = useMemo(() => {
    const values = profile.profiles[frameIdx];
    if (!values) return [];
    return profile.distances.map((d, i) => ({
      distance: d,
      elevation: values[i],
    }));
  }, [profile, frameIdx]);

  const unitLabel = lengthUnit === 'm' ? 'm' : 'ft';
  // Fixed over every date, on round values
  const yDomain = useMemo(() => niceDomain(profile.elevationRange[0], profile.elevationRange[1]), [profile]);
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="distance"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={fmt}
          stroke="var(--chart-axis)"
          fontSize={10}
          label={{ value: `Distance (${unitLabel})`, position: 'insideBottom', offset: -2, style: { fill: 'var(--chart-text)', fontSize: 10 } }}
        />
        <YAxis
          stroke="var(--chart-axis)"
          fontSize={10}
          domain={yDomain}
          allowDataOverflow
          tickFormatter={fmt}
          label={{ value: `Elevation (${unitLabel})`, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--chart-text)', fontSize: 10 } }}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0]?.payload;
            if (!p || p.elevation === null) return null;
            return (
              <div className="rfs-tip px-2 py-1.5 text-[10px]">
                <div className="text-[var(--text-faint)] mb-0.5">{profile.frameDates[frameIdx]}</div>
                <div className="text-[var(--text-dim)]">Distance: {fmt(p.distance)} {unitLabel}</div>
                <div className="text-blue-700 font-medium">Elevation: {p.elevation.toFixed(1)} {unitLabel}</div>
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
      </AreaChart>
    </ResponsiveContainer>
  );
};

export default CrossSectionChart;
