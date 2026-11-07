import type { Well, WellDepthFilter } from '../types';

/** Whether a well goes into a map made with this depth filter. */
export function passesDepthFilter(well: Well, f: WellDepthFilter): boolean {
  if (well.depth == null) return f.includeNoDepth;
  if (f.min != null && well.depth < f.min) return false;
  if (f.max != null && well.depth > f.max) return false;
  return true;
}

/** "120 to 400 ft; wells with no depth left out", for summaries and Raster Info. */
export function describeDepthFilter(f: WellDepthFilter): string {
  const u = f.unit;
  const n = (v: number) => v.toLocaleString();
  const range = f.min != null && f.max != null ? `${n(f.min)} to ${n(f.max)} ${u}`
    : f.min != null ? `${n(f.min)} ${u} or deeper`
    : f.max != null ? `${n(f.max)} ${u} or shallower`
    : 'any depth';
  return `${range}; wells with no depth ${f.includeNoDepth ? 'included' : 'left out'}`;
}
