import { saveFiles } from './dataStore';
import {
  Aquifer, Region, Well, Measurement,
  ImputationParams, ImputationDataRow, ImputationModelResult, ImputationWellMetrics, ImputationCheck,
} from '../types';
import { fetchGldasFeatures, GldasFeatures } from './gldasFetch';
import { trainElm, predictElm } from './elm';
import { interpolatePCHIP } from '../utils/interpolation';
import { slugify } from '../utils/strings';
import { pchipMonthMask, MIN_TRAINING_MONTHS } from '../utils/imputationMonths';
import {
  shiftedSeries, checkWindow, summarizeChecks, CHECK_MIN_BEFORE, CHECK_MIN_AFTER, CHECK_MIN_SCORED,
} from '../utils/imputationSeries';
import { PipelineCancelledError } from './pipelineCancel';

export interface ImputationPipelineInput {
  title: string;
  startDate: string;
  endDate: string;
  gldasStartDate: string;  // first month of the soil moisture record (from fetchGldasDateRange)
  gldasEndDate: string;    // last month of the soil moisture record
  minSamples: number;
  gapSize: number;    // days (Python default: 730)
  padSize: number;    // days (Python default: 180)
  hiddenUnits: number;
  lambda: number;
}

function yieldToUI(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

/**
 * Generate monthly date grid from startDate to endDate (inclusive), UTC-based.
 * Matches Python: pd.date_range(start, freq='1MS', end=end)
 */
function generateMonthlyDates(startDate: string, endDate: string): string[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  // An Invalid Date makes `d > end` always false — without this guard the
  // loop below would never terminate
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid date range: "${startDate}" – "${endDate}"`);
  }
  const dates: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const MAX_MONTHS = 10000; // backstop: ~833 years
  for (let i = 0; i < MAX_MONTHS; i++) {
    const d = new Date(Date.UTC(year, month, 1));
    if (d > end) break;
    dates.push(d.toISOString().slice(0, 10));
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return dates;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Run the full imputation pipeline.
 *
 * Matches the Python notebook flow:
 * 1. interp_well — PCHIP per well with gap/pad blanking
 * 2. Build combined dataframe (well PCHIP + GLDAS features)
 * 3. zscore_training_data — global z-score normalization
 * 4. Add year (min-max) and month (one-hot) features
 * 5. impute_data — per-well ELM training on ALL wells
 * 6. reverse_zscore_data — per-well denormalization
 */
export async function runImputationPipeline(
  input: ImputationPipelineInput,
  aquifer: Aquifer,
  region: Region,
  wells: Well[],
  measurements: Measurement[],
  onLog: (msg: string) => void,
  onProgress: (step: string, pct: number) => void,
  isCancelled?: () => boolean,
): Promise<ImputationModelResult> {
  const { title, startDate, endDate, minSamples, gapSize, padSize, hiddenUnits, lambda } = input;

  // The run's log goes into the model file, so the chart's Processing Log shows it after a reload and for Sample Data
  const logLines: string[] = [];
  const log = (msg: string) => { logLines.push(msg); onLog(msg); };

  // Yield point: lets the UI repaint AND aborts the pipeline when the
  // user cancelled — without this the ELM training grinds on (and saves
  // its model file) after the wizard closes
  const tick = async () => {
    if (isCancelled?.()) throw new PipelineCancelledError();
    await yieldToUI();
  };

  // Gap/pad are already in days (matching Python's gap_size=730, pad=180)
  const gapSizeMs = gapSize * MS_PER_DAY;
  const padSizeMs = padSize * MS_PER_DAY;

  // ===== Step 1: Fetch GLDAS data (0-5%) =====
  onProgress('Reading soil moisture...', 0);
  log(`Reading soil moisture for aquifer "${aquifer.name}"...`);
  await tick();

  let gldas: GldasFeatures;
  try {
    // Cache key must include the region — every single-unit region uses
    // aquifer_id=0, so a bare aquifer id collides across regions
    gldas = await fetchGldasFeatures(`${region.id}:${aquifer.id}`, aquifer.geojson, input.gldasStartDate, input.gldasEndDate);
    log(`Soil moisture features: ${gldas.dates.length} months, ${gldas.dates[0]} to ${gldas.dates[gldas.dates.length - 1]}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: Could not read soil moisture: ${msg}`);
    throw new Error(`Could not read soil moisture: ${msg}`);
  }
  onProgress('Soil moisture loaded', 5);

  // ===== Step 2: Prepare well data (5-10%) =====
  onProgress('Preparing well data...', 5);
  await tick();

  const wteMeasurements = measurements.filter(m => m.dataType === 'wte');
  const byWell = new Map<string, Measurement[]>();
  for (const m of wteMeasurements) {
    if (!byWell.has(m.wellId)) byWell.set(m.wellId, []);
    byWell.get(m.wellId)!.push(m);
  }

  // Filter wells by minSamples (matches Python: wells_df.dropna(thresh=min_samples, axis=1))
  interface QualifiedWell {
    well: Well;
    sorted: { date: string; ts: number; value: number }[];
  }
  const qualifiedWells: QualifiedWell[] = [];
  let omitted = 0;

  for (const well of wells) {
    const sorted = (byWell.get(well.id) ?? [])
      .filter(m => !isNaN(new Date(m.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(m => ({ date: m.date, ts: new Date(m.date).getTime(), value: m.value }));
    if (sorted.length < Math.max(2, minSamples)) {
      omitted++;
      continue;
    }
    qualifiedWells.push({ well, sorted });
  }

  log(`${qualifiedWells.length} wells qualified (>= ${minSamples} measurements), ${omitted} omitted`);

  if (qualifiedWells.length === 0) {
    throw new Error(`No wells have >= ${minSamples} measurements. Adjust min samples or date range.`);
  }

  onProgress('Well data prepared', 10);

  // ===== Step 3: Generate monthly date grid from actual GLDAS feature dates =====
  // Use the actual trimmed GLDAS dates (not WMS capabilities dates) to match Python
  const gldasFeatureStart = gldas.dates[0];
  const gldasFeatureEnd = gldas.dates[gldas.dates.length - 1];
  const monthlyDates = generateMonthlyDates(gldasFeatureStart, gldasFeatureEnd);
  const monthlyTimestamps = monthlyDates.map(d => new Date(d).getTime());
  log(`Training date grid: ${monthlyDates.length} months from ${gldasFeatureStart} to ${gldasFeatureEnd}`);
  log(`Output will be clipped to: ${startDate} to ${endDate}`);

  // Build GLDAS lookup by date
  const gldasByDate = new Map<string, number>();
  for (let i = 0; i < gldas.dates.length; i++) {
    gldasByDate.set(gldas.dates[i], i);
  }

  // ===== PHASE A: PCHIP interpolation for ALL wells =====
  // Matches Python interp_well(wells_df, gap_size, pad, spacing)
  onProgress('PCHIP interpolation...', 12);
  await tick();

  const wellPchip = new Map<string, (number | null)[]>();

  for (const { well, sorted } of qualifiedWells) {
    const measTimestamps = sorted.map(m => m.ts);
    const measValues = sorted.map(m => m.value);

    // PCHIP at the months from the first reading up to (not including) the last, as Python blanks
    // index >= end_meas_date, less the inside of each gap longer than gapSize, which keeps padSize of
    // PCHIP at each end (Python: x_diff > gap_size; interp_df[meas + pad : next - pad] = np.nan)
    const mask = pchipMonthMask(measTimestamps, monthlyTimestamps, gapSizeMs, padSizeMs);
    const pchipIndices = mask.flatMap((m, i) => (m ? [i] : []));
    const pchipFull: (number | null)[] = new Array(monthlyDates.length).fill(null);
    if (pchipIndices.length > 0) {
      const pchipValues = interpolatePCHIP(measTimestamps, measValues, pchipIndices.map(i => monthlyTimestamps[i]));
      pchipIndices.forEach((idx, j) => { pchipFull[idx] = pchipValues[j]; });
    }

    wellPchip.set(well.id, pchipFull);
  }

  // Second filter: drop wells with < minSamples non-NaN PCHIP values
  // Matches Python: well_interp_df.dropna(thresh=min_samples, axis=1). The fit needs
  // MIN_TRAINING_MONTHS too; the wizard counts wells by the same rule.
  const minMonths = Math.max(minSamples, MIN_TRAINING_MONTHS);
  const activeWells: QualifiedWell[] = [];
  for (const qw of qualifiedWells) {
    const pchip = wellPchip.get(qw.well.id);
    if (!pchip) continue;
    const nonNullCount = pchip.filter(v => v !== null).length;
    if (nonNullCount >= minMonths) {
      activeWells.push(qw);
    } else {
      wellPchip.delete(qw.well.id);
      log(`Well ${qw.well.name}: dropped after PCHIP (only ${nonNullCount} non-NaN values)`);
    }
  }

  log(`PCHIP interpolation complete: ${activeWells.length} wells retained`);

  // ===== PHASE B: Identify valid GLDAS rows =====
  // Matches Python: combined_df.dropna(subset=names) — keep rows where GLDAS features are present
  const validRowIndices: number[] = [];
  for (let i = 0; i < monthlyDates.length; i++) {
    if (gldasByDate.has(monthlyDates[i])) {
      validRowIndices.push(i);
    }
  }
  const nRows = validRowIndices.length;
  log(`${nRows} months with soil moisture`);

  if (nRows === 0) {
    throw new Error('No soil moisture in the selected date range');
  }

  // GLDAS feature arrays for valid rows
  const gldasSoilw = validRowIndices.map(i => gldas.soilw[gldasByDate.get(monthlyDates[i])!]);
  const gldasYr01 = validRowIndices.map(i => gldas.soilw_yr01[gldasByDate.get(monthlyDates[i])!]);
  const gldasYr03 = validRowIndices.map(i => gldas.soilw_yr03[gldasByDate.get(monthlyDates[i])!]);
  const gldasYr05 = validRowIndices.map(i => gldas.soilw_yr05[gldasByDate.get(monthlyDates[i])!]);
  const gldasYr10 = validRowIndices.map(i => gldas.soilw_yr10[gldasByDate.get(monthlyDates[i])!]);

  // ===== PHASE C: Compute z-score statistics =====
  // Matches Python: norm_df = zscore_training_data(combined_df, combined_df)
  // Global per-column mean/std using sample std (ddof=1, pandas default)
  onProgress('Computing normalization statistics...', 15);
  await tick();

  // Feature z-score stats (global, from ALL valid rows)
  const gArrays = [gldasSoilw, gldasYr01, gldasYr03, gldasYr05, gldasYr10];
  const featureMeans: number[] = [];
  const featureStds: number[] = [];

  for (let f = 0; f < 5; f++) {
    let sum = 0;
    for (let r = 0; r < nRows; r++) sum += gArrays[f][r];
    const mean = sum / nRows;
    featureMeans.push(mean);

    let sumSq = 0;
    for (let r = 0; r < nRows; r++) sumSq += (gArrays[f][r] - mean) ** 2;
    // Sample std (ddof=1) matching pandas .std() default
    featureStds.push(nRows > 1 ? Math.sqrt(sumSq / (nRows - 1)) || 1 : 1);
  }

  // PCHIP at the valid soil moisture rows, per well
  const wellPchipAtRows = new Map<string, (number | null)[]>();
  for (const { well } of activeWells) {
    const pchipFull = wellPchip.get(well.id);
    if (pchipFull) wellPchipAtRows.set(well.id, validRowIndices.map(i => pchipFull[i]));
  }

  // ===== PHASE D: Build feature matrix for ALL valid rows =====
  // Columns: 5 z-scored GLDAS + 1 min-max year + 12 one-hot month + 1 bias = 19
  // Matches Python: names = ['soilw', ..., 'soilw_yr10', 'year', 'month_1', ..., 'month_12'] + bias
  onProgress('Building feature matrix...', 18);
  await tick();

  // Year min-max normalization (matches Python: (year - min) / (max - min))
  const years = validRowIndices.map(i => new Date(monthlyDates[i]).getUTCFullYear());
  const yearMin = Math.min(...years);
  const yearMax = Math.max(...years);
  const yearRange = yearMax - yearMin || 1;

  const allFeatures: number[][] = [];
  for (let r = 0; r < nRows; r++) {
    const d = new Date(monthlyDates[validRowIndices[r]]);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth(); // 0-11 (matches Python's 1-12 one-hot encoding order)

    // Z-score GLDAS features (using global stats)
    const zGldas = gArrays.map((arr, f) => (arr[r] - featureMeans[f]) / featureStds[f]);

    // Min-max normalized year
    const normYear = (year - yearMin) / yearRange;

    // One-hot month (12 columns)
    const monthOneHot = new Array(12).fill(0);
    monthOneHot[month] = 1;

    // Combine: 5 GLDAS + 1 year + 12 month + 1 bias = 19
    // Bias matches Python: np.hstack((tx, np.ones(n).T))
    allFeatures.push([...zGldas, normYear, ...monthOneHot, 1.0]);
  }

  // ===== PHASE E: Per-well ELM training and prediction =====
  // Matches Python: impute_data(norm_df, well_names, names) — trains ELM for EVERY well

  /**
   * Fit the ELM to a well's PCHIP values at the rows (null where there is none) and predict every row, in the well's units.
   * The targets are z-scored with the mean and sample standard deviation of the well's own PCHIP values
   * (Python: norm_df[well] = (combined_df[well] - mean) / std); R² and RMSE compare the fit with them.
   */
  const fitSeries = (pchipAtRows: (number | null)[]) => {
    const values = pchipAtRows.filter((v): v is number => v !== null);
    if (values.length < 3) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)) || 1;
    const trainIndices: number[] = [];
    const trainTargets: number[] = [];
    pchipAtRows.forEach((v, r) => { if (v !== null) { trainIndices.push(r); trainTargets.push((v - mean) / std); } });
    // Matches Python: W_out = np.linalg.lstsq(X.T.dot(X) + lamb*I, X.T.dot(ty))
    const elmResult = trainElm(trainIndices.map(r => allFeatures[r]), trainTargets, hiddenUnits, lambda);
    let ssTot = 0, ssRes = 0;
    trainIndices.forEach((r, i) => {
      const actual = pchipAtRows[r] as number;
      ssTot += (actual - mean) ** 2;
      ssRes += (actual - (elmResult.trainPredictions[i] * std + mean)) ** 2;
    });
    // Predict for ALL valid rows (Python: predict(all_tx_values, W_in, b, W_out)), back in the well's units
    const pred = predictElm(elmResult.model, allFeatures).map(v => v * std + mean);
    return { pred, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, rmse: Math.sqrt(ssRes / trainIndices.length), nTrain: trainIndices.length };
  };

  const rowTs = validRowIndices.map(i => monthlyTimestamps[i]);
  const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rmseOf = (errors: number[]) => Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);

  /**
   * The hold-out check: hide a stretch from the middle of the well's record (checkWindow), fit the well again on the other
   * readings, and score the hidden readings that fall between two months the model fills, against the shifted model and
   * against the PCHIP curve through the other readings. Null when the well has too few readings for it.
   */
  const runCheck = (sorted: { ts: number; value: number }[]): ImputationCheck | null => {
    const { from, to } = checkWindow(sorted.map(m => m.ts), gapSizeMs, padSizeMs);
    const kept = sorted.filter(m => m.ts <= from || m.ts >= to);
    const hidden = sorted.filter(m => m.ts > from && m.ts < to);
    if (kept.filter(m => m.ts <= from).length < CHECK_MIN_BEFORE || kept.filter(m => m.ts >= to).length < CHECK_MIN_AFTER
      || hidden.length < CHECK_MIN_SCORED) return null;
    const keptTs = kept.map(m => m.ts), keptValues = kept.map(m => m.value);
    const monthIdx = pchipMonthMask(keptTs, monthlyTimestamps, gapSizeMs, padSizeMs).flatMap((m, i) => (m ? [i] : []));
    const full: (number | null)[] = new Array(monthlyDates.length).fill(null);
    if (monthIdx.length > 0) {
      const v = interpolatePCHIP(keptTs, keptValues, monthIdx.map(i => monthlyTimestamps[i]));
      monthIdx.forEach((k, j) => { full[k] = v[j]; });
    }
    const atRows = validRowIndices.map(i => full[i]);
    if (atRows.filter(v => v !== null).length < minMonths) return null;
    const fit = fitSeries(atRows);
    if (!fit) return null;
    const series = shiftedSeries(atRows, fit.pred);
    const scored: { ts: number; value: number; model: number }[] = [];
    for (const h of hidden) {
      let lo = 0, hi = rowTs.length;  // k = the last row at or before the reading
      while (lo < hi) { const mid = (lo + hi) >> 1; if (rowTs[mid] <= h.ts) lo = mid + 1; else hi = mid; }
      const k = lo - 1;
      if (k < 0 || k >= rowTs.length - 1 || atRows[k] !== null || atRows[k + 1] !== null) continue;
      const f = (h.ts - rowTs[k]) / (rowTs[k + 1] - rowTs[k]);
      scored.push({ ts: h.ts, value: h.value, model: series[k] + f * (series[k + 1] - series[k]) });
    }
    if (scored.length < CHECK_MIN_SCORED) return null;
    const pchipAt = interpolatePCHIP(keptTs, keptValues, scored.map(m => m.ts));
    return {
      from: isoDate(from), to: isoDate(to), n: scored.length,
      model: rmseOf(scored.map(m => m.model - m.value)),
      pchip: rmseOf(scored.map((m, i) => pchipAt[i] - m.value)),
    };
  };

  const allDataRows: ImputationDataRow[] = [];
  const wellMetrics: Record<string, ImputationWellMetrics> = {};

  for (let wi = 0; wi < activeWells.length; wi++) {
    const { well, sorted } = activeWells[wi];
    const pct = 20 + (wi / activeWells.length) * 70;
    onProgress(`ELM training well ${wi + 1}/${activeWells.length}...`, pct);
    // Yield before each well's solve so progress text can repaint and Cancel takes effect between wells
    await tick();

    const pchipAtRows = wellPchipAtRows.get(well.id);
    if (!pchipAtRows || pchipAtRows.filter(v => v !== null).length < 3) {
      log(`Well ${well.name}: skipped (too few months of record with soil moisture)`);
      continue;
    }

    try {
      const fit = fitSeries(pchipAtRows)!;
      const combined = shiftedSeries(pchipAtRows, fit.pred);
      const check = runCheck(sorted);
      wellMetrics[well.id] = check ? { r2: fit.r2, rmse: fit.rmse, check } : { r2: fit.r2, rmse: fit.rmse };
      log(`Well ${well.name}: ELM R²=${fit.r2.toFixed(4)}, RMSE=${fit.rmse.toFixed(2)} (${fit.nTrain} training pts); `
        + (check ? `check, ${check.n} readings hidden from ${check.from} to ${check.to}: model RMSE ${check.model.toFixed(2)}, PCHIP ${check.pchip.toFixed(2)}`
          : 'no check (too few readings)'));

      // Rows: PCHIP where available, else the model shifted to meet it
      for (let r = 0; r < nRows; r++) {
        allDataRows.push({
          well_id: well.id,
          date: monthlyDates[validRowIndices[r]],
          model: fit.pred[r],
          pchip: pchipAtRows[r],
          combined: combined[r],
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Well ${well.name}: ELM training failed: ${msg}`);
    }
  }

  const checks = summarizeChecks(wellMetrics);
  log(checks
    ? `Check: ${checks.wells} of ${Object.keys(wellMetrics).length} wells; the model was closer than PCHIP to the hidden readings at `
      + `${checks.modelCloser} (${Math.round((100 * checks.modelCloser) / checks.wells)}%); median RMSE model ${checks.medianModel.toFixed(2)}, `
      + `PCHIP ${checks.medianPchip.toFixed(2)}`
    : 'Check: no well had enough readings to hide a stretch');

  // ===== Step 5: Save result (90-100%) =====
  onProgress('Saving model...', 90);
  await tick();

  const code = slugify(title);
  const aquiferSlug = slugify(aquifer.name);
  const filePath = `${region.id}/${aquiferSlug}/model_wte_${code}.json`;

  // Filter output rows to the user's requested date range
  const outputStartTs = new Date(startDate).getTime();
  const outputEndTs = new Date(endDate).getTime();
  const outputRows = allDataRows.filter(row => {
    const ts = new Date(row.date).getTime();
    return ts >= outputStartTs && ts <= outputEndTs;
  });

  const params: ImputationParams = {
    startDate,
    endDate,
    gldasStartDate: gldasFeatureStart,
    gldasEndDate: gldasFeatureEnd,
    minSamples,
    gapSize,
    padSize,
    hiddenUnits,
    lambda,
  };

  const result: ImputationModelResult = {
    title,
    code,
    aquiferId: aquifer.id,
    aquiferName: aquifer.name,
    regionId: region.id,
    dataType: 'wte',
    filePath,
    createdAt: new Date().toISOString(),
    params,
    wellMetrics,
    data: outputRows,
    log: logLines,
  };

  // Save to My Data
  await saveFiles([{ path: filePath, content: JSON.stringify(result) }]);

  onProgress('Complete!', 100);
  onLog('Imputation complete! Model saved.');

  return result;
}
