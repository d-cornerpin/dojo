// Groups consecutive same-category tool calls into batches so the executor can run
// safe (read-only) batches concurrently via Promise.all and serialize everything
// else. A tool with no declared class is 'special', the safest serial behavior.

import type { ToolCall } from '@dojo/shared';
import { workOperation } from '../../../tools/work-verbs.js';

export type ToolCategory = 'safe' | 'serial' | 'agent' | 'special';

export interface ToolBatch {
  category: ToolCategory;
  calls: ToolCall[];
}

/** Per-tool classes registered from the tool definitions at module load (each definitions file calls
 *  registerConcurrency, so this file imports none of them). Also holds per-tool max-result-token caps. */
const REGISTRY_OVERRIDES = new Map<string, ToolCategory>();
const REGISTRY_MAX_RESULT_TOKENS = new Map<string, number>();

export function registerConcurrency(toolName: string, category: ToolCategory): void {
  REGISTRY_OVERRIDES.set(toolName, category);
}

export function registerMaxResultTokens(toolName: string, tokens: number): void {
  REGISTRY_MAX_RESULT_TOKENS.set(toolName, tokens);
}

/** The tool's registered max-result-token cap, or undefined if none. */
export function getRegisteredMaxResultTokens(toolName: string): number | undefined {
  return REGISTRY_MAX_RESULT_TOKENS.get(toolName);
}

/** Keyed on the OPERATION, not the name: `work_update` is both the two reads (safe)
 *  and the status/edit writes; one name-keyed entry could only be one of those. */
export const WORK_OP_CONCURRENCY: Readonly<Record<string, ToolCategory>> = {
  'work_update:list': 'safe',
  'work_update:get': 'safe',
  // Same class as its siblings: it runs SELECTs and nothing else, so it cannot race.
  'work_update:activity': 'safe',
};

/** Lookup order: tracker operation map, then the tool's registered class; anything else is 'special'. */
export function classifyConcurrency(toolName: string, args?: Record<string, unknown>): ToolCategory {
  const op = workOperation(toolName, args);
  if (op !== null) return WORK_OP_CONCURRENCY[op] ?? 'special';
  return REGISTRY_OVERRIDES.get(toolName) ?? 'special';
}

/** Only `safe` batches run concurrently; everything else runs serially. Invariant: a
 *  serial/agent/special call BREAKS a preceding safe batch, the model chose that order
 *  and regrouping by category would change semantics. */
export function partitionTools(toolCalls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const tc of toolCalls) {
    const category = classifyConcurrency(tc.name, tc.arguments);
    const last = batches[batches.length - 1];
    // Only `safe` batches accumulate calls. All other categories produce
    // single-element batches so each gets its own awaited execution.
    if (last && last.category === category && category === 'safe') {
      last.calls.push(tc);
    } else {
      batches.push({ category, calls: [tc] });
    }
  }
  return batches;
}
