import React from 'react';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

// Standalone radar chart so recharts (~120KB min) is split into its own Vite
// chunk and never reaches the initial CoachPortal payload. Imported via
// React.lazy from CoachPortal so the chart bundle is fetched only when an
// operator actually toggles compare-mode and selects ≥2 athletes.

export interface CoachRadarDatum {
  drill: string;
  [athleteKey: string]: string | number;
}

export interface CoachRadarAthlete {
  id:         string;
  first_name: string;
  last_name:  string;
}

interface CoachRadarChartProps {
  data:     CoachRadarDatum[];
  athletes: CoachRadarAthlete[];
  colors:   string[];
}

const CoachRadarChart: React.FC<CoachRadarChartProps> = ({ data, athletes, colors }) => (
  <ResponsiveContainer width="100%" height="100%">
    <RadarChart data={data}>
      <PolarGrid stroke="#e4e4e7" />
      <PolarAngleAxis
        dataKey="drill"
        tick={{ fontSize: 11, fontWeight: 700, fill: '#71717a' }}
      />
      <Tooltip
        formatter={(value: number) => [`${value}th percentile`]}
        contentStyle={{ borderRadius: '12px', border: '1px solid #e4e4e7', fontSize: 12 }}
      />
      {athletes.map((athlete, i) => (
        <Radar
          key={athlete.id}
          name={`${athlete.first_name} ${athlete.last_name}`}
          dataKey={`athlete${i}`}
          stroke={colors[i]}
          fill={colors[i]}
          fillOpacity={0.15}
          strokeWidth={2}
        />
      ))}
    </RadarChart>
  </ResponsiveContainer>
);

export default CoachRadarChart;
