// decide(): the one door to the local decision model. It returns typed answers, or null on any failure (no
// model, Ollama down, the timeout, the agent's Stop, a non-2xx, an answer that does not parse), and then the
// caller's rule answers. The call is its own request, so the agent's prompt is untouched; the model stays
// resident (`keep_alive: -1`) at the window the memory fit sets aside for it.

import { createLogger } from '../logger.js';
import { recordCost } from '../costs/tracker.js';
import { openAgentCall } from './abortable-call.js';
import { getDecisionProvider, type DecisionProvider } from './decision-provider.js';
import { localHeld, localWorkBegins } from '../services/ollama-quiet.js';
import { MEASURED_CHARS_PER_TOKEN, tokensAt } from '../services/token-density.js';
import { decideCountedBytes, decideRequestBody, decideTimeoutMs, fencedState } from './decide-sizing.js';

const logger = createLogger('decide');

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
/** `agentId`: the agent waiting on the answer, whose Stop cuts the call. `timeoutMs`: a caller's own clock, else the measured one. */
export interface DecideOpts { purpose: string; agentId?: string; timeoutMs?: number; onFailure?: (failure: FailureClass) => void }

/** Ollama's documented limit for one `/v1/systemone` request. */
const MAX_QUESTIONS_PER_REQUEST = 64;
/** Measured: a request whose state and questions exceed 64 KiB is refused with HTTP 413, so it is not dialled. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;

/** Models this process saw answer: resident until any call of theirs fails, after which the next call gets the load time. */
const resident = new Set<string>();
/** Test-only: forget which models this process saw answer. */
export function __forgetResidencyForTests(): void { resident.clear(); }
/** Failures are logged once per class per minute: a down Ollama on a busy box is one line, not one per turn. */
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

export type FailureClass = 'too_many_questions' | 'too_large' | 'http' | 'timeout' | 'transport' | 'parse' | 'stopped';
function fail(cls: FailureClass, opts: DecideOpts, detail?: string): null {
  const now = Date.now();
  if (now - (lastLogged.get(cls) ?? 0) >= LOG_EVERY_MS) {
    lastLogged.set(cls, now);
    logger.warn(cls === 'too_large' ? 'decide() refused a request as too large; the caller splits it if it can, else the rule decides' : 'decide() returned no answer; the rule decides', { failure: cls, purpose: opts.purpose, detail });
  }
  try { opts.onFailure?.(cls); } catch { /* a caller's note never breaks the seam */ }
  return null;
}

/** One call in flight at a time: the local Ollama answers one request at a time, so a call's clock starts when it is
 *  sent, never while it waits. A Stop while waiting leaves at once and the call is never sent. */
let tail: Promise<unknown> = Promise.resolve();
function inTurn<T>(stop: AbortSignal | null, work: () => Promise<T | null>): Promise<T | null> {
  const run = tail.then(() => (stop?.aborted ? null : work()));
  tail = run.catch(() => undefined);
  if (!stop) return run;
  return Promise.race([run, new Promise<null>((r) => (stop.aborted ? r(null) : stop.addEventListener('abort', () => r(null), { once: true })))]);
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
  const counted = decideCountedBytes(state, questions);
  if (counted > MAX_DECISION_BODY_BYTES) return fail('too_large', opts, `${counted} bytes as Ollama counts them`);
  // The waiting agent's stop slot opens when the call joins the line, so a Stop cuts it waiting or in flight.
  const slot = opts.agentId === undefined ? null : openAgentCall(opts.agentId, 'turn');
  try {
    let wasSent = false;
    const got = await inTurn(slot?.signal ?? null, () => { wasSent = true; return sent(provider, state, questions, opts, slot?.signal ?? null); });
    return got === null && !wasSent ? fail('stopped', opts, 'left the line unsent') : got;
  } finally {
    slot?.release();
  }
}

async function sent(
  provider: DecisionProvider, state: unknown, questions: Record<string, Question>, opts: DecideOpts, stop: AbortSignal | null,
): Promise<Record<string, Answer> | null> {
  // While the Ollama app restarts to apply the model limit the rule answers; otherwise the restart waits for this call.
  if (localHeld()) return null;
  const endLocalWork = await localWorkBegins();
  try {
    const names = Object.keys(questions);
    const stateTokens = tokensAt(JSON.stringify(fencedState(state)).length, MEASURED_CHARS_PER_TOKEN);
    const clock = AbortSignal.timeout(opts.timeoutMs ?? decideTimeoutMs(stateTokens, names.length, resident.has(provider.model)));
    const cut = (): FailureClass | null => (clock.aborted ? 'timeout' : stop?.aborted ? 'stopped' : null);
    resident.delete(provider.model);   // until this call is answered
    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${provider.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: decideRequestBody(provider.model, state, questions),
        signal: stop ? AbortSignal.any([clock, stop]) : clock,
      });
    } catch (err) {
      return fail(cut() ?? 'transport', opts, err instanceof Error ? err.message : String(err));
    }
    if (!resp.ok) return resp.status === 413 ? fail('too_large', opts, 'refused by the model, HTTP 413') : fail('http', opts, `${resp.status}`);
    let body: { answers?: Record<string, unknown>; usage?: { input_tokens?: number; prompt_tokens?: number } };
    try { body = await resp.json() as typeof body; } catch (err) {
      return fail(cut() ?? 'parse', opts, err instanceof Error ? err.message : String(err));
    }
    const answers: Record<string, Answer> = {};
    for (const name of names) {
      const a = typed(questions[name], body.answers?.[name]);
      if (!a) return fail('parse', opts, `no usable answer for ${name}`);
      answers[name] = a;
    }
    const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0;
    recordCost({
      agentId: opts.agentId ?? 'system', modelId: provider.modelId, providerId: provider.providerId,
      inputTokens: isNum(inputTokens) ? inputTokens : 0, outputTokens: 0, latencyMs: Date.now() - started,
      requestType: 'decision', callPurpose: opts.purpose,
    });
    resident.add(provider.model);
    return answers;
  } finally {
    endLocalWork();
  }
}
