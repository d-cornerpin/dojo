// The one repeat rule, for every agent: when the same call brings back the same result a 4th time the engine
// stops that call, and it runs again only after the agent calls `continue_repeating` with a reason; the next
// stops are at 8, 20, 50, 100 and every further 100. The same call with a new result is work and never counts.
// A send to an agent counts per recipient within the turn, whatever its wording; other calls count over two turns.

import { createHash } from 'node:crypto';
import { createLogger } from '../../logger.js';
import type { TurnContext } from '../turn-context.js';

const logger = createLogger('v2-loop');

export const LIFT_TOOL = 'continue_repeating';
const RUNGS = [4, 8, 20, 50, 100];
// Refusals of one unchanged signature before the turn's tool phase ends. Counting refusals, not calls, keeps
// fan-outs and corrected retries safe: only a call that is not executing anyway can reach this rung.
const TERMINAL_AT = 3;
const SENDS = new Set(['send_to_agent', 'broadcast_to_group']);
// Clock-shaped text: ISO dates and times, clock times, the time formatter's day and month words, epochs, durations.
const CLOCK = /\d{4}-\d\d-\d\d(T[\d:.]+Z?)?|\b\d{1,2}:\d\d(:\d\d)?(\s?[AP]M)?|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b|\b\d{10}(\d{3})?\b|\b\d+(\.\d+)?\s?(ms|s|sec|seconds|min|minutes)\b/g;

/** Per call, how many times each result came back. */
type Counts = Map<string, Map<string, number>>;
interface Window {
  ref: TurnContext;
  turn: number;
  before: Counts;
  now: Counts;
  stopAt: Map<string, number>;
  refused: Map<string, number>;
  fresh: number;
}
const windows = new Map<string, Window>();

// Stable JSON with keys sorted at every depth; a JSON.stringify replacer array would erase nested keys.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical signature: tool name + stable-stringified args. */
export function identicalCallSignature(tool: string, args: unknown): string {
  let argsKey: string;
  try {
    argsKey = stableStringify(args ?? {});
  } catch {
    argsKey = String(args);
  }
  return `${tool}:${argsKey}`;
}

/** The result with clock-shaped text masked, so a time stamp never makes an answer new; counts and ids stay. */
export function fingerprint(text: string, blocks?: unknown): string {
  const masked = text.replace(CLOCK, '#').replace(/\s+/g, ' ');
  return createHash('sha1').update(masked + (blocks ? JSON.stringify(blocks) : '')).digest('hex').slice(0, 16);
}

function keyOf(tool: string, args: unknown): string {
  if (!SENDS.has(tool)) return identicalCallSignature(tool, args);
  const a = (args ?? {}) as { agent?: unknown; group_id?: unknown };
  return `${tool}:${String(a.agent ?? a.group_id ?? '').trim().toLowerCase()}`;
}
const nextStop = (n: number): number => RUNGS.find((r) => r > n) ?? Math.floor(n / 100) * 100 + 100;
const stopOf = (w: Window, key: string): number => w.stopAt.get(key) ?? RUNGS[0];
const isSend = (key: string): boolean => SENDS.has(key.slice(0, key.indexOf(':')));
const seenWords = (key: string, n: number): string => isSend(key)
  ? `this would be message ${n} to this recipient`
  : `this exact call has returned the same result ${n} times`;
const WAYS = `Use what you have or do something different. If repeating it is really what the job needs, call ${LIFT_TOOL} with a one-line reason, then make the call again.`;

/** The agent's window in this turn: the next turn number keeps the last turn's counts as `before`; any other
 *  turn, a second run under the same number included, starts clean. */
function windowAt(agentId: string, ref: TurnContext): Window {
  const w = windows.get(agentId);
  if (w?.ref === ref) return w;
  const turn = ref.turnNumber ?? 0;
  const before: Counts = w?.turn === turn - 1 ? w.now : new Map();
  const stopAt = new Map([...(w?.stopAt ?? [])].filter(([key]) => before.has(key)));
  const next: Window = {
    ref, turn, before, now: new Map(), stopAt, refused: new Map(), fresh: 0,
  };
  windows.set(agentId, next);
  return next;
}

/** The most times one result of this call came back in the window; a send counts within this turn only. */
function timesSeen(w: Window, key: string): number {
  const now = w.now.get(key);
  const before = isSend(key) ? undefined : w.before.get(key);
  let most = 0;
  for (const fp of new Set([...(now?.keys() ?? []), ...(before?.keys() ?? [])])) {
    most = Math.max(most, (now?.get(fp) ?? 0) + (before?.get(fp) ?? 0));
  }
  return most;
}

/** The count a stop is judged on: a send is stopped before it goes out, so the one about to go counts. */
const due = (w: Window, key: string): number => timesSeen(w, key) + (isSend(key) ? 1 : 0);

/** The refusal for a stopped call, which does not run; null when it may run. */
export function repeatStopRefusal(agentId: string, turn: TurnContext, tool: string, args: unknown): string | null {
  const w = windowAt(agentId, turn);
  const key = keyOf(tool, args);
  const n = due(w, key);
  if (n < stopOf(w, key)) return null;
  w.refused.set(key, (w.refused.get(key) ?? 0) + 1);
  return `[Engine: not run. ${seenWords(key, n)}, so the engine stopped it; a plain retry does not lift the stop. ${WAYS}]`;
}

/** Counts an executed call's result, and a work call's result new to the window as the job moving; returns
 *  the stop notice when this result reaches the call's next stop (a send is stopped before it runs instead). */
export function noteRepeatResult(agentId: string, turn: TurnContext, tool: string, args: unknown, fp: string, work: boolean): string | null {
  const w = windowAt(agentId, turn);
  const key = keyOf(tool, args);
  const results = w.now.get(key) ?? new Map<string, number>();
  const same = SENDS.has(tool) ? '' : fp;
  results.set(same, (results.get(same) ?? 0) + 1);
  w.now.set(key, results);
  const n = (results.get(same) ?? 0) + (w.before.get(key)?.get(same) ?? 0);
  if (n === 1 && work) w.fresh += 1;
  if (isSend(key) || n !== stopOf(w, key)) return null;
  logger.warn('v2: repeat rule stopped a call', { agentId, call: key.slice(0, 160), times: n }, agentId);
  return `\n\n[Engine: ${seenWords(key, n)}, so the engine has stopped this call; asking again will not change the answer. ${WAYS}]`;
}

/** The job's momentum this turn: work results new to the window, and the agent's choices to continue. */
export function freshResults(agentId: string, turn: TurnContext | undefined): number {
  const w = windows.get(agentId);
  return w && w.ref === turn ? w.fresh : 0;
}

/** True once a signature has been refused TERMINAL_AT times; the loop then ends the turn's tool phase. */
export function isSignatureTerminal(agentId: string, turn: TurnContext, tool: string, args: unknown): boolean {
  return (windowAt(agentId, turn).refused.get(keyOf(tool, args)) ?? 0) >= TERMINAL_AT;
}

/** True when the engine refused any repeated call this turn (an engine decision, for the turn record). Read from
 *  this map, not latched at the refusal site, because parallel runOne callbacks clobber each other's state. */
export function anyRepeatRefused(agentId: string, turn: TurnContext): boolean {
  return windowAt(agentId, turn).refused.size > 0;
}

/** The lift: every call stopped now runs again until its next stop. The reason is recorded as the call's argument. */
export function liftRepeatStops(agentId: string, reason: unknown): { content: string; isError: boolean } {
  if (typeof reason !== 'string' || !reason.trim()) {
    return { content: `${LIFT_TOOL} needs a one-line reason: why running the stopped call again is useful. Nothing was lifted.`, isError: true };
  }
  const nothing = { content: 'Nothing is stopped right now, so there is nothing to continue.', isError: false };
  const w = windows.get(agentId);
  if (!w) return nothing;
  const stopped = [...new Set([...w.now.keys(), ...w.before.keys()])].filter((key) => due(w, key) >= stopOf(w, key));
  if (stopped.length === 0) return nothing;
  w.fresh += 1;   // choosing to continue, with a reason, is the job moving for the checkpoint window
  const lifted = stopped.map((key) => {
    w.stopAt.set(key, nextStop(due(w, key)));
    w.refused.delete(key);
    return `${key.slice(0, key.indexOf(':'))} (stopped again at ${stopOf(w, key)})`;
  });
  logger.info('v2: repeat stop lifted', { agentId, calls: stopped.map((key) => key.slice(0, 160)), reason }, agentId);
  return { content: `Continuing: ${lifted.join(', ')}.`, isError: false };
}
