// The PRIMARY agent uses its own judgment; every OTHER agent's destructive call is held by the engine
// and routed to the primary for approval: sub-agent -> engine gate -> primary -> judgment -> owner.
// The gate refuses with a held result, files a token-bound request and A2A-wakes the primary.
// An approval is one-shot, expires, and the retry passes once: prose cannot hold a line on weak models.

import { URGENT_APPROVAL_EXPIRY_NOTE } from './engine-lines.js';
import { v4 as uuidv4 } from 'uuid';
import { turnContext } from './turn-context.js';
import { getDb } from '../db/connection.js';
import { insertMessage } from '../memory/message-store.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getPrimaryAgentName, isHealerAgent } from '../config/platform.js';
import { isProtectedIdentityPath } from './permissions.js';
import { getAgentPermissions } from './manifest.js';
import { grantForManifest } from './brokers/grants.js';
import { authorizeFs } from './brokers/fs.js';
import { EXEC_DOOR_ARG, authorizeExecShapedArgs, execCallText, execDoorFor } from './brokers/exec-seam.js';
import { destroysDojoData, destroysDojoFiles, overwritesFile, writesCoreDojoRows } from './brokers/dojo-redirect.js';
import { floorReadings } from './brokers/proc.js';
import { authorizeAppleScript, shellPayloads } from './brokers/applescript.js';
import { wrappedProgramIndex } from './brokers/sudo-policy.js';
import { commandWords } from './exec-grammar.js';
import path from 'node:path';
import { denyRuleFor, isLoginKeyFile } from './brokers/deny.js';
import { resolveCommandArg, type ResolvedPath } from './brokers/resolve.js';
import { canonicalizeAgentPath } from './path-resolve.js';
import { resolveAgentRef } from './tool-helpers.js';
import { callerFileEffects } from './tools/gates.js';
import { callerPaths } from './effects/scopes.js';
import { OWNER_ALERT_DOJO_PREFIX } from '@dojo/shared';
import { tellAgentWhatDojoSent } from './dojo-voice.js';
import { APPROVAL_TTL_MINUTES, deliverGateWake } from './approval-decision.js';

const logger = createLogger('destructive-gate');

// A pending request the primary never got (a dropped wake) or ignored must not sit silent past the reap.
// The sweeper re-wakes once after STALE_PENDING_MINUTES; it stays well under the approval TTL.
const STALE_PENDING_MINUTES = 5;

// Conservative surface: deleting programs and forced git rewrites, read per command from the shared grammar.
// Catastrophics are hard-denied by the broker; this covers the destructive-but-legitimate band.
// mv/cp stay out: benign overwhelmingly, destructive form undetectable.
const DESTROYERS = /^(?:rm|rmdir|shred|truncate|dd|mkfs(?:\.\w+)?)$/i;

/** Whether a line runs a deleting program (behind a wrapper like `xargs` or `sudo` too) or forces a git rewrite. */
function runsDestroyer(line: string): boolean {
  return floorReadings(line).some((command) => {
    const w = commandWords(command);
    return wrappedProgramIndex(w, (bare) => DESTROYERS.test(bare)) !== null || w.some((x) => x.startsWith('--force') || x === '--hard')
      || (w[0] === 'git' && w[1] === 'clean' && w.some((x) => /^-[a-z]*f/i.test(x)));
  });
}

/** Whether a line's `rm` names `/`, the home folder or another folder that holds the Dojo. */
function wipesTheMac(line: string): boolean {
  const dojo = canonicalizeAgentPath('~/.dojo');
  return floorReadings(line).some((command) => {
    const words = commandWords(command);
    return path.basename(words[0] ?? '') === 'rm' && words.slice(1).some((w) => {
      const rel = path.relative(canonicalizeAgentPath(w), dojo);
      return !w.startsWith('-') && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  });
}

/** The shell lines a call runs: an AppleScript's `do shell script` payloads, or the exec doors' text. */
function shellLinesOf(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === 'applescript_run') return typeof args.script === 'string' ? shellPayloads(args.script) : [];
  return [execCallText(toolName, args)].filter((t): t is string => t !== null);
}

export function isDestructiveCall(
  toolName: string,
  args: Record<string, unknown>,
  callerAgentId?: string,
): string | null {
  // execCallText is the one owner of 'what did this call ask to run', at both doors and every call shape.
  // A shape it cannot read is UNKNOWN, not harmless: hold it; the manifest pre-check then refuses outright.
  const door = execDoorFor(toolName);
  const text = door ? execCallText(toolName, args) : null;
  const raw = door ? args[EXEC_DOOR_ARG[door]] : null;
  const argv = Array.isArray(raw) && raw.every((e) => typeof e === 'string') ? (raw as string[]) : null;
  if (door && text === null) return 'destructive shell command';
  if (shellLinesOf(toolName, args).some(runsDestroyer) || (text !== null && destroysDojoData(argv ?? text))) return 'destructive shell command';
  if (callerAgentId && isHealerAgent(callerAgentId) && text !== null && writesCoreDojoRows(argv ?? text)) return 'change to the Dojo\'s own records';
  // A login key lets whoever holds it sign in to the Mac: a write onto one is held, whatever door writes it.
  const written = callerWrites(toolName, args);
  if (written.some((p) => isLoginKeyFile(p.lexical) || isLoginKeyFile(p.real))
    || (text !== null && overwritesFile(argv ?? text, (word) => isLoginKeyFile(canonicalizeAgentPath(word))))) {
    return 'write to a login-key file';
  }
  // The Healer holds primary-equivalent write, so a protected-identity-file write is destructive for it.
  if (callerAgentId && isHealerAgent(callerAgentId) && written.some((p) => isProtectedIdentityPath(p.lexical))) {
    return 'edit to an owner identity or config file';
  }
  return null;
}

/** Every path this call writes that its caller named, resolved: what the one file check asked. */
function callerWrites(toolName: string, args: Record<string, unknown>): ResolvedPath[] {
  return callerFileEffects(toolName, 'fs_write').flatMap((e) => callerPaths(e, args)).flatMap((r) => (r.ok ? [r.value] : []));
}

/** What a main-agent call would destroy, or null: the one question its warn-once hurdle asks. */
export function wouldWreck(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'vault_discard_archives') return 'permanently delete saved conversation archives from the Dojo\'s memory';
  if (toolName === 'kill_agent') {
    const target = resolveAgentRef(typeof args.agent_id === 'string' ? args.agent_id : null);
    const row = target.ok ? getDb().prepare('SELECT classification FROM agents WHERE id = ?').get(target.id) as { classification: string } | undefined : undefined;
    return row?.classification === 'sensei' ? 'end a sensei the Dojo runs on, or the main agent itself' : null;
  }
  const rule = callerWrites(toolName, args).map((p) => denyRuleFor(p.real, 'global_write') ?? denyRuleFor(p.lexical, 'global_write')).find(Boolean);
  if (rule?.id === 'dojo-secrets-writes') return 'overwrite the Dojo\'s secrets file and lose every saved key';
  if (rule?.id === 'dojo-database-writes') return 'write straight into the Dojo\'s live database file and can corrupt every agent, message and setting in it';
  const raw = args[EXEC_DOOR_ARG[execDoorFor(toolName) ?? 'shell']];
  const lines = shellLinesOf(toolName, args);
  if (lines.some(wipesTheMac)) return 'erase the whole disk or the home folder, the Dojo with it';
  const argv = toolName === 'exec' && Array.isArray(raw) && raw.every((e) => typeof e === 'string') ? (raw as string[]) : null;
  if (argv ? destroysDojoFiles(argv) : lines.some((l) => destroysDojoFiles(l))) {
    return 'delete, move or overwrite the Dojo\'s own database, data, backups or secrets file';
  }
  return null;
}

// Pre-hold check: only hold what the manifest would allow, or the hold files an unfillable approval.
// The seam is authorizeExecShapedArgs, the EXACT call the dispatcher's own gate row makes: one, no drift.
// Manifest-permitted but destructive still returns true and is held (git reset --hard, an explicit rm).
// A shape-mismatched exec call returns FALSE: refused, never authorized as the empty command.
// A non-exec call is asked the one file check for each path it writes.
export function manifestPermitsDestructiveCall(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const grant = grantForManifest(agentId, getAgentPermissions(agentId));
  if (toolName === 'applescript_run') {
    const script = resolveCommandArg(args.script);
    return script.ok && authorizeAppleScript(grant, script.value).allowed;
  }
  const verdict = authorizeExecShapedArgs(grant, toolName, args);
  // Not exec-shaped: the one file check answers for every path the call writes.
  if (verdict === null) return callerWrites(toolName, args).every((p) => authorizeFs(grant, 'fs_write', p).allowed);
  if (!verdict.allowed) {
    logger.warn('destructive-gate: pre-hold check refused the call', {
      agentId, toolName, rule: verdict.rule, reason: verdict.reason,
    });
  }
  return verdict.allowed;
}

// Mint a one-shot approval for a decided call, bound to (agent, signature): the Healer's owner path.
// The owner's dashboard approval writes the row the retry consumes, so it passes exactly once.
// tool_name comes off the signature prefix; display and audit only, never part of the match.
export function grantApprovalForSignature(input: {
  agentId: string;
  signature: string;
  requestText: string;
  decidedBy: string;
  // A NULL args_json keeps the legacy signature-only consumption for that row.
  argsJson?: string | null;
}): void {
  const token = uuidv4();
  const toolName = input.signature.slice(0, input.signature.indexOf(':')) || 'unknown';
  getDb().prepare(`
    INSERT INTO destructive_approvals
      (token, agent_id, tool_name, signature, request_text, args_json, status, decided_by, decided_at, wake_delivered)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'), 1)
  `).run(token, input.agentId, toolName, input.signature, input.requestText, input.argsJson ?? null, input.decidedBy);
  logger.info('destructive-gate: minted consumable approval from owner-approved proposal', {
    agentId: input.agentId, token,
  });
}

/** One-shot check: is there a live approval for this exact call? Consumes it. */
export function consumeApproval(agentId: string, signature: string, argsJson?: string | null): boolean {
  try {
    const db = getDb();
    // The approval covers precisely the command the approver saw, once: the FULL args JSON must match,
    // not the lossy signature (prose dropped, strings cut, digits masked; two calls could collide).
    const row = db.prepare(`
      SELECT token FROM destructive_approvals
      WHERE agent_id = ? AND signature = ? AND status = 'approved'
        AND decided_at >= datetime('now', '-${APPROVAL_TTL_MINUTES} minutes')
        AND (args_json IS NULL OR args_json = ?)
      ORDER BY decided_at DESC LIMIT 1
    `).get(agentId, signature, argsJson ?? null) as { token: string } | undefined;
    if (!row) return false;
    db.prepare(`UPDATE destructive_approvals SET status = 'consumed', updated_at = datetime('now') WHERE token = ?`)
      .run(row.token);
    return true;
  } catch {
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

// File the request, wake the primary, and return the refusal text the requester gets as its tool result.
export async function requestApproval(input: {
  agentId: string;
  agentName: string;
  toolName: string;
  signature: string;
  kind: string;
  callDescription: string;
  argsJson?: string | null;
}): Promise<string> {
  const token = uuidv4();
  try {
    const root = turnContext(input.agentId)?.root ?? null;
    const served = turnContext(input.agentId)?.servedWork ?? null;
    getDb().prepare(`
      INSERT INTO destructive_approvals (token, agent_id, tool_name, signature, request_text, args_json, root_kind, root_id, task_id, turn_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(token, input.agentId, input.toolName, input.signature, input.callDescription,
      input.argsJson ?? null, root?.kind ?? null, root?.id ?? null,
      served?.taskId ?? null, turnContext(input.agentId)?.turnNumber ?? null);
  } catch (err) {
    logger.error('destructive-gate: failed to file approval request', {
      error: err instanceof Error ? err.message : String(err),
    });
    return `[BLOCKED by engine: destructive-action gate] This ${input.kind} requires the primary agent's approval, and the approval request could not be filed. Do not retry; mark the task blocked.`;
  }

  // Neither approval wait may count against the task-timeout: a reap would drop an action just approved.
  // extendAgentTimeout moves the DB row AND the in-memory timer together; the raw UPDATE helped nobody.
  // Re-anchored at request and on approval; never shortens; no-timeout agents keep their semantics.
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

  // If the wake did not land the primary was never told; say so and hand the worker the reference token.
  // Tell it to escalate in band with send_to_agent; the sweeper re-wakes shortly anyway.
  return (
    `[HELD by engine: destructive-action gate] ${input.kind} requires approval from ${getPrimaryAgentName()}, ` +
    `but the engine could NOT reach ${getPrimaryAgentName()} to request it automatically. Do not retry the call and do ` +
    `not attempt a workaround. Instead, message ${getPrimaryAgentName()} yourself with send_to_agent (intent="QUESTION") ` +
    `asking them to approve this action, and include this reference token: ${token} ` +
    `(they approve it with approve_destructive_action(token="${token}", decision="approve")). ` +
    `The engine will also retry the request on its own shortly.`
  );
}

// Boot + periodic on the 30s reap interval; bounded and idempotent.
// Pending past the TTL: mark 'expired' with an owner-visible note, so an unanswered request fails LOUDLY.
// Pending past STALE_PENDING_MINUTES and never re-woken: exactly one more wake to the primary.
// Expiry runs first, so a row past the TTL is expired, not re-woken.
export async function sweepStaleApprovals(): Promise<void> {
  const db = getDb();

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
    // Mark the re-wake BEFORE attempting it: a throw cannot loop it; exactly one extra attempt.
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

  // Texted (surface='imessage') proposals expire on the SAME clock, with the same loud owner notice.
  // A quietly-queued consent keeps its own quiet lifecycle; legacy toast rows never match this surface.
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
      URGENT_APPROVAL_EXPIRY_NOTE,   // the Dojo speaking, never 'I'
      row.id,
    );
    if (marked.changes > 0) {
      notifyOwnerApprovalExpired({
        agent_id: row.agent_id ?? getPrimaryAgentId(),
        request_text: row.proposed_fix ?? row.title,
      });
      // The status stamp lets any surface drop a stale pending card, wherever it resolved.
      try { broadcast({ type: 'healer:proposal', data: { id: row.id, status: 'auto_resolved' } }); } catch { /* */ }
      logger.warn('destructive-gate: texted healer approval expired unanswered', { proposalId: row.id });
    }
  }
}

// Owner-visible surface for an expired approval: a role='system' row in the primary's chat plus a broadcast.
// System rows render in history without waking any agent turn; plain words for a non-technical owner.
function notifyOwnerApprovalExpired(row: { agent_id: string; request_text: string }): void {
  try {
    const name = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(row.agent_id) as { name: string } | undefined)?.name ?? 'a helper';
    const primaryId = getPrimaryAgentId();
    // The prefix is load-bearing: it puts this note in the owner's DEFAULT chat (@dojo/shared
    // OWNER_ALERT_SYSTEM_PREFIXES) and makes it plainly the Dojo speaking, never the agent.
    const ownerMsg =
      `${OWNER_ALERT_DOJO_PREFIX} "${name}" asked for approval of a sensitive action (${row.request_text.slice(0, 160)}), ` +
      `but no answer came within an hour, so the request expired. Nothing was changed or deleted. ` +
      `To do it, ask the agent again.`;
    const ownerMsgId = uuidv4();
    insertMessage({ id: ownerMsgId, agentId: primaryId, role: 'system', content: ownerMsg });
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
    tellAgentWhatDojoSent({ agentId: primaryId, recipient: 'the owner (on the dashboard)', text: ownerMsg, why: 'because a sensitive-action request went unanswered' });
  } catch (err) {
    logger.warn('destructive-gate: owner expiry notice failed (non-fatal)', {
      agentId: row.agent_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}
