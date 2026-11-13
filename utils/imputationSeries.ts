// The hold-out check of a gap-filling model. Shared by the pipeline and the dialogs that report it.

import { ImputationCheck, ImputationWellMetrics } from '../types';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** The check hides this many years of a well's readings */
export const CHECK_YEARS = 5;
/** Readings a well needs before the hidden stretch, after it, and inside it (scored) for a check. */
export const CHECK_MIN_BEFORE = 5;
export const CHECK_MIN_AFTER = 2;
export const CHECK_MIN_SCORED = 3;

/** The stretch of a well's record the check hides: CHECK_YEARS centered on the middle reading (by time, the median) */
export function checkWindow(readingTs: number[]): { from: number; to: number } {
  const len = CHECK_YEARS * MS_PER_YEAR;
  const sorted = [...readingTs].sort((x, y) => x - y);
  const m = sorted.length >> 1;
  const mid = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  return { from: mid - len / 2, to: mid + len / 2 };
}

export interface CheckSummary {
  wells: number;        // wells checked
  modelCloser: number;  // of them, where MC+LNN's RMSE was below PCHIP's
  medianModel: number;  // median over wells of MC+LNN's RMSE on the hidden readings
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
