// One session reset for every door: the reset_session tool and the dashboard's New Session.
import { v4 as uuidv4 } from 'uuid';
import { NEW_SESSION_DIVIDER } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { archiveAgentConversation } from '../vault/archive.js';
import { onAgentRecovered, evaluateSessionResetGuard } from '../healer/injury-recovery.js';
import { writeAgentStatus } from './agent-status.js';
import { activeRuns, pendingWakeups } from './shared-state.js';
import { buildSessionResetMessage } from './session-reset.js';
import { forgetSessionScratch } from './session-forget.js';
import { rehomeUnclaimedEngineEvents } from './v2/counterparty.js';
import { serveLater } from './v2/serve-later.js';

const logger = createLogger('session-reset');

export interface ResetSessionOptions {
  /** The agent asking, or null when the owner asks from the dashboard. */
  callerAgentId: string | null;
  reason?: string | null;
  ownerRequested?: boolean;
}

export type ResetSessionResult =
  | { ok: true; name: string; archiveId: string | null; boundary: string; healed: boolean }
  | { ok: false; code: 'not_found' | 'terminated' | 'live_turn' | 'guard'; error: string };

// A reset clears the context behind these badges; 'working' only when no run is live (the stuck case).
const HEALED_STATUSES = new Set(['error', 'paused', 'working']);

export async function resetSession(targetId: string, opts: ResetSessionOptions): Promise<ResetSessionResult> {
  const db = getDb();
  const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?')
    .get(targetId) as { id: string; name: string; status: string } | undefined;
  if (!agent) return { ok: false, code: 'not_found', error: 'Agent not found' };
  if (agent.status === 'terminated') {
    return { ok: false, code: 'terminated', error: `Agent "${agent.name}" is already terminated, there is no live session to reset. Spawn a new agent if you need a fresh start.` };
  }
  // Only the run itself may reset mid-turn; a stale 'working' row with no live run is the stuck case a reset heals.
  const live = activeRuns.has(targetId);
  if (live && opts.callerAgentId !== targetId) {
    return { ok: false, code: 'live_turn', error: `Agent "${agent.name}" is in the middle of a live turn right now. Resetting it would cut its work off mid-thought and leak that work past the new-session divider. Wait for it to go idle, then reset.` };
  }
  // An agent's reset of a size-class injury takes compaction first; the owner's own New Session is not checked.
  if (opts.callerAgentId !== null) {
    const guard = evaluateSessionResetGuard(targetId, { reason: opts.reason ?? null, ownerRequested: opts.ownerRequested === true });
    if (!guard.allowed) {
      return { ok: false, code: 'guard', error: guard.refusalText ?? 'Session reset refused: compaction comes first for this injury class.' };
    }
  }

  // force=true: an unprocessed archive must not block the re-archive, or the fresh conversation is lost.
  const archiveId = archiveAgentConversation(targetId, true);
  await forgetSessionScratch(targetId);

  // Summaries stay (the agent's only context across a reset); the scratchpad goes with the session.
  const boundary = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.scratchpad') WHERE id = ?")
    .run(boundary, boundary, targetId);
  rehomeUnclaimedEngineEvents(targetId, boundary);
  if (!live) pendingWakeups.delete(targetId);
  // A reset session has no job to continue: its parked jobs lose their due.
  for (const { id } of db.prepare("SELECT id FROM work WHERE agent_id = ? AND kind <> 'ask' AND next_attempt_at IS NOT NULL").all(targetId) as Array<{ id: string }>) serveLater({ kind: 'task', id }, null, 'a reset session has no job to continue');

  // created_at is stamped at insert, at or after `boundary`, so both rows land inside the new session.
  for (const content of [NEW_SESSION_DIVIDER, buildSessionResetMessage(targetId)]) {
    const id = uuidv4();
    insertMessageIfAbsent({ id, agentId: targetId, role: 'system', content });
    broadcast({ type: 'chat:message', agentId: targetId, message: { id, agentId: targetId, role: 'system', content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });
  }

  const healed = HEALED_STATUSES.has(agent.status) && !(agent.status === 'working' && live);
  if (healed) {
    writeAgentStatus(targetId, 'idle', { clearError: true });
    broadcast({ type: 'agent:status', agentId: targetId, status: 'idle' });
    try { onAgentRecovered(targetId); } catch { /* recovery bookkeeping never fails a reset */ }
  }

  logger.info('Session reset', { callerAgentId: opts.callerAgentId, targetAgentId: targetId, archiveId }, targetId);
  return { ok: true, name: agent.name, archiveId, boundary, healed };
}
