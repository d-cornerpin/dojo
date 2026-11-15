// The one door to the local decision model: typed answers, or null on any failure; then the caller's rule.
// Its own request, so the agent's prompt is untouched; the model stays resident at its reserved window.

import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { recordCost } from '../costs/tracker.js';
import { openAgentCall } from './abortable-call.js';
import { getDecisionProvider, type DecisionProvider } from './decision-provider.js';
import { localWorkBegins } from '../services/ollama-lock.js';
import { MEASURED_CHARS_PER_TOKEN, tokensAt } from '../services/token-density.js';
import { fenceExternal } from '../tools/external-content.js';

const logger = createLogger('decide');

/** A yes/no question; its answer is the probability of yes. */
export interface Question { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
export interface Answer { type: 'noul'; noul: number }
/** `agentId`: the agent waiting on the answer, whose Stop cuts the call. */
export interface DecideOpts { purpose: string; agentId?: string }

/** Ollama's documented limit for one `/v1/systemone` request. */
const MAX_QUESTIONS_PER_REQUEST = 64;
/** Measured: a request whose state and questions exceed 64 KiB is refused with HTTP 413, so it is not dialled. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;

/** Models this process saw answer: resident until any call of theirs fails, after which the next call gets the load time. */
const resident = new Set<string>();
export function __forgetResidencyForTests(): void { resident.clear(); }
/** Failures are logged once per class per minute: a down Ollama on a busy box is one line, not one per turn.
 *  The line says how many of that class were left out since the last one. */
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();
const leftOut = new Map<string, number>();

export type FailureClass = 'too_many_questions' | 'too_large' | 'http' | 'timeout' | 'transport' | 'parse' | 'stopped';
function fail(cls: FailureClass, opts: DecideOpts, detail?: string): null {
  const now = Date.now();
  if (now - (lastLogged.get(cls) ?? 0) >= LOG_EVERY_MS) {
    lastLogged.set(cls, now);
    const suppressed = leftOut.get(cls);
    leftOut.delete(cls);
    logger.warn(cls === 'too_large' ? 'decide() refused a request as too large; the rule decides' : 'decide() returned no answer; the rule decides', { failure: cls, purpose: opts.purpose, detail, suppressed });
  } else leftOut.set(cls, (leftOut.get(cls) ?? 0) + 1);
  return null;
}

/** One call in flight at a time: the local Ollama answers one request at a time, so a call's clock starts when it is
 *  sent, never while it waits. A Stop while waiting, a timeout ahead of it in the line, or a wait past `MAX_LINE_WAIT_MS` leaves the call unsent. */
let tail: Promise<unknown> = Promise.resolve();
let joined = 0, unsentThrough = 0;
function inTurn<T>(stop: AbortSignal | null, work: () => Promise<T | null>): Promise<T | null> {
  const ticket = ++joined;
  let began = false, gaveUp = false;
  const run = tail.then(() => (gaveUp || stop?.aborted || ticket <= unsentThrough ? null : (began = true, work())));
  tail = run.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waits: Array<Promise<T | null>> = [run, new Promise<null>((r) => {
    timer = setTimeout(() => { if (!began) { gaveUp = true; r(null); } }, MAX_LINE_WAIT_MS);
  })];
  if (stop) waits.push(new Promise<null>((r) => (stop.aborted ? r(null) : stop.addEventListener('abort', () => r(null), { once: true }))));
  return Promise.race(waits).finally(() => clearTimeout(timer));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function typed(a: unknown): Answer | null {
  const noul = a && typeof a === 'object' ? (a as Record<string, unknown>).noul : undefined;
  return isNum(noul) ? { type: 'noul', noul } : null;
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
    return got === null && !wasSent ? fail(slot?.signal.aborted ? 'stopped' : 'timeout', opts, 'left the line unsent') : got;
  } finally {
    slot?.release();
  }
}

async function sent(
  provider: DecisionProvider, state: unknown, questions: Record<string, Question>, opts: DecideOpts, stop: AbortSignal | null,
): Promise<Record<string, Answer> | null> {
  const endLocalWork = localWorkBegins();   // an Ollama restart waits for this call
  try {
    const names = Object.keys(questions);
    const stateTokens = tokensAt(JSON.stringify(fencedState(state)).length, MEASURED_CHARS_PER_TOKEN);
    const clock = AbortSignal.timeout(decideTimeoutMs(stateTokens, names.length, resident.has(provider.model)));
    const cut = (): FailureClass | null => {
      if (clock.aborted) unsentThrough = joined;   // the calls already waiting behind a timeout stay unsent
      return clock.aborted ? 'timeout' : stop?.aborted ? 'stopped' : null;
    };
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
      const a = typed(body.answers?.[name]);
      if (a) answers[name] = a; else fail('parse', opts, `no usable answer for ${name}`);
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


// The timeout fits the call's measured size: 62 + 1.33*T + 94*(Q-1) ms (T state tokens, Q questions, warm).
// Observed p99 ran 2.05 times the fit; a non-resident model added about 1.3 s; the box shared its GPU.
// So a call gets its own size's worth, never under the floor.
export function decideTimeoutMs(stateTokens: number, questions: number, resident: boolean): number {
  return Math.max(MIN_WARM_MS, Math.ceil(decideFitMs(stateTokens, questions) * P99_OVER_FIT)) + (resident ? 0 : MODEL_LOAD_MS);
}
/** The fitted warm time of a call of this size (the p99 margin and the load time are not in it). */
const decideFitMs = (stateTokens: number, questions: number): number => 62 + 1.33 * stateTokens + 94 * (questions - 1);
const P99_OVER_FIT = 2.05;
const MODEL_LOAD_MS = 1_300;
/** A floor for a box whose GPU or event loop is busy: an answer already on its way is not cut at a fraction of a second. */
const MIN_WARM_MS = 2_500;
/** A call not yet sent gives up waiting in the line after the time the largest per-turn call may take; its rule answers. */
/** The largest per-turn call: about 800 state tokens and 9 questions. */
export const LARGEST_TURN_CALL = { stateTokens: 800, questions: 9 } as const;
const MAX_LINE_WAIT_MS = decideTimeoutMs(LARGEST_TURN_CALL.stateTokens, LARGEST_TURN_CALL.questions, false);

// The state is the MATERIAL the questions are about, never instructions.
// Each text in it goes to the model in its own fence (fenceExternal defangs a forged end), named by its key, with a code
// that is an HMAC of the text under a key made once per process: the same text gets the same code (so the same answer)
// within a process, and the code cannot be predicted from the text. Numbers, flags and shape pass through.
const FENCE_KEY = randomBytes(16);
function fencedState(v: unknown, key = 'state'): unknown {
  if (typeof v === 'string') return fenceExternal('document', `the ${key} this question is about`, v, { code: createHmac('sha256', FENCE_KEY).update(v).digest('hex').slice(0, 8) });
  if (Array.isArray(v)) return v.map((x) => fencedState(x, key));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fencedState(x, k)]));
  return v;
}

/** The request body exactly as `decide()` sends it. */
export const decideRequestBody = (model: string, state: unknown, questions: Record<string, Question>): string =>
  JSON.stringify({ model, state: fencedState(state), questions, keep_alive: -1 });
// Measured: Ollama counts state's JSON plus questions' JSON plus 93 bytes of its own, not the full body.
const decideCountedBytes = (state: unknown, questions: Record<string, Question>): number =>
  Buffer.byteLength(JSON.stringify(fencedState(state))) + Buffer.byteLength(JSON.stringify(questions)) + 93;
