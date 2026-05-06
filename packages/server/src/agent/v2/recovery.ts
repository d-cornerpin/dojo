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
import { broadcast } from '../../gateway/ws.js';
import { getDb } from '../../db/connection.js';
import { recordError, AgentError } from '../errors.js';
import { classifyRecoverableProviderError } from './classifiers/provider.js';
import {
  pendingWakeups,
  recoveryRunStreak,
  MAX_CONSECUTIVE_INLOOP_RECOVERIES,
} from '../shared-state.js';
import { setAgentStatus } from './loop.js';
import type { AgentTurnState } from './state.js';

const logger = createLogger('v2-recovery');

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

  // 1. Context overflow — provider rejected because prompt too big.
  //    Dreamer gets batch-resize; everyone else gets force-compact + wakeup.
  if (await tryContextOverflowRecovery(agentId, fullErrText, message, code, cause)) {
    return;
  }

  // 2. Output truncation as a thrown error. Most providers signal output
  //    truncation via stopReason='max_tokens' (handled in-loop by
  //    outputTruncationClassifier with budget escalation). Some providers
  //    instead throw an error like "max_output_tokens exceeded". Catch
  //    that here so the agent gets a system note + wakeup instead of an
  //    injury — Phase 6 spec acceptance criterion.
  if (await tryOutputTruncationRecovery(agentId, fullErrText)) {
    return;
  }

  // 3. Provider 4xx that the agent itself can adapt to (vision mismatch,
  //    malformed tool call, etc.). Persist a [System: …] note → wakeup.
  //    Capped at MAX_CONSECUTIVE_INLOOP_RECOVERIES of the same kind so
  //    a recovery that can't actually fix the problem doesn't loop.
  if (await tryProviderRecovery(agentId, fullErrText, message)) {
    return;
  }

  // 3. Generic injury path: log, recordError (loop detection), persist
  //    last_error, set status, schedule healer notification, broadcast
  //    chat:error. This is the "we couldn't fix it ourselves" exit.
  await recordInjury(agentId, message, cause, code);
}

/**
 * Classify an error into a recovery kind. Used by callers that want to
 * report what KIND of failure occurred (e.g. for telemetry) without
 * actually running recovery.
 */
export function classifyError(error: Error): ClassifiedError {
  const msg = error.message.toLowerCase();
  if (/rate.?limit|429/.test(msg)) return { kind: 'rate_limit' };
  if (/overloaded|529/.test(msg)) return { kind: 'overloaded' };
  if (/context.*overflow|prompt.*too.?long/.test(msg)) return { kind: 'context_overflow' };
  if (/output.*token.*(limit|exceed|max)|max_output_tokens|truncat/.test(msg))
    return { kind: 'output_truncated' };
  if (/network|timeout|econnrefused|socket/.test(msg)) return { kind: 'network' };
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
  agentId: string,
  fullErrText: string,
  message: string,
): Promise<boolean> {
  let recovery;
  try {
    recovery = classifyRecoverableProviderError(fullErrText);
  } catch (err) {
    logger.warn('v2: provider classifier threw', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return false;
  }
  if (!recovery) return false;

  const prev = recoveryRunStreak.get(agentId);
  const sameKind = prev?.kind === recovery.kind;
  const newCount = sameKind ? prev!.count + 1 : 1;
  recoveryRunStreak.set(agentId, { kind: recovery.kind, count: newCount });

  if (newCount > MAX_CONSECUTIVE_INLOOP_RECOVERIES) {
    // Cap reached — give up on in-loop recovery, escalate to injury.
    recoveryRunStreak.delete(agentId);
    logger.error('v2: in-loop recovery cap reached — escalating to injury', {
      agentId,
      kind: recovery.kind,
      count: newCount,
      max: MAX_CONSECUTIVE_INLOOP_RECOVERIES,
    }, agentId);
    const giveUpNote =
      `[System: The same problem keeps coming back (${recovery.kind}, ${newCount} attempts). ` +
      `Auto-recovery is giving up and handing this off to the Healer agent. ` +
      `Underlying issue: ${recovery.userFacingReason}.]`;
    persistAndBroadcastSystemNote(agentId, giveUpNote);
    // Fall through to caller — return false so recoverFromError calls recordInjury.
    return false;
  }

  logger.warn('v2: recoverable provider error — injecting system note instead of injuring', {
    agentId,
    kind: recovery.kind,
    count: newCount,
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

  const systemNote =
    `[System: Your last action failed because the model could not handle the request as sent. ` +
    `Reason: ${recovery.userFacingReason}. ${recovery.guidance} ` +
    `Do not retry the exact same action; adapt your approach and continue.]`;
  persistAndBroadcastSystemNote(agentId, systemNote);

  // Don't mark error/injury. Queue a wakeup so the agent retries with
  // the system note in context.
  pendingWakeups.add(agentId);
  return true;
}

// ── Step 3: injury ──

async function recordInjury(
  agentId: string,
  message: string,
  cause: string | undefined,
  code: string | undefined,
): Promise<void> {
  logger.error(`v2 agent loop failed: ${message}`, { agentId, code, cause }, agentId);

  // Loop detection (5 errors in 2min → pause). Returns true if the
  // threshold tripped; we leave status alone in that case (errors.ts
  // sets it to 'paused' for us).
  const paused = recordError(agentId);
  if (!paused) {
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

  // Schedule healer notification after grace period. If the agent
  // recovers within 5 minutes the timer is cancelled automatically.
  try {
    const { onAgentInjured } = await import('../../healer/injury-recovery.js');
    onAgentInjured(agentId, message);
  } catch {
    /* module may not be available */
  }

  // Broadcast structured chat:error to dashboard. User-facing text is plain
  // language; the raw provider message goes to logs only (already at line ~250).
  const lower = message.toLowerCase();
  const isRateLimit =
    lower.includes('429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('overloaded');
  const userMsg = isRateLimit
    ? 'Model is rate-limited. Retrying automatically — give it a moment.'
    : paused
      ? 'Agent paused after repeated errors. Open the Health page to investigate, or resume from its detail page.'
      : 'Agent hit an error and stopped. Send a new message to retry, or check the Health page if it keeps failing.';
  broadcast({
    type: 'chat:error',
    agentId,
    error: userMsg,
    code: isRateLimit ? 'RATE_LIMITED' : paused ? 'ERROR_LOOP' : 'MODEL_FAILED',
    severity: isRateLimit ? 'warning' : 'error',
    retryable: isRateLimit,
  });

  // For rate limit errors, also persist a visible system message so the
  // user can see what's happening (the error banner can be missed).
  if (isRateLimit) {
    const msgId = uuidv4();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    try {
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, ?)`,
        )
        .run(
          msgId,
          agentId,
          '[Rate limited] The model provider returned a rate limit error. Retrying shortly...',
          now,
        );
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: msgId,
          agentId,
          role: 'system',
          content: '[Rate limited] The model provider returned a rate limit error. Retrying shortly...',
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: now,
        },
      });
    } catch {
      /* best effort */
    }
  }
}

// ── Helpers ──

function persistAndBroadcastSystemNote(agentId: string, content: string): void {
  try {
    const noteId = uuidv4();
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`,
      )
      .run(noteId, agentId, content);
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
