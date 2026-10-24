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
// sets aside for it (`num_ctx`, `services/dojo-working-memory.ts decisionWindowTokens`). An agent that
// waits on a decision is the one whose stop cuts it (`openAgentCall`).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { recordCost } from '../costs/tracker.js';
import { openAgentCall } from './abortable-call.js';
import { getDecisionProvider } from './decision-provider.js';
import { localHeld, localWorkBegins } from '../services/ollama-quiet.js';
import { decisionWindowTokens } from '../services/dojo-working-memory.js';
import { fenceExternal } from '../tools/external-content.js';

const logger = createLogger('decide');

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
export interface DecideOpts { purpose: string; agentId?: string; timeoutMs?: number; turnId?: string }

/** Ollama's documented limit for one `/v1/systemone` request. */
const MAX_QUESTIONS_PER_REQUEST = 64;
/** PROVISIONAL (orchestrator ruling, fix round 1): the plan's figure, with no measurement behind it yet.
 *  It is REPLACED by Wave 2's B5 dev-box measurement of decide() latency (the cost rows already carry
 *  `latency_ms` per purpose). Callers pass their own. */
const DEFAULT_TIMEOUT_MS = 1_500;
/** Failures are logged once per class per minute: a down Ollama on a busy box is one line, not one per turn. */
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

type FailureClass = 'too_many_questions' | 'http' | 'timeout' | 'transport' | 'parse';
function fail(cls: FailureClass, purpose: string, detail?: string): null {
  const now = Date.now();
  if (now - (lastLogged.get(cls) ?? 0) >= LOG_EVERY_MS) {
    lastLogged.set(cls, now);
    logger.warn('decide() returned no answer; the rule decides', { failure: cls, purpose, detail });
  }
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
  if (names.length > MAX_QUESTIONS_PER_REQUEST) return fail('too_many_questions', opts.purpose, String(names.length));

  // Fix round 4 (NB-4): the window it runs at is the one the memory fit sets aside for it — one number, one
  // origin (`decisionWindowTokens`); without it Ollama would size the call by the model file's own default.
  const numCtx = await decisionWindowTokens();
  // NB-1: while the Ollama app restarts to apply the model limit, the rule answers (no wait on a restart);
  // otherwise this call is in-flight work the restart waits for.
  if (localHeld()) return null;
  const endLocalWork = await localWorkBegins();
  const clock = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const slot = opts.agentId === undefined ? null : openAgentCall(opts.agentId, 'turn', clock);
  const started = Date.now();
  try {
    let resp: Response;
    try {
      resp = await fetch(`${provider.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model, state: fencedState(state), questions, keep_alive: -1, options: { num_ctx: numCtx } }),
        signal: slot?.signal ?? clock,
      });
    } catch (err) {
      return fail(clock.aborted ? 'timeout' : 'transport', opts.purpose, err instanceof Error ? err.message : String(err));
    }
    if (!resp.ok) return fail('http', opts.purpose, `${resp.status}`);
    let body: { answers?: Record<string, unknown>; usage?: { input_tokens?: number; prompt_tokens?: number } };
    try { body = await resp.json() as typeof body; } catch (err) {
      return fail(clock.aborted ? 'timeout' : 'parse', opts.purpose, err instanceof Error ? err.message : String(err));
    }
    const answers: Record<string, Answer> = {};
    for (const name of names) {
      const a = typed(questions[name], body.answers?.[name]);
      if (!a) return fail('parse', opts.purpose, `no usable answer for ${name}`);
      answers[name] = a;
    }
    const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0;
    recordCost({
      agentId: opts.agentId ?? 'system', modelId: provider.modelId, providerId: provider.providerId,
      inputTokens: isNum(inputTokens) ? inputTokens : 0, outputTokens: 0, latencyMs: Date.now() - started,
      requestType: 'decision', callPurpose: opts.purpose,
    });
    return answers;
  } finally {
    slot?.release();
    endLocalWork();
  }
}
