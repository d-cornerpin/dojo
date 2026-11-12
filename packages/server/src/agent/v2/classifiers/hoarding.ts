// Advisory only, never a block: N heavy loads AND context near compaction, then one nudge (loop.ts).

export const LOADING_GATE_THRESHOLD = 6;

import { isTrackerFamilyCall, toolOpKey } from '../../../tools/work-verbs.js';

/** Measured floor in estimated tokens (chars/4): separates orientation reads from corpus loads. */
export const LOADING_RESULT_MIN_TOKENS = 250;

/** Own-state reads (recent thread, own tracker): cannot confabulate, exempt at any size. */
export function isLoadCountExemptRead(name: string, args?: Record<string, unknown>): boolean {
  return name === 'recall_recent_thread' || isTrackerFamilyCall(name, args);
}

// Durable writes proving the loads have somewhere to land; scratchpad_set stays out: too cheap an escape.
export const STRUCTURING_OPS = new Set<string>([
  'work_open:project',
  'work_open:task',
  'work_update:status',
  'work_update:hand_in',
  'work_note',
  'work_update:edit',
  'file_write',
  'file_append',
  'file_patch',
]);

export function isStructuringTool(name: string, args?: Record<string, unknown>): boolean {
  return STRUCTURING_OPS.has(toolOpKey(name, args));
}

