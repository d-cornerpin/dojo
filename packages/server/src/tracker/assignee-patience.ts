// How long a worker is left alone before the stall ladder (`work/done/ladder.ts`) steps in, and the
// human reassignment record. The bound is never shorter than one legitimate model call on the
// worker's provider, so a slow model is not hinted on a fast model's clock.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { resolveStreamPatience } from '../agent/stream-patience.js';
import { AUDIT_KIND } from '../work/audit-trail.js';
import { appendWorkEvent } from '../work/store.js';

const logger = createLogger('assignee-patience');

/** The trail entry a person's reassignment leaves (an `audit` entry, no event kind of its own). */
export const PATIENCE_ENTRY = {
  reassigned: 'reassignment',
} as const;

export interface PatienceFloor {
  /** Seconds one legitimate model call may take on this assignee's provider, patience total. */
  floorSeconds: number;
  /** `declared`: a provider row named it; `default`: none did; `measured`: recent calls ran longer. */
  basis: 'declared' | 'default' | 'measured';
  modelId: string | null;
}

/** One call's legitimate length on this agent's model, per its provider's declared patience. Anything
 *  unknown falls to the defaults: an unknown provider must not buy itself extra silence. */
export function patienceFloorFor(agentId: string | null | undefined): PatienceFloor {
  const declared = declaredPatienceFloorFor(agentId);
  const measured = measuredCallSeconds(agentId);
  return measured > declared.floorSeconds ? { ...declared, floorSeconds: measured, basis: 'measured' } : declared;
}

/** Slowest of the assignee's last 20 model calls, in seconds (0 when none): a real call is a legitimate one. */
function measuredCallSeconds(agentId: string | null | undefined): number {
  if (!agentId) return 0;
  try {
    const r = getDb().prepare(`SELECT MAX(latency_ms) AS ms FROM (SELECT latency_ms FROM cost_records
        WHERE agent_id = ? AND latency_ms IS NOT NULL ORDER BY created_at DESC LIMIT 20)`).get(agentId) as { ms: number | null } | undefined;
    return r?.ms ? Math.ceil(r.ms / 1000) : 0;
  } catch { return 0; }
}

function declaredPatienceFloorFor(agentId: string | null | undefined): PatienceFloor {
  const fallback: PatienceFloor = {
    floorSeconds: Math.ceil((resolveStreamPatience(null).firstChunkMs
      + resolveStreamPatience(null).idleMs) / 1000),
    basis: 'default',
    modelId: null,
  };
  if (!agentId) return fallback;
  try {
    const row = getDb().prepare(
      `SELECT m.id AS model_id,
              p.first_chunk_timeout_ms AS first_chunk_timeout_ms,
              p.stream_idle_timeout_ms AS stream_idle_timeout_ms
         FROM agents a
         JOIN models m ON m.id = a.model_id
         JOIN providers p ON p.id = m.provider_id
        WHERE a.id = ?`,
    ).get(agentId) as {
      model_id: string;
      first_chunk_timeout_ms: number | null;
      stream_idle_timeout_ms: number | null;
    } | undefined;
    if (!row) return fallback;
    const patience = resolveStreamPatience({
      firstChunkTimeoutMs: row.first_chunk_timeout_ms,
      streamIdleTimeoutMs: row.stream_idle_timeout_ms,
    });
    return {
      floorSeconds: Math.ceil((patience.firstChunkMs + patience.idleMs) / 1000),
      // The resolver's own answer to "did a provider declare this", not a second reading of the
      // same columns: a default and a declaration can be the same number but are not the same thing.
      basis: patience.firstChunkDeclared || patience.idleDeclared ? 'declared' : 'default',
      modelId: row.model_id,
    };
  } catch {
    return fallback;
  }
}

/** The least time a task waits for its worker before a ladder step, in seconds. */
const PATIENCE_BASE_SECONDS = 300;

/** The worker's patience bound in ms: the base, or one legitimate call on its model when that is longer. */
export function patienceBoundMs(agentId: string | null | undefined): number {
  return Math.max(PATIENCE_BASE_SECONDS, patienceFloorFor(agentId).floorSeconds) * 1000;
}

/** What the assignee was last seen doing: the half of a reassignment record nobody can rebuild later. */
export function assigneeLastState(agentId: string | null | undefined): string {
  if (!agentId) return 'unassigned';
  try {
    const row = getDb().prepare(
      `SELECT a.status AS status, a.updated_at AS updated_at,
              (SELECT strftime('%Y-%m-%d %H:%M:%S', MAX(created_at) / 1000, 'unixepoch')
                 FROM messages WHERE agent_id = a.id) AS last_message_at
         FROM agents a WHERE a.id = ?`,
    ).get(agentId) as
      { status: string; updated_at: string | null; last_message_at: string | null } | undefined;
    if (!row) return 'the assigned agent no longer exists';
    const seen = row.last_message_at ?? row.updated_at;
    return seen ? `status=${row.status}, last activity ${seen}` : `status=${row.status}`;
  } catch {
    return 'unknown';
  }
}

/** A person's reassignment, from the dashboard or the main agent's reassign verb: who, why, and the prior worker's last state. */
export function recordReassignment(p: {
  taskId: string; actor: string; fromAgentId: string | null; toAgentId: string | null;
  toGroupId?: string | null; reason: string;
}): void {
  const priorState = assigneeLastState(p.fromAgentId);
  appendWorkEvent(p.taskId, AUDIT_KIND, p.actor, {
    entry_kind: PATIENCE_ENTRY.reassigned,
    reason: p.reason,
    from_agent: p.fromAgentId,
    action_taken: `reassigned ${p.fromAgentId ?? 'unassigned'} → `
      + `${p.toAgentId ?? p.toGroupId ?? 'unassigned'}`,
    note: `prior assignee last state: ${priorState}`,
  });
  logger.info('reassignment recorded', {
    taskId: p.taskId, actor: p.actor, from: p.fromAgentId, to: p.toAgentId ?? p.toGroupId,
  });
}
