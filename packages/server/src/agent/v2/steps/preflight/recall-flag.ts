// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §8: THE POST-COMPACTION RECALL FLAG.
//
// If compaction fired a recall nudge that nothing has acknowledged since, arm the
// one-shot auto-recall for this turn's first significant tool call. Bounded by
// `session_started_at`, so a nudge from before a session reset cannot arm it.
//
// ⚠ HANDED UP RATHER THAN RETIRED (CUT 9's H4). `awaitingPostCompactRecall` is armed
// HERE and dead-ended in `execute`: its only reader
// (`steps/execute/dispatch-bookkeeping.ts`) clears the flag and sets a second one,
// under a comment saying the auto-injection it existed for was REMOVED at v2.7.10.
// There is no test for it in either repo. It MOVES UNCHANGED — a relocation does not
// get to retire a flag (#15, CUT 5's `modelCallInFlight` precedent, which T13 retired
// on positive evidence: see TOMBSTONE 8).
//
// ⚠ T13's VERDICT ON THIS ONE IS **KEEP**, and the reason is the difference between the
// two. `modelCallInFlight` had NO reader and a NAMED LIVE successor. This flag HAS a
// live reader — `steps/execute/dispatch-bookkeeping.ts` clears it and sets a second
// flag — so retiring it is not a demolition, it is a decision about what that reader
// should do instead, and #15's bar ("when the positive evidence cannot be produced, the
// thing stays") is not met by an absence of tests. Still owned, still unretired.
//
// The section OUTPUTS NOTHING. It only advances the state.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import { advance } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
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
  // ── Post-compaction recall flag (auto-injected via intercept, v2.7.2) ──
  // If compaction fired an unacknowledged recall nudge (no
  // recall_recent_thread call since), arm the one-shot auto-recall that
  // fires on the agent's first significant tool call this turn.
  //
  // v2.7.2, bounded by session_started_at. Previously this query swept
  // ALL of an agent's history for "Memory was just compacted", which
  // meant stale compaction nudges from prior sessions kept arming the
  // flag after a session_reset. Symptom: agent post-reset gets the
  // auto-recall on its very first tool call, recall replays a transcript
  // from before the reset, and the agent gets confused into duplicate
  // calls. The boundary makes the check session-local.
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
