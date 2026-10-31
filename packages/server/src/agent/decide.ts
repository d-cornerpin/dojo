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
import { fenceExternal } from '../tools/external-content.js';
import { decisionCharsPerToken, recordDensitySample, tokensAt } from '../services/token-density.js';
import { inTurn } from './decide-queue.js';

const logger = createLogger('decide');

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
/** `patienceMs` (t274 fix round 1) is REQUIRED of every caller: how long it will wait, counted from when it asks —
 *  queued time included; the decision's own timeout still counts from send. Out of patience while queued, the call
 *  leaves the queue unsent; in flight, it is cut; either way the caller's rule answers. `onFailure`: why a call gave
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
/** MEASURED (B5, `overhaul-plans/v35-writer-measure.md` → "The num_ctx question"): any body over 64 KiB is
 *  refused with HTTP 413 "text and schema must not exceed 64 KiB". A request over it is not dialled. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;
/**
 * THE TIMEOUT, MEASURED (t268 ruling 4; B5, `overhaul-plans/v35-writer-measure.md` → "decide() latency"): on a
 * box whose GPU the writer shares, a warm call took 62 + 1.33·T + 94·(Q − 1) ms (T = the state's tokens, Q =
 * the questions: reading the state is most of it, each extra question ~94 ms), observed ÷ fitted was 2.05 at
 * p99, and loading a model that is not resident added about 1.3 s. So a call is given that long for its own
 * size — never one fixed figure (the provisional 1,500 ms cut 22 of 24 cold calls). A caller may pass its own.
 */
export function decideTimeoutMs(stateTokens: number, questions: number, resident: boolean): number {
  return Math.ceil((62 + 1.33 * stateTokens + 94 * (questions - 1)) * 2.05) + (resident ? 0 : 1_300);
}

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
    logger.warn('decide() returned no answer; the rule decides', { failure: cls, purpose: opts.purpose, detail });
  }
  try { opts.onFailure?.(cls); } catch { /* a caller's note never breaks the seam */ }
  return null;
}

/**
 * v3.5 K33: the state is the MATERIAL the questions are about — a reply, a summary, a job's source rows
 * with a contact's message or a page in them — never instructions. So every text in it goes to the model
 * inside its own fence (the one fence, `fenceExternal`; a forged end in it is defanged), named by its key.
 * Numbers, flags and the shape pass as they are. Exported so a caller sizing a request can count the fences.
 */
export function fencedState(v: unknown, key = 'state'): unknown {
  if (typeof v === 'string') return fenceExternal('document', `the ${key} this question is about`, v);
  if (Array.isArray(v)) return v.map((x) => fencedState(x, key));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fencedState(x, k)]));
  return v;
}

/** The request body exactly as `decide()` sends it (a caller sizing parts measures its bytes with this). */
export const decideRequestBody = (model: string, state: unknown, questions: Record<string, Question>): string =>
  JSON.stringify({ model, state: fencedState(state), questions, keep_alive: -1 });

/** The measured time `decide()` would give this call if it were sent now — the patience a caller states when it will
 *  wait no longer than the call itself is allowed (t274 fix round 1). 0 with no decision model: nothing is dialled. */
export function measuredDecideTimeoutMs(state: unknown, questionCount: number): number {
  const provider = getDecisionProvider();
  if (!provider) return 0;
  const stateChars = JSON.stringify(fencedState(state)).length;
  return decideTimeoutMs(tokensAt(stateChars, decisionCharsPerToken()), questionCount, resident.has(provider.model));
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
  if (Buffer.byteLength(request) > MAX_DECISION_BODY_BYTES) return fail('too_large', opts, `${Buffer.byteLength(request)} bytes`);
  // N-A (fix round 4): a background call waits for the agents to go idle BEFORE it joins the queue, so a call
  // somebody waits on is never held behind a check that is itself waiting.
  if (opts.background) await whenAgentWorkEnds(provider.providerId);
  // Patience counts from when a waited caller ASKS; a background ask's from when its turn comes (see `BackgroundAsk`).
  const patience = opts.background ? null : AbortSignal.timeout(opts.patienceMs);
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
      return sent(provider, request, stateChars, names, questions, opts, cuts);
    }, { background: opts.background === true, stale: opts.background ? opts.staleWhen : undefined });
    if (turn.left) return fail(cutBy(null, cuts) ?? (opts.background && opts.staleWhen?.() ? 'superseded' : 'patience'), opts, 'left the queue unsent');
    return turn.value;
  } finally {
    slot?.release();
  }
}

async function sent(
  provider: NonNullable<ReturnType<typeof getDecisionProvider>>, request: string, stateChars: number, names: string[],
  questions: Record<string, Question>, opts: DecideOpts, cuts: Cuts,
): Promise<Record<string, Answer> | null> {
  // NB-1: while the Ollama app restarts to apply the model limit, the rule answers (no wait on a restart);
  // otherwise this call is in-flight work the restart waits for.
  if (localHeld()) return null;
  const endLocalWork = await localWorkBegins();
  try {
    let timeoutMs = opts.timeoutMs;
    if (timeoutMs === undefined) {
      timeoutMs = decideTimeoutMs(tokensAt(stateChars, decisionCharsPerToken()), names.length, resident.has(provider.model));
    }
    resident.delete(provider.model);   // until this call is answered
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
      return fail(cutBy(clock, cuts) ?? 'transport', opts, err instanceof Error ? err.message : String(err));
    }
    if (!resp.ok) return fail('http', opts, `${resp.status}`);
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
    // I-3: usage is summed over the questions (B5), so one question's count against the state teaches the decision model its density.
    if (isNum(inputTokens)) recordDensitySample(provider.modelId, stateChars, inputTokens / names.length);
    return answers;
  } finally {
    endLocalWork();
  }
}

/** What may cut a call besides its own clock: the agent's Stop (its slot) and the caller's patience. */
interface Cuts { stop: AbortSignal | null; patience: AbortSignal | null }
/** Which one cut it, if any: the call's own timeout, the owner's Stop, or the caller's patience. */
function cutBy(clock: AbortSignal | null, cuts: Cuts): FailureClass | null {
  if (clock?.aborted) return 'timeout';
  if (cuts.stop?.aborted) return 'stopped';
  return cuts.patience?.aborted ? 'patience' : null;
}
