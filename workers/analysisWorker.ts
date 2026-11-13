/**
 * Web Worker host for the raster pipeline. Running it here keeps kriging and
 * IDW off the main thread entirely, and makes cancellation a
 * worker.terminate() instead of cooperative checks. (Impute Gaps runs in
 * mclnnWorker.ts.)
 *
 * Protocol: one job per worker instance.
 *   in:  { kind: 'raster', args: {...} }
 *   out: { type: 'progress', step, pct }
 *        { type: 'done', result }
 *        { type: 'error', message }
 */
import { runRasterAnalysis, RasterPipelineInput } from '../services/rasterAnalysis';
import { Aquifer, Region, Well, Measurement } from '../types';

export interface RasterJobArgs {
  input: RasterPipelineInput;
  dataType: string;
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
}

export type AnalysisJob = { kind: 'raster'; args: RasterJobArgs };

self.onmessage = async (e: MessageEvent<AnalysisJob>) => {
  const job = e.data;
  const post = (msg: object) => (self as unknown as Worker).postMessage(msg);
  try {
    const { input, dataType, aquifer, region, wells, measurements } = job.args;
    const result = await runRasterAnalysis(
      input, dataType, aquifer, region, wells, measurements,
      (step, pct) => post({ type: 'progress', step, pct })
    );
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
