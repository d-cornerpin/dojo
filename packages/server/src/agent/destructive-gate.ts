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
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getPrimaryAgentName, isHealerAgent } from '../config/platform.js';
import { checkPermission, isProtectedIdentityPath } from './permissions.js';

const logger = createLogger('destructive-gate');

const APPROVAL_TTL_MINUTES = 60;

// FA-P1: a pending request the primary never received (a dropped wake) or simply
// ignored must not sit silent until the worker is reaped. The sweeper re-wakes the
// primary ONCE more after a request has been pending this long, then, if it is
// still undecided at APPROVAL_TTL_MINUTES, marks it expired with an owner-visible
// note. Kept well under the TTL so the extra wake has time to be acted on.
const STALE_PENDING_MINUTES = 5;

// Conservative v1 surface: outright deletion, and exec commands whose text
// matches clearly-destructive patterns. (Catastrophic commands are already
// hard-denied for everyone in permissions.ts GLOBAL_EXEC_DENY; this gate
// covers the destructive-but-sometimes-legitimate band for non-primary
// agents.) Widen deliberately, not speculatively.
//
// FA-P4 (exec classification): `truncate` joins the outright-destroy group
// (truncate -s0 zeroes a file, unambiguously destructive, and as a bare command
// name it is low false positive, SQL "TRUNCATE" is quote-preceded, not
// whitespace/;&|-preceded, and "truncated" fails the trailing \b). mv/cp are
// deliberately NOT added: they are overwhelmingly non-destructive, "onto an
// existing path" (the only destructive form) cannot be detected statically, and
// holding every move/copy would bury the primary in approvals for benign work.
const DESTRUCTIVE_EXEC_RE = /(^|[\s;&|])(rm|rmdir|shred|truncate|mkfs(\.\w+)?|dd)\b|--force|--hard\b|git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/i;

// FU-4: caller passed as an OPTIONAL third arg so the pre-existing 2-arg call
// sites keep compiling. Only the Healer classification below consults it; when it
// is omitted the function behaves exactly as before.
export function isDestructiveCall(
  toolName: string,
  args: Record<string, unknown>,
  callerAgentId?: string,
): string | null {
  // FA-P4 (option B): there is no agent-callable file_delete tool today, so this
  // branch is currently unreachable, real deletion rides the exec/rm path below
  // (which the gate + manifest now handle coherently, FA-P2). The branch is kept
  // as future-proofing for FU-4's possible scoped-delete tool: a file_delete tool
  // is destructive by definition, so this classifies it the day it exists without
  // another edit here. It does NOT imply a live file_delete tool exists now.
  if (toolName === 'file_delete') return 'file deletion';
  if (toolName === 'exec') {
    const cmd = String(args.command ?? '');
    if (DESTRUCTIVE_EXEC_RE.test(cmd)) return 'destructive shell command';
  }
  // FU-4: the Healer now holds full primary-equivalent write ('*'), so a
  // file_write/file_patch/file_append to one of the owner's identity/config files
  // (PROTECTED_IDENTITY_PATHS: USER.md, ~/.dojo/config/**, loose ~/.dojo/*.yaml)
  // is a NEW destructive path that rm alone does not cover. Classify it as
  // destructive ONLY for the Healer, so it routes through the same approval hold
  // as its rm/dd calls instead of a free write. SOUL/secrets are already globally
  // write-denied and never reach here. isProtectedIdentityPath canonicalizes the
  // path (collapses '..') before matching, so a traversal cannot slip the prefix.
  if (
    callerAgentId &&
    isHealerAgent(callerAgentId) &&
    (toolName === 'file_write' || toolName === 'file_patch' || toolName === 'file_append')
  ) {
    const filePath = typeof args.path === 'string' ? args.path : '';
    if (filePath && isProtectedIdentityPath(filePath)) {
      return 'edit to an owner identity or config file';
    }
  }
  return null;
}

/**
 * FA-P2 pre-hold check: would the agent's OWN permission manifest let this call
 * run at all? The gate HOLDS a non-primary destructive call for primary
 * approval, but holding a call the manifest denies anyway (e.g. a restricted
 * worker's `rm`, which is absent from its exec_allow) files an approval that can
 * never be satisfied: the primary approves, the worker is woken to retry, and the
 * executor's allowlist (this same checkPermission, called INSIDE executeTool)
 * denies it, wasting the one-shot approval and dead-ending the worker after it
 * was told approval was granted. So the caller runs this first and only holds
 * when it returns true; when it returns false the caller lets the normal executor
 * path deny the call, which yields the standard [BLOCKED] result plus the
 * permissionAlternativeFinder escalation (send_to_agent to a privileged agent,
 * request a grant), with no unsatisfiable approval row filed.
 *
 * The seam is checkPermission({type:'exec'}), the EXACT call executeTool makes,
 * so the pre-check reads the SAME manifest the executor will (getAgentPermissions
 * then checkExecPermission), with zero drift. A manifest-permitted-but-destructive
 * call still returns true and is still held: a destructive git subcommand like
 * `git reset --hard` (base command `git` is on the default allowlist), or an `rm`
 * a privileged worker explicitly lists in exec_allow.
 *
 * Non-exec destructive kinds have no manifest command to check (file_delete has
 * no live tool, FA-P4), so they return true and hold exactly as before.
 */
export function manifestPermitsDestructiveCall(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName === 'exec') {
    return checkPermission(agentId, { type: 'exec', command: String(args.command ?? '') }).allowed;
  }
  return true;
}

/**
 * D-B step 2: mint a one-shot, consumable approval for an already-decided call,
 * bound to (agentId, signature). This is the bridge for the Healer's owner-
 * authority path: a HELD Healer call files a healer_proposals row (not a primary
 * wake), and when the OWNER approves it (gateway/routes/healer.ts, dashboard JWT
 * = owner authority) this writes the destructive_approvals row consumeApproval
 * expects, so the Healer's RE-ATTEMPT of the same signature passes exactly once.
 * The signature is the canonical one stored on the proposal at hold time, so the
 * retry (same canonicalToolSignature on the same call) matches it deterministically.
 * tool_name is derived from the signature prefix (canonicalToolSignature emits
 * "<toolName>:<json>"); it is display/audit only and never used in the match.
 */
export function grantApprovalForSignature(input: {
  agentId: string;
  signature: string;
  requestText: string;
  decidedBy: string;
}): void {
  const token = uuidv4();
  const toolName = input.signature.slice(0, input.signature.indexOf(':')) || 'unknown';
  getDb().prepare(`
    INSERT INTO destructive_approvals
      (token, agent_id, tool_name, signature, request_text, status, decided_by, decided_at, wake_delivered)
    VALUES (?, ?, ?, ?, ?, 'approved', ?, datetime('now'), 1)
  `).run(token, input.agentId, toolName, input.signature, input.requestText, input.decidedBy);
  logger.info('destructive-gate: minted consumable approval from owner-approved proposal', {
    agentId: input.agentId, token,
  });
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
 * Deliver an engine wake over A2A and report whether it actually LANDED.
 * The transport returns { delivered:false } for its common drop reasons (target
 * not found, hop limit, semantic dedup) and only THROWS on unexpected errors, so
 * the pre-FA-P1 bare try/catch treated a dropped wake as a success. This gate
 * cannot: an undelivered approval wake is the exact failure it must survive.
 */
async function deliverGateWake(envelope: {
  intent: 'QUESTION' | 'ANSWER';
  payload: string;
  toAgent: string;
  requiresResponse: boolean;
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

/** The primary-facing approval-request text, shared by the initial wake and the sweeper re-wake. */
function buildPrimaryWakePayload(input: {
  agentName: string;
  agentId: string;
  callDescription: string;
  token: string;
}): string {
  return (
    `Destructive-action approval request (engine gate).\n` +
    `Agent: ${input.agentName} (${input.agentId})\n` +
    `Action: ${input.callDescription}\n\n` +
    `If this is appropriate, approve it with approve_destructive_action(token="${input.token}", decision="approve"). ` +
    `To refuse, use decision="deny". Use your judgment about checking with the owner first. ` +
    `Approval is one-shot and expires in ${APPROVAL_TTL_MINUTES} minutes.`
  );
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

  // The gate is about to HOLD this call and rely on waking the primary to
  // approve, then waking THIS worker to retry. Neither wait may count against the
  // worker's task-timeout: a worker blocked on approval is not idle by choice,
  // and its per-agent reap timer (armed in-memory at spawn) would otherwise kill
  // it mid-approval, silently dropping the approved action. Push the reap out to
  // the approval window via extendAgentTimeout, which reschedules the DB row AND
  // the in-memory timer together (FA-A3; the raw UPDATE this replaces never
  // rescheduled the timer, so the extension helped no worker). Anchored at REQUEST
  // time here; re-anchored at DECISION time on approval so the one-shot window is
  // actually usable. Never shortens a longer timeout; no-timeout agents (ronin/
  // persist) are left on their own semantics.
  try {
    const { extendAgentTimeout } = await import('./spawner.js');
    extendAgentTimeout(input.agentId, new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000).toISOString());
  } catch (err) {
    logger.warn('destructive-gate: failed to extend held agent timeout', {
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const delivered = await deliverGateWake({
    intent: 'QUESTION',
    requiresResponse: true,
    toAgent: getPrimaryAgentId(),
    payload: buildPrimaryWakePayload({
      agentName: input.agentName,
      agentId: input.agentId,
      callDescription: input.callDescription,
      token,
    }),
  });

  if (delivered) {
    try {
      getDb().prepare(`UPDATE destructive_approvals SET wake_delivered = 1, updated_at = datetime('now') WHERE token = ?`).run(token);
    } catch { /* best effort, the row is already filed pending */ }
  }

  logger.warn('destructive-gate: call held for primary approval', {
    agentId: input.agentId,
    toolName: input.toolName,
    token,
    wakeDelivered: delivered,
  });

  if (delivered) {
    return (
      `[HELD by engine: destructive-action gate] ${input.kind} requires approval from ${getPrimaryAgentName()} ` +
      `(non-primary agents do not execute destructive actions on their own). The engine has sent the approval ` +
      `request. Continue other work or end your turn; if approval is granted you will be woken to retry this ` +
      `exact call. Do not attempt workarounds.`
    );
  }

  // The wake did NOT land: the primary was not told. Do not leave the worker
  // waiting on a wake that will never arrive. Tell it plainly to escalate in
  // band, and hand it the reference token so the primary can approve the exact
  // request. The sweeper will also re-wake the primary on its own shortly; this
  // in-band nudge is just the faster of the two paths.
  return (
    `[HELD by engine: destructive-action gate] ${input.kind} requires approval from ${getPrimaryAgentName()}, ` +
    `but the engine could NOT reach ${getPrimaryAgentName()} to request it automatically. Do not retry the call and do ` +
    `not attempt a workaround. Instead, message ${getPrimaryAgentName()} yourself with send_to_agent (intent="QUESTION") ` +
    `asking them to approve this action, and include this reference token: ${token} ` +
    `(they approve it with approve_destructive_action(token="${token}", decision="approve")). ` +
    `The engine will also retry the request on its own shortly.`
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

  const reqName = (db.prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined)?.name ?? row.agent_id;

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

/**
 * FA-P1 sweeper (boot + periodic; piggybacks the 30s agent-reap interval in
 * index.ts rather than arming its own timer). Bounded and idempotent:
 *   1. Any pending request past APPROVAL_TTL_MINUTES is marked 'expired' with an
 *      owner-visible note (the FA-S2 primary-chat system-row idiom), so an
 *      undelivered or ignored approval fails LOUDLY instead of evaporating when
 *      the worker is reaped.
 *   2. Any pending request older than STALE_PENDING_MINUTES that has not yet been
 *      re-woken gets ONE more wake to the primary (covers both a dropped first
 *      wake and a primary that simply has not acted). rewake_count bounds it to
 *      exactly once.
 * Expiry runs before re-wake, so a row past the TTL is expired, not re-woken.
 */
export async function sweepStaleApprovals(): Promise<void> {
  const db = getDb();

  // 1. Loud expiry for anything the primary never decided within the TTL.
  let expired: Array<{ token: string; agent_id: string; request_text: string }> = [];
  try {
    expired = db.prepare(`
      SELECT token, agent_id, request_text FROM destructive_approvals
      WHERE status = 'pending'
        AND created_at < datetime('now', '-${APPROVAL_TTL_MINUTES} minutes')
    `).all() as Array<{ token: string; agent_id: string; request_text: string }>;
  } catch (err) {
    logger.warn('destructive-gate: sweep expiry query failed', { error: err instanceof Error ? err.message : String(err) });
  }
  for (const row of expired) {
    const marked = db.prepare(`UPDATE destructive_approvals SET status = 'expired', updated_at = datetime('now') WHERE token = ? AND status = 'pending'`).run(row.token);
    if (marked.changes > 0) {
      notifyOwnerApprovalExpired(row);
      logger.warn('destructive-gate: approval request expired unanswered', { token: row.token, agentId: row.agent_id });
    }
  }

  // 2. One extra wake for stale-but-still-live pending requests.
  let stale: Array<{ token: string; agent_id: string; tool_name: string; request_text: string }> = [];
  try {
    stale = db.prepare(`
      SELECT token, agent_id, tool_name, request_text FROM destructive_approvals
      WHERE status = 'pending' AND rewake_count = 0
        AND created_at < datetime('now', '-${STALE_PENDING_MINUTES} minutes')
    `).all() as Array<{ token: string; agent_id: string; tool_name: string; request_text: string }>;
  } catch (err) {
    logger.warn('destructive-gate: sweep re-wake query failed', { error: err instanceof Error ? err.message : String(err) });
  }
  for (const row of stale) {
    // Mark the re-wake BEFORE attempting it so a throw cannot cause an unbounded
    // re-wake loop; exactly one extra attempt is the contract.
    db.prepare(`UPDATE destructive_approvals SET rewake_count = rewake_count + 1, updated_at = datetime('now') WHERE token = ?`).run(row.token);
    const name = (db.prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined)?.name ?? row.agent_id;
    const delivered = await deliverGateWake({
      intent: 'QUESTION',
      requiresResponse: true,
      toAgent: getPrimaryAgentId(),
      payload: buildPrimaryWakePayload({
        agentName: name, agentId: row.agent_id, callDescription: row.request_text, token: row.token,
      }),
    });
    if (delivered) {
      db.prepare(`UPDATE destructive_approvals SET wake_delivered = 1, updated_at = datetime('now') WHERE token = ?`).run(row.token);
    }
    logger.info('destructive-gate: re-woke primary for stale pending approval', {
      token: row.token, agentId: row.agent_id, delivered,
    });
  }

  // 3. D-B v2: the CRITICAL TEXTED class only (surface='imessage') expires on the
  //    SAME 60-minute clock as gate holds, with the same loud owner notice (keep
  //    the "Heads up:" prefix). Owner-directed v2 narrowed the loud-expiry class
  //    from all 'urgent' to just the texted lane: a quietly-queued Vitals consent
  //    is NOT loud here, it keeps its 14-day healer_proposals lifecycle and a
  //    quiet expiry note (healer-agent.ts runHealingCycle sweep). Legacy toast
  //    rows never match surface='imessage'.
  let expiredUrgent: Array<{ id: string; agent_id: string | null; proposed_fix: string | null; title: string }> = [];
  try {
    expiredUrgent = db.prepare(`
      SELECT id, agent_id, proposed_fix, title FROM healer_proposals
      WHERE status = 'pending' AND surface = 'imessage'
        AND created_at < datetime('now', '-${APPROVAL_TTL_MINUTES} minutes')
    `).all() as Array<{ id: string; agent_id: string | null; proposed_fix: string | null; title: string }>;
  } catch (err) {
    logger.warn('destructive-gate: sweep texted-proposal expiry query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const row of expiredUrgent) {
    const marked = db.prepare(`
      UPDATE healer_proposals
      SET status = 'auto_resolved', resolved_at = datetime('now'), result_summary = ?
      WHERE id = ? AND status = 'pending'
    `).run(
      'This urgent approval went unanswered for over an hour, so I let it expire. Nothing was changed or deleted.',
      row.id,
    );
    if (marked.changes > 0) {
      notifyOwnerApprovalExpired({
        agent_id: row.agent_id ?? getPrimaryAgentId(),
        request_text: row.proposed_fix ?? row.title,
      });
      // Nudge the live Vitals view to reload; the status stamp lets any surface
      // drop a stale pending card no matter where it resolved.
      try { broadcast({ type: 'healer:proposal', data: { id: row.id, status: 'auto_resolved' } }); } catch { /* */ }
      logger.warn('destructive-gate: texted healer approval expired unanswered', { proposalId: row.id });
    }
  }
}

/**
 * Owner-visible surface for an expired approval, the FA-S2 idiom: a role='system'
 * row into the primary agent's chat plus a chat:message broadcast, which renders
 * in the owner's history WITHOUT waking any agent turn (role='system' rows are
 * dropped by the model-message builder). Plain language for a non-technical owner.
 */
function notifyOwnerApprovalExpired(row: { agent_id: string; request_text: string }): void {
  try {
    const name = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined)?.name ?? 'a helper';
    const primaryId = getPrimaryAgentId();
    // The "Heads up:" prefix is load-bearing: it makes this note render in the
    // owner's DEFAULT (non-wordy) chat, not just wordy mode (dashboard
    // OWNER_ALERT_SYSTEM_PREFIXES). Keep the prefix if you reword the message.
    const ownerMsg =
      `Heads up: "${name}" asked me to approve a sensitive action (${row.request_text.slice(0, 160)}), ` +
      `but it went unanswered for over an hour, so I let the request expire. Nothing was changed or deleted. ` +
      `If you still want it done, just tell me and I'll approve it.`;
    const ownerMsgId = uuidv4();
    getDb().prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(ownerMsgId, primaryId, ownerMsg);
    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: ownerMsgId, agentId: primaryId, role: 'system' as const,
        content: ownerMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('destructive-gate: owner expiry notice failed (non-fatal)', {
      agentId: row.agent_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}
