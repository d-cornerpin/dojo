// ════════════════════════════════════════
// Model Switch Sanitizer
//
// When an agent's model changes, tool_use/tool_result messages in their
// history may contain IDs from the old model that the new model can't
// reconcile. Some providers (MiniMax, etc.) reject messages with
// unrecognized tool IDs entirely.
//
// v2.5.11 — REWORKED. Previously this function MUTATED the DB on every
// model change: it rewrote assistant messages from JSON to plain text and
// DELETED tool_result rows. The intent was "make history compatible with
// the new model." The effect was destroying recent conversation history
// every time a user switched models mid-session.
//
// Now it's a no-op for the DB. The actual flattening happens in-memory in
// the context assembler at API-call time, only when the message's source
// model differs from the current model's provider in a way that matters.
// DB stays the source of truth. Switching models is reversible — switch
// back and the original structured tool history is still there.
//
// v2.5.11 (recall hardening) — Also drops a small system message into the
// chat after the switch, nudging the agent toward recall_recent_thread if
// it feels disoriented. Belt-and-suspenders for the rare case where the
// in-memory flattener can't fully reconcile the old-model tool IDs.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';

const logger = createLogger('model-switch');

const RECALL_NUDGE_TEXT =
  '[System: Model just changed. If the recent thread feels unclear or tool history looks malformed, call recall_recent_thread(include_tool_results: true) BEFORE responding — it reads directly from your messages table and shows you what was actually said.]';

function insertModelSwitchNudge(agentId: string): void {
  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(id, agentId, RECALL_NUDGE_TEXT);
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content: RECALL_NUDGE_TEXT,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('Failed to insert model-switch recall nudge', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/**
 * v2.5.11 — Non-destructive. Kept as an exported function so existing call
 * sites (route handlers, agent tools, healer auto-fix) don't break. Logs
 * the call for visibility and returns the previous shape so callers'
 * messages stay accurate, but does NOT touch existing rows.
 *
 * The actual flattening of tool_use/tool_result history for cross-provider
 * compatibility now happens in memory/assembler.ts:flattenToolCallsForCompat
 * at API-call time. That way no data is ever lost, and switching models is
 * a fully reversible operation.
 */
export function sanitizeMessagesOnModelChange(agentId: string): { collapsed: number } {
  logger.info('Model change recorded (sanitization deferred to assembly time)', { agentId }, agentId);
  insertModelSwitchNudge(agentId);
  return { collapsed: 0 };
}
