// ════════════════════════════════════════
// v2 unified error recovery cascade — Part IX
//
// Single entry point for every error path. v1's recovery is split across
// 9+ different code locations in runtime.ts; v2 funnels everything through
// recoverFromError(). Recovery happens in code, never reaches the LLM
// unless all paths exhausted, at which point the run surrenders to the
// existing healer-handoff contract.
//
// Phase 6 (2026-05-04) — replaced the surrender stub with full cascade:
//   1. Context overflow recovery (Dreamer batch-resize, non-Dreamer compact)
//   2. Recoverable provider 4xx with per-agent streak cap
//   3. Generic injury (recordError + last_error + healer notify + chat:error)
//
// All side effects happen in this file. recoverFromError returns void —
// the caller (v2/loop.ts catch) just awaits it and exits cleanly.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../logger.js';
import { markTurnDied } from './turn-record.js';
import { broadcast } from '../../gateway/ws.js';
import { getDb } from '../../db/connection.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { recordError, AgentError } from '../errors.js';
import { hasActiveRateLimitRetry } from '../rate-limit-retry.js';
import { classifyRecoverableProviderError, classifyPlatformError } from './classifiers/provider.js';
import { classifyProviderError, classifyProviderErrorText, type ProviderErrorFacts } from '../provider-error.js';
import {
  pendingWakeups,
  recoveryRunStreak,
  MAX_INLOOP_RECOVERIES_SAME_INPUTS,
} from '../shared-state.js';
import { setAgentStatus } from './loop.js';
import type { AgentTurnState } from './state.js';
import {
  formatErrorForHuman,
  formatTierBNoteForAgent,
  type ErrorKind,
} from './error-format.js';

const logger = createLogger('v2-recovery');

// Informational chat note for a rate limit whose recovery the background
// retry manager owns. Shared by the step-0 passthrough (retry active) and the
// auto-router-exhausted loud path in recordInjury (no retry scheduled) so the
// wording lives in one place.
const RATE_LIMIT_RETRY_NOTE =
  `[System: The model provider returned a rate limit error. The platform is retrying ` +
  `automatically. Give it a moment, and tell the user there is a short delay if they are waiting.]`;

// ── Public API ──

export type RecoveryKind =
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'output_truncated'
  | 'vision_mismatch'
  | 'tool_format_rejected'
  | 'auto_router_fallback'
  | 'tool_crash'
  | 'network'
  | 'unknown';

export interface ClassifiedError {
  kind: RecoveryKind;
  retryAfter?: number | null;
  guidance?: string;
}

/**
 * Recovery cascade entry point. Tries each recovery path in order and
 * stops at the first one that handles the error. If none do, records
 * an injury so the Healer can take over. All side effects (DB writes,
 * broadcasts, status changes, wakeup queueing) happen in here — the
 * caller just awaits and lets the turn end.
 */
export async function recoverFromError(
  state: AgentTurnState,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof AgentError && error.cause instanceof Error
      ? error.cause.message
      : undefined;
  const code = error instanceof AgentError ? error.code : undefined;
  const fullErrText = cause ? `${message} ${cause}` : message;
  const agentId = state.agentId;
  // PHASE-4 T5: what the provider actually said, read ONCE and handed to every step below.
  // The model layer attaches it when it raises; anything else is classified here.
  const facts = error instanceof AgentError && error.provider
    ? error.provider : classifyProviderError(error);

  // 0. Rate limit / overloaded that the background decay retry manager already
  //    owns (FA-A1). When the model layer hit a 429/529 on a PINNED model (not
  //    auto-routed), it called scheduleRateLimitRetry BEFORE re-throwing; that
  //    manager owns recovery end to end (silent retries, status 'rate_limited'
  //    at strike 3, re-wake when the provider window resets). Running the
  //    injury cascade for the SAME error double-handles it: it bumps the
  //    error-loop counter (5 in 2min pauses even the primary), thrashes status
  //    between error/working/rate_limited, and wakes the Healer for an infra
  //    condition it is forbidden to fix by switching a pinned model.
  //
  //    Gated on an ACTIVE retry state, NEVER on the error text alone. The
  //    auto-router all-fallbacks-exhausted case set routerTier, so the model
  //    layer did NOT schedule a retry, hasActiveRateLimitRetry is false, and
  //    that case still degrades loudly through the cascade below. Reuses
  //    classifyError's regex so the match stays in one place.
  const rlKind = classifyError(new Error(fullErrText), facts).kind;
  if ((rlKind === 'rate_limit' || rlKind === 'overloaded') && hasActiveRateLimitRetry(agentId)) {
    logger.info(
      'v2: rate limit owned by background retry manager, skipping injury cascade',
      { agentId, kind: rlKind },
      agentId,
    );
    // Persist the informational note only (no recordError, no status='error',
    // no last_error write, no onAgentInjured). The retry manager drives status
    // and the eventual back-online notice.
    persistAndBroadcastSystemNote(agentId, RATE_LIMIT_RETRY_NOTE);
    return;
  }

  // 1. Context overflow — provider rejected because prompt too big.
  //    Dreamer gets batch-resize; everyone else gets force-compact + wakeup.
  if (await tryContextOverflowRecovery(agentId, fullErrText, message, code, cause)) {
    return;
  }

  // 2. Output truncation as a thrown error.
  if (await tryOutputTruncationRecovery(agentId, fullErrText)) {
    return;
  }

  // 3. Platform errors (Tier D) — auth invalid, access denied, quota
  //    exhausted, DNS failure. The platform genuinely can't proceed; the
  //    user needs to act. Persist a human-language system note for the
  //    agent (so when it eventually wakes, it has context) AND set
  //    status='error' AND surface a plain-English banner + iMessage.
  //    error-handling-spec Phase 1 / Phase 2.
  if (await tryPlatformErrorRecovery(state, fullErrText, message, facts)) {
    return;
  }

  // 4. Provider 4xx that the agent itself can adapt to. Persist a
  //    [System: …] note + wakeup. Status STAYS idle. error-handling-spec
  //    Phase 1: no status change for Tier B. Same-kind cap replaced with
  //    "same kind + same inputs" so the agent has unlimited adaptation
  //    attempts as long as it actually changes its approach.
  if (await tryProviderRecovery(state, fullErrText, message, facts)) {
    return;
  }

  // 5. Unclassified error. Per spec Phase 1: still persist a
  //    plain-language system note so the agent has context on its
  //    next turn. Only THEN consider injury — and even then, the agent
  //    has something in chat history to read instead of just going
  //    silent.
  await recordInjury(state, message, cause, code, facts);
}

/**
 * v2.3.19 — fingerprint an agent's "inputs" so we can detect when a
 * recovery is being re-tried with identical inputs (system note isn't
 * helping). Stable across identical retries; changes when the agent's
 * trigger message or last response actually differs.
 *
 * Uses readily-available state: the turn's trigger user message and the
 * canonical signature of the agent's most recent response (already
 * computed for repetition detection). Cheap, no DB query.
 */
// Exported for tests in agent/v2/__tests__/integration.test.ts so the
// cap-reach test can pre-populate `recoveryRunStreak` with the exact
// fingerprint runV2Turn will compute on the next failure.
export function computeInputsFingerprint(state: AgentTurnState): string {
  const trigger = state.lastUserMessageContent?.slice(0, 200) ?? '';
  const lastResp = state.lastResponseSig ?? '';
  let h = 0;
  const seed = `${trigger}|${lastResp}`;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  // PHASE-2 T2: the turn number is NOT an input and is out of this key. With `t<turnNumber>`
  // in it the streak could only match WITHIN a turn; the cross-turn cap fired only because the
  // old MAX(messages) derivation handed two turns the same number. Details: T2's report §4.
  return `h${h.toString(36)}`;
}

/**
 * Classify an error into a recovery kind. Used by callers that want to
 * report what KIND of failure occurred (e.g. for telemetry) without
 * actually running recovery.
 */
export function classifyError(error: Error, facts?: ProviderErrorFacts): ClassifiedError {
  const msg = error.message.toLowerCase();
  // PHASE-4 T5: the two message shapes that CARRY a big number are read FIRST, then the
  // provider's own verdict. "usage limit" is the Claude subscription (agent-sdk) phrasing for
  // a rate limit; keeping it here keeps the FA-A1 passthrough owning SDK usage-limit errors
  // on pinned models instead of injuring the agent (FA-PC4), and no status can express it.
  if (/context.*overflow|prompt.*too.?long/.test(msg)) return { kind: 'context_overflow' };
  if (/output.*token.*(limit|exceed|max)|max_output_tokens|truncat/.test(msg))
    return { kind: 'output_truncated' };
  if (msg.includes('usage limit')) return { kind: 'rate_limit' };
  const cls = (facts ?? classifyProviderErrorText(msg)).class;
  if (cls === 'rate_limit' || cls === 'quota') return { kind: 'rate_limit' };
  if (cls === 'overloaded') return { kind: 'overloaded' };
  if (cls === 'network' || msg.includes('socket')) return { kind: 'network' };
  return { kind: 'unknown' };
}

// ── Step 1: context overflow ──

async function tryContextOverflowRecovery(
  agentId: string,
  fullErrText: string,
  message: string,
  code: string | undefined,
  cause: string | undefined,
): Promise<boolean> {
  try {
    const { isContextOverflowError, recoverDreamerFromContextOverflow } = await import(
      '../../vault/maintenance.js'
    );
    if (!isContextOverflowError(fullErrText)) return false;

    logger.warn(`v2: context overflow detected — ${message}`, { agentId, code, cause }, agentId);

    const { getDreamerAgentId } = await import('../../config/platform.js');
    if (agentId === getDreamerAgentId()) {
      // Dreamer has a structured pending-batch queue we can re-shape.
      const recovered = await recoverDreamerFromContextOverflow(agentId, fullErrText);
      if (recovered) {
        logger.warn('v2: recovered from Dreamer context overflow by splitting batch', { agentId }, agentId);
        return true;
      }
      return false;
    }

    // Non-Dreamer agents: force a compaction + wakeup so the next turn
    // assembles fresh post-compaction context. Keeps the agent working
    // instead of going into the error/injury loop.
    const lastModelRow = getDb()
      .prepare('SELECT model_id FROM agents WHERE id = ?')
      .get(agentId) as { model_id: string | null } | undefined;
    const compactModelId = lastModelRow?.model_id ?? null;
    if (!compactModelId || compactModelId === 'auto') return false;

    const { checkAndCompact } = await import('../../memory/compaction.js');
    const { getContextWindow } = await import('../model.js');
    const cw = getContextWindow(compactModelId);
    await checkAndCompact(agentId, compactModelId, cw, { force: true });
    logger.warn('v2: forced compaction after context overflow on non-Dreamer agent', { agentId }, agentId);
    pendingWakeups.add(agentId);
    return true;
  } catch (recovErr) {
    logger.warn('v2: context overflow recovery attempt failed', {
      agentId,
      error: recovErr instanceof Error ? recovErr.message : String(recovErr),
    }, agentId);
    return false;
  }
}

// ── Step 1.5: output truncation thrown as error ──

async function tryOutputTruncationRecovery(
  agentId: string,
  fullErrText: string,
): Promise<boolean> {
  const lower = fullErrText.toLowerCase();
  // Match the patterns providers use when they raise (rather than signal via
  // stopReason). Conservative — only obvious output-budget-exceeded phrasing.
  const matches =
    /(max[_\s-]?output[_\s-]?tokens|output[_\s-]?token[_\s-]?limit|output[_\s-]?(token|length).*(exceed|limit)|exceed.*output[_\s-]?token)/i.test(
      fullErrText,
    ) ||
    (lower.includes('max_tokens') && lower.includes('exceed'));
  if (!matches) return false;

  logger.warn('v2: output truncation thrown as error — system note + wakeup', {
    agentId,
    errorPreview: fullErrText.slice(0, 200),
  }, agentId);

  const note =
    `[System: Your last response was rejected because it exceeded the output token limit. ` +
    `Be more concise — produce a shorter response, or break the task into smaller pieces. ` +
    `If a tool result is too large to summarize in one turn, call complete_task or update the user with what you've done so far and continue next turn.]`;
  persistAndBroadcastSystemNote(agentId, note);
  pendingWakeups.add(agentId);
  return true;
}

// ── Step 2: provider 4xx ──

async function tryProviderRecovery(
  state: AgentTurnState,
  fullErrText: string,
  message: string,
  facts: ProviderErrorFacts,
): Promise<boolean> {
  const agentId = state.agentId;
  let recovery;
  try {
    recovery = classifyRecoverableProviderError(fullErrText, facts);
  } catch (err) {
    logger.warn('v2: provider classifier threw', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return false;
  }
  if (!recovery) return false;

  // v2.3.19 — inputs-changed check replaces the per-kind count cap. We
  // only consider a retry "wasteful" when the same kind fires WITH the
  // same inputs fingerprint. If the agent has adapted (different message
  // content, different last response), the streak resets even if the
  // error kind is identical.
  const fingerprint = computeInputsFingerprint(state);
  const prev = recoveryRunStreak.get(agentId);
  const sameKindSameInputs =
    prev?.kind === recovery.kind && prev?.inputsFingerprint === fingerprint;
  const newCount = sameKindSameInputs ? prev!.count + 1 : 1;
  recoveryRunStreak.set(agentId, {
    kind: recovery.kind,
    inputsFingerprint: fingerprint,
    count: newCount,
  });

  if (newCount > MAX_INLOOP_RECOVERIES_SAME_INPUTS) {
    // Same error, same inputs, multiple attempts in a row. The system note
    // isn't unsticking the agent — escalate to Healer (Tier C) instead of
    // looping uselessly. We still leave the agent IDLE — only the Healer
    // path runs. The agent will get one final "we've tried, the Healer is
    // looking" note so it can apologize cleanly to the user if asked.
    recoveryRunStreak.delete(agentId);
    logger.warn('v2: in-loop recovery exhausted on same inputs — handing off to Healer (Tier C)', {
      agentId,
      kind: recovery.kind,
      count: newCount,
      fingerprint,
    }, agentId);
    const giveUpNote =
      `[System: We have tried this recovery ${newCount} times with the same approach and it keeps failing. ` +
      `The Healer is being notified to investigate. ` +
      `If the user is waiting, apologize and tell them you ran into a problem you cannot work around right now.]`;
    persistAndBroadcastSystemNote(agentId, giveUpNote);
    // Fall through so recoverFromError calls recordInjury — but per
    // spec Phase 1, recordInjury now persists a Tier B note first AND
    // tries to keep the agent recoverable without status='error'.
    return false;
  }

  logger.warn('v2: recoverable provider error — injecting Tier B system note', {
    agentId,
    kind: recovery.kind,
    count: newCount,
    fingerprint,
    message: message.slice(0, 200),
  }, agentId);

  // For vision-mismatch errors, also correct the model's capability cache
  // so the pre-flight gate strips images on every subsequent turn for any
  // agent using this model. Self-healing capability probe.
  if (recovery.kind === 'vision_mismatch') {
    try {
      const lastModelRow = getDb()
        .prepare('SELECT model_id FROM agents WHERE id = ?')
        .get(agentId) as { model_id: string | null } | undefined;
      if (lastModelRow?.model_id && lastModelRow.model_id !== 'auto') {
        const { removeCapability } = await import('../../services/capabilities.js');
        removeCapability(lastModelRow.model_id, 'vision');
      }
    } catch {
      /* best effort — recovery still proceeds */
    }
  }

  // v2.3.19 — agent system note is now sourced from the spec table via
  // formatTierBNoteForAgent. The recovery.userFacingReason / guidance
  // fields still live on the recovery object so legacy callers don't
  // break, but the user-facing wording flows through one place.
  const recoveryKindAsErrorKind = recovery.kind as ErrorKind;
  const tierBBody = formatTierBNoteForAgent(recoveryKindAsErrorKind, recovery.context ?? {});
  const systemNote = `[System: ${tierBBody}]`;
  persistAndBroadcastSystemNote(agentId, systemNote);

  // Tier B: NO status change. Queue a wakeup so the agent retries with
  // the system note in context.
  pendingWakeups.add(agentId);
  return true;
}

/**
 * Tier D — true platform conditions (auth invalid, access denied, quota
 * exhausted, DNS failure). The agent CAN'T proceed and the user needs to
 * act. Sets status='error', persists a chat-history system note for the
 * agent (so the next session has context), broadcasts a plain-English
 * banner, sends iMessage.
 *
 * Returns true if it handled the error (caller should NOT fall through
 * to recordInjury).
 */
async function tryPlatformErrorRecovery(
  state: AgentTurnState,
  fullErrText: string,
  message: string,
  facts: ProviderErrorFacts,
): Promise<boolean> {
  const agentId = state.agentId;
  let platform;
  try {
    platform = classifyPlatformError(fullErrText, facts);
  } catch (err) {
    logger.warn('v2: platform classifier threw', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return false;
  }
  if (!platform) return false;

  // Resolve display context for human-language message.
  let agentName = agentId;
  let providerName: string | undefined;
  try {
    const row = getDb()
      .prepare(`
        SELECT a.name AS agent_name, p.name AS provider_name
        FROM agents a
        LEFT JOIN models m ON m.id = a.model_id
        LEFT JOIN providers p ON p.id = m.provider_id
        WHERE a.id = ?
      `)
      .get(agentId) as { agent_name: string; provider_name: string | null } | undefined;
    if (row?.agent_name) agentName = row.agent_name;
    if (row?.provider_name) providerName = row.provider_name;
  } catch { /* */ }

  logger.error('v2: platform error — Tier D (locking agent, alerting user)', {
    agentId, kind: platform.kind, message: message.slice(0, 200),
  }, agentId);

  // Persist a chat-history system note for the agent. The agent will
  // not run again until the platform issue is resolved, but if/when it
  // does, this note will be at the top of its next session context.
  const humanText = formatErrorForHuman(platform.kind as ErrorKind, { agentName, providerName });
  const systemNote = `[System (platform error): ${humanText}]`;
  persistAndBroadcastSystemNote(agentId, systemNote);

  // Set status='error' so the dashboard reflects the locked state.
  setAgentStatus(agentId, 'error');

  // Persist last_error for diagnostics (full technical detail logged
  // already above; only sanitized version stored).
  try {
    getDb()
      .prepare(
        `UPDATE agents SET last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
      .run(`[${platform.kind}] ${message.slice(0, 400)}`, agentId);
  } catch { /* best effort */ }

  // Plain-English chat:error toast.
  const code =
    platform.kind === 'auth_invalid' ? 'AUTH_INVALID' as const :
    platform.kind === 'access_denied' ? 'ACCESS_DENIED' as const :
    platform.kind === 'quota_exhausted' ? 'QUOTA_EXHAUSTED' as const :
    'DNS_FAILURE' as const;
  broadcast({
    type: 'chat:error',
    agentId,
    error: humanText,
    code,
    severity: 'error',
    retryable: false,
  });

  // Schedule Healer (it can still help — different provider, can audit).
  try {
    const { onAgentInjured } = await import('../../healer/injury-recovery.js');
    onAgentInjured(agentId, `[${platform.kind}] ${humanText}`);
  } catch { /* */ }

  return true;
}

// ── Step 3: injury ──

async function recordInjury(
  state: AgentTurnState,
  message: string,
  cause: string | undefined,
  code: string | undefined,
  facts?: ProviderErrorFacts,
): Promise<void> {
  const agentId = state.agentId;
  logger.error(`v2 agent loop failed: ${message}`, { agentId, code, cause }, agentId);
  // P4 turn record: a turn that died on an exception gets an honest terminal
  // state instead of an open-ended row.
  try { markTurnDied(agentId, state.turnNumber); } catch { /* best effort */ }

  // v2.3.19 — ALWAYS persist a chat-history system note FIRST so the
  // agent has context on its next turn. Pre-spec the only path that
  // wrote a note was rate-limit; every other error went silent. The
  // note uses plain language and never contains raw provider JSON.
  // PHASE-4 T5: the provider's own verdict, not this message's digits.
  const injuryClass = (facts ?? classifyProviderErrorText(message)).class;
  const isRateLimit =
    injuryClass === 'rate_limit' || injuryClass === 'quota' || injuryClass === 'overloaded';

  // Persist the unclassified-error note as a system message so the agent
  // sees something it can act on (apologize to user, try a different
  // approach next session, etc.) rather than just going silent.
  if (isRateLimit) {
    persistAndBroadcastSystemNote(agentId, RATE_LIMIT_RETRY_NOTE);
  } else {
    persistAndBroadcastSystemNote(
      agentId,
      `[System: Your last turn hit an unexpected error that the platform could not classify or auto-recover. ` +
      `Apologize to the user, end your turn cleanly, and the Healer will look into it.]`,
    );
  }

  // Loop detection (5 errors in 2min → pause). Per spec Phase 1, this
  // remains as the SAFETY NET for genuine error loops — but the
  // threshold should rarely be hit now that Tier B errors don't bump
  // the count (they no longer reach recordInjury).
  const paused = recordError(agentId);
  if (!paused) {
    // v2.3.19 — keep setting status='error' here for the unclassified
    // and rate-limit paths. Tier B and Tier D are handled BEFORE
    // recordInjury fires; anything that reaches this function is by
    // definition "we couldn't classify or recover, the agent should
    // pause until something changes."
    setAgentStatus(agentId, 'error');
  }

  // Persist the error details so the healer system can diagnose and
  // attempt auto-recovery without needing the in-memory state.
  try {
    const errDetail = cause ? `${message} (${cause})` : message;
    getDb()
      .prepare(
        `UPDATE agents SET last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
      .run(errDetail.slice(0, 500), agentId);
  } catch {
    /* best effort */
  }

  // Schedule healer notification after grace period.
  try {
    const { onAgentInjured } = await import('../../healer/injury-recovery.js');
    onAgentInjured(agentId, message);
  } catch {
    /* module may not be available */
  }

  // Broadcast plain-English chat:error to dashboard. The persisted
  // system note (above) is the durable record; the toast is the
  // ephemeral signal.
  const userMsg = isRateLimit
    ? 'Model is rate-limited. Retrying automatically — give it a moment.'
    : paused
      ? 'Agent paused after repeated errors. Open the Vitals page to investigate, or resume from its detail page.'
      : 'Agent hit an error and the Healer is looking into it. Send a new message to retry, or check the Vitals page if it keeps failing.';
  broadcast({
    type: 'chat:error',
    agentId,
    error: userMsg,
    code: isRateLimit ? 'RATE_LIMITED' : paused ? 'ERROR_LOOP' : 'MODEL_FAILED',
    severity: isRateLimit ? 'warning' : 'error',
    retryable: isRateLimit,
  });
}

// ── Helpers ──

function persistAndBroadcastSystemNote(agentId: string, content: string): void {
  try {
    const noteId = uuidv4();
    insertMessageIfAbsent({ id: noteId, agentId, role: 'system', content });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: noteId,
        agentId,
        role: 'system',
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch {
    /* best effort */
  }
}
