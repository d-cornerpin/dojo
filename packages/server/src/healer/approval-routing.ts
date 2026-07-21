// ════════════════════════════════════════
// Healer destructive-approval routing (D-B, owner-directed v2).
//
// When the v2 loop's destructive gate HOLDS a Healer tool call, the Healer does
// NOT wake the primary the way every other worker does. The Healer answers to
// the OWNER, so a single owner-approval object is filed instead: a healer_proposals
// row (the same object the model uses for routine consent) carrying the bound
// approval token + the exact canonical signature of the held call, plus the
// engine-derived urgency and delivery surface.
//
// Owner approval (gateway/routes/healer.ts) mints a one-shot destructive_approvals
// row from that bound token/signature, so the Healer's RE-ATTEMPT of the same
// call consumes it once and executes (destructive-gate.ts consumeApproval). The
// signature is computed ONCE at hold time with canonicalToolSignature and stored;
// the retry re-computes it from the identical tool call with the same function,
// so the two cannot diverge.
//
// v2 (owner-directed): consent asks live in the Healer section of Vitals in plain
// language; the orb toast is retired. The ONLY loud lane is a text, and only for a
// CRITICAL diagnostic while the owner is away. A clean file returns a NON-error,
// "queued, move on" tool-result so nothing blocks. A strictly-parseable deletion
// whose every target is inside a scratch zone auto-approves with an audit + Vitals
// record and no consent ask at all.
//
// This module owns the pure surface selector, the scratch-zone auto-approve rule,
// the proposal filing, and the deterministic "applied on retry" close. It does NOT
// render UI; the Vitals view and the iMessage lane consume the columns it stamps.
// ════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { resolveRealPathHardened, isProtectedIdentityPath } from '../agent/permissions.js';

const logger = createLogger('healer-approval-routing');

/** Engine diagnostic severity, mirrored from diagnostic.ts DiagnosticItem. */
export type EngineSeverity = 'critical' | 'warning' | 'info';

export type HealerApprovalUrgency = 'routine' | 'urgent';
export type HealerApprovalSurface = 'vitals' | 'toast' | 'imessage';

export interface HealerApprovalRouting {
  urgency: HealerApprovalUrgency;
  surface: HealerApprovalSurface;
}

/**
 * D-B v2 (owner-directed) surface selector. Pure and deterministic, no model
 * judgment, no I/O. The caller supplies the engine-derived facts; this function
 * only applies the rules.
 *
 * The owner ruled the orb toast RETIRES: consent asks live in the Healer section
 * of Vitals in plain language. The ONLY loud, out-of-band lane left is a text,
 * and it is narrow:
 *
 *   surface = 'imessage'  iff  engine-severity is CRITICAL  AND  the owner is
 *             away (presence)  AND  iMessage is enabled. Everything else queues
 *             quietly in Vitals. 'toast' is never produced.
 *
 * Urgency now drives only the Vitals badge tone + the expiry class:
 *   - 'imessage' (the critical texted class) is 'urgent' and expires on the
 *     60-minute destructive-gate clock with a loud owner notice.
 *   - everything else is 'routine', queues in Vitals, and keeps the 14-day
 *     healer_proposals lifecycle (quiet expiry, never an error).
 *
 * The engine-severity, never the model's word, is what the selector reads.
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

// ════════════════════════════════════════
// D-B v2 Part 1: scratch-zone auto-approve (engine rule, static, fail-closed).
//
// A Healer destructive call whose EVERY target resolves (through the hardened
// canonicalizer) strictly INSIDE a designated scratch zone runs WITHOUT consent,
// leaving an audit_log row (outcome 'auto_approved_scratch') and a Vitals-visible
// history record. Anything unparseable, out-of-zone, or unresolvable takes the
// normal hold path. Protected-identity and global denies run FIRST (in
// isDestructiveCall + the manifest exec check) and always win; this only ever
// NARROWS what holds, never widens what can be deleted.
// ════════════════════════════════════════

// Static scratch/work zones. Ephemeral work areas ONLY: general temp + the agent
// file-output tree. NEVER ~/.dojo/config, prompts, data, secrets, logs, or
// techniques (all outside these roots). Resolved once through the hardened
// canonicalizer so a symlinked /tmp or $TMPDIR normalizes to the same real path a
// target resolves to (macOS /tmp -> /private/tmp, $TMPDIR -> /private/var/...).
const SCRATCH_ZONE_SOURCES = [
  '/tmp',
  os.tmpdir(),
  path.join(os.homedir(), '.dojo', 'uploads'),
  path.join(os.homedir(), '.dojo', 'tmp'),
];

const SCRATCH_ZONE_ROOTS: string[] = (() => {
  const roots = new Set<string>();
  for (const src of SCRATCH_ZONE_SOURCES) {
    const resolved = resolveRealPathHardened(src);
    if (resolved.resolved) roots.add(resolved.path);
  }
  return [...roots];
})();

// Only a single, plain rm/rmdir with a literal arg list is auto-approvable. Any
// shell metacharacter, subshell, redirection, variable, quote, or glob forces the
// normal hold (we cannot statically reason about what those would delete).
const SHELL_META_RE = /[;&|`$()<>*?[\]{}!"'\\\n\r]/;
// Conservative rm flag whitelist (recursive / force / directory / -R). Any other
// dash-arg (e.g. --no-preserve-root) forces the hold.
const RM_FLAG_RE = /^-[rRfd]+$/;

export interface ScratchZoneDecision {
  /** The exact command evaluated (audit/history target). */
  command: string;
  /** The zone root each target landed strictly inside (audit detail). */
  zones: string[];
}

/**
 * Pure decision: is this a strictly-parseable rm/rmdir whose every target
 * resolves strictly inside a scratch zone? Returns the decision on a match,
 * null on ANY miss (fail closed). No I/O beyond the symlink-resolving stat walk
 * the hardened canonicalizer already performs.
 */
export function evaluateScratchZoneAutoApprove(
  toolName: string,
  args: Record<string, unknown>,
): ScratchZoneDecision | null {
  if (toolName !== 'exec') return null;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
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
    // Protected identity/config paths ALWAYS hold, never auto-approve.
    if (isProtectedIdentityPath(target)) return null;
    const resolved = resolveRealPathHardened(target);
    if (!resolved.resolved) return null; // fail closed
    const zone = SCRATCH_ZONE_ROOTS.find(
      (root) => resolved.path === root || resolved.path.startsWith(root + path.sep),
    );
    // Require STRICTLY under a zone; deleting a zone root itself (rm -rf /tmp)
    // is NOT auto-approvable.
    if (!zone || resolved.path === zone) return null;
    zones.push(zone);
  }
  return { command, zones: [...new Set(zones)] };
}

/**
 * Evaluate + record. Returns true when the call was auto-approved (the caller
 * then lets it execute once WITHOUT filing a proposal), false when it must take
 * the normal hold path. On auto-approve it writes the audit_log row and the
 * Vitals history record and nudges the live Vitals view to refresh.
 */
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
    // audit_log.action_type is a fixed enum ('exec' is the action); the
    // auto-approval outcome rides in detail.outcome, never a secret.
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
    // Vitals-visible record ("Things the Healer Did Automatically").
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
  // Refresh the live Vitals view (HealerVitals reloads on any healer:proposal
  // frame); no proposal exists, so this carries only the action id.
  try { broadcast({ type: 'healer:proposal', data: { id: actionId } }); } catch { /* best effort */ }

  logger.info('healer scratch-zone destructive auto-approved', {
    agentId: input.agentId, command: decision.command.slice(0, 120), zones: decision.zones,
  });
  return true;
}

export interface FileHealerApprovalInput {
  /** The Healer agent id (the held call's caller). */
  agentId: string;
  agentName: string;
  toolName: string;
  /** Canonical destructive-gate signature of the held call (bound). */
  signature: string;
  /** The gate's kind label, e.g. 'destructive shell command'. */
  kind: string;
  /** Human-readable one-line description of the held call. */
  callDescription: string;
  /** True for a live gate hold (a direct rm/write pause, not diagnostic
   *  provenance). Retained for the caller's record; the v2 selector routes on
   *  engine severity + presence, so a live hold with no diagnostic severity
   *  queues quietly in Vitals. */
  heldDirectDestructiveCall: boolean;
  /** Engine diagnostic severity when the call has provenance. Only CRITICAL +
   *  owner-away routes to the iMessage lane; everything else queues in Vitals. */
  engineSeverity?: EngineSeverity | null;
  // P7b: full argument JSON of the held call (exact-call contract).
  argsJson?: string | null;
}

export interface FileHealerApprovalResult {
  proposalId: string;
  token: string;
  urgency: HealerApprovalUrgency;
  surface: HealerApprovalSurface;
  /** The structured tool-result text the loop gate hands back to the Healer. */
  refusal: string;
  /** True when the consent was filed cleanly (queued, not an error): the loop
   *  returns it as a NON-error tool result so the turn continues. False only
   *  when filing failed (a genuine block). */
  queued: boolean;
}

/**
 * D-B step 2: file the single owner-approval object for a HELD Healer call and
 * return the structured tool-result the gate hands back. Broadcasts the typed
 * healer:proposal WS frame (stamped with urgency + surface) so the live Vitals
 * view sees it immediately; only the critical-texted class (surface='imessage')
 * also texts the owner.
 *
 * Presence is read here (dynamic import to keep the loop gate's static import
 * graph free of the iMessage bridge); the DECISION stays in the pure selector.
 */
export async function fileHealerApprovalProposal(
  input: FileHealerApprovalInput,
): Promise<FileHealerApprovalResult> {
  let presence: 'in_dojo' | 'away' = 'in_dojo';
  let imessageEnabled = false;
  try {
    const presenceMod = await import('../services/presence.js');
    presence = presenceMod.getPresence();
    imessageEnabled = presenceMod.isImessageEnabled();
  } catch (err) {
    // Presence unavailable: default to present (in_dojo), which routes to the
    // quiet Vitals lane. Never block the hold on a presence lookup.
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
  // The severity column is the Vitals badge tone: red for the critical texted
  // class, amber for a quietly-queued consent (matching the Vitals pending tone).
  const severity = routing.surface === 'imessage' ? 'critical' : 'warning';
  // Engine-fixed, plain-language copy (never a model-authored headline). What it
  // is, why it paused, what declining does, and a recommendation. The raw command
  // rides in proposed_fix, which the Vitals card tucks behind a details expander.
  const title = 'A cleanup change is waiting for your OK';
  const description =
    'Your self-healing helper wants to delete or change something outside its ' +
    'normal temporary work area, so it paused and is checking with you first. ' +
    'Nothing has been changed yet. If you decline, nothing happens and everything ' +
    'stays exactly as it is. If you are not sure, it is safe to decline; you can ' +
    'always ask for it again later. My suggestion: approve it only if you recognize ' +
    'this as something you asked for.';
  const proposedFix = `Run this action: ${input.callDescription}`;
  const evidence = JSON.stringify([
    'It paused on its own because this kind of change can delete or overwrite files.',
    'Nothing will happen unless you approve it. Declining leaves everything as it is.',
  ]);

  try {
    getDb().prepare(`
      INSERT INTO healer_proposals
        (id, category, severity, title, description, proposed_fix, status, agent_id,
         evidence_json, urgency, surface, notified_at, approval_token, approval_signature, approval_args_json, created_at)
      VALUES (?, 'destructive_action', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now'))
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

  // D-B step 5 OUTBOUND: the owner is away with iMessage enabled, so text the
  // approval request to them. The proposal already stands in Vitals (the mirror),
  // so a send failure is fail-open: log loudly, the request is never lost. Only
  // the 'imessage' surface texts; 'toast'/'vitals' are handled by their own lanes.
  if (routing.surface === 'imessage') {
    await sendHealerApprovalRequestOverIMessage(proposalId);
  }

  // D-B v2 Part 3: a NON-error, structured result. The action is QUEUED, not
  // failed, and nothing is blocked. The turn continues normally. Do not frame the
  // agent as waiting to be re-woken (that is what left it sitting during the wall
  // run); tell it plainly to move on. If the owner approves later, the engine
  // brings the exact call back through the existing 30s kick + consume-once retry.
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
 * D-B step 2 (deterministic close): the owner-approved held action just ran
 * through the gate (its bound token was consumed). Mark the matching proposal
 * applied so runHealingCycle stops re-presenting it AND, critically, so a stray
 * re-issue cannot re-hold the now-consumed token into a brand-new proposal.
 * Matched on (agent_id, approval_signature) exactly as the approval was bound.
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
 * D-B step 5: text the owner an approval request for an 'imessage'-surface
 * proposal. The message is plain (no tool names, no raw command), carries a
 * SHORT id (first 8 of the proposal id), and tells the owner exactly how to
 * reply. B2: the reply MUST name that id ("yes 1a2b3c"); a bare "yes"/"no" is
 * treated as ordinary chat, so the copy never implies a bare reply works. On
 * success it refreshes notified_at to the real send time.
 *
 * The iMessage bridge is pulled in via DYNAMIC import so the loop's static
 * import graph (loop.ts -> approval-routing.ts) never links the bridge, matching
 * the presence lookup idiom above. In dev sim mode the bridge captures the send
 * instead of really texting (imessage-bridge.ts sendIMessage), so the harness
 * verifies this lane without a real round-trip.
 */
async function sendHealerApprovalRequestOverIMessage(proposalId: string): Promise<void> {
  const shortId = proposalId.slice(0, 8);
  const text =
    'Your self-healing helper needs your OK before it makes a change on your Mac ' +
    'that could delete or overwrite something. Nothing has changed yet.\n\n' +
    `Reply "yes ${shortId}" to approve or "no ${shortId}" to decline. Please ` +
    'include that code so I change the right thing.';

  try {
    const bridge = await import('../services/imessage-bridge.js');
    const owner = bridge.getDefaultSender();
    if (!owner) {
      logger.error('healer approval-routing: no owner iMessage address on file; approval stays in Vitals only', {
        proposalId,
      });
      return;
    }
    const sent = bridge.sendIMessage(owner, text);
    if (!sent) {
      logger.error('healer approval-routing: iMessage approval send failed; approval stays in Vitals', {
        proposalId,
      });
      return;
    }
    try {
      getDb().prepare(`UPDATE healer_proposals SET notified_at = datetime('now') WHERE id = ?`).run(proposalId);
    } catch { /* notified_at refresh is best-effort; the row is already filed */ }
    logger.info('healer approval-routing: approval request texted to owner', { proposalId });
  } catch (err) {
    logger.error('healer approval-routing: iMessage approval send threw; approval stays in Vitals', {
      proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
