// Turn-end records on a job's task, both engine-written so `taskMovedAtSql` never reads them as a move:
// `continued` (ended mid-job with momentum, written by `agent/v2/steps/post-call-classify/job-continues.ts`)
// and `stalled` (a continued turn came back with none; `work/done/ladder.ts` takes it from there).
import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { appendWorkEvent } from './store.js';
import type { WorkEventKind } from './event-kinds.js';

export const CONTINUED_EVENT = 'continued' as const satisfies WorkEventKind;
export const STALLED_EVENT = 'stalled' as const satisfies WorkEventKind;

export interface ContinuedFacts { remaining: number; touchedThisTurn: number; novelCallsThisTurn: number; turnNumber: number }
export interface StalledFacts { remaining: number; turnNumber: number }

export function recordContinued(taskId: string, f: ContinuedFacts): void {
  appendWorkEvent(taskId, CONTINUED_EVENT, 'engine', f);
}

export function recordStalled(taskId: string, f: StalledFacts): void {
  appendWorkEvent(taskId, STALLED_EVENT, 'engine', f);
}

/** How the task's last turn ended: its latest `continued` or `stalled` event, payload and time, or null. ONLY
 *  those two: a `claim_turn` or a note says a turn worked the task, not how it ended. */
export function lastTurnEnd(taskId: string): { kind: 'continued' | 'stalled'; payload: Record<string, unknown>; at: number } | null {
  const r = getDb().prepare(
    `SELECT kind, payload, created_at AS at FROM work_events WHERE work_id = ? AND kind IN ('continued', 'stalled') ORDER BY id DESC LIMIT 1`,
  ).get(taskId) as { kind: 'continued' | 'stalled'; payload: string | null; at: number } | undefined;
  if (!r) return null;
  let payload: Record<string, unknown> = {};
  try { payload = r.payload ? JSON.parse(r.payload) as Record<string, unknown> : {}; } catch { /* an unreadable payload reads as empty */ }
  return { kind: r.kind, payload, at: r.at };
}

export interface TurnCall { id?: string; name: string; arguments?: unknown }

/** The tool and its arguments with object keys sorted, so key order never makes two calls differ. */
function callSignature(call: TurnCall): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => [k, norm((x as Record<string, unknown>)[k])]))
      : x;
  let args: string;
  try { args = JSON.stringify(norm(call.arguments ?? {})) ?? '{}'; } catch { args = String(call.arguments); }
  return createHash('sha1').update(`${call.name}\u0000${args}`).digest('hex');
}

/** In this process: every call each task has made, and the new successful ones of its latest turn. A
 *  restart empties it, which can only make a call read as new. */
const seenCalls = new Map<string, Set<string>>();
const turnNovelty = new Map<string, { turnStartMs: number; novel: number }>();

/** Note one round of a turn's calls on its task: a call this task never made before, that succeeded, is momentum. */
export function noteTurnCalls(taskId: string, calls: readonly TurnCall[], turn: { startMs: number; succeeded: (c: TurnCall) => boolean }): void {
  const seen = seenCalls.get(taskId) ?? new Set<string>();
  let novel = 0;
  for (const call of calls) {
    const sig = callSignature(call);
    if (seen.has(sig)) continue;
    seen.add(sig);
    if (turn.succeeded(call)) novel += 1;
  }
  seenCalls.set(taskId, seen);
  const t = turnNovelty.get(taskId);
  turnNovelty.set(taskId, { turnStartMs: turn.startMs, novel: (t?.turnStartMs === turn.startMs ? t.novel : 0) + novel });
}

export function novelCallsInTurn(taskId: string, turnStartMs: number): number {
  const t = turnNovelty.get(taskId);
  return t && t.turnStartMs === turnStartMs ? t.novel : 0;
}
