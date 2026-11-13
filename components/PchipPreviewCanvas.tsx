import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import { Well, Measurement } from '../types';
import { interpolatePCHIP } from '../utils/interpolation';
import { cssVar, useTheme } from '../utils/theme';

const PREVIEW_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48',
  '#a855f7', '#22c55e', '#eab308', '#0ea5e9',
];

interface PchipPreviewCanvasProps {
  wells: Well[];
  wteMeasurements: Measurement[];
  /** Wells drawn in colour (the rest in grey); all in colour when absent */
  highlightIds?: Set<string>;
  startTs?: number;
  endTs?: number;
  /** A stretch of time shaded behind the lines, e.g. a model's months */
  shadeRange?: { min: number; max: number };
}

const PchipPreviewCanvas: React.FC<PchipPreviewCanvasProps> = ({
  wells, wteMeasurements, highlightIds, startTs, endTs, shadeRange,
}) => {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute PCHIP series per well (lightweight: just arrays, not Recharts data objects)
  const wellSeries = useMemo(() => {
    const byWell = new Map<string, Measurement[]>();
    for (const m of wteMeasurements) {
      if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
      byWell.get(m.wellId)!.push(m);
    }

    const series: { points: [number, number][]; color: string | null }[] = [];
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

      if (highlightIds && !highlightIds.has(wellId)) {
        series.push({ points, color: null });
      } else {
        series.push({ points, color: PREVIEW_COLORS[colorIdx % PREVIEW_COLORS.length] });
        colorIdx++;
      }
    }

    // Grey lines first, so the coloured ones lie on top
    return [...series.filter(s => s.color === null), ...series.filter(s => s.color !== null)];
  }, [wteMeasurements, highlightIds]);

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

    // Extend x-axis to the shaded stretch so its markers are visible
    if (shadeRange) {
      if (shadeRange.min < xMin) xMin = shadeRange.min;
      if (shadeRange.max > xMax) xMax = shadeRange.max;
    }

    // Add 5% Y padding
    const yPad = (yMax - yMin) * 0.05 || 1;
    yMin -= yPad;
    yMax += yPad;

    const toX = (v: number) => margin.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const toY = (v: number) => margin.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Background
    ctx.fillStyle = cssVar('--bg');
    ctx.fillRect(0, 0, W, H);

    // Shaded stretch
    if (shadeRange) {
      const gx1 = Math.max(margin.left, toX(shadeRange.min));
      const gx2 = Math.min(W - margin.right, toX(shadeRange.max));
      if (gx2 > gx1) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.07)';
        ctx.fillRect(gx1, margin.top, gx2 - gx1, plotH);
      }
    }

    // Grid lines
    ctx.strokeStyle = cssVar('--chart-grid');
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
      ctx.strokeStyle = s.color ?? '#94a3b8';
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = s.color ? 0.6 : 0.3;
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
    ctx.fillStyle = cssVar('--chart-text');
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
  }, [wellSeries, startTs, endTs, shadeRange, theme]);

  useEffect(() => {
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

export default PchipPreviewCanvas;
