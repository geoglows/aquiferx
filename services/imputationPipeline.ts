// Impute Gaps: fill each well's water levels month by month (decisions 88a, 91a, 92b, 99a, 100a, 101b).
//   inside a well's record   PCHIP across gaps under 6 months; MC+LNN across longer ones, where it can fill the well
//   before / after it        MC+LNN where it can (wells with under 60 measured months: at most 12 months out), else the
//                            first / last reading held; in all, at most holdYears beyond the record
// Wells MC+LNN cannot fill (under 12 measured months, or no correlated neighbours) get PCHIP and the held readings only.
//
// The work is split in three: planImputation (the monthly matrix and one task per well, plus one per check),
// the MC+LNN fills of those tasks (fillTask; analysisClient spreads them over workers), and assembleModel.

import { saveFiles } from './dataStore';
import {
  Aquifer, Region, Well, Measurement,
  ImputationParams, ImputationModelResult, ImputationWellMetrics, ImputationWellSeries, ImputationCheck,
} from '../types';
import { interpolatePCHIP } from '../utils/interpolation';
import { slugify } from '../utils/strings';
import { checkWindow, summarizeChecks, CHECK_MIN_AFTER, CHECK_MIN_BEFORE, CHECK_MIN_SCORED } from '../utils/imputationSeries';
import { Basin, fillTarget, prepareBasin, MIN_EXTRAP_OBS, MIN_MATRIX_MONTHS, MIN_MEAS, SPARSE_EXTRAP } from './mclnn/core';
import { PipelineCancelledError } from './pipelineCancel';

export interface ImputationPipelineInput {
  title: string;
  minObservations: number;
  minTimeSpan: number;  // years
  holdYears: number;
  check: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;
/** Gaps between readings this long or longer are MC+LNN's; shorter ones keep PCHIP (decision 92b) */
export const MCLNN_GAP_DAYS = 183;

interface Reading { ts: number; value: number }

interface TargetPlan {
  well: Well;
  readings: Reading[];       // sorted, one per time (readings at the same time averaged)
  row: number;               // the well's row in the MC+LNN matrix; -1 under MIN_MATRIX_MONTHS measured months
  check?: { from: number; to: number; hiddenMonths: number[] };
}

/** One MC+LNN fill: matrix row `row` with the months `hidden` left out (a check), or none (the well's fill) */
export interface FillTask { id: string; row: number; hidden: number[] }
export interface FillResult { inside: Float64Array; outside: Float64Array | null; neighbours: number }

export interface ImputationPlan {
  months: string[];          // the model's months, YYYY-MM-01
  monthTs: number[];
  calendarMonth: number[];   // 1-12
  raw: Float64Array[];       // monthly means of the matrix wells (every aquifer well with MIN_MATRIX_MONTHS measured months)
  targets: TargetPlan[];
  tasks: FillTask[];
  omitted: number;           // wells with readings that miss the two minimums
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The monthly matrix, the wells to fill, and the MC+LNN tasks */
export function planImputation(input: ImputationPipelineInput, wells: Well[], measurements: Measurement[]): ImputationPlan {
  const byWell = new Map<string, Map<number, number[]>>();
  for (const m of measurements) {
    if (m.dataType !== 'wte' || !Number.isFinite(m.value)) continue;
    const ts = new Date(m.date).getTime();
    if (isNaN(ts)) continue;
    let w = byWell.get(m.wellId);
    if (!w) byWell.set(m.wellId, w = new Map());
    const list = w.get(ts);
    if (list) list.push(m.value); else w.set(ts, [m.value]);
  }
  const readingsOf = (id: string): Reading[] => [...(byWell.get(id) ?? new Map<number, number[]>()).entries()]
    .map(([ts, v]) => ({ ts, value: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => a.ts - b.ts);

  const wellReadings = wells.map(w => ({ well: w, readings: readingsOf(w.id) })).filter(x => x.readings.length > 0);
  if (wellReadings.length === 0) throw new Error('No wells of this aquifer have water level readings.');

  // The months from the aquifer's first reading to its last
  let lo = Infinity, hi = -Infinity;
  for (const { readings } of wellReadings) { lo = Math.min(lo, readings[0].ts); hi = Math.max(hi, readings[readings.length - 1].ts); }
  const y0 = new Date(lo).getUTCFullYear(), m0 = new Date(lo).getUTCMonth();
  const monthIndex = (ts: number) => { const d = new Date(ts); return (d.getUTCFullYear() - y0) * 12 + d.getUTCMonth() - m0; };
  const T = monthIndex(hi) + 1;
  const monthTs = Array.from({ length: T }, (_, t) => Date.UTC(y0, m0 + t, 1));
  const months = monthTs.map(isoDate);
  const calendarMonth = monthTs.map(ts => new Date(ts).getUTCMonth() + 1);

  // The matrix: monthly means of every well with enough measured months, filled or not (they all serve as neighbours)
  const raw: Float64Array[] = [];
  const rowOf = new Map<string, number>();
  for (const { well, readings } of wellReadings) {
    const sum = new Map<number, [number, number]>();
    for (const r of readings) {
      const k = monthIndex(r.ts);
      const s = sum.get(k);
      if (s) { s[0] += r.value; s[1]++; } else sum.set(k, [r.value, 1]);
    }
    if (sum.size < MIN_MATRIX_MONTHS) continue;
    const row = new Float64Array(T).fill(NaN);
    for (const [k, [s, n]] of sum) row[k] = s / n;
    rowOf.set(well.id, raw.length);
    raw.push(row);
  }

  // The wells to fill: at least minObservations readings over at least minTimeSpan years (as Spatial Analysis)
  const targets: TargetPlan[] = [];
  let omitted = 0;
  for (const { well, readings } of wellReadings) {
    const span = (readings[readings.length - 1].ts - readings[0].ts) / MS_PER_YEAR;
    if (readings.length < Math.max(2, input.minObservations) || span < input.minTimeSpan) { omitted++; continue; }
    const target: TargetPlan = { well, readings, row: rowOf.get(well.id) ?? -1 };
    if (input.check && target.row >= 0) {
      const { from, to } = checkWindow(readings.map(r => r.ts));
      const before = readings.filter(r => r.ts <= from).length, after = readings.filter(r => r.ts >= to).length;
      const hidden = readings.filter(r => r.ts > from && r.ts < to);
      if (before >= CHECK_MIN_BEFORE && after >= CHECK_MIN_AFTER && hidden.length >= CHECK_MIN_SCORED) {
        target.check = { from, to, hiddenMonths: [...new Set(hidden.map(r => monthIndex(r.ts)))] };
      }
    }
    targets.push(target);
  }
  if (targets.length === 0) {
    throw new Error(`No wells have ${input.minObservations} readings over ${input.minTimeSpan} years.`);
  }

  // Tasks, most measured months first (the slowest), so the workers finish together
  const measured = (row: number) => raw[row].reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0);
  const tasks: FillTask[] = [];
  for (const t of [...targets].filter(t => t.row >= 0).sort((a, b) => measured(b.row) - measured(a.row))) {
    if (measured(t.row) < MIN_MEAS) continue;
    tasks.push({ id: `${t.well.id}|fill`, row: t.row, hidden: [] });
    if (t.check) tasks.push({ id: `${t.well.id}|check`, row: t.row, hidden: t.check.hiddenMonths });
  }
  return { months, monthTs, calendarMonth, raw, targets, tasks, omitted };
}

/** The basin the fills share, built once per worker */
export function basinOf(plan: Pick<ImputationPlan, 'raw' | 'calendarMonth'>): Basin {
  return prepareBasin(plan.raw, plan.calendarMonth);
}

/** One MC+LNN fill; null when MC+LNN cannot fill the well */
export function fillTask(basin: Basin, task: FillTask): FillResult | null {
  const series = Float64Array.from(basin.raw[task.row]);
  for (const t of task.hidden) series[t] = NaN;
  return fillTarget(basin, task.row, series);
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const rmseOf = (e: number[]) => Math.sqrt(e.reduce((a, x) => a + x * x, 0) / e.length);

/** Each well's series, metrics and check from the MC+LNN fills (keyed by task id), saved as the model file */
export async function assembleModel(
  input: ImputationPipelineInput, aquifer: Aquifer, region: Region, plan: ImputationPlan,
  fills: Map<string, FillResult | null>, log: (msg: string) => void,
): Promise<ImputationModelResult> {
  const { monthTs, raw, targets } = plan;
  const T = monthTs.length;
  const y0 = new Date(monthTs[0]).getUTCFullYear(), m0 = new Date(monthTs[0]).getUTCMonth();
  const monthOf = (ts: number) => { const d = new Date(ts); return (d.getUTCFullYear() - y0) * 12 + d.getUTCMonth() - m0; };
  const holdMonths = Math.round(input.holdYears * 12);
  const data: Record<string, ImputationWellSeries> = {};
  const wellMetrics: Record<string, ImputationWellMetrics> = {};

  for (const target of targets) {
    const { well, readings, row } = target;
    const xs = readings.map(r => r.ts), ys = readings.map(r => r.value);
    const mFirst = monthOf(xs[0]), mLast = monthOf(xs[xs.length - 1]);
    const readMonths = new Set(xs.map(monthOf));
    const fill = row >= 0 ? fills.get(`${well.id}|fill`) ?? null : null;
    const nMeasured = row >= 0 ? raw[row].reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0) : readMonths.size;
    const reach = nMeasured >= MIN_EXTRAP_OBS ? Infinity : SPARSE_EXTRAP;

    const start = Math.max(0, mFirst - holdMonths), end = Math.min(T - 1, mLast + holdMonths);
    const pchipAt = interpolatePCHIP(xs, ys, monthTs.slice(start, end + 1).map(ts => Math.min(Math.max(ts, xs[0]), xs[xs.length - 1])));
    const values: number[] = [], model: (number | null)[] = [];
    let source = '';
    let k = 0;   // the last reading before the month
    for (let m = start; m <= end; m++) {
      const ts = monthTs[m];
      if (m < mFirst || m > mLast) {
        const out = m < mFirst ? mFirst - m : m - mLast;
        const v = fill?.outside && out <= reach ? fill.outside[m] : NaN;
        model.push(Number.isFinite(v) ? round(v) : null);
        if (Number.isFinite(v)) { values.push(round(v)); source += 'm'; }
        else { values.push(round(m < mFirst ? ys[0] : ys[ys.length - 1])); source += 'h'; }
        continue;
      }
      const inside = fill ? fill.inside[m] : NaN;
      model.push(Number.isFinite(inside) ? round(inside) : null);
      while (k < xs.length - 2 && xs[k + 1] < ts) k++;
      const longGap = !readMonths.has(m) && xs[k] < ts && ts < xs[k + 1] && (xs[k + 1] - xs[k]) / MS_PER_DAY >= MCLNN_GAP_DAYS;
      if (longGap && Number.isFinite(inside)) { values.push(round(inside)); source += 'm'; }
      else { values.push(round(pchipAt[m - start])); source += 'p'; }
    }
    data[well.id] = { start: plan.months[start], values, source, ...(fill ? { model } : {}) };

    // Metrics: MC+LNN's cross-fitted estimates at the measured months against the monthly readings
    let metrics: ImputationWellMetrics;
    if (fill) {
      const obs: number[] = [], est: number[] = [];
      raw[row].forEach((v, m) => { if (!Number.isNaN(v)) { obs.push(v); est.push(fill.inside[m]); } });
      const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
      const ssTot = obs.reduce((a, v) => a + (v - mean) ** 2, 0);
      const ssRes = obs.reduce((a, v, i) => a + (v - est[i]) ** 2, 0);
      metrics = { filled: 'mc-lnn', neighbours: fill.neighbours, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, rmse: Math.sqrt(ssRes / obs.length) };
    } else {
      const reason = row < 0 ? `fewer than ${MIN_MATRIX_MONTHS} months with readings`
        : nMeasured < MIN_MEAS ? `fewer than ${MIN_MEAS} months with readings`
        : 'no nearby wells whose readings track it';
      metrics = { filled: 'simple', reason };
    }

    // The check: the hidden readings against MC+LNN filled without them, and against PCHIP through the rest
    const checkFill = target.check ? fills.get(`${well.id}|check`) ?? null : null;
    let check: ImputationCheck | undefined;
    if (target.check && checkFill) {
      const { from, to } = target.check;
      const kept = readings.filter(r => r.ts <= from || r.ts >= to), hidden = readings.filter(r => r.ts > from && r.ts < to);
      const pchip = interpolatePCHIP(kept.map(r => r.ts), kept.map(r => r.value), hidden.map(r => r.ts));
      const scored = hidden.map((r, i) => ({ r, model: checkFill.inside[monthOf(r.ts)], pchip: pchip[i] })).filter(s => Number.isFinite(s.model));
      if (scored.length >= CHECK_MIN_SCORED) {
        check = {
          from: isoDate(from), to: isoDate(to), n: scored.length,
          model: rmseOf(scored.map(s => s.model - s.r.value)), pchip: rmseOf(scored.map(s => s.pchip - s.r.value)),
        };
        metrics.check = check;
      }
    }
    wellMetrics[well.id] = metrics;

    const counts = { p: 0, m: 0, h: 0 } as Record<string, number>;
    for (const c of source) counts[c]++;
    log(`Well ${well.name || well.id}: `
      + (fill ? `MC+LNN (${fill.neighbours} neighbours, R² ${metrics.r2!.toFixed(3)}, RMSE ${metrics.rmse!.toFixed(2)})` : `PCHIP and held readings only: ${metrics.reason}`)
      + `; months: ${counts.p} PCHIP, ${counts.m} MC+LNN, ${counts.h} held`
      + (check ? `; check, ${check.n} readings hidden ${check.from} to ${check.to}: MC+LNN ${check.model.toFixed(2)}, PCHIP ${check.pchip.toFixed(2)}` : ''));
  }

  const filled = Object.values(wellMetrics).filter(m => m.filled === 'mc-lnn').length;
  log(`${targets.length} wells filled, ${filled} by MC+LNN; ${plan.omitted} wells with readings left out (fewer than `
    + `${input.minObservations} readings over ${input.minTimeSpan} years)`);
  const checks = summarizeChecks(wellMetrics);
  if (input.check) {
    log(checks
      ? `Check: ${checks.wells} wells; MC+LNN was closer than PCHIP to the hidden readings at ${checks.modelCloser} `
        + `(${Math.round((100 * checks.modelCloser) / checks.wells)}%); median RMSE MC+LNN ${checks.medianModel.toFixed(2)}, PCHIP ${checks.medianPchip.toFixed(2)}`
      : 'Check: no well had enough readings to hide a stretch');
  }

  const code = slugify(input.title);
  const filePath = `${region.id}/${slugify(aquifer.name)}/model_wte_${code}.json`;
  const params: ImputationParams = {
    version: 2,
    startDate: plan.months[0],
    endDate: plan.months[T - 1],
    minObservations: input.minObservations,
    minTimeSpan: input.minTimeSpan,
    holdYears: input.holdYears,
    check: input.check,
  };
  const result: ImputationModelResult = {
    title: input.title,
    code,
    aquiferId: aquifer.id,
    aquiferName: aquifer.name,
    regionId: region.id,
    dataType: 'wte',
    filePath,
    createdAt: new Date().toISOString(),
    params,
    wellMetrics,
    data,
    log: [],
  };
  return result;
}

/** Saves a model with its log */
export async function saveModel(result: ImputationModelResult, logLines: string[]): Promise<void> {
  result.log = logLines;
  await saveFiles([{ path: result.filePath, content: JSON.stringify(result) }]);
}

/**
 * The whole run on this thread, for when workers are unavailable: plan, every fill in turn (yielding between them, so the
 * page stays responsive and Cancel takes effect), assemble, save.
 */
export async function runImputationPipeline(
  input: ImputationPipelineInput, aquifer: Aquifer, region: Region, wells: Well[], measurements: Measurement[],
  onLog: (msg: string) => void, onProgress: (step: string, pct: number) => void, isCancelled?: () => boolean,
): Promise<ImputationModelResult> {
  const logLines: string[] = [];
  const log = (msg: string) => { logLines.push(msg); onLog(msg); };
  const plan = planImputation(input, wells, measurements);
  log(describePlan(plan));
  const basin = basinOf(plan);
  const fills = new Map<string, FillResult | null>();
  for (let i = 0; i < plan.tasks.length; i++) {
    if (isCancelled?.()) throw new PipelineCancelledError();
    onProgress(`MC+LNN: ${i} of ${plan.tasks.length} fills done`, 5 + (90 * i) / plan.tasks.length);
    await new Promise(r => setTimeout(r, 0));
    fills.set(plan.tasks[i].id, fillTask(basin, plan.tasks[i]));
  }
  onProgress('Saving model...', 95);
  const result = await assembleModel(input, aquifer, region, plan, fills, log);
  await saveModel(result, logLines);
  onProgress('Complete!', 100);
  return result;
}

export function describePlan(plan: ImputationPlan): string {
  const checks = plan.tasks.filter(t => t.hidden.length > 0).length;
  return `${plan.months.length} months, ${plan.months[0].slice(0, 7)} to ${plan.months[plan.months.length - 1].slice(0, 7)}; `
    + `${plan.targets.length} wells to fill, ${plan.raw.length} wells with ${MIN_MATRIX_MONTHS}+ months of readings as neighbours; `
    + `${plan.tasks.length - checks} MC+LNN fills and ${checks} checks`;
}
