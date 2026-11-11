// The months an imputation model covers, and the months of each well it trains on. Shared by the
// pipeline and the wizard, so the wizard's well count is the run's.

/** The longest soil moisture average, in months. The features start once it has a full window. */
export const LONGEST_MEAN_MONTHS = 120;

/** A well needs at least this many months of record for the model's fit. */
export const MIN_TRAINING_MONTHS = 3;

const firstOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

/**
 * The months the model covers, given the soil moisture record's first and last month: from the first
 * month with a full 10-year average to the end of the record.
 */
export function featureDateRange(record: { min: string; max: string }): { min: string; max: string } {
  const d = new Date(record.min);
  return { min: firstOfMonth(d.getUTCFullYear(), d.getUTCMonth() + LONGEST_MEAN_MONTHS - 1), max: record.max };
}

/** The first of each month from start to end, inclusive, as UTC timestamps. */
export function monthlyTimestamps(start: string, end: string): number[] {
  const s = new Date(start), e = new Date(end).getTime();
  if (isNaN(s.getTime()) || isNaN(e)) return [];
  const out: number[] = [];
  for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); out.length < 10000; m++) {
    const t = Date.UTC(y, m, 1);
    if (t > e) break;
    out.push(t);
  }
  return out;
}

/**
 * Which months get a PCHIP value for a well read at measTs (sorted, in ms): those from its first reading up
 * to, not including, its last, less the inside of every gap longer than gapMs, which keeps padMs of PCHIP
 * at each end of the gap.
 */
export function pchipMonthMask(measTs: number[], monthTs: number[], gapMs: number, padMs: number): boolean[] {
  const first = measTs[0], last = measTs[measTs.length - 1];
  const mask = monthTs.map(t => t >= first && t < last);
  for (let i = 0; i < measTs.length - 1; i++) {
    if (measTs[i + 1] - measTs[i] <= gapMs) continue;
    const from = measTs[i] + padMs, to = measTs[i + 1] - padMs;
    for (let k = 0; k < monthTs.length; k++) {
      if (monthTs[k] >= from && monthTs[k] <= to) mask[k] = false;
    }
  }
  return mask;
}
