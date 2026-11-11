// Post-reset prompt: tracker work in progress or on deck means full reorient; none means a fresh start.

import { listTasks } from '../tracker/schema.js';

const FULL_REORIENT = '[System: Your session was just reset. Your conversation history has been archived. BEFORE doing anything else, you MUST:\n1. Search the vault (vault_search) for your current projects, active work, and recent decisions\n2. Check the tracker (work_update(action="list")) to see your assigned tasks\n3. Load any relevant techniques (list_techniques) for work in progress\n4. Check the current time (get_current_time)\nDo NOT proceed with any work or respond to the user until you have reoriented yourself.]';

// Must read as answering the message below it, or ending the turn; any vaguer target stalls the turn.
const FRESH_START = '[System: Your session was just reset. Your conversation history has been archived. You currently have no in-progress or on-deck tasks assigned, so this is a clean slate. The reset was intentional. If there is a user message immediately below this note, treat it as a fresh request and respond to it directly — do NOT search the vault or tracker for old work to resume. If there is no user message below this note, simply end your turn without doing anything; the user will send one when they\'re ready.]';

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
    // Tracker failure falls back to full reorient: dredging old context beats leaving real work blind.
    hasActiveTask = true;
  }
  return hasActiveTask ? FULL_REORIENT : FRESH_START;
}
