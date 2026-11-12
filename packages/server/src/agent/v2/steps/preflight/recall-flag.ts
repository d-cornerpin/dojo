// Post-compaction recall flag: if compaction fired a recall nudge that no recall_recent_thread call has
// followed, arm `awaitingPostCompactRecall`. Its only reader is `steps/execute/dispatch-bookkeeping.ts`.

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import { advance } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

export interface RecallFlagInputs {
  readonly db: Database;
}

export function runRecallFlag(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: RecallFlagInputs,
): void {
  const { agentId } = ctx;
  const { db } = input;
  // Bounded by session_started_at, so a nudge from before a session reset cannot arm the flag.
  try {
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;
    const nudgeQuery = sessionBoundary
      ? `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
           AND created_at >= (unixepoch(?) * 1000)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      : `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const nudgeParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
    const lastNudge = db.prepare(nudgeQuery).get(...nudgeParams) as { created_at: string } | undefined;
    if (lastNudge) {
      const recallQuery = sessionBoundary
        ? `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
             AND created_at >= (unixepoch(?) * 1000)
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        : `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const recallParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
      const lastRecall = db.prepare(recallQuery).get(...recallParams) as { created_at: string } | undefined;
      const nudgeTs = new Date((lastNudge.created_at.includes('Z') ? lastNudge.created_at : lastNudge.created_at + 'Z')).getTime();
      const recallTs = lastRecall
        ? new Date((lastRecall.created_at.includes('Z') ? lastRecall.created_at : lastRecall.created_at + 'Z')).getTime()
        : 0;
      if (nudgeTs > recallTs) {
        turnCtx.state = advance(turnCtx.state!, { awaitingPostCompactRecall: true });
        logger.info('v2: post-compaction recall flag armed', { agentId }, agentId);
      }
    }
  } catch (err) {
    logger.warn('v2: post-compaction recall check failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
