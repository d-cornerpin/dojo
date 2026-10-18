// ════════════════════════════════════════
// The primary's decision on a held destructive call, and the wake that carries it back (t232).
//
// Split out of `destructive-gate.ts` (which files the request and sweeps the stale ones) because this
// half has one more thing to know than that one: WHICH WORK the held call belonged to.
//
// A decision is not a job of its own. It serves the ask, task or run that was waiting on the held call,
// and the approval row recorded that lineage when the call was held (migration 117: root_kind, root_id,
// task_id). So the decision asks the work ledger what became of that work:
//   * still open        -> wake the requester as before, but INTO that work: the wake carries the row's
//                          lineage through the A2A door (`work`), so the turn it starts is rooted in the
//                          ask or task and not in a fresh engine event with nothing to serve;
//   * finished          -> record the decision and wake nobody. Nothing is left for it to serve: a grant
//                          expires unused, a denial retries nothing. (Waking an agent with no open work and
//                          the words "find a non-destructive approach" made it redo finished work and answer
//                          the owner a second time.)
//   * no lineage at all -> an old row, or a call made outside any turn: nothing says the work is finished,
//                          so wake as before.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { EngineEventWork } from '../memory/message-store.js';
import { lineageVerdict, type LineageVerdict } from './v2/work-lineage.js';

const logger = createLogger('destructive-gate');

export const APPROVAL_TTL_MINUTES = 60;

/**
 * Deliver an engine wake over A2A and report whether it actually LANDED.
 * The transport returns { delivered:false } for its common drop reasons (target
 * not found, hop limit, semantic dedup) and only THROWS on unexpected errors, so
 * the pre-FA-P1 bare try/catch treated a dropped wake as a success. This gate
 * cannot: an undelivered approval wake is the exact failure it must survive.
 */
export async function deliverGateWake(envelope: {
  intent: 'QUESTION' | 'ANSWER';
  payload: string;
  toAgent: string;
  requiresResponse: boolean;
  work?: EngineEventWork | null;
}): Promise<boolean> {
  try {
    const { deliverA2AMessage } = await import('./a2a-transport.js');
    const result = await deliverA2AMessage({
      intent: envelope.intent,
      threadId: uuidv4(),
      requiresResponse: envelope.requiresResponse,
      payload: envelope.payload,
      toAgent: envelope.toAgent,
      fromAgent: 'system',
      work: envelope.work ?? null,
    });
    if (!result.delivered) {
      logger.warn('destructive-gate: approval wake not delivered', {
        to: envelope.toAgent, intent: envelope.intent, reason: result.reason,
      });
    }
    return result.delivered;
  } catch (err) {
    logger.error('destructive-gate: approval wake threw', {
      to: envelope.toAgent, intent: envelope.intent,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The lineage of the held call that is STILL open, as the columns the woken turn is rooted from. */
function wakeWork(row: { root_kind: string | null; root_id: string | null; task_id: string | null }, v: LineageVerdict): EngineEventWork | null {
  const root = !!row.root_kind && !!row.root_id && !v.rootSpent;
  const task = !!row.task_id && !v.taskSpent;
  if (!root && !task) return null;
  return {
    taskId: task ? row.task_id : null,
    runId: root && row.root_kind === 'occurrence' ? row.root_id : null,
    rootKind: root ? row.root_kind : null,
    rootId: root ? row.root_id : null,
  };
}

/** The primary's decision. Returns agent-facing result text. */
export async function decideApproval(input: {
  deciderAgentId: string;
  token: string;
  decision: 'approve' | 'deny';
}): Promise<string> {
  const db = getDb();
  const row = db.prepare(`SELECT token, agent_id, tool_name, request_text, status, root_kind, root_id, task_id FROM destructive_approvals WHERE token = ?`)
    .get(input.token) as {
      token: string; agent_id: string; tool_name: string; request_text: string; status: string;
      root_kind: string | null; root_id: string | null; task_id: string | null;
    } | undefined;
  if (!row) return `No approval request found for token ${input.token}.`;
  if (row.status !== 'pending') return `Request ${input.token} is already ${row.status}.`;

  const status = input.decision === 'approve' ? 'approved' : 'denied';
  db.prepare(`UPDATE destructive_approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE token = ?`)
    .run(status, input.deciderAgentId, input.token);

  const reqName = (db.prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined)?.name ?? row.agent_id;

  // The work this held call belonged to. A row with nothing the ledger can answer for is `judged: false`, which
  // falls through to the wake exactly as every row did before this existed.
  const verdict = lineageVerdict({ rootKind: row.root_kind, rootId: row.root_id, taskId: row.task_id });
  if (verdict.finished) {
    logger.info('destructive-gate: decision recorded; the work it belonged to is finished, so no wake', {
      token: input.token, decision: input.decision, decidedBy: input.deciderAgentId, rootKind: row.root_kind, taskId: row.task_id,
    });
    return input.decision === 'approve'
      ? `Approved. No wake was needed: the work ${reqName} asked this for is already finished. The approval is filed and expires unused in ${APPROVAL_TTL_MINUTES} minutes.`
      : `Denied. No wake was needed: the work ${reqName} asked this for is already finished, so there is nothing to retry or stop.`;
  }

  // FA-A3 (anchor fix): the one-shot approval's consume-TTL anchors at decided_at
  // (see consumeApproval), but the worker's reap timeout was anchored back at
  // REQUEST time. A slow approval would therefore leave the worker almost no life
  // to wake and consume its approval before being reaped. On GRANT, re-anchor the
  // worker's reap timeout from NOW so both windows are coincident and usable.
  if (input.decision === 'approve') {
    try {
      const { extendAgentTimeout } = await import('./spawner.js');
      extendAgentTimeout(row.agent_id, new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000).toISOString());
    } catch (err) {
      logger.warn('destructive-gate: failed to re-anchor held agent timeout on approval', {
        agentId: row.agent_id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const delivered = await deliverGateWake({
    intent: 'ANSWER',
    requiresResponse: true,
    toAgent: row.agent_id,
    work: wakeWork(row, verdict),
    payload: input.decision === 'approve'
      ? `Your destructive action was APPROVED (one-shot, expires in ${APPROVAL_TTL_MINUTES} minutes): ${row.request_text}\nRetry the exact same call now; the gate will let it through once.`
      : `Your destructive action was DENIED: ${row.request_text}\nDo not retry it. Mark the task blocked or find a non-destructive approach.`,
  });

  logger.info('destructive-gate: decision recorded', {
    token: input.token, decision: input.decision, decidedBy: input.deciderAgentId, wakeDelivered: delivered,
  });

  // Only claim the requester was woken when the wake actually resolved; otherwise
  // say plainly it will pick the decision up on its own next turn (the message is
  // persisted regardless, so it is waiting for them).
  if (input.decision === 'approve') {
    return delivered
      ? `Approved. ${reqName} has been woken to retry the call (one-shot approval, ${APPROVAL_TTL_MINUTES} min expiry).`
      : `Approved, but ${reqName} could not be woken right now (it may have ended its turn or be mid-task). The approval is filed; ${reqName} will pick it up and retry on its own next turn, within the ${APPROVAL_TTL_MINUTES}-minute window.`;
  }
  return delivered
    ? `Denied. ${reqName} has been told not to retry.`
    : `Denied. ${reqName} could not be woken right now, but the denial is recorded; ${reqName} will see it on its next turn.`;
}
