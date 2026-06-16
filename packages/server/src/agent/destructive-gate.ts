// ════════════════════════════════════════
// Destructive-action gate (remediation Phase 4 item 4d, open question 6).
//
// Decision (owner, 2026-06-12): the PRIMARY agent has full reign and uses its
// own judgment about confirming with the owner. Every OTHER agent's
// destructive tool call is held by the ENGINE and routed to the primary for
// approval. The hierarchy: sub-agent → engine gate → primary → (primary's
// judgment) → owner. Prose cannot hold a safety line on the weakest model;
// this module is the mechanism.
//
// Flow (async approval, no blocked turns): the gate REFUSES the call with a
// "held for approval" result, files a token-bound request, and A2A-wakes the
// primary with the exact call. The primary decides via the
// approve_destructive_action tool; on approval the requester is A2A-woken to
// retry, and the retry passes because the gate finds a one-shot approval
// bound to (agent, canonical signature). Approvals expire and are consumed
// on use: one approval, one execution.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId, getPrimaryAgentName } from '../config/platform.js';

const logger = createLogger('destructive-gate');

const APPROVAL_TTL_MINUTES = 60;

// Conservative v1 surface: outright deletion, and exec commands whose text
// matches clearly-destructive patterns. (Catastrophic commands are already
// hard-denied for everyone in permissions.ts GLOBAL_EXEC_DENY; this gate
// covers the destructive-but-sometimes-legitimate band for non-primary
// agents.) Widen deliberately, not speculatively.
const DESTRUCTIVE_EXEC_RE = /(^|[\s;&|])(rm|rmdir|shred|mkfs(\.\w+)?|dd)\b|--force|--hard\b|git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/i;

export function isDestructiveCall(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'file_delete') return 'file deletion';
  if (toolName === 'exec') {
    const cmd = String(args.command ?? '');
    if (DESTRUCTIVE_EXEC_RE.test(cmd)) return 'destructive shell command';
  }
  return null;
}

/** One-shot check: is there a live approval for this exact call? Consumes it. */
export function consumeApproval(agentId: string, signature: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT token FROM destructive_approvals
      WHERE agent_id = ? AND signature = ? AND status = 'approved'
        AND decided_at >= datetime('now', '-${APPROVAL_TTL_MINUTES} minutes')
      ORDER BY decided_at DESC LIMIT 1
    `).get(agentId, signature) as { token: string } | undefined;
    if (!row) return false;
    db.prepare(`UPDATE destructive_approvals SET status = 'consumed', updated_at = datetime('now') WHERE token = ?`)
      .run(row.token);
    return true;
  } catch {
    return false;
  }
}

/**
 * File the request and wake the primary. Returns the refusal text the
 * requesting agent receives as its tool result.
 */
export async function requestApproval(input: {
  agentId: string;
  agentName: string;
  toolName: string;
  signature: string;
  kind: string;
  callDescription: string;
}): Promise<string> {
  const token = uuidv4();
  try {
    getDb().prepare(`
      INSERT INTO destructive_approvals (token, agent_id, tool_name, signature, request_text)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, input.agentId, input.toolName, input.signature, input.callDescription);
  } catch (err) {
    logger.error('destructive-gate: failed to file approval request', {
      error: err instanceof Error ? err.message : String(err),
    });
    return `[BLOCKED by engine: destructive-action gate] This ${input.kind} requires the primary agent's approval, and the approval request could not be filed. Do not retry; mark the task blocked.`;
  }

  // The gate is about to HOLD this call and rely on waking the agent to retry
  // once the primary approves. That wait must NOT count against the agent's
  // task-timeout: a worker blocked on approval is not idle by choice, and a
  // short timeout (or a slow approval) would otherwise let the timeout reaper
  // kill it before the retry, silently dropping the approved action. Push the
  // timeout out to at least the approval window. Never shorten a longer one;
  // leave no-timeout agents (freelance/persist) alone.
  try {
    getDb().prepare(`
      UPDATE agents
      SET timeout_at = datetime('now', '+${APPROVAL_TTL_MINUTES} minutes'),
          updated_at = datetime('now')
      WHERE id = ?
        AND timeout_at IS NOT NULL
        AND timeout_at < datetime('now', '+${APPROVAL_TTL_MINUTES} minutes')
    `).run(input.agentId);
  } catch (err) {
    logger.warn('destructive-gate: failed to extend held agent timeout', {
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { deliverA2AMessage } = await import('./a2a-transport.js');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: uuidv4(),
      requiresResponse: true,
      payload:
        `Destructive-action approval request (engine gate).\n` +
        `Agent: ${input.agentName} (${input.agentId})\n` +
        `Action: ${input.callDescription}\n\n` +
        `If this is appropriate, approve it with approve_destructive_action(token="${token}", decision="approve"). ` +
        `To refuse, use decision="deny". Use your judgment about checking with the owner first. ` +
        `Approval is one-shot and expires in ${APPROVAL_TTL_MINUTES} minutes.`,
      toAgent: getPrimaryAgentId(),
      fromAgent: 'system',
    });
  } catch (err) {
    logger.error('destructive-gate: failed to notify primary', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.warn('destructive-gate: call held for primary approval', {
    agentId: input.agentId,
    toolName: input.toolName,
    token,
  });

  return (
    `[HELD by engine: destructive-action gate] ${input.kind} requires approval from ${getPrimaryAgentName()} ` +
    `(non-primary agents do not execute destructive actions on their own). The engine has sent the approval ` +
    `request. Continue other work or end your turn; if approval is granted you will be woken to retry this ` +
    `exact call. Do not attempt workarounds.`
  );
}

/** The primary's decision. Returns agent-facing result text. */
export async function decideApproval(input: {
  deciderAgentId: string;
  token: string;
  decision: 'approve' | 'deny';
}): Promise<string> {
  const db = getDb();
  const row = db.prepare(`SELECT token, agent_id, tool_name, request_text, status FROM destructive_approvals WHERE token = ?`)
    .get(input.token) as { token: string; agent_id: string; tool_name: string; request_text: string; status: string } | undefined;
  if (!row) return `No approval request found for token ${input.token}.`;
  if (row.status !== 'pending') return `Request ${input.token} is already ${row.status}.`;

  const status = input.decision === 'approve' ? 'approved' : 'denied';
  db.prepare(`UPDATE destructive_approvals SET status = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE token = ?`)
    .run(status, input.deciderAgentId, input.token);

  try {
    const { deliverA2AMessage } = await import('./a2a-transport.js');
    await deliverA2AMessage({
      intent: 'ANSWER',
      threadId: uuidv4(),
      requiresResponse: false,
      payload: input.decision === 'approve'
        ? `Your destructive action was APPROVED (one-shot, expires in ${APPROVAL_TTL_MINUTES} minutes): ${row.request_text}\nRetry the exact same call now; the gate will let it through once.`
        : `Your destructive action was DENIED: ${row.request_text}\nDo not retry it. Mark the task blocked or find a non-destructive approach.`,
      toAgent: row.agent_id,
      fromAgent: 'system',
    });
  } catch (err) {
    logger.error('destructive-gate: failed to notify requester of decision', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('destructive-gate: decision recorded', {
    token: input.token, decision: input.decision, decidedBy: input.deciderAgentId,
  });
  return input.decision === 'approve'
    ? `Approved. ${row.agent_id} has been woken to retry the call (one-shot approval, ${APPROVAL_TTL_MINUTES} min expiry).`
    : `Denied. ${row.agent_id} has been told not to retry.`;
}
