/**
 * Web Worker for Impute Gaps' MC+LNN fills. analysisClient starts several and hands each well to the next free one.
 *
 * Protocol:
 *   in:  { type: 'init', raw, calendarMonth }   the basin's monthly matrix, once
 *        { type: 'task', task }                 one fill (FillTask)
 *   out: { type: 'ready' }
 *        { type: 'result', id, result }         result: { inside, insideTest, outside, neighbours } or null
 *        { type: 'error', message }
 */
import { basinOf, fillTask, FillTask } from '../services/imputationPipeline';
import { Basin } from '../services/mclnn/core';

let basin: Basin | null = null;
const post = (msg: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<{ type: 'init'; raw: Float64Array[]; calendarMonth: number[] } | { type: 'task'; task: FillTask }>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      basin = basinOf({ raw: msg.raw, calendarMonth: msg.calendarMonth });
      post({ type: 'ready' });
    } else {
      if (!basin) throw new Error('MC+LNN worker used before init');
      const r = fillTask(basin, msg.task);
      if (!r) { post({ type: 'result', id: msg.task.id, result: null }); return; }
      const transfer: Transferable[] = [r.inside.buffer as ArrayBuffer, r.insideTest.buffer as ArrayBuffer];
      if (r.outside) transfer.push(r.outside.buffer as ArrayBuffer);
      post({ type: 'result', id: msg.task.id, result: r }, transfer);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
