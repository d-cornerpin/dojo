// ════════════════════════════════════════
// agent/v2/hooks/task-complete.ts — Phase 7 / Part X
//
// When a sub-agent completes a task, the parent agent needs to know what
// was asked, what was delivered, and decide whether the result is acceptable.
// v1 already sends a parent-facing system message at completion time, but
// it only includes the COMPLETION SUMMARY — not the original ask. The model
// loses the context of what was originally requested if the sub-agent's
// description got edited mid-task or the parent's chat has churned.
//
// onTaskComplete preserves Claude Code's contract: parent reads + judges.
// No automated drift scoring (Part X "Drift detection: parent agent's job,
// not the engine's"). The engine's only job is to surface the original ask
// alongside the summary.
//
// Fired from agent/spawner.ts:completeAgent AFTER the existing parent
// notification. Both messages are persisted; the existing one stays for
// continuity with v1, the new structured one carries the original ask.
// ════════════════════════════════════════

// (comms-audit 2026-07-01) This hook is now a documented no-op — see onTaskComplete.
// The DB / broadcast / uuid imports and the row interfaces it used to need for its
// full-report injection were removed with the injection.

/**
 * Fires after a sub-agent reports task completion. Persists a structured
 * `[System: ...]` message into the parent's conversation surfacing the
 * original ask + completion summary. Non-fatal — any thrown error is
 * logged and swallowed so completion isn't blocked by a hook failure.
 *
 * @param taskId — the task that was just completed (may be null/undefined
 *   when the sub-agent didn't have a task assigned, in which case this
 *   hook no-ops).
 * @param completingAgentId — the sub-agent that called complete_task.
 */
export async function onTaskComplete(
  taskId: string | null | undefined,
  completingAgentId: string,
): Promise<void> {
  // No-op (comms-audit 2026-07-01, rank 3). This hook used to inject a full
  //   "[System: <agent> completed task '<title>'. Original ask: … Completion
  //    summary: … Review and decide whether to accept, redirect, or reassign.]"
  // report into the PARENT's conversation + a chat:message to the parent's
  // dashboard feed on EVERY task-linked sub-agent completion. That is a firehose
  // dump: it duplicated the brief, self-attributed AGENT NOTICE that
  // spawner.completeAgent now writes (the good template), and flooded the owner's
  // dashboard chat with an engine work-log the primary does not need to see.
  //
  // The requirement it encoded — the parent may need the ORIGINAL ASK (not just
  // the completion summary) to judge the result, in case the sub-agent's
  // description drifted mid-task — is preserved WITHOUT the dump: (a) the brief
  // AGENT NOTICE tells the parent the delegate finished; (b) the tracker task row
  // durably carries original_description + completion_summary for review; (c) the
  // full completion detail (summary + results + stats) is on the agent bus
  // (sendAgentMessage) for deliberate pull. Nothing is surfaced into the parent's
  // live conversation or dashboard chat here. Kept as a documented seam rather
  // than deleted so the requirement above stays visible to future readers.
  void taskId;
  void completingAgentId;
  return;
}
