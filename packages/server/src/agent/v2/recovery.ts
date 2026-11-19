// One entry point (recoverFromError) for every error path: recovery runs in code and only
// surrenders to the healer-handoff contract once every path fails. All side effects live here.

import { v4 as uuidv4 } from 'uuid';
import { OWNER_ALERT_DOJO_PREFIX, stripInboundChannelMarker } from '@dojo/shared';
import { tellAgentWhatDojoSent } from '../dojo-voice.js';
import { createLogger } from '../../logger.js';
import { markTurnDied } from './turn-record.js';
import { broadcast } from '../../gateway/ws.js';
import { getDb } from '../../db/connection.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { recordError, AgentError, pausedWords } from '../errors.js';
import { turnContext } from '../turn-context.js';
import { classifyRecoverableProviderError, classifyPlatformError, isEngineAssemblyFault } from './classifiers/provider.js';
import { classifyProviderError, classifyProviderErrorText, type ProviderErrorFacts } from '../provider-error.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../stream-patience.js';
import { compactionBrakeMsLeft } from '../../memory/compaction-brakes.js';
import { parkAfterForcedPass, parkUntilCompactionLands } from './full-context-wait.js';
import {
  queueSelfWake,
  recoveryRunStreak,
  MAX_INLOOP_RECOVERIES_SAME_INPUTS,
  doomedPrefillCompactionSpent,
  declaredPatienceHonestFailTurn,
} from '../shared-state.js';
import { setAgentStatus, writeAgentLastError } from '../agent-status.js';
import { tryHonestStopRecovery } from './honest-stop.js';
import type { AgentTurnState } from './state.js';
import { currentAddress, userWords } from './turn-address.js';
import {
  formatErrorForHuman,
  formatTierBNoteForAgent,
  type ErrorKind,
} from './error-format.js';

const logger = createLogger('v2-recovery');

// A bare system row is hidden in default chat; OWNER_ALERT_DOJO_PREFIX makes it visible with no later
// turn to relay it. Callers post it only on turns a person is waiting on.
export function declaredPatienceStatusLine(): string {
  return `${OWNER_ALERT_DOJO_PREFIX} the agent hit its model's size limit, so it is trimming its context and retrying now.`;
}

// The ask named briefly, the cause shape-agnostic, no jargon or error codes; didCompact keeps the
// trim clause honest. Strip the trigger's inbound marker first or the engine-only tag leaks.
export function declaredPatienceHonestFailNote(triggerContent: string | null, didCompact: boolean): string {
  const stripped = stripInboundChannelMarker(triggerContent ?? '');
  const trimmed = stripped.replace(/\s+/g, ' ').trim();
  const preview = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
  const askClause = preview ? ` "${preview}"` : '';
  const trimClause = didCompact
    ? 'even after it was trimmed once and tried again'
    : "and it couldn't be trimmed down enough to try again";
  return (
    `${OWNER_ALERT_DOJO_PREFIX} the agent couldn't finish answering${askClause}: its model couldn't process ` +
    `this much context in time, ${trimClause}. The Healer is looking into it.`
  );
}

/** A turn with a person on the other end: the same predicate steps/teardown/finalize-record.ts uses,
 *  computed once at the caller and passed as a boolean to keep this file decoupled. */
export interface RecoveryTurnFacing {
  readonly isUserFacingTurn: boolean;
}

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

/** Cascade entry point: the first path that handles it wins, else an injury is recorded for the Healer. */
export async function recoverFromError(
  state: AgentTurnState,
  error: unknown,
  turnFacing: RecoveryTurnFacing,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof AgentError && error.cause instanceof Error
      ? error.cause.message
      : undefined;
  const code = error instanceof AgentError ? error.code : undefined;
  const fullErrText = cause ? `${message} ${cause}` : message;
  const agentId = state.agentId;
  // What the provider said, read ONCE for every step: the model layer attaches it at raise time.
  const facts = error instanceof AgentError && error.provider ? error.provider : classifyProviderError(error);

  // 0. A rate limit or overload waits on its request's row until the provider's reset; nothing else handles it.
  const rlKind = classifyError(new Error(fullErrText), facts).kind;
  if (rlKind === 'rate_limit' || rlKind === 'overloaded') {
    const turnCtx = turnContext(agentId);
    if (turnCtx) turnCtx.retryAt = Date.now() + Math.max(60, facts.retryAfterSeconds ?? 60) * 1000;
    logger.info('v2: rate limit or overload: the request waits for the reset', { agentId, kind: rlKind, retryAt: turnCtx?.retryAt }, agentId);
    return;
  }

  // 0.5. Declared-patience exhaustion, structural on `error.code` alone, BEFORE step 1; both
  //      shapes share one capped compact-and-retry; declared outside so the fall-through is defined.
  let declaredPatienceDidCompact = false;
  if (error instanceof AgentError && error.code === DECLARED_PATIENCE_EXCEEDED_CODE) {
    const compactAttempt = await tryDeclaredPatienceCompactOnceRecovery(state);
    declaredPatienceDidCompact = compactAttempt.didCompact;
    if (compactAttempt.recovered) {
      // Fires once per doomed chain, so this status line is deduped for free; the answer follows.
      if (turnFacing.isUserFacingTurn) {
        persistAndBroadcastSystemNote(agentId, declaredPatienceStatusLine());
        tellAgentWhatDojoSent({ agentId, recipient: 'the person who asked (on the dashboard)', text: declaredPatienceStatusLine(), why: 'because your model hit its size limit' });
      }
      return;
    }
    // The one attempt is spent: no step below knows this code, so it falls through to the honest fail.
  }

  // 0.9. The boundary's own over-budget refusal condenses and re-assembles once, or stops on a card.
  if (await (await import('./over-budget-assembly.js')).tryOverBudgetAssemblyRecovery(state, error)) return;
  if (await tryContextOverflowRecovery(state, fullErrText, message, code, cause)) {
    return;
  }

  if (await tryOutputTruncationRecovery(agentId, fullErrText)) {
    return;
  }

  // 3. Platform errors (Tier D): the user must act: human-language note, status='error', banner + iMessage.
  if (await tryHonestStopRecovery(state, error) || await tryPlatformErrorRecovery(state, fullErrText, message, facts)) {
    return;
  }

  // 4. Provider 4xx the agent can adapt to: note + wakeup, status STAYS idle (Tier B); cap: kind + inputs.
  if (!isEngineAssemblyFault(error) && await tryProviderRecovery(state, fullErrText, message, facts)) { // An engine fault is no provider 4xx
    return;
  }

  // 5. Unclassified: persist the plain note FIRST (context for the next turn), then record the wound.
  await recordInjury(state, message, cause, code, turnFacing, facts, declaredPatienceDidCompact);
}

/** Fingerprint of the agent's "inputs": stable across identical retries, changes when the
 *  trigger or last response differs. Cheap, no DB query. */
export function computeInputsFingerprint(state: AgentTurnState): string {
  const trigger = state.lastUserMessageContent?.slice(0, 200) ?? '';
  const r = state.lastResponse;
  const lastResp = r ? `${r.content ?? ''}|${r.toolCalls.map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`).sort().join(',')}` : '';
  let h = 0;
  const seed = `${trigger}|${lastResp}`;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  // The turn number is NOT an input: with it the streak could only match within one turn.
  return `h${h.toString(36)}`;
}

/** Classify an error to a recovery kind, for callers reporting the KIND without running recovery. */
export function classifyError(error: Error, facts?: ProviderErrorFacts): ClassifiedError {
  const msg = error.message.toLowerCase();
  // The two message shapes that carry a big number read FIRST, then the provider's verdict:
  // "usage limit" is the SDK's own rate-limit phrasing and must ride the passthrough.
  if (/context.*overflow|prompt.*too.?long/.test(msg)) return { kind: 'context_overflow' };
  if (/output.*token.*(limit|exceed|max)|max_output_tokens|truncat/.test(msg))
    return { kind: 'output_truncated' };
  if (msg.includes('usage limit')) return { kind: 'rate_limit' };
  const cls = (facts ?? classifyProviderErrorText(msg)).class;
  if (cls === 'rate_limit') return { kind: 'rate_limit' };   // Not `quota`: out of credit is the owner's to fix, not a wait
  if (cls === 'overloaded') return { kind: 'overloaded' };
  if (cls === 'network' || msg.includes('socket')) return { kind: 'network' };
  return { kind: 'unknown' };
}

// Both run it through the one door the context gate's surrenders use (`parkAfterForcedPass`): the wake is
// queued when the pass reclaimed, or set for the compaction brake's expiry when the brake binds.
// `brakedBefore` is read before the pass is asked, as the gate reads it; `afterPass` runs only after the
// pass returned without throwing, before the park.
async function forcedPassThenPark(state: AgentTurnState, reason: string, afterPass?: () => void): Promise<void> {
  const { agentId } = state;
  const { checkAndCompact } = await import('../../memory/compaction.js');
  const { agentTurnWindow } = await import('../../router/router-window.js');
  const contextWindow = state.lockedModelId ? agentTurnWindow(agentId, state.lockedModelId) : state.contextWindow;
  const brakedBefore = compactionBrakeMsLeft(agentId) !== null;
  const ran = await checkAndCompact(agentId, state.configuredModelId, contextWindow, { force: true, inTurn: true, dialedModelId: state.lockedModelId ?? state.configuredModelId });
  if (ran.lockBusy) { parkUntilCompactionLands(agentId, reason); return; }   // Never wait on its lock
  afterPass?.();
  parkAfterForcedPass(agentId, reason, brakedBefore);
}

async function tryContextOverflowRecovery(
  state: AgentTurnState,
  fullErrText: string,
  message: string,
  code: string | undefined,
  cause: string | undefined,
): Promise<boolean> {
  const agentId = state.agentId;
  try {
    const { isContextOverflowError, recoverDreamerFromContextOverflow } = await import(
      '../../vault/maintenance.js'
    );
    if (!isContextOverflowError(fullErrText)) return false;

    // BOUNDED (200) like every log message here: a provider's overflow text can echo the whole
    // prompt and push the `code`/`cause` that classify the death past the reader's truncation.
    logger.warn(`v2: context overflow detected — ${message.slice(0, 200)}`, { agentId, code, cause }, agentId);

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

    // Non-Dreamer agents: force a compaction, then park with the wake the pass left behind.
    await forcedPassThenPark(state, 'recovery-forced-compaction');
    logger.warn('v2: forced compaction after context overflow on non-Dreamer agent', { agentId }, agentId);
    return true;
  } catch (recovErr) {
    logger.warn('v2: context overflow recovery attempt failed', {
      agentId,
      error: recovErr instanceof Error ? recovErr.message : String(recovErr),
    }, agentId);
    return false;
  }
}

// Its own step, not folded into the overflow recovery above: that fires on provider PROSE, this on the
// STRUCTURAL `error.code`; sharing a function would let either edit widen what the other one fires on.
// Capped at ONE attempt per doomed chain, unlike overflow: a repeat after one forced compaction asks the
// same question twice, while a chain that resurfaces after another turn ran earns its own try.
/** Two facts: `recovered` = compacted and queued a retry (caller returns early); `didCompact` = a
 *  compaction completed for this doomed chain, now or the turn before. `recovered` implies it. */
interface DeclaredPatienceCompactAttempt {
  recovered: boolean;
  didCompact: boolean;
}

async function tryDeclaredPatienceCompactOnceRecovery(
  state: AgentTurnState,
): Promise<DeclaredPatienceCompactAttempt> {
  const agentId = state.agentId;
  const turnNumber = state.turnNumber;
  const spentAtTurn = doomedPrefillCompactionSpent.get(agentId);
  if (spentAtTurn === turnNumber - 1) {
    // The attempt ran last turn, its retry still failed: clear the marker so a later chain gets its own try.
    doomedPrefillCompactionSpent.delete(agentId);
    return { recovered: false, didCompact: true };
  }

  try {
    await forcedPassThenPark(state, 'recovery-doomed-prefill-compaction', () => doomedPrefillCompactionSpent.set(agentId, turnNumber));
    logger.warn('v2: forced compaction after a declared-patience exhaustion (T81b/T82b)', { agentId, turnNumber }, agentId);
    return { recovered: true, didCompact: true };
  } catch (recovErr) {
    logger.warn('v2: declared-patience compact-once recovery attempt failed', {
      agentId,
      error: recovErr instanceof Error ? recovErr.message : String(recovErr),
    }, agentId);
    return { recovered: false, didCompact: false };
  }
}

async function tryOutputTruncationRecovery(
  agentId: string,
  fullErrText: string,
): Promise<boolean> {
  const lower = fullErrText.toLowerCase();
  // Match the providers' raise-time phrasings; conservative: only obvious output-budget-exceeded ones.
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
    `If a tool result is too large to summarize in one turn, call complete_task or update the person you are talking to with what you've done so far and continue next turn.]`;
  persistAndBroadcastSystemNote(agentId, note);
  queueSelfWake(agentId, 'recovery-output-cap-note');
  return true;
}

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

  // A retry is wasteful only when the same kind fires with the same inputs fingerprint.
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
    // Same error, same inputs, repeatedly: stop looping and hand the agent to the Healer, still IDLE.
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
      `If ${userWords(currentAddress(agentId))} is waiting, apologize and tell them you ran into a problem you cannot work around right now.]`;
    persistAndBroadcastSystemNote(agentId, giveUpNote);
    // Fall through: recordInjury persists the Tier B note and keeps the agent recoverable, not 'error'.
    return false;
  }

  logger.warn('v2: recoverable provider error — injecting Tier B system note', {
    agentId,
    kind: recovery.kind,
    count: newCount,
    fingerprint,
    message: message.slice(0, 200),
  }, agentId);

  // Vision mismatch: also correct the model's capability cache so later turns strip images. Self-healing.
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
      /* best effort; recovery still proceeds */
    }
  }

  // The agent note comes from the spec table via formatTierBNoteForAgent, one source of wording.
  const recoveryKindAsErrorKind = recovery.kind as ErrorKind;
  const tierBBody = formatTierBNoteForAgent(recoveryKindAsErrorKind, recovery.context ?? {});
  const systemNote = `[System: ${tierBBody}]`;
  persistAndBroadcastSystemNote(agentId, systemNote);

  // Tier B: NO status change; queue a wakeup so the agent retries with the note in context.
  queueSelfWake(agentId, 'recovery-tier-b-retry');
  return true;
}

/** Tier D: true platform conditions (auth, access, quota, DNS): the agent CAN'T proceed, the user
 *  must act. Returns true when handled, so the caller must NOT fall through to recordInjury. */
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

  // Persist a chat-history system note: the agent won't run again until the platform issue is
  // fixed, but when it does, this note heads its next session context.
  const humanText = formatErrorForHuman(platform.kind as ErrorKind, { agentName, providerName });
  const systemNote = `[System (platform error): ${humanText}]`;
  persistAndBroadcastSystemNote(agentId, systemNote);

  // status='error' AND the sanitized last_error in ONE statement: two could leave an `error`
  // row with a NULL last_error, invisible to the rehydrate sweep that rescues it on restart.
  setAgentStatus(agentId, 'error', { lastError: `[${platform.kind}] ${message.slice(0, 400)}` });

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
    cardClass: 'action',   // a platform lock: the engine cannot proceed until he fixes the account, the quota or the network
    retryable: false,
  });

  try {
    const { onAgentInjured } = await import('../../healer/injury-recovery.js');
    onAgentInjured(agentId, `[${platform.kind}] ${humanText}`);
  } catch { /* */ }

  return true;
}

async function recordInjury(
  state: AgentTurnState,
  message: string,
  cause: string | undefined,
  code: string | undefined,
  turnFacing: RecoveryTurnFacing,
  facts?: ProviderErrorFacts,
  /** True iff a compaction genuinely completed for this doomed chain; only read under
   *  `DECLARED_PATIENCE_EXCEEDED_CODE`. Default `false`: never consulted for other classes. */
  declaredPatienceDidCompact = false,
): Promise<void> {
  const agentId = state.agentId;
  // BOUNDED, same reason and 200 as the sibling above: the first line a reader sees when a turn died.
  logger.error(`v2 agent loop failed: ${message.slice(0, 200)}`, { agentId, code, cause }, agentId);
  // A dead turn gets an honest terminal state; this closes the row before `finalizeTurn` can, so
  // the cause the engine OBSERVED lands; `classifyThrownCut` answers null, recording `unknown`.
  try { markTurnDied(agentId, state.turnNumber, state.engineCutExit ?? 'unknown'); } catch { /* best effort */ }

  // THE ONLY PLACE THIS MARKER IS SET: reaching recordInjury with the patience code means every
  // earlier step declined, so THIS is the honest-fail turn; keyed by turn for the wake gate.
  if (code === DECLARED_PATIENCE_EXCEEDED_CODE) {
    declaredPatienceHonestFailTurn.set(agentId, state.turnNumber);
  }

  // ALWAYS persist a chat-history system note FIRST so the agent has context on its next turn;
  // plain language, never raw provider JSON. The provider's own verdict, not this message's digits.
  // A rate limit or overload never reaches here (step 0); out of credit is the owner's to fix.
  const outOfCredit = (facts ?? classifyProviderErrorText(message)).class === 'quota';

  // The patience honest fail has no later turn coming on its own, so on a human-facing turn
  // the generic apology note is REPLACED by one honest in-channel line naming the ask and cause.
  const isDeclaredPatienceHonestFail = code === DECLARED_PATIENCE_EXCEEDED_CODE;
  if (isDeclaredPatienceHonestFail && turnFacing.isUserFacingTurn) {
    // A job turn has no fresh trigger: the line names the request its job started from.
    const asked = state.lastUserMessageContent ?? (getDb().prepare('SELECT content FROM messages WHERE id = ?')
      .get(turnContext(agentId)?.root?.sourceMessageId ?? '') as { content: string } | undefined)?.content ?? null;
    const honestFail = declaredPatienceHonestFailNote(asked, declaredPatienceDidCompact);
    persistAndBroadcastSystemNote(agentId, honestFail);
    tellAgentWhatDojoSent({ agentId, recipient: 'the person who asked (on the dashboard)', text: honestFail, why: 'because your model could not finish this answer' });
  } else {
    persistAndBroadcastSystemNote(
      agentId,
      `[System: Your last turn hit an unexpected error that the platform could not classify or auto-recover. ` +
      `Apologize to ${userWords(currentAddress(agentId))}, end your turn cleanly, and the Healer will look into it.]`,
    );
  }

  // Loop detection (5 errors in 2min -> pause) stays as the SAFETY NET for genuine error
  // loops; Tier B errors no longer reach here, so it should rarely trip now.
  // Persisted for the healer, and computed BEFORE the pause decision so the status write carries it.
  const errDetail = (cause ? `${message} (${cause})` : message).slice(0, 500);

  const paused = recordError(agentId);
  if (!paused) {
    // status='error' stays here for unclassified/rate-limit paths; one statement for status
    // AND the diagnostic, so this arm cannot leave an `error` row with a NULL `last_error`.
    setAgentStatus(agentId, 'error', { lastError: errDetail });
  } else {
    // The PAUSED arm keeps two writes deliberately: `recordError` already moved the status
    // inside `agent/errors.ts`; the window they leave is what the rehydrate sweep catches.
    try { writeAgentLastError(agentId, errDetail); } catch { /* best effort */ }
  }

  // `code` rides along with `message` to the healer: the live path gets the code; only the
  // restart path holding `agents.last_error` carries the identical phrase instead.
  try {
    const { onAgentInjured } = await import('../../healer/injury-recovery.js');
    onAgentInjured(agentId, message, code);
  } catch {
    /* module may not be available */
  }

  // Broadcast the plain-English chat:error toast; the system note above is the durable
  // record and this toast the ephemeral signal.
  const userMsg = outOfCredit
    ? 'The AI provider says this account is out of credit. Add credit with the provider, then send the message again.'
    : paused
      ? pausedWords(agentId) // the owner card's words: on this chat the two fold into one
      : 'Agent hit an error and the Healer is looking into it. Send a new message to retry, or check the Vitals page if it keeps failing.';
  broadcast({
    type: 'chat:error',
    agentId,
    error: userMsg,
    code: outOfCredit ? 'QUOTA_EXHAUSTED' : paused ? 'ERROR_LOOP' : 'MODEL_FAILED',
    // "the Healer is looking into it" asks nothing of the user: only a paused agent is his.
    severity: paused ? 'error' : 'warning',
    cardClass: paused ? 'action' : 'informational',
    retryable: false,
  });
}

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
