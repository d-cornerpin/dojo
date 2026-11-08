// decide()'s request sizing: the state fenced as material, the body exactly as sent, the bytes Ollama counts
// against its limit, and the time a call of that size is given. Pure: no model, no clock, no network.

import { fenceExternal } from '../tools/external-content.js';
import type { Question } from './decide.js';

/**
 * The timeout, measured on a box whose GPU the writer shares: a warm call took 62 + 1.33·T + 94·(Q − 1) ms
 * (T the state's tokens, Q the questions), observed over fitted was 2.05 at p99, and loading a model that is
 * not resident added about 1.3 s. So a call is given that long for its own size; a caller may pass its own.
 */
export function decideTimeoutMs(stateTokens: number, questions: number, resident: boolean): number {
  return Math.ceil(decideFitMs(stateTokens, questions) * P99_OVER_FIT) + (resident ? 0 : MODEL_LOAD_MS);
}
/** The fitted warm time of a call of this size (the p99 margin and the load time are not in it). */
const decideFitMs = (stateTokens: number, questions: number): number => 62 + 1.33 * stateTokens + 94 * (questions - 1);
const P99_OVER_FIT = 2.05;
const MODEL_LOAD_MS = 1_300;

/**
 * The state is the MATERIAL the questions are about (a reply, a summary, a job's source rows with a contact's
 * message or a page in them), never instructions. So every text in it goes to the model
 * inside its own fence (the one fence, `fenceExternal`; a forged end in it is defanged), named by its key.
 * Numbers, flags and the shape pass as they are. Exported so a caller sizing a request can count the fences.
 */
export function fencedState(v: unknown, key = 'state'): unknown {
  if (typeof v === 'string') return fenceExternal('document', `the ${key} this question is about`, v);
  if (Array.isArray(v)) return v.map((x) => fencedState(x, key));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fencedState(x, k)]));
  return v;
}

/** The request body exactly as `decide()` sends it. */
export const decideRequestBody = (model: string, state: unknown, questions: Record<string, Question>): string =>
  JSON.stringify({ model, state: fencedState(state), questions, keep_alive: -1 });
/** Measured: what Ollama counts against `MAX_DECISION_BODY_BYTES` is the
 *  JSON of `state` plus the JSON of `questions` plus 93 bytes of its own, not the body (the model name and `keep_alive`
 *  are not counted; a part filled to a 64 KiB BODY was refused). A caller sizing parts counts with this. */
export const decideCountedBytes = (state: unknown, questions: Record<string, Question>): number =>
  Buffer.byteLength(JSON.stringify(fencedState(state))) + Buffer.byteLength(JSON.stringify(questions)) + 93;
