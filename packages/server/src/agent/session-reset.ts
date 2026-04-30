// ════════════════════════════════════════
// Session reset reorientation prompt
//
// When an agent's session is reset (via the reset_session tool or the
// dashboard's "new session" button), we inject a short [System: ...]
// message at the top of the new session. Pre-2026-04-30 this prompt
// always told the agent to search the vault, check the tracker, and
// reorient itself before doing anything else. That made sense when the
// reset was a recovery action — the agent had work in flight and we
// wanted them to pick up where they left off.
//
// But when the user resets to give the agent a clean slate (e.g.,
// "stop failing this slide and start over"), the same prompt actively
// fights the user's intent: the agent finds the failed work in the
// vault and tries to resume it.
//
// The fix: pick the prompt based on whether the agent currently has
// any in-progress or on-deck tasks assigned. If yes, the user almost
// certainly wants the agent to resume — full reorientation. If no,
// the user wants a clean start — minimal acknowledgment, wait for the
// next message.
// ════════════════════════════════════════

import { listTasks } from '../tracker/schema.js';

const FULL_REORIENT = '[System: Your session was just reset. Your conversation history has been archived. BEFORE doing anything else, you MUST:\n1. Search the vault (vault_search) for your current projects, active work, and recent decisions\n2. Check the tracker (tracker_list_active) to see your assigned tasks\n3. Load any relevant techniques (list_techniques) for work in progress\n4. Check the current time (get_current_time)\nDo NOT proceed with any work or respond to the user until you have reoriented yourself.]';

const FRESH_START = '[System: Your session was just reset. Your conversation history has been archived. You currently have no in-progress or on-deck tasks assigned, so this is a clean slate. Wait for the user\'s next message before doing anything — do NOT search the vault or tracker for old work to resume. The reset was intentional; treat the next user message as a fresh request.]';

/**
 * Builds the reorientation system message to insert after a session reset.
 * Returns the full reorientation prompt when the agent has active tracker
 * tasks (they should pick up where they left off), or a minimal fresh-start
 * message when the agent has nothing assigned (don't dredge up the past).
 */
export function buildSessionResetMessage(agentId: string): string {
  let hasActiveTask = false;
  try {
    const inProgress = listTasks({ status: 'in_progress', assignedTo: agentId });
    if (inProgress.length > 0) {
      hasActiveTask = true;
    } else {
      const onDeck = listTasks({ status: 'on_deck', assignedTo: agentId });
      hasActiveTask = onDeck.length > 0;
    }
  } catch {
    // If the tracker lookup fails, fall back to the safer behavior:
    // full reorient. Better to dredge up old context than to leave an
    // agent with real work blind.
    hasActiveTask = true;
  }
  return hasActiveTask ? FULL_REORIENT : FRESH_START;
}
