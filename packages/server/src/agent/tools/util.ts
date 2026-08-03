// ════════════════════════════════════════════════════════════════════════════
// TOOLBOX UTILITIES (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// The helpers a relocated handler needs that are not specific to any one
// category. Research 05 §(a) names this module in the split skeleton, and it
// exists for a structural reason rather than a tidiness one: a category module
// may NOT import `agent/tools.ts` (that would close the cycle the split is
// undoing), so anything a handler body used from that file has to move here
// first. This module imports only leaves and stores; nothing in the toolbox
// depends back on it.
//
// RELOCATION, NOT REWRITE. Each function below is the function that stood in
// `agent/tools.ts`, byte-faithful. `agent/tools.ts` now imports them from here
// rather than declaring them, so there is ONE copy and the audit rows the
// remaining switch writes and the ones a relocated handler writes are the same
// rows written by the same code.
// ════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { getCurrentToolCallId, currentTurnNumber, currentTurnRoot } from '../turn-state.js';

/**
 * THE TOOLBOX LOGGER, shared rather than re-created per module.
 *
 * It is named `tools` because that is the name every one of these lines has
 * always carried, and a relocation that silently re-labels the operator's log
 * stream is not a relocation. A category module logs through this, so a line
 * emitted by a moved handler is byte-identical to the line it emitted from the
 * switch.
 */
export const toolsLogger = createLogger('tools');

// Map tool names to valid audit_log action_type values
const AUDIT_ACTION_MAP: Record<string, string> = {
  file_read: 'file_read',
  file_list: 'file_read',
  file_write: 'file_write',
  file_delete: 'file_write',
  exec: 'exec',
};

export function auditLog(agentId: string, actionType: string, target: string | null, result: 'success' | 'denied' | 'error', detail?: string, callId?: string | null): void {
  try {
    const db = getDb();
    // Normalize action_type to match the CHECK constraint
    const normalizedAction = AUDIT_ACTION_MAP[actionType] ?? 'tool_call';
    // P6a execution lineage: every audit row carries the turn that ran it and
    // the root it served, read from the live turn state (the receipts
    // pattern), plus the exact tool_use call id where the caller has one.
    const turnNumber = currentTurnNumber.get(agentId) ?? null;
    const root = currentTurnRoot.get(agentId) ?? null;
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, turn_number, call_id, root_kind, root_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), agentId, normalizedAction, target, result, detail ?? null,
      turnNumber, callId ?? getCurrentToolCallId(agentId), root?.kind ?? null, root?.id ?? null);
  } catch (err) {
    toolsLogger.error('Failed to write audit log', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
