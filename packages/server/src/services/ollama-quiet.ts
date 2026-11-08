// ════════════════════════════════════════════════════════════════════════════
// v3.5 fix round 4 (NB-1) — WHAT IS IN FLIGHT ON THIS BOX'S OLLAMA, AND THE MODEL-LIMIT RESTART'S HOLD.
//
// The Ollama app is restarted to apply its raised loaded-model limit (`ollama-model-limit.ts`) only when nothing
// is in flight on the local Ollama: the Ollama lock's slots (agent turns), the engine's pinned calls on the
// resident pair, and the local work that takes no slot at all — decide(), the embedder, a model pull, the
// standard-models install (`localWorkBegins`). Then every new call on it waits until the app answers again, so
// a restart never cuts a running call or a download. Each count is taken in the same tick a call is let through,
// so the check and the hold can never let one slip in between.
// ════════════════════════════════════════════════════════════════════════════

import { getOllamaLock } from './ollama-lock.js';
import { isLocalOllamaBaseUrl } from './num-ctx-calculator.js';
import { broadcast } from '../gateway/ws.js';

let held: { providerId: string; over: Promise<void> } | null = null;
let localWork = 0;
const pinned = new Map<string, number>();
let quietWaiters: Array<() => void> = [];

/** The hold on `providerId` (or on the local Ollama when none is named), or null. */
export function heldFor(providerId?: string): Promise<void> | null {
  return held && (providerId === undefined || held.providerId === providerId) ? held.over : null;
}
/** Is a restart holding the local Ollama right now? (decide() answers with its rule instead of waiting.) */
export const localHeld = (): boolean => held !== null;

/** Who is waiting (fix round 5, NB4-3): the agent's Stop ends the wait, and its turn shows what it waits for. */
export interface HoldWait { signal?: AbortSignal; agentId?: string }

/**
 * Wait out a hold on `providerId` (the local Ollama when none is named): null when nothing holds it, so a caller
 * that is let through is counted in the same tick. A stopped agent stops waiting (the Stop's own reason is
 * thrown). An agent's wait is shown as an engine activity row — the existing frame the dashboard's active-jobs
 * row renders; the 'compaction' kind is reused as the nightly maintenance row does, the label carries the meaning.
 */
export function waitOutHold(providerId?: string, wait: HoldWait = {}): Promise<void> | null {
  if (!heldFor(providerId)) return null;
  return (async () => {
    const id = `ollama_restart_${wait.agentId ?? 'engine'}_${Date.now()}`;
    const startedAt = new Date().toISOString();
    const emit = (phase: 'start' | 'end'): void => {
      if (wait.agentId) broadcast({ type: 'engine:activity', data: { id, kind: 'compaction', agentId: wait.agentId, label: 'Waiting for the local model to restart', startedAt, phase } });
    };
    emit('start');
    // The listener is removed when the wait ends in ANY way (the hold released or the agent stopped): a
    // `{ once: true }` listener that never fires stays on the signal for its whole life — a leak on a
    // long-lived signal. `finally` runs on both the resolve and the abort path.
    let rejectStop!: (reason?: unknown) => void;
    const onAbort = (): void => rejectStop(wait.signal!.reason);
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
      if (wait.signal?.aborted) reject(wait.signal.reason);
      wait.signal?.addEventListener('abort', onAbort, { once: true });
    });
    stopped.catch(() => { /* raced below */ });
    try {
      for (let h = heldFor(providerId); h; h = heldFor(providerId)) await Promise.race([h, stopped]);
    } finally { emit('end'); wait.signal?.removeEventListener('abort', onAbort); }
  })();
}

export function wakeQuietWaiters(): void {
  const w = quietWaiters;
  quietWaiters = [];
  for (const wake of w) wake();
}
export function pinnedBegins(providerId: string): void { pinned.set(providerId, (pinned.get(providerId) ?? 0) + 1); }
export function pinnedEnds(providerId: string): void {
  pinned.set(providerId, Math.max(0, (pinned.get(providerId) ?? 0) - 1));
  wakeQuietWaiters();
}

/**
 * Local Ollama work that takes no lock slot begins: it waits out a restart's hold, is counted from this tick, and
 * the returned function ends it (once). With a `baseUrl` that is not this box's Ollama it counts nothing.
 */
export function localWorkBegins(baseUrl?: string, wait?: HoldWait): Promise<() => void> {
  if (baseUrl !== undefined && !isLocalOllamaBaseUrl(baseUrl)) return Promise.resolve(() => {});
  const begin = (): (() => void) => {
    localWork++;
    let ended = false;
    return () => { if (ended) return; ended = true; localWork--; wakeQuietWaiters(); };
  };
  if (!held) return Promise.resolve(begin());
  return (async () => { for (let w = waitOutHold(undefined, wait); w; w = waitOutHold(undefined, wait)) await w; return begin(); })();
}

/** Everything in flight on the local Ollama (`providerId` is its provider row). */
export function localInFlight(providerId: string): number {
  return getOllamaLock().getStatus().slots.filter((s) => s.providerId === providerId).reduce((n, s) => n + s.activeRequests, 0)
    + (pinned.get(providerId) ?? 0) + localWork;
}

/** Waits until nothing is in flight on the local Ollama, then holds every new call on it until the returned
 *  function is called. The check and the hold happen in one tick. */
export async function holdWhenQuiet(providerId: string): Promise<() => void> {
  for (;;) {
    if (!held && localInFlight(providerId) === 0) {
      let end!: () => void;
      const hold = { providerId, over: new Promise<void>((r) => { end = r; }) };
      held = hold;
      return () => { if (held === hold) held = null; end(); };
    }
    await (held ? held.over : new Promise<void>((r) => { quietWaiters.push(r); }));
  }
}
