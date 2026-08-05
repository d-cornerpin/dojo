// ── THE ONE OWNER OF THE `agents.status` TRANSITION (PHASE-6 T10 Step 1a) ──
//
// `agents.status` is the fact every other subsystem reads to decide whether an agent is
// available, wedged, or stopped: the drains consult it before self-re-queueing, the Healer
// reaps on it, the dashboard renders it, and the boot sweep repairs it. Before this module
// it had SIXTEEN writers.
//
// The census is in `agent/__tests__/status-writer-conformance.test.ts` and it reads
// STATEMENTS, not hit lines, because five of the writers put `status` on a later line of a
// multi-line `UPDATE agents SET` and no one-line grep has ever seen them:
//
//     33 statements assign `agents.status` / 17 modules / 5 multi-line   (at `1c756a7`)
//     31 statements in 16 modules bypassed the declared writer.
//
// T10 owns the ENGINE side. The thirteen engine + boot + tool-surface statements are re-
// pointed here; the gateway / healer / channel / Dreamer / service-agent rows keep their own
// sweeps and are DECLARED in the census's allowlist with their owner named, so the surface
// that remains is a list somebody wrote rather than a thing somebody finds.
//
// ── WHY THE OWNER IS A LEAF AND NOT `loop.ts` ──
//
// `setAgentStatus` lived inside `agent/v2/loop.ts`. Two costs followed from that, and both
// are paid off by the move:
//
//   1. `rate-limit-retry.ts` had to reach it through `await import('./v2/loop.js')`, with
//      its reason written in place — `model.ts` imports the retry manager and `loop.ts`
//      imports `model.ts`, so a static edge closed an import cycle. This module imports the
//      database, the logger, the broadcaster and the turn context, and nothing else; the
//      dynamic import is retired and the edge is now static.
//   2. `agent/__tests__/rate-limit-alert.test.ts` mocked `../v2/loop.js` to intercept the
//      writer — a mock bound to a PATH rather than to a behaviour, which vitest does not
//      fail when the target stops exporting the name (GUARD-AUDIT F3). It now mocks this
//      module, which is the writer's actual home.
//
// ── THE THREE SHAPES ARE THE TREE'S OWN, CARRIED VERBATIM ──
//
// A single owner that could only express one shape would have forced the other two to stay
// outside it, which is exactly how the surface grew back last time. So the three write forms
// the call sites actually used are all here, and every re-point preserves its site's written
// values EXACTLY — same columns, same values, same `updated_at`:
//
//     plain        status + updated_at
//     clearError   status + last_error = NULL + last_error_at = NULL + updated_at
//     lastError    status + last_error = <text> + last_error_at = now + updated_at
//
// Broadcasting stays at the CALL SITES that already did it, in the order they did it: some
// broadcast, some deliberately do not, and one interleaves in-memory map deletes between the
// write and the broadcast. Moving the broadcast in here would have changed observable order
// at three sites for no requirement, so this module writes and `setAgentStatus` — the
// engine's own turn-aware seam — is the only caller that also emits.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { turnContext } from './turn-context.js';
import type { AgentStatus } from '@dojo/shared';

const logger = createLogger('agent-status');

/** The optional halves of the write. Absent = the plain shape. Never both. */
export interface StatusWriteOptions {
  /** Also NULL `last_error` / `last_error_at` — a clean end, not a retry. */
  readonly clearError?: boolean;
  /** Also RECORD a diagnostic on the row. The 400-char slice is the caller's, not ours. */
  readonly lastError?: string;
}

/**
 * Move one agent's status. THE write; every other module calls this one.
 *
 * Deliberately silent about WHY: the reason lives at the call site, which is where the
 * decision was made. This function owns the statement, not the policy.
 */
export function writeAgentStatus(
  agentId: string,
  status: AgentStatus,
  opts?: StatusWriteOptions,
): void {
  const db = getDb();
  if (opts?.lastError !== undefined) {
    db.prepare(`
      UPDATE agents SET status = ?, last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(status, opts.lastError, agentId);
    return;
  }
  if (opts?.clearError) {
    db.prepare(`
      UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(status, agentId);
    return;
  }
  db.prepare(`
    UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, agentId);
}

/**
 * The boot sweep: a process that died mid-turn leaves rows reading `working` that no run
 * owns. Restarting is the only thing that can know that, so it is the only thing that does
 * this — a SET-based repair with no id, no broadcast (nothing is connected yet) and, kept
 * verbatim from `index.ts`, no `updated_at` bump: the 75-minute stuck-agent reaper reads
 * `updated_at` and touching every row here would reset that clock on the whole roster.
 *
 * Returns how many rows it repaired, so the caller can say so out loud.
 */
export function resetWorkingAgentsToIdleAtBoot(): number {
  return getDb().prepare("UPDATE agents SET status = 'idle' WHERE status = 'working'").run().changes;
}

/**
 * THE ENGINE'S SEAM: write the status and tell the dashboard, with the turn's own facts on
 * the event. Carried verbatim from `agent/v2/loop.ts`, comments included, because every
 * sentence of it is an incident.
 *
 * PHASE-6 T10: the SQL moved to `writeAgentStatus` above and nothing else changed — same
 * two shapes chosen on the same condition, same broadcast, same swallow-and-log.
 */
export function setAgentStatus(agentId: string, status: AgentStatus): void {
  try {
    // The turn's human-conversation binding: non-null conv_key on a genuine human turn
    // (dashboard / iMessage / voice), null on a pure background a2a / engine turn,
    // undefined outside a turn. Threaded onto the broadcast as `userFacing` so the
    // composer can tell "idle after a user turn" from "idle after background noise": on
    // a busy box a queued dashboard send must keep its working-UI latch across a
    // background turn's idle (see AgentStatusEvent.userFacing).
    // PHASE-6 T1: was a capture taken BEFORE this function deleted ten turn-state maps.
    // That delete is gone; a status write no longer decides how long the turn's facts live.
    const turnConvKeyAtStatus = turnContext(agentId)?.convKey; // string | null | undefined
    const userFacingTurn = typeof turnConvKeyAtStatus === 'string' && turnConvKeyAtStatus.length > 0;
    // FA-A2: clear the diagnostic ONLY on a clean turn end ('idle'), not on the
    // 'working' transition. A turn that errors and retries goes working → error →
    // working; clearing last_error on 'working' wiped the diagnostic on every
    // retry and raced the Healer's grace-delayed notify. Clearing on 'idle' lets
    // it survive across retries and clears once the turn actually finishes clean.
    // Genuine recovery also clears it via onAgentRecovered (injury-recovery.ts).
    writeAgentStatus(agentId, status, status === 'idle' ? { clearError: true } : undefined);
    // On 'working', carry the turn kind so the composer can stay quiet on pure
    // A2A turns (unless wordy mode). Defaults to 'user' until the counterparty
    // is resolved early in the turn.
    const turnKind = status === 'working' ? (turnContext(agentId)?.kind ?? 'user') : undefined;
    // userFacing rides on EVERY status this seam emits (working AND idle/terminal),
    // captured above before the idle delete. `undefined` (no turn resolved yet, e.g.
    // the pre-classification 'working' at turn start) is omitted so the client keeps
    // its safe default there; the authoritative value lands on the post-resolution
    // working re-broadcast and on the terminal broadcast.
    broadcast({
      type: 'agent:status',
      agentId,
      status,
      ...(turnKind ? { turnKind } : {}),
      ...(turnConvKeyAtStatus !== undefined ? { userFacing: userFacingTurn } : {}),
    });
  } catch (err) {
    logger.warn('Failed to update agent status', {
      agentId,
      status,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
