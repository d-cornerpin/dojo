// ════════════════════════════════════════════════════════════════════════════
// v3.5 (proof-fix T) — IS THE DECISION MODEL'S RUNNER WORKING ON A CALL? (a sign of life for a call that has not answered)
//
// `/v1/systemone` answers once, whole (no stream: measured on Ollama 0.40.13, a `stream:true` body still came back as one
// JSON), so a call in flight shows nothing in its own response. What the local Ollama does show: its runner (a
// `llama-server` on 127.0.0.1) reports `GET /slots` — per slot `is_processing` and `n_prompt_tokens_processed`, which
// climbed 512 tokens at a time through a 19k-token call. A runner that is hung, or never took the call, shows none.
// The runner's port is not in Ollama's API; it is on the runner's command line (`--port`, `-c <context>`), and the
// context length is in Ollama's own `/api/ps` for the model. Anything not found exactly (no `ps`, a runner that is not
// llama-server, two runners with the same context, an unreadable answer) is NOT a sign of life: the caller learns nothing.
// Only 127.0.0.1 is ever dialled — the box's own Ollama, which `decide()` already talks to.
// ════════════════════════════════════════════════════════════════════════════

import { processCommandsAsync } from '../process-identity.js';
import { ollamaJson } from './local-standard.js';

/** The runner port for a model with this context length: the one local `llama-server` started with `-c <context>`; null unless exactly one. */
export function runnerPortOf(psOutput: string, contextLength: number): number | null {
  const ports = new Set<number>();
  for (const line of psOutput.split('\n')) {
    if (!/llama-server/.test(line) || !/--host 127\.0\.0\.1\b/.test(line)) continue;
    const ctx = /\s-c (\d+)\b/.exec(line)?.[1];
    const port = /--port (\d+)\b/.exec(line)?.[1];
    if (ctx !== undefined && port !== undefined && Number(ctx) === contextLength) ports.add(Number(port));
  }
  return ports.size === 1 ? [...ports][0] : null;
}

/** True when any slot of a `/slots` answer is processing a prompt and has taken in tokens of it. */
export function slotsShowWork(slots: unknown): boolean {
  return Array.isArray(slots) && slots.some((s) => !!s && typeof s === 'object'
    && (s as Record<string, unknown>).is_processing === true && Number((s as Record<string, unknown>).n_prompt_tokens_processed) > 0);
}

/** The local runner's port for `model`, from Ollama's `/api/ps` and the process list; null when it cannot be told exactly. */
async function runnerPort(baseUrl: string, model: string, signal: AbortSignal): Promise<number | null> {
  const ps = await ollamaJson<{ models?: Array<{ name?: string; model?: string; context_length?: number }> }>(baseUrl, '/api/ps', signal);
  const ctx = (ps?.models ?? []).find((m) => m.name === model || m.model === model)?.context_length;
  return typeof ctx === 'number' && ctx > 0 ? runnerPortOf(await processCommandsAsync(signal), ctx) : null;
}

/**
 * Is the runner of `model` processing a prompt right now, with tokens taken in? Best effort, bounded by `withinMs`
 * (the caller's measured time for a call with no state, scaled): any failure or doubt is false, never an error.
 */
export async function runnerIsWorking(baseUrl: string, model: string, withinMs: number): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(withinMs);
    const port = await runnerPort(baseUrl, model, signal);
    return port !== null && slotsShowWork(await ollamaJson<unknown>(`http://127.0.0.1:${port}`, '/slots', signal));
  } catch { return false; }
}

export interface RunnerWatch { working: () => Promise<boolean>; stop: () => void }
/** Looks at the runner shortly before a call's clock (`timeoutMs`) runs out; the cut is not delayed (the look has its own
 *  bound `budgetMs`: four reads of a call with no state at this box's pace). `working()` is what it saw; no look made is no sign. */
export function watchRunner(baseUrl: string, model: string, timeoutMs: number, budgetMs: number): RunnerWatch {
  let seen: Promise<boolean> | null = null;
  const timer = setTimeout(() => { seen = runnerIsWorking(baseUrl, model, budgetMs); }, Math.max(timeoutMs - budgetMs, timeoutMs / 2));
  return { working: async () => (seen ? await seen : false), stop: () => clearTimeout(timer) };
}
