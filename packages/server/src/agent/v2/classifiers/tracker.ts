// ════════════════════════════════════════
// Phase 1B, tracker enforcer + status updater
//
// Per Part VI #1 and #17. v1 relies on a "MANDATORY: Project Tracker"
// rule in the system prompt to make agents create tracker tasks for
// multi-step work. The model often forgets, especially on weak models
// or after compaction. v2 takes the decision out of the LLM's hands:
// the engine inspects the planned tool batch and creates the task
// directly via the tracker module (no tool_use/tool_result in context
// per Part XVI #12, engine-side insertion).
//
// This file is the CLASSIFIER only, pure decision functions. Phase 2
// wires the decisions into actual side effects (calling the tracker
// module to create / update tasks).
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

/**
 * Tools that don't count toward the "is this multi-step work?" threshold.
 * Verbatim from v1 runtime.ts:1598.
 *
 * Rationale: get_current_time / load_tool_docs / vault_search / history_search
 * are reconnaissance, not work. complete_task is a terminal call. vault_remember
 * is bookkeeping. The agent shouldn't get a tracker task auto-created for
 * "let me check the time then look something up in the vault."
 */
const TRIVIAL_TOOLS = new Set([
  'get_current_time',
  'load_tool_docs',
  'complete_task',
  'vault_search',
  'vault_remember',
  'vault_forget',
  'history_search',
  'history_get',
  'history_expand',
]);

/** Tools that ARE tracker operations themselves. */
function isTrackerTool(name: string): boolean {
  return name.startsWith('tracker_');
}

// ── Enforcer ──

export interface TrackerEnforcerInput {
  plannedTools: ToolCall[];
  agentHasTrackerTools: boolean;
  trackerToolCalledThisTurn: boolean;
  agentHasInProgressTask: boolean;
}

export type TrackerEnforcerDecision = 'create' | 'skip';

export interface TrackerEnforcerResult {
  decision: TrackerEnforcerDecision;
  reason: string;
  /** When `decision === 'create'`, suggested task title derived from agent context. Phase 2 fills the real title from the user message. */
  suggestedTitle?: string;
}

/**
 * Decide whether the engine should auto-create a tracker task before
 * executing the planned tool batch. Returns 'skip' when the work is
 * trivial, the agent is already tracking, or the agent doesn't have
 * tracker tools.
 */
export function trackerEnforcer(input: TrackerEnforcerInput): TrackerEnforcerResult {
  if (!input.agentHasTrackerTools) {
    return { decision: 'skip', reason: 'agent has no tracker tools in policy' };
  }
  if (input.agentHasInProgressTask) {
    return { decision: 'skip', reason: 'agent already has an in_progress task, continuing existing work' };
  }
  if (input.trackerToolCalledThisTurn) {
    return { decision: 'skip', reason: 'tracker tool already called this turn' };
  }
  // If the agent itself is calling tracker_create_task, let them do it.
  if (input.plannedTools.some((tc) => tc.name === 'tracker_create_task')) {
    return { decision: 'skip', reason: 'agent is calling tracker_create_task themselves' };
  }
  // If the agent IS using any tracker_* tool in this batch, that means they're
  // engaged with the tracker, skip the engine insertion.
  if (input.plannedTools.some((tc) => isTrackerTool(tc.name))) {
    return { decision: 'skip', reason: 'agent is engaging with tracker (different tracker_* tool)' };
  }
  // Count non-trivial tool calls
  const nonTrivialCount = input.plannedTools.filter(
    (tc) => !TRIVIAL_TOOLS.has(tc.name) && !isTrackerTool(tc.name),
  ).length;
  if (nonTrivialCount < 2) {
    return { decision: 'skip', reason: `only ${nonTrivialCount} non-trivial tool call(s); not multi-step work` };
  }
  return {
    decision: 'create',
    reason: `${nonTrivialCount} non-trivial tool call(s) planned without a tracker task, auto-creating`,
  };
}

// ── Status updater ──

export interface TrackerStatusUpdaterInput {
  toolName: string;
  toolArgs: Record<string, unknown> | undefined;
  isError: boolean;
  currentTaskId: string | null;
}

export type TrackerStatusUpdate = {
  taskId: string;
  status: 'in_progress' | 'complete' | 'blocked' | 'failed';
  reason: string;
};

/**
 * After a tool call completes, decide whether the engine should update
 * the agent's current tracker task status. Most cases return null, 
 * tracker status updates are usually explicit (the agent calls
 * `tracker_update_status` themselves). This catches the few cases
 * where the engine should mirror the call into the tracker.
 *
 * Phase 1B baseline: only fires for `complete_task`, where the agent's
 * declared status maps directly to a tracker status. Phase 2 may
 * extend with more inferences as warranted by real usage.
 */
export function trackerStatusUpdater(
  input: TrackerStatusUpdaterInput,
): TrackerStatusUpdate | null {
  if (!input.currentTaskId) return null;

  if (input.toolName === 'complete_task') {
    const status = (input.toolArgs?.status as string | undefined) ?? null;
    if (status === 'complete' || status === 'completed') {
      return {
        taskId: input.currentTaskId,
        status: 'complete',
        reason: 'agent called complete_task with status=complete',
      };
    }
    if (status === 'blocked') {
      return {
        taskId: input.currentTaskId,
        status: 'blocked',
        reason: 'agent called complete_task with status=blocked',
      };
    }
    if (status === 'failed' || status === 'fail') {
      return {
        taskId: input.currentTaskId,
        status: 'failed',
        reason: 'agent called complete_task with status=failed',
      };
    }
    // Unknown / missing status: complete_task without explicit status
    // is treated as completion (matches v1 default behavior).
    return {
      taskId: input.currentTaskId,
      status: 'complete',
      reason: 'agent called complete_task without explicit status, treating as complete',
    };
  }

  return null;
}
