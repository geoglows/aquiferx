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
