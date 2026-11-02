// ════════════════════════════════════════════════════════════════════════════
// v3.5 B1 — decide(): THE ONE SEAM FOR EVERY PROSE JUDGMENT, RULES AS THE FALLBACK.
//
// Every question the engine asks the decision model goes through here; no caller builds a
// `/v1/systemone` request itself. It returns typed answers, or `null` on ANY failure (no model,
// Ollama down, a timeout, a non-2xx, an answer that does not parse) — and in that case the caller's
// rule runs exactly as before. Safety gates (the spec's Group C) are never callers.
//
// The call is a separate request: the agent's own prompt is untouched (the cache tenet). The model is
// resident (`keep_alive: -1`; it takes no Ollama lock slot, `services/ollama-lock.ts`), at the window the memory fit
// sets aside for it — the derived tag's (`services/decision-window.ts`; `/v1/systemone` ignores `num_ctx`, B5).
// An agent that waits on a decision is the one whose stop cuts it (`openAgentCall`).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { recordCost } from '../costs/tracker.js';
import { openAgentCall } from './abortable-call.js';
import { getDecisionProvider } from './decision-provider.js';
import { localHeld, localWorkBegins, whenAgentWorkEnds } from '../services/ollama-quiet.js';
import { decisionCharsPerToken, recordDensitySample, tokensAt } from '../services/token-density.js';
import { aheadOfAWaiterMs, inTurn } from './decide-queue.js';
import { decideCountedBytes, decideFitMs, decideRequestBody, decideTimeoutMs, fencedState, MODEL_LOAD_MS } from './decide-sizing.js';
import { decidePace, recordDecidePace } from './decide-pace.js';
import { runnerIsWorking } from '../services/ollama-runner-progress.js';

const logger = createLogger('decide');

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
/** `patienceMs` (t274 fix round 1) is REQUIRED of every caller: how long it gives its OWN call. A waited caller's
 *  patience counts from when it asks, and (proof-fix N) decide() adds what it must wait behind — the measured
 *  allowance left to the call in flight and of the waited callers ahead (`aheadOfAWaiterMs`) — so it is still bounded
 *  but no longer spent behind a long check; the decision's own timeout still counts from send. Out of patience while
 *  queued, the call leaves the queue unsent; in flight, it is cut; either way the caller's rule answers. `onFailure`: why a call gave
 *  no answer, told to the caller each time (the log line below is once per class per minute). */
interface DecideCommon { purpose: string; timeoutMs?: number; turnId?: string; patienceMs: number; onFailure?: (failure: FailureClass) => void }
/** Someone waits on the answer: it holds that agent's stop slot from the moment it queues (a Stop cuts it). */
interface WaitedAsk extends DecideCommon { background?: false; agentId?: string }
/** Nobody waits (a shadow check, t268 fix round 2): it first waits for the agents' own local turns to end, then for
 *  the calls ahead of it, and its patience counts from when its TURN comes — t268 measured that clocks spent queued
 *  lost most shadow verdicts of a busy fold, and nobody is waiting on it while it queues. It CANNOT name an agent, so
 *  it never opens a turn-scoped slot and never makes an idle agent look live. */
interface BackgroundAsk extends DecideCommon {
  background: true; agentId?: never;
  /** A real signal that nothing needs this answer any more (the agent has a newer reply): asked when the ask's turn
   *  comes, and if true the ask is dropped unsent (failure class `superseded`). Never a timer. */
  staleWhen?: () => boolean;
}
export type DecideOpts = WaitedAsk | BackgroundAsk;

/** Ollama's documented limit for one `/v1/systemone` request. */
const MAX_QUESTIONS_PER_REQUEST = 64;
/** MEASURED (B5, `overhaul-plans/v35-writer-measure.md` → "The num_ctx question"): a request over 64 KiB is
 *  refused with HTTP 413 "text and schema must not exceed 64 KiB". A request over it is not dialled. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;

/**
 * Is the decision model loaded? Fix round 1: no `/api/ps` round trip per call — what this process already knows:
 * a call it answered left the model resident (`keep_alive: -1`), until any call of it fails (a restart, an
 * eviction, a removed tag), after which the next call is given the load time again.
 */
const resident = new Set<string>();
/** Test-only: forget which models this process saw answer. */
export function __forgetResidencyForTests(): void { resident.clear(); }
/** Failures are logged once per class per minute: a down Ollama on a busy box is one line, not one per turn. */
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

/** `patience`: the caller stopped waiting (`patienceMs`); `stopped`: the owner's Stop cut it, queued or in flight. */
export type FailureClass = 'too_many_questions' | 'too_large' | 'http' | 'timeout' | 'transport' | 'parse' | 'patience' | 'stopped' | 'superseded';
function fail(cls: FailureClass, opts: DecideOpts, detail?: string): null {
  const now = Date.now();
  if (now - (lastLogged.get(cls) ?? 0) >= LOG_EVERY_MS) {
    lastLogged.set(cls, now);
    logger.warn(cls === 'too_large' ? 'decide() refused a request as too large; the caller splits it if it can, else the rule decides' : 'decide() returned no answer; the rule decides', { failure: cls, purpose: opts.purpose, detail });
  }
  try { opts.onFailure?.(cls); } catch { /* a caller's note never breaks the seam */ }
  return null;
}

/** The measured time `decide()` would give this call if it were sent now — the patience a caller states when it will
 *  wait no longer than the call itself is allowed (t274 fix round 1). 0 with no decision model: nothing is dialled. */
export function measuredDecideTimeoutMs(state: unknown, questionCount: number): number {
  const provider = getDecisionProvider();
  if (!provider) return 0;
  const stateChars = JSON.stringify(fencedState(state)).length;
  return formulaMs(provider, stateChars, questionCount);
}

/** The formula's time for a call of this size on THIS box: B5's fit at the pace this box's own calls have shown
 *  (`decide-pace.ts`; B5's 2.05 until it has any), plus the load time when the model is not resident. */
function formulaMs(provider: NonNullable<ReturnType<typeof getDecisionProvider>>, stateChars: number, questionCount: number): number {
  return decideTimeoutMs(tokensAt(stateChars, decisionCharsPerToken()), questionCount, resident.has(provider.model), decidePace(provider.modelId));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isProbs = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === 'object' && Object.values(v as Record<string, unknown>).every(isNum);

/** One typed answer from the documented shape, or null when it is not that shape. */
function typed(q: Question, a: unknown): Answer | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as Record<string, unknown>;
  if (q.type === 'noul') return isNum(r.noul) ? { type: 'noul', noul: r.noul } : null;
  if (!isProbs(r.probabilities) || !isNum(r.confidence)) return null;
  if (q.type === 'choice') {
    return typeof r.choice === 'string' ? { type: 'choice', choice: r.choice, probabilities: r.probabilities, confidence: r.confidence } : null;
  }
  return isNum(r.score) ? { type: 'score', score: r.score, probabilities: r.probabilities, confidence: r.confidence } : null;
}

export async function decide(
  state: unknown, questions: Record<string, Question>, opts: DecideOpts,
): Promise<Record<string, Answer> | null> {
  const provider = getDecisionProvider();
  if (!provider) return null;   // no decision model on this box: the rule, silently (not a failure)
  const names = Object.keys(questions);
  if (names.length === 0) return {};
  if (names.length > MAX_QUESTIONS_PER_REQUEST) return fail('too_many_questions', opts, String(names.length));

  const request = decideRequestBody(provider.model, state, questions);
  const stateChars = JSON.stringify(fencedState(state)).length;
  const counted = decideCountedBytes(state, questions);
  if (counted > MAX_DECISION_BODY_BYTES) return fail('too_large', opts, `${counted} bytes as Ollama counts them`);
  // N-A (fix round 4): a background call waits for the agents to go idle BEFORE it joins the queue, so a call
  // somebody waits on is never held behind a check that is itself waiting.
  if (opts.background) await whenAgentWorkEnds(provider.providerId);
  // The time this call is allowed once sent: its caller's own, or the measured formula for its size (residency read at send).
  const clockMs = (): number => opts.timeoutMs ?? formulaMs(provider, stateChars, names.length);
  // Patience counts from when a waited caller ASKS, plus what it must wait behind; a background ask's from when its turn
  // comes (see `BackgroundAsk`).
  const patience = opts.background ? null : AbortSignal.timeout(opts.patienceMs + aheadOfAWaiterMs());
  // t274 fix round 1: the agent's stop slot opens when the call JOINS the queue, so a Stop cuts it queued or in flight.
  // A background ask never opens one, whatever it was handed at run time.
  const slot = opts.background || opts.agentId === undefined ? null : openAgentCall(opts.agentId, 'turn');
  const cuts: Cuts = { stop: slot?.signal ?? null, patience };
  const leave = [cuts.stop, cuts.patience].filter((x): x is AbortSignal => x !== null);
  try {
    // A caller that waits goes ahead of every background ask not yet started; a background ask whose newer-reply signal
    // has fired is dropped when its turn comes (`decide-queue.ts`).
    const turn = await inTurn(leave.length === 0 ? null : AbortSignal.any(leave), () => {
      cuts.patience ??= AbortSignal.timeout(opts.patienceMs);
      return sent(provider, request, stateChars, names, questions, opts, cuts, clockMs);
    }, { background: opts.background === true, stale: opts.background ? opts.staleWhen : undefined, allowedMs: clockMs });
    if (turn.left) return fail(cutBy(null, cuts) ?? (opts.background && staleNow(opts.staleWhen) ? 'superseded' : 'patience'), opts, 'left the queue unsent');
    return turn.value;
  } finally {
    slot?.release();
  }
}

/** A caller's signal; one that throws is not a reason to drop. */
function staleNow(f?: () => boolean): boolean { try { return f?.() === true; } catch { return false; } }

async function sent(
  provider: NonNullable<ReturnType<typeof getDecisionProvider>>, request: string, stateChars: number, names: string[],
  questions: Record<string, Question>, opts: DecideOpts, cuts: Cuts, clockMs: () => number,
): Promise<Record<string, Answer> | null> {
  // NB-1: while the Ollama app restarts to apply the model limit, the rule answers (no wait on a restart);
  // otherwise this call is in-flight work the restart waits for.
  if (localHeld()) return null;
  const endLocalWork = await localWorkBegins();
  let watch: RunnerWatch | null = null;
  try {
    const timeoutMs = clockMs();
    // What this call teaches the pace: its time against B5's fit for its size (the load time is not part of the fit).
    const fitMs = decideFitMs(tokensAt(stateChars, decisionCharsPerToken()), names.length);
    const loadMs = resident.has(provider.model) ? 0 : MODEL_LOAD_MS;
    resident.delete(provider.model);   // until this call is answered
    // A cut teaches slowness only if the runner was WORKING on the call near its end (`watchRunner`); a hung one teaches nothing.
    watch = opts.timeoutMs === undefined ? watchRunner(provider, timeoutMs) : null;
    const clock = AbortSignal.timeout(timeoutMs);
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${provider.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request,
        signal: AbortSignal.any([clock, ...[cuts.stop, cuts.patience].filter((x): x is AbortSignal => x !== null)]),
      });
    } catch (err) {
      const why = cutBy(clock, cuts);
      // Cut by its OWN formula clock while the runner was working on it: no latency, but the true one is at least this
      // long (a censored sample). A cut with no sign of life is only a failed call, as before.
      if (why === 'timeout' && await watch?.working()) recordDecidePace(provider.modelId, timeoutMs - loadMs, fitMs, true);
      return fail(why ?? 'transport', opts, err instanceof Error ? err.message : String(err));
    }
    // 413: the model's own refusal of the size. Whatever Ollama's version counts, that is the signal a caller can act on.
    if (!resp.ok) return resp.status === 413 ? fail('too_large', opts, 'refused by the model, HTTP 413') : fail('http', opts, `${resp.status}`);
    let body: { answers?: Record<string, unknown>; usage?: { input_tokens?: number; prompt_tokens?: number } };
    try { body = await resp.json() as typeof body; } catch (err) {
      return fail(cutBy(clock, cuts) ?? 'parse', opts, err instanceof Error ? err.message : String(err));
    }
    const answers: Record<string, Answer> = {};
    for (const name of names) {
      const a = typed(questions[name], body.answers?.[name]);
      if (!a) return fail('parse', opts, `no usable answer for ${name}`);
      answers[name] = a;
    }
    const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0;
    recordCost({
      agentId: (opts.background ? undefined : opts.agentId) ?? 'system', modelId: provider.modelId, providerId: provider.providerId,
      inputTokens: isNum(inputTokens) ? inputTokens : 0, outputTokens: 0, latencyMs: Date.now() - started,
      requestType: 'decision', callPurpose: opts.purpose,
    });
    resident.add(provider.model);
    recordDecidePace(provider.modelId, Math.max(1, Date.now() - started - loadMs), fitMs, false);
    // I-3: usage is summed over the questions (B5), so one question's count against the state teaches the decision model its density.
    if (isNum(inputTokens)) recordDensitySample(provider.modelId, stateChars, inputTokens / names.length);
    return answers;
  } finally {
    watch?.stop();
    endLocalWork();
  }
}

interface RunnerWatch { working: () => Promise<boolean>; stop: () => void }
/** Looks at the runner shortly before the call's clock runs out (it does not delay the cut: the look has its own bound,
 *  four reads of a call with no state at this box's pace). `working()` is what it saw; no look made is no sign of life. */
function watchRunner(provider: NonNullable<ReturnType<typeof getDecisionProvider>>, timeoutMs: number): RunnerWatch {
  const budgetMs = 4 * decideTimeoutMs(0, 1, true, decidePace(provider.modelId));
  let seen: Promise<boolean> | null = null;
  const timer = setTimeout(() => { seen = runnerIsWorking(provider.baseUrl, provider.model, budgetMs); }, Math.max(timeoutMs - budgetMs, timeoutMs / 2));
  return { working: async () => (seen ? await seen : false), stop: () => clearTimeout(timer) };
}

/** What may cut a call besides its own clock: the agent's Stop (its slot) and the caller's patience. */
interface Cuts { stop: AbortSignal | null; patience: AbortSignal | null }
/** Which one cut it, if any: the call's own timeout, the owner's Stop, or the caller's patience. */
function cutBy(clock: AbortSignal | null, cuts: Cuts): FailureClass | null {
  if (clock?.aborted) return 'timeout';
  if (cuts.stop?.aborted) return 'stopped';
  return cuts.patience?.aborted ? 'patience' : null;
}
