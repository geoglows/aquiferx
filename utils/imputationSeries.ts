// The saved series of an imputation model and its hold-out check. Shared by the pipeline and the dialogs that report it.
import { ImputationCheck, ImputationWellMetrics } from '../types';

/**
 * The saved series: the PCHIP value in each training month (pchip not null), and elsewhere the model shifted to meet PCHIP.
 * In each run of months without PCHIP, the shift is PCHIP minus the model at the training month just before the run,
 * changing linearly to PCHIP minus the model at the training month just after it. A run with training months on one side
 * only (before a well's first reading or after its last) takes that side's shift throughout. Without the shift the series
 * stepped by the model's error wherever it passed between PCHIP and the model (up to 32 ft on Escalante).
 */
export function shiftedSeries(pchip: (number | null)[], model: number[]): number[] {
  const n = pchip.length;
  const out = pchip.map((p, i) => (p !== null ? p : model[i]));
  for (let i = 0; i < n;) {
    if (pchip[i] !== null) { i++; continue; }
    let j = i;
    while (j < n && pchip[j] === null) j++;
    const a = i - 1, b = j;  // the training months on either side of the run i..j-1, if any
    const d0 = a >= 0 ? (pchip[a] as number) - model[a] : null;
    const d1 = b < n ? (pchip[b] as number) - model[b] : null;
    if (d0 !== null || d1 !== null) {
      for (let k = i; k < j; k++) {
        const shift = d0 === null ? d1! : d1 === null ? d0 : d0 + ((d1 - d0) * (k - a)) / (b - a);
        out[k] = model[k] + shift;
      }
    }
    i = j;
  }
  return out;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The check hides this many years of a well's readings, or more when the run's gap and pad sizes need it. */
export const CHECK_YEARS = 5;
/** Readings a well needs before the hidden stretch, after it, and inside it (scored) for a check. */
export const CHECK_MIN_BEFORE = 5;
export const CHECK_MIN_AFTER = 2;
export const CHECK_MIN_SCORED = 3;

/**
 * The stretch of a well's record the check hides: CHECK_YEARS centered on the middle reading (by time, the median), or,
 * when the gap and pad sizes are large, long enough that the model still fills a year of it.
 */
export function checkWindow(readingTs: number[], gapMs: number, padMs: number): { from: number; to: number } {
  const len = Math.max(CHECK_YEARS * 365.25 * MS_PER_DAY, gapMs + 2 * padMs + 365 * MS_PER_DAY);
  const sorted = [...readingTs].sort((x, y) => x - y);
  const m = sorted.length >> 1;
  const mid = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  return { from: mid - len / 2, to: mid + len / 2 };
}

export interface CheckSummary {
  wells: number;        // wells checked
  modelCloser: number;  // of them, where the model's RMSE was below PCHIP's
  medianModel: number;  // median over wells of the model's RMSE on the hidden readings
  medianPchip: number;
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarizeChecks(metrics: Record<string, ImputationWellMetrics>): CheckSummary | null {
  const checks = Object.values(metrics).map(m => m.check).filter((c): c is ImputationCheck => !!c);
  if (checks.length === 0) return null;
  return {
    wells: checks.length,
    modelCloser: checks.filter(c => c.model < c.pchip).length,
    medianModel: median(checks.map(c => c.model)),
    medianPchip: median(checks.map(c => c.pchip)),
  };
}
