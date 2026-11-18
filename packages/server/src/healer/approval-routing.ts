// Healer destructive-approval routing. A held Healer tool call files ONE owner-approval row in
// healer_proposals (bound token plus canonical signature) instead of waking the primary agent.
// Owner approval mints a one-shot destructive_approvals row, so the Healer's retry of the same call
// consumes it once (destructive-gate.ts consumeApproval); the signature is computed once with
// canonicalToolSignature at hold time, so hold and retry cannot diverge.
// Owns the surface selector, the scratch-zone auto-approve rule, proposal filing and the "applied on
// retry" close. It renders no UI.

import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { resolveRealPathHardened, isProtectedIdentityPath } from '../agent/permissions.js';
import { withOutboundAsyncIfAbsent, PLATFORM_SENDER } from '../agent/v2/outbound.js';
import { homeDir } from '../home.js';
import { execCallText } from '../agent/brokers/exec-seam.js';
import { execSimpleCommands, commandWords } from '../agent/exec-grammar.js';
import { healerApprovalText, healerApprovalBody } from '../agent/engine-lines.js';
import { tellAgentWhatDojoSent } from '../agent/dojo-voice.js';
import { getPrimaryAgentId } from '../config/platform.js';

const logger = createLogger('healer-approval-routing');

// Must match DiagnosticItem's severity union (item-cap.ts).
export type EngineSeverity = 'critical' | 'warning' | 'info';

export type HealerApprovalUrgency = 'routine' | 'urgent';
export type HealerApprovalSurface = 'vitals' | 'imessage';

export interface HealerApprovalRouting {
  urgency: HealerApprovalUrgency;
  surface: HealerApprovalSurface;
}

/**
 * Pure surface selector (no model judgment, no I/O): 'imessage' only when engine severity is CRITICAL,
 * the owner is away and iMessage is enabled; everything else queues in Vitals.
 * Expiry keys on surface: 'imessage' uses the 60-minute gate clock (destructive-gate.ts), the rest 14 days.
 */
export function selectHealerApprovalRouting(input: {
  engineSeverity?: EngineSeverity | null;
  presence: 'in_dojo' | 'away';
  imessageEnabled: boolean;
}): HealerApprovalRouting {
  const criticalTexted =
    input.engineSeverity === 'critical' && input.presence === 'away' && input.imessageEnabled;
  const surface: HealerApprovalSurface = criticalTexted ? 'imessage' : 'vitals';
  const urgency: HealerApprovalUrgency = criticalTexted ? 'urgent' : 'routine';
  return { urgency, surface };
}

// Scratch-zone auto-approve: a Healer destructive call whose EVERY target resolves strictly inside
// a scratch zone runs without consent and leaves an audit_log row ('auto_approved_scratch') plus a
// Vitals history record. Unparseable, out-of-zone or unresolvable calls take the normal hold path.
// Protected-identity and global denies run first, so this only ever narrows what holds.

// Ephemeral work areas only (never ~/.dojo config, prompts, data, secrets or logs). Resolved through
// the hardened canonicalizer so a symlinked /tmp or $TMPDIR matches the real path a target resolves to.
const SCRATCH_ZONE_SOURCES = [
  '/tmp',
  os.tmpdir(),
  path.join(homeDir(), '.dojo', 'uploads'),
  path.join(homeDir(), '.dojo', 'tmp'),
];

const SCRATCH_ZONE_ROOTS: string[] = (() => {
  const roots = new Set<string>();
  for (const src of SCRATCH_ZONE_SOURCES) {
    const resolved = resolveRealPathHardened(src);
    if (resolved.resolved) roots.add(resolved.path);
  }
  return [...roots];
})();

// Only a single plain rm/rmdir with a literal arg list is auto-approvable: any shell metacharacter,
// quote, variable or glob forces the hold, since we cannot statically reason about what it deletes.
const SHELL_META_RE = /[;&|`$()<>*?[\]{}!"'\\\n\r]/;
// rm flag whitelist (recursive, force, directory); any other dash-arg forces the hold.
const RM_FLAG_RE = /^-[rRfd]+$/;

export interface ScratchZoneDecision {
  command: string;
  zones: string[];
}

/** A strictly-parseable rm/rmdir with every target strictly inside a scratch zone; null on ANY miss. */
export function evaluateScratchZoneAutoApprove(
  toolName: string,
  args: Record<string, unknown>,
): ScratchZoneDecision | null {
  if (toolName !== 'exec') return null;
  // An argv element holding a space would be split into two words below, so it holds instead.
  if (Array.isArray(args.argv) && args.argv.some((w) => typeof w !== 'string' || /\s/.test(w))) return null;
  const command = execCallText(toolName, args)?.trim() ?? '';
  if (!command || SHELL_META_RE.test(command)) return null;

  const tokens = command.split(/\s+/);
  const head = tokens[0];
  if (head !== 'rm' && head !== 'rmdir') return null;

  const targets: string[] = [];
  for (const tok of tokens.slice(1)) {
    if (tok.startsWith('-')) {
      // rmdir takes no such flags; only rm's recursive/force whitelist is allowed.
      if (head === 'rm' && RM_FLAG_RE.test(tok)) continue;
      return null;
    }
    targets.push(tok);
  }
  if (targets.length === 0) return null;

  const zones: string[] = [];
  for (const target of targets) {
    if (isProtectedIdentityPath(target)) return null;
    const resolved = resolveRealPathHardened(target);
    if (!resolved.resolved) return null; // fail closed
    const zone = SCRATCH_ZONE_ROOTS.find(
      (root) => resolved.path === root || resolved.path.startsWith(root + path.sep),
    );
    // Strictly under a zone: deleting a zone root itself (rm -rf /tmp) is not auto-approvable.
    if (!zone || resolved.path === zone) return null;
    zones.push(zone);
  }
  return { command, zones: [...new Set(zones)] };
}

/** Evaluate and record; true means auto-approved (runs once, no proposal filed). Writes audit and history. */
export function maybeAutoApproveHealerScratch(input: {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  kind: string;
}): boolean {
  const decision = evaluateScratchZoneAutoApprove(input.toolName, input.args);
  if (!decision) return false;

  const auditId = uuidv4();
  const actionId = uuidv4();
  const detail = JSON.stringify({
    outcome: 'auto_approved_scratch',
    kind: input.kind,
    command: decision.command,
    zones: decision.zones,
  });
  try {
    // audit_log.action_type is a fixed enum ('exec'); the outcome rides in detail.outcome.
    getDb().prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
      VALUES (?, ?, 'exec', ?, 'success', ?, datetime('now'))
    `).run(auditId, input.agentId, decision.command.slice(0, 500), detail);
  } catch (err) {
    logger.warn('healer scratch auto-approve: audit write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    getDb().prepare(`
      INSERT INTO healer_actions
        (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
      VALUES (?, NULL, 'destructive_action', ?, ?, ?, 'success', datetime('now'))
    `).run(
      actionId,
      `Cleaned up files in a temporary work area (nothing you rely on): ${decision.command.slice(0, 200)}`,
      input.agentId,
      decision.command.slice(0, 500),
    );
  } catch (err) {
    logger.warn('healer scratch auto-approve: history write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // HealerVitals reloads on any healer:proposal frame; no proposal exists, so it carries the action id.
  try { broadcast({ type: 'healer:proposal', data: { id: actionId } }); } catch { /* best effort */ }

  logger.info('healer scratch-zone destructive auto-approved', {
    agentId: input.agentId, command: decision.command.slice(0, 120), zones: decision.zones,
  });
  return true;
}

export interface FileHealerApprovalInput {
  agentId: string;
  agentName: string;
  toolName: string;
  signature: string;
  kind: string;
  /** True for a live gate hold; recorded only, routing uses engine severity plus presence. */
  heldDirectDestructiveCall: boolean;
  engineSeverity?: EngineSeverity | null;
  // Full argument JSON of the held call (exact-call contract).
  argsJson?: string | null;
}

export interface FileHealerApprovalResult {
  proposalId: string;
  token: string;
  urgency: HealerApprovalUrgency;
  surface: HealerApprovalSurface;
  refusal: string;
  /** True when filed cleanly (a non-error "queued" result); false only when filing failed. */
  queued: boolean;
}

/** A string over `room` characters, cut in the middle with "..." so its start and end both show. */
const clip = (s: string, room: number): string => (s.length <= room ? s : `${s.slice(0, room / 2 - 2)}...${s.slice(1 - room / 2)}`);

/** Whole items that fit the room (one over-long item is clipped), then "and N more": the sentence after it stays. */
function nameList(all: string[], room = 160): string {
  const items = all.map((s) => clip(s, room));
  let n = 1;
  while (n < items.length && items.slice(0, n + 1).join(', ').length <= room) n++;
  return items.slice(0, n).join(', ') + (n < items.length ? ` and ${items.length - n} more` : '');
}

/** A shell word as written, quotes off; null when it holds an escape, a variable, a glob, a redirect or other syntax,
 *  or is a quoted `~` (the shell does not expand it there, so it is no home path). */
const unquote = (w: string): string | null => {
  const q = /^(["'])(.*)\1$/.exec(w);
  const v = q?.[2] ?? w;
  return (q && v.startsWith('~')) || /[\\$`*?[\]{}()"'<>|;&]/.test(v) ? null : v;
};

/** One plain sentence for a held call: what will be done, to what, and what it affects. It names only what it can
 *  read exactly (argv as given, a shell line through the engine's splitter). */
export function describeHeldAction(toolName: string, argsJson: string | null | undefined): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson ?? '{}') as Record<string, unknown>; } catch { /* an unreadable call reads as the general case */ }
  const filePath = typeof args.path === 'string' ? args.path : '';
  if (filePath && /^file_(write|patch|append)$/.test(toolName)) {
    return `Change the file "${clip(path.basename(filePath), 80)}" in ${clip(path.dirname(filePath), 80)}. `
      + 'It holds an agent\'s identity or the Dojo\'s settings, and its current contents would change.';
  }
  const argv = Array.isArray(args.argv) ? args.argv : null;
  const cmds: Array<Array<string | null>> = argv
    ? (argv.every((w) => typeof w === 'string') ? [argv as string[]] : [])
    : execSimpleCommands(execCallText(toolName, args) ?? '').map((c) => commandWords(c).map(unquote));
  let [head, ...rest] = cmds.length === 1 ? cmds[0] : [];
  if (head === 'sudo') {   // look through sudo to the command it runs
    [head, ...rest] = rest.slice(Math.max(0, rest.findIndex((w) => !w?.startsWith('-'))));
  }
  const targets = rest.filter((w) => !w?.startsWith('-'));
  if ((head === 'rm' || head === 'rmdir') && targets.length > 0 && targets.every((t) => t !== null && !t.startsWith('..'))) {
    const named = (targets as string[]).map((t) => (/^[/~]/.test(t) ? t : `"${clip(t, 80)}" in the folder this command runs from`));
    const recursive = rest.some((w) => /^-[a-zA-Z]*[rR]|^--recursive$/.test(w ?? ''));
    return `Delete ${nameList(named)}${recursive ? ', including everything inside' : ''}. `
      + 'Deleted files do not go to the Trash and cannot be brought back.';
  }
  const paths = [...new Set(cmds.flat().filter((w): w is string => !!w && /^(~|\.{0,2})\//.test(w)))];
  return `Run a command${cmds.length > 1 ? ' line' : ''} on this Mac that can delete or overwrite files.${paths.length ? ` It touches ${nameList(paths)}.` : ''}`;
}

/**
 * File the single owner-approval row for a HELD Healer call and return the tool-result text. Presence is
 * read via dynamic import so the loop gate's static import graph stays free of the iMessage bridge.
 */
export async function fileHealerApprovalProposal(
  input: FileHealerApprovalInput,
): Promise<FileHealerApprovalResult> {
  let presence: 'in_dojo' | 'away' = 'in_dojo';
  let imessageEnabled = false;
  try {
    const presenceMod = await import('../services/presence.js');
    presence = presenceMod.getPresence();
    imessageEnabled = presenceMod.isImessageConfigured();
  } catch (err) {
    // Presence unavailable: default to in_dojo (quiet Vitals lane); never block the hold on it.
    logger.warn('healer approval-routing: presence lookup failed, defaulting to in_dojo', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const routing = selectHealerApprovalRouting({
    engineSeverity: input.engineSeverity ?? null,
    presence,
    imessageEnabled,
  });

  const proposalId = uuidv4();
  const token = uuidv4();
  // Severity is the Vitals badge tone: red for the texted class, amber for a quiet consent. The wording is
  // engine-fixed plain language (never model-authored); the exact call rides in approval_args_json.
  const severity = routing.surface === 'imessage' ? 'critical' : 'warning';
  const title = 'A cleanup change is waiting for your OK';
  const what = describeHeldAction(input.toolName, input.argsJson);
  const description = healerApprovalBody(what);
  const proposedFix = what;
  const evidence = JSON.stringify([
    'It paused on its own because this kind of change can delete or overwrite files.',
    'Nothing will happen unless you approve it. Declining leaves everything as it is.',
  ]);

  try {
    getDb().prepare(`
      INSERT INTO healer_proposals
        (id, category, severity, title, description, proposed_fix, status, agent_id,
         evidence_json, urgency, surface, approval_token, approval_signature, approval_args_json, created_at)
      VALUES (?, 'destructive_action', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      proposalId,
      severity,
      title,
      description,
      proposedFix,
      input.agentId,
      evidence,
      routing.urgency,
      routing.surface,
      token,
      input.signature,
      input.argsJson ?? null,
    );
  } catch (err) {
    logger.error('healer approval-routing: failed to file approval proposal', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      proposalId,
      token,
      urgency: routing.urgency,
      surface: routing.surface,
      queued: false,
      refusal:
        `[BLOCKED by engine: destructive-action gate] This ${input.kind} needs the owner's ` +
        `approval, and the request could not be filed. Do not retry it; move on to other work.`,
    };
  }

  try {
    broadcast({
      type: 'healer:proposal',
      data: {
        id: proposalId,
        title,
        severity,
        urgency: routing.urgency,
        surface: routing.surface,
      },
    });
  } catch { /* best effort, the row is already filed pending */ }

  logger.warn('healer approval-routing: destructive call held for owner approval', {
    agentId: input.agentId,
    toolName: input.toolName,
    proposalId,
    urgency: routing.urgency,
    surface: routing.surface,
  });

  // Owner away with iMessage on: text the request. The proposal already stands in Vitals, so a send
  // failure is fail-open (logged, never lost).
  if (routing.surface === 'imessage') {
    await sendHealerApprovalRequestOverIMessage(proposalId, what);
  }

  // A NON-error "queued" result so the turn continues: tell the agent to move on, not wait. If the owner
  // approves, the engine brings the exact call back through the post-approval kick and consume-once retry.
  const refusal =
    `[Queued for the owner] This ${input.kind} could delete or overwrite something, so it is ` +
    `now waiting in the Healer section of the owner's dashboard for a yes or no. This is not an ` +
    `error and nothing is blocked. Do NOT retry it, do NOT wait on it, and do NOT try another ` +
    `way around it. Move on to your other work or finish your turn. If the owner approves it ` +
    `later, the engine will bring this exact action back to you to run then; you do not need to ` +
    `do anything until that happens.`;

  return { proposalId, token, urgency: routing.urgency, surface: routing.surface, queued: true, refusal };
}

/**
 * Close an owner-approved held action that just ran: mark the matching proposal (agent_id +
 * approval_signature) applied so it is not re-presented and the consumed token cannot re-hold.
 */
export function markHealerProposalAppliedBySignature(agentId: string, signature: string): void {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM healer_proposals
      WHERE agent_id = ? AND approval_signature = ? AND status = 'approved' AND applied_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(agentId, signature) as { id: string } | undefined;
    if (!row) return;
    db.prepare(`
      UPDATE healer_proposals
      SET applied_at = datetime('now'), resolved_at = COALESCE(resolved_at, datetime('now'))
      WHERE id = ?
    `).run(row.id);
    try { broadcast({ type: 'healer:proposal', data: { id: row.id, status: 'applied' } }); } catch { /* */ }
    logger.info('healer approval-routing: held proposal marked applied on retry', { proposalId: row.id });
  } catch (err) {
    logger.warn('healer approval-routing: failed to mark held proposal applied', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Text the owner an approval request for an 'imessage'-surface proposal. The reply must name the short
 * id (first 8 chars of the proposal id); a bare yes/no is ordinary chat.
 * The bridge is imported dynamically so loop.ts -> approval-routing.ts never statically links it.
 */
async function sendHealerApprovalRequestOverIMessage(proposalId: string, what: string): Promise<void> {
  const shortId = proposalId.slice(0, 8);
  // Labelled "Dojo:" (never "I"); the main agent is told what was sent, below.
  const text = healerApprovalText(shortId, what);

  try {
    const bridge = await import('../services/imessage-bridge.js');
    const owner = bridge.getDefaultSender();
    if (!owner) {
      logger.error('healer approval-routing: no owner iMessage address on file; approval stays in Vitals only', {
        proposalId,
      });
      return;
    }
    // A platform outbound, not an agent's: the healer speaks for the box.
    const sent = await withOutboundAsyncIfAbsent(
      { agentId: PLATFORM_SENDER, tool: 'healer-approval', channel: 'imessage', recipientId: owner },
      () => bridge.sendIMessage(owner, text),
    );
    {
      const mainAgent = getPrimaryAgentId();
      if (mainAgent) tellAgentWhatDojoSent({ agentId: mainAgent, recipient: 'the owner (by iMessage)', text, sent: !!sent, why: 'to ask the owner to approve a change the Healer wants to make' });
    }
    if (!sent) {
      logger.error('healer approval-routing: iMessage approval send failed; approval stays in Vitals', {
        proposalId,
      });
      return;
    }
    logger.info('healer approval-routing: approval request texted to owner', { proposalId });
  } catch (err) {
    logger.error('healer approval-routing: iMessage approval send threw; approval stays in Vitals', {
      proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
