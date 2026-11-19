// Axis helpers shared by the charts.

// A y range that covers [min, max] in four equal steps of 1, 2, 2.5 or 5 times a power of ten, so the axis's five ticks
// fall on round values. Without it, a padded range gave ticks such as 5,177.658.
export function niceDomain(min: number, max: number): [number, number] {
  const raw = (max - min) / 4 || 1;
  let pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (let guard = 0; guard < 20; guard++, pow *= 10) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * pow;
      if (step < raw) continue;
      const lo = Math.floor(min / step) * step;
      if (lo + 4 * step >= max) return [lo, lo + 4 * step];
    }
  }
  return [min, max];
}

// Steps of 1, 2 or 5 times a power of ten, from the one below range / maxSteps upward
function* niceSteps(range: number, maxSteps: number) {
  let pow = Math.pow(10, Math.floor(Math.log10(range / maxSteps)));
  for (let guard = 0; guard < 20; guard++, pow *= 10) for (const m of [1, 2, 5]) yield m * pow;
}
const tidy = (v: number) => Number(v.toPrecision(12));   // no 0.6000000000000001

// Round ticks inside [min, max], at most maxSteps + 1 of them
export function innerTicks(min: number, max: number, maxSteps = 7): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  for (const step of niceSteps(max - min, maxSteps)) {
    const a = Math.ceil(min / step), b = Math.floor(max / step);
    if (b - a <= maxSteps) {
      const ticks: number[] = [];
      for (let k = a; k <= b; k++) ticks.push(tidy(k * step));
      return ticks;
    }
  }
  return [];
}

// A y axis for values from min to max, with at most maxSteps steps between round ticks. The axis ends on round ticks when
// they leave at most a quarter of it empty; otherwise it runs from just below min to just above max, with round ticks
// inside. A storage curve that falls 1,040,000 and rises 36,000 gets -1.2M to 200K in steps of 200K with room for 7 steps;
// with room for 3, round ends would be -2M and 1M, so it gets -1,070,000 to 70,000 with ticks at -1M, -500K and 0. Recharts'
// own ticks there ran to 350K, and niceDomain gave -1.5M to 500K.
export function niceAxis(min: number, max: number, maxSteps = 7): { domain: [number, number]; ticks: number[] } | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) { min -= 1; max += 1; }
  for (const step of niceSteps(max - min, maxSteps)) {
    const lo = Math.floor(min / step), hi = Math.ceil(max / step);
    if (hi - lo > maxSteps) continue;
    if ((max - min) / ((hi - lo) * step) >= 0.75) {
      const ticks: number[] = [];
      for (let k = lo; k <= hi; k++) ticks.push(tidy(k * step));
      return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
    }
    break;
  }
  const pad = (max - min) * 0.03;
  return { domain: [min - pad, max + pad], ticks: innerTicks(min - pad, max + pad, maxSteps) };
}

// Round ticks from 0 up past max, for counts: at most maxSteps steps (Recharts' own put 0, 55, 110 and 220 on one axis)
export function countTicks(max: number, maxSteps = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  for (const step of niceSteps(max, maxSteps)) {
    if (step < 1) continue;
    const n = Math.ceil(max / step);
    if (n <= maxSteps) return Array.from({ length: n + 1 }, (_, k) => tidy(k * step));
  }
  return [0, max];
}

// How many steps a y axis has room for in a chart this many CSS px tall (axes included, as ResponsiveContainer's onResize gives
// it): about one per 24 px of plot, 3 to 7. In the chart panel's default 250 px, 7 steps left Recharts room for every other label.
export function stepsForHeight(px: number): number {
  return px > 0 ? Math.max(3, Math.min(7, Math.floor((px - 40) / 24))) : 7;
}

// January 1 (UTC) of every 1st, 2nd, 5th, 10th, 20th, 25th or 50th year between two times, the smallest step that gives at
// most maxTicks ticks. A tick for every year made Recharts drop the ones that collided, leaving 1957, 1960, 1962, 1965...
export function yearTicks(minTs: number, maxTs: number, maxTicks = 10): number[] {
  const first = new Date(minTs).getUTCFullYear();
  const last = new Date(maxTs).getUTCFullYear();
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find(s => (last - first) / s < maxTicks) ?? 100;
  const ticks: number[] = [];
  for (let y = Math.ceil(first / step) * step; y <= last; y += step) {
    const t = Date.UTC(y, 0, 1);
    if (t >= minTs && t <= maxTs) ticks.push(t);
  }
  return ticks;
}

// Ticks for a date axis from minTs to maxTs: January 1 of round years (yearTicks) labeled by year when it spans two years or
// more, else the 1st of every 1, 2, 3 or 6 months labeled month/year. Recharts' own ticks fell on odd months (8/1943, 10/1965,
// 12/1987, 3/2010, 6/2028).
export function dateTicks(minTs: number, maxTs: number, maxTicks = 10): { ticks: number[]; format: (t: number) => string } {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return { ticks: [], format: t => String(t) };
  if (maxTs - minTs >= 2 * 365.25 * 86400000) {
    return { ticks: yearTicks(minTs, maxTs, maxTicks), format: t => String(new Date(t).getUTCFullYear()) };
  }
  const a = new Date(minTs), b = new Date(maxTs);
  const first = a.getUTCFullYear() * 12 + a.getUTCMonth(), last = b.getUTCFullYear() * 12 + b.getUTCMonth();
  const step = [1, 2, 3, 6].find(s => (last - first) / s < maxTicks) ?? 12;
  const ticks: number[] = [];
  for (let m = Math.ceil(first / step) * step; m <= last; m += step) {
    const t = Date.UTC(Math.floor(m / 12), m % 12, 1);
    if (t >= minTs && t <= maxTs) ticks.push(t);
  }
  return { ticks, format: t => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; } };
}

