// The engine's owner of the `agents.status` write; gateway and Dreamer sweeps keep their own writes.
// A leaf module, not in `loop.ts`: there it would close an import cycle and bind test mocks to its path.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { turnContext } from './turn-context.js';
import { markTurnsTerminated } from './v2/turn-record.js';
import type { AgentStatus } from '@dojo/shared';
import { agentStatusMoved } from './agent-owner-cards.js';

const logger = createLogger('agent-status');

/** The optional halves of the write. Absent = the plain shape. Never both. */
export interface StatusWriteOptions {
  readonly clearError?: boolean;
  readonly lastError?: string;
}

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
  } else if (opts?.clearError) {
    db.prepare(`
      UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(status, agentId);
  } else {
    db.prepare(`
      UPDATE agents SET status = ?, last_error = CASE WHEN ? = 'paused' AND (instr(COALESCE(last_error, ''), '[budget_stop]') = 1 OR instr(COALESCE(last_error, ''), '[no_model_fits]') = 1) THEN NULL ELSE last_error END, updated_at = datetime('now') WHERE id = ?
    `).run(status, status, agentId);   // another pause over a park wins: the park's tag goes with it
  }
  agentStatusMoved(agentId, status); // an owner card whose status this left is over
  // An agent back at idle may be owed what waited while it was paused or in error: the one clock looks.
  if (status === 'idle') void import('./v2/owed.js').then((m) => m.armOwedClock());
  if (status === 'terminated') void import('./a2a-transport.js').then((m) => m.judgeKeptRequests(agentId));   // its kept requests are judged now
}

// Diagnostic-only write; a caller holding both facts passes { lastError } to the status writers instead.
export function writeAgentLastError(agentId: string, lastError: string): void {
  getDb().prepare(`
    UPDATE agents SET last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(lastError, agentId);
}

// Clear the diagnostic only; the Healer's recovery chokepoint calls it once, deliberately.
export function clearAgentLastError(agentId: string): void {
  getDb().prepare(`
    UPDATE agents SET last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(agentId);
}

// Boot sweep: a dead process leaves rows 'working' and turns open; restart is the only thing that can know that.
// No updated_at bump (the 75-minute reaper reads it). No turn survives a restart. A turn the dead process did not run
// was left by an older one and is closed at its own start, so nothing reads it as the dead process's work: one that
// started before the dead process (`previousStartMs`, its boot stamp) or, with no stamp, any but the newest open turn
// of an agent left working.
export function resetWorkingAgentsToIdleAtBoot(previousStartMs: number | null = null): number {
  getDb().prepare(`UPDATE turns SET ended_at = started_at, exit_reason = 'terminated', answered = 0 WHERE ended_at IS NULL
    AND (unixepoch(started_at) < @prev OR (@prev IS NULL AND (agent_id NOT IN (SELECT id FROM agents WHERE status = 'working')
      OR turn_number < (SELECT MAX(o.turn_number) FROM turns o WHERE o.agent_id = turns.agent_id AND o.ended_at IS NULL))))`)
    .run({ prev: previousStartMs === null ? null : Math.floor(previousStartMs / 1000) });
  const open = getDb().prepare('SELECT DISTINCT agent_id AS id FROM turns WHERE ended_at IS NULL').all() as Array<{ id: string }>;
  let turnsClosed = 0;
  for (const c of open) turnsClosed += markTurnsTerminated(c.id);
  if (turnsClosed > 0) {
    logger.info(`Closed ${turnsClosed} turn record(s) left open by a run that died mid-turn, as 'terminated'`);
  }
  return getDb().prepare("UPDATE agents SET status = 'idle' WHERE status = 'working'").run().changes;
}

// THE ENGINE'S SEAM: write the status, then broadcast with the turn's own facts on the event.
export function setAgentStatus(
  agentId: string,
  status: AgentStatus,
  // Optional override so a caller holding the diagnostic writes both in ONE statement.
  opts?: StatusWriteOptions,
): void {
  try {
    // userFacing: the turn's conversation binding; `undefined` is omitted so the client keeps its default.
    const turnConvKeyAtStatus = turnContext(agentId)?.convKey; // string | null | undefined
    const userFacingTurn = typeof turnConvKeyAtStatus === 'string' && turnConvKeyAtStatus.length > 0;
    // Clear the diagnostic only on a clean 'idle' end: on 'working' it wipes each retry's error.
    writeAgentStatus(agentId, status, opts ?? (status === 'idle' ? { clearError: true } : undefined));
    // turnKind rides on 'working' so the composer stays quiet on pure A2A turns (unless wordy mode).
    const turnKind = status === 'working' ? turnContext(agentId)?.kind : undefined;
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
