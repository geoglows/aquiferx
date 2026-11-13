/**
 * Client wrapper for the analysis Web Worker. Each run gets its own worker;
 * cancel() terminates it immediately (no cooperative checks needed) and
 * rejects the run promise with PipelineCancelledError so callers can treat
 * it as a quiet abort. Falls back to the main-thread pipeline (with
 * cooperative cancellation) if worker construction fails.
 */
import { RasterAnalysisResult, ImputationModelResult, Aquifer, Region, Well, Measurement } from '../types';
import { runRasterAnalysis } from './rasterAnalysis';
import {
  runImputationPipeline, planImputation, assembleModel, saveModel, describePlan,
  ImputationPipelineInput, ImputationPlan, FillResult,
} from './imputationPipeline';
import { PipelineCancelledError } from './pipelineCancel';
import type { AnalysisJob, RasterJobArgs } from '../workers/analysisWorker';

export interface ImputationJobArgs {
  input: ImputationPipelineInput;
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
}

export interface AnalysisRun<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('../workers/analysisWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('Analysis worker unavailable — running on the main thread:', err);
    return null;
  }
}

function runJob<T>(
  job: AnalysisJob,
  worker: Worker,
  onProgress: (step: string, pct: number) => void,
  onLog?: (msg: string) => void,
): AnalysisRun<T> {
  let settled = false;
  let rejectFn!: (err: unknown) => void;

  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (e: MessageEvent<any>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.step, msg.pct);
      } else if (msg.type === 'log') {
        onLog?.(msg.msg);
      } else if (msg.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(msg.result as T);
      } else if (msg.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker crashed'));
    };
    worker.postMessage(job);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectFn(new PipelineCancelledError());
    },
  };
}

export function startRasterAnalysis(
  args: RasterJobArgs,
  onProgress: (step: string, pct: number) => void,
): AnalysisRun<RasterAnalysisResult> {
  const worker = createWorker();
  if (!worker) {
    let cancelled = false;
    return {
      promise: runRasterAnalysis(
        args.input, args.dataType, args.aquifer, args.region, args.wells, args.measurements,
        onProgress, () => cancelled
      ),
      cancel: () => { cancelled = true; },
    };
  }
  return runJob<RasterAnalysisResult>({ kind: 'raster', args }, worker, onProgress);
}

class WorkersUnavailable extends Error {}

/**
 * Runs the plan's MC+LNN fills on several workers, handing each task to the next free one. Rejects with
 * WorkersUnavailable when not even one worker can be made. `workers` collects them for cancel().
 */
function runFills(
  plan: ImputationPlan, workers: Worker[], onDone: (done: number, total: number) => void,
): Promise<Map<string, FillResult | null>> {
  const tasks = plan.tasks, total = tasks.length;
  const fills = new Map<string, FillResult | null>();
  if (total === 0) return Promise.resolve(fills);
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, total));
  return new Promise((resolve, reject) => {
    let next = 0, done = 0, settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      for (const w of workers) w.terminate();
      if (err) reject(err); else resolve(fills);
    };
    for (let k = 0; k < n; k++) {
      let worker: Worker;
      try {
        worker = new Worker(new URL('../workers/mclnnWorker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        if (k === 0) { finish(new WorkersUnavailable(String(err))); return; }
        break;
      }
      workers.push(worker);
      const send = () => { if (next < total) worker.postMessage({ type: 'task', task: tasks[next++] }); };
      worker.onmessage = (e: MessageEvent<any>) => {
        const msg = e.data;
        if (msg.type === 'ready') send();
        else if (msg.type === 'result') {
          fills.set(msg.id, msg.result);
          onDone(++done, total);
          if (done === total) finish(); else send();
        } else if (msg.type === 'error') finish(new Error(msg.message));
      };
      worker.onerror = (e) => finish(new Error(e.message || 'MC+LNN worker crashed'));
      worker.postMessage({ type: 'init', raw: plan.raw, calendarMonth: plan.calendarMonth });
    }
  });
}

/**
 * Impute Gaps: the plan on this thread, the MC+LNN fills on a pool of workers, then the model is assembled and saved here.
 * Without workers, the whole run happens on this thread (runImputationPipeline).
 */
export function startImputation(
  args: ImputationJobArgs,
  onLog: (msg: string) => void,
  onProgress: (step: string, pct: number) => void,
): AnalysisRun<ImputationModelResult> {
  const { input, aquifer, region, wells, measurements } = args;
  const workers: Worker[] = [];
  let cancelled = false;
  let rejectFn!: (err: unknown) => void;
  const run = async (): Promise<ImputationModelResult> => {
    const logLines: string[] = [];
    const log = (msg: string) => { logLines.push(msg); onLog(msg); };
    onProgress('Preparing the wells...', 1);
    const plan = planImputation(input, wells, measurements);
    log(describePlan(plan));
    let fills: Map<string, FillResult | null>;
    try {
      onProgress(`MC+LNN: 0 of ${plan.tasks.length} fills done`, 3);
      fills = await runFills(plan, workers, (done, total) => onProgress(`MC+LNN: ${done} of ${total} fills done`, 3 + (90 * done) / total));
    } catch (err) {
      if (!(err instanceof WorkersUnavailable)) throw err;
      console.warn('MC+LNN workers unavailable — running on the main thread:', err.message);
      return runImputationPipeline(input, aquifer, region, wells, measurements, onLog, onProgress, () => cancelled);
    }
    if (cancelled) throw new PipelineCancelledError();
    onProgress('Saving model...', 95);
    const result = await assembleModel(input, aquifer, region, plan, fills, log);
    if (cancelled) throw new PipelineCancelledError();
    await saveModel(result, logLines);
    onProgress('Complete!', 100);
    return result;
  };
  const promise = new Promise<ImputationModelResult>((resolve, reject) => {
    rejectFn = reject;
    run().then(resolve, reject);
  });
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const w of workers) w.terminate();
      rejectFn(new PipelineCancelledError());
    },
  };
}
