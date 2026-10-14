// ════════════════════════════════════════════════════════════════════════════════════════
// LIVENESS, JUDGED ON MOVEMENT (t143, v3.3.3 — OR-LONG-JOBS, OR-PM-1, OR-V333-SET (3)).
//
// The owner, 2026-10-12: "if there is progress of any kind, maybe we just let them work … a true
// connection issue or no movement (no tokens going in or out) for a couple hours, we notify the
// user." The ONE reader of what the Dojo can see an agent doing; the scheduler's own clock sweeps it.
//
// MOVEMENT: tokens in or out (a model call's `cost_records` row); a request open on a live
// connection (the abort registry: every model call registers for its whole life, and the stream
// watchdog cuts a dead connection at the provider's own patience — declared, or sized by the
// measured prefill speed through the pre-dial doom gate — so the clock does not run while a request
// is open, and a slow-prefill local model is never called SILENT); a tool started or finished (the
// agent's own assistant / tool `messages` rows). NOT movement: the 30-second status heartbeat
// (`runtime.ts` `startStatusHeartbeat`, a timer bumping `agents.updated_at` regardless);
// `audit_log` (only some tools write it, and owner-side doors file rows ON the agent); inbound rows
// (a PM poke or the owner's words arriving is not the agent doing anything).
//
// PER TASK (t137 review M3, round 2): a task's movement is its own record (`work/task-freshness.ts`):
// its row's clock, what its assignee wrote on it, its transitions and claim, the finalize stamp of
// a turn whose trigger names it. The engine checkpoint now touches only the job's own work.
//
// SILENT: one notice per incident through the owner-notice door, recorded on `agents.silent_notice`
// (migration 191), which decides the text, the card and the clear (the agent moving again). Not
// told: an agent the owner stopped, or one whose status says something louder (paused, error,
// rate-limited: BROKEN-class, told by their own doors). The window: `agents.silent_window_minutes`,
// default 2 hours (owner-confirmed).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { countAbortable, isStopFenced } from '../agent/shared-state.js';
import { isPrimaryAgent, isPMAgent, isHealerAgent, isDreamerAgent } from '../config/platform.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { noteNoticeOnce, endNotice, readNotice } from '../agent/agent-owner-cards.js';
import { taskScope } from '../work/tracker-view.js';
import { taskMovedAtSql } from '../work/task-freshness.js';
import { createLogger } from '../logger.js';

const logger = createLogger('liveness');

/** OR-LONG-JOBS: "a couple hours", confirmed as a per-agent setting with this default. */
export const DEFAULT_SILENT_WINDOW_MINUTES = 120;

const MIN_MS = 60_000;
const textMs = (col: string): string => `CAST(strftime('%s', ${col}) AS INTEGER) * 1000`;

/** This agent's silent window, in ms. NULL (or anything a door would refuse) is the default. */
export function silentWindowMs(agentId: string): number {
  const m = (getDb().prepare('SELECT silent_window_minutes AS m FROM agents WHERE id = ?').get(agentId) as { m: unknown } | undefined)?.m;
  return (typeof m === 'number' && Number.isInteger(m) && m >= 1 ? m : DEFAULT_SILENT_WINDOW_MINUTES) * MIN_MS;
}

export interface Activity {
  /** The newest movement, epoch ms; `null` when the agent has never moved. */
  lastAt: number | null;
  /** The newest movement that left a ROW (tokens, a tool start or finish) — an open request is not
   *  one. This, never `lastAt`, is what ends a SILENT incident (t143 round 3, I3). */
  lastRowAt: number | null;
  /** That movement, in plain words. */
  lastWhat: string;
  /** The newest finished model call, epoch ms (BROKEN's "healthy work" signal). */
  lastModelCallAt: number | null;
  /** A tool the agent started and that has not returned, in plain words; else null. */
  waitingOn: string | null;
}

function toolNames(content: string): string[] {
  try {
    const blocks = JSON.parse(content) as unknown;
    if (!Array.isArray(blocks)) return [];
    return blocks.filter((b): b is { type: string; name: string } =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use' && typeof (b as { name?: unknown }).name === 'string')
      .map((b) => b.name);
  } catch { return []; }
}

/** What the agent has visibly done, newest first, from the records above. */
export function agentActivity(agentId: string, now = Date.now()): Activity {
  const db = getDb();
  const call = db.prepare(`SELECT ${textMs('created_at')} AS at, input_tokens + COALESCE(cache_read_tokens, 0) AS tin,
      output_tokens AS tout FROM cost_records WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(agentId) as { at: number; tin: number; tout: number } | undefined;
  const own = db.prepare(`SELECT role, content, created_at AS at FROM messages
      WHERE agent_id = ? AND role IN ('assistant', 'tool') ORDER BY created_at DESC, seq DESC LIMIT 1`)
    .get(agentId) as { role: string; content: string; at: number } | undefined;
  // The newest own row is an assistant row that asked for tools: those tools have not returned.
  const started = own?.role === 'assistant' ? toolNames(own.content) : [];
  const waitingOn = started.length > 0 ? started.join(', ') : null;

  const seen: Array<{ at: number; what: string }> = [];
  if (call) seen.push({ at: call.at, what: `a model call finished (${call.tin} tokens in, ${call.tout} out)` });
  if (own) {
    seen.push({
      at: own.at,
      what: own.role === 'tool' ? 'a tool returned its result' : waitingOn ? `it started ${waitingOn}` : 'it wrote a message',
    });
  }
  const lastRowAt = seen.length > 0 ? Math.max(...seen.map((x) => x.at)) : null;
  if (countAbortable(agentId) > 0) seen.push({ at: now, what: 'a request is open on a live connection' });
  const newest = seen.sort((a, b) => b.at - a.at)[0];
  return {
    lastAt: newest?.at ?? null,
    lastRowAt,
    lastWhat: newest?.what ?? 'nothing since it was given this work',
    lastModelCallAt: call?.at ?? null,
    waitingOn,
  };
}

/** Has the agent moved inside its own window? (The PM's ladder never escalates on a timer
 *  against an agent that is visibly working.) */
export function agentIsMoving(agentId: string, now = Date.now()): boolean {
  try {
    const { lastAt } = agentActivity(agentId, now);
    return lastAt !== null && now - lastAt <= silentWindowMs(agentId);
  } catch { return false; /* unreadable: no claim of movement, so the ladder behaves as before */ }
}

/** The task's own last movement, epoch ms — the PM ladder's idle clock (t137 review M3). Since
 *  round 2 the checkpoint touches only the job's own work, so the row's clock is honest; the one
 *  expression is shared with the close-out gate (`work/task-freshness.ts`). */
export function taskLastMovedAt(taskId: string, updatedAtMs: number): number {
  try {
    const r = getDb().prepare(`SELECT ${taskMovedAtSql('w')} AS at FROM work w WHERE w.id = ?`).get(taskId) as { at: number } | undefined;
    return r?.at ?? updatedAtMs;
  } catch { return updatedAtMs; /* the row's own clock, as before */ }
}

function roleOf(agentId: string): string {
  if (isPrimaryAgent(agentId)) return 'your main agent';
  if (isPMAgent(agentId)) return 'project manager';
  if (isHealerAgent(agentId)) return 'Healer';
  if (isDreamerAgent(agentId)) return 'Dreamer';
  return 'sub-agent';
}

const dur = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / MIN_MS));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};

interface OpenWork { id: string; title: string; updated: number; opened: number }

function openWorkOf(agentId: string, now: number): OpenWork[] {
  return getDb().prepare(`SELECT w.id, COALESCE(w.title, w.id) AS title, w.updated_at AS updated, w.opened_at AS opened
      FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0
        AND (w.scheduled_start IS NULL OR w.scheduled_start <= ?) AND COALESCE(w.schedule_status, '') != 'waiting'`)
    .all(agentId, now) as OpenWork[];
}

/** The owner stopped this agent and it has not started a turn since (his Stop is standing, or the
 *  last turn ended on it). Not measured against the agent's last row: a straggling row landing
 *  after the stopped turn ended does not make the Stop forgotten (t143 round 3, M2). */
function ownerStopped(agentId: string): boolean {
  if (isStopFenced(agentId)) return true;
  return !!getDb().prepare(`SELECT 1 FROM turns s WHERE s.agent_id = ? AND s.exit_reason = 'stop' AND NOT EXISTS (
      SELECT 1 FROM turns t WHERE t.agent_id = s.agent_id AND t.started_at > s.ended_at) LIMIT 1`).get(agentId);
}

/** The words of a SILENT notice: agent and role, task, last movement, what it was doing. */
function newestOf(work: OpenWork[]): OpenWork | undefined {
  return [...work].sort((a, b) => taskLastMovedAt(b.id, b.updated) - taskLastMovedAt(a.id, a.updated))[0];
}

function silentWords(agentId: string, name: string, quietMs: number, work: OpenWork[], act: Activity): string {
  const newest = newestOf(work);
  const others = work.length - 1;
  const task = newest ? ` on "${newest.title}"${others > 0 ? ` (and ${others} other open task${others > 1 ? 's' : ''})` : ''}` : '';
  const doing = act.waitingOn ? ` It was waiting on ${act.waitingOn}, which has not come back.` : '';
  return `${name} (${roleOf(agentId)}) has shown no sign of work for ${dur(quietMs)}${task}. `
    + `The last thing it did: ${act.lastWhat}.${doing} Open its chat to check on it; Stop ends the turn if it is stuck.`;
}

/**
 * The PM sweep's liveness pass: tell the owner once about every agent gone SILENT past its
 * window, end every SILENT incident whose agent moved again, and end every BROKEN incident whose
 * agent has since completed a model call. Never throws into the sweep.
 */
export function sweepSilentAgents(now = Date.now()): void {
  let agents: Array<{ id: string; name: string; status: string }>;
  try {
    agents = getDb().prepare(`SELECT a.id, a.name, a.status FROM agents a WHERE a.status != 'terminated' AND (
        a.status = 'working' OR a.silent_notice IS NOT NULL OR a.broken_notice IS NOT NULL
        OR EXISTS (SELECT 1 FROM work w WHERE ${taskScope('w')} AND w.agent_id = a.id AND w.state = 'claimed'))`)
      .all() as Array<{ id: string; name: string; status: string }>;
  } catch (err) {
    logger.warn('liveness sweep could not read the agents', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const a of agents) {
    try { judge(a, now); } catch (err) {
      logger.warn('liveness: one agent could not be judged', { agentId: a.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function judge(a: { id: string; name: string; status: string }, now: number): void {
  const act = agentActivity(a.id, now);
  const broken = readNotice(a.id, 'broken_notice');
  if (broken && act.lastModelCallAt !== null && act.lastModelCallAt > broken.at) endNotice(a.id, 'broken_notice');

  const silent = readNotice(a.id, 'silent_notice');
  const work = openWorkOf(a.id, now);
  // t143 round 3 (I5): SILENT is a WEDGE — something it owes is meant to be in progress: a working
  // status, an open turn, or a tool it started that never returned. An idle agent between turns
  // (waiting on the owner's answer, or on a delegate) owes nothing in progress and is never SILENT.
  const owes = a.status === 'working' || openTurnStartedAt(a.id) > 0 || act.waitingOn !== null;
  // A louder status owns this agent, or there is nothing it was meant to be doing: not SILENT.
  if (['paused', 'error', 'rate_limited'].includes(a.status) || (work.length === 0 && a.status !== 'working') || !owes) {
    if (silent) endNotice(a.id, 'silent_notice');
    return;
  }
  if (silent) {
    const since = silent.since ?? silent.at;
    // t143 round 3 (I3): only a ROW ends the incident. A request that opens and dies without tokens
    // is a retry loop inside the same wedge, not progress: it neither ends the card nor earns a
    // second text (an open request only ever suppresses RAISING a notice, below).
    if ((act.lastRowAt !== null && act.lastRowAt > since) || ownerStopped(a.id)) endNotice(a.id, 'silent_notice');
    return;
  }
  // The quiet runs from the newest movement, or from when the agent was handed what it holds.
  const handed = Math.max(0, ...work.map((w) => w.opened), openTurnStartedAt(a.id));
  const since = Math.max(act.lastAt ?? 0, handed);
  // No movement ever, nothing handed, no open turn: there is no instant to measure quiet from.
  if (since === 0 || now - since <= silentWindowMs(a.id) || ownerStopped(a.id)) return;
  const words = silentWords(a.id, a.name, now - since, work, act);
  if (noteNoticeOnce(a.id, 'silent_notice', words, since)) {
    logger.warn('liveness: an agent is SILENT past its window; the owner is told once', { agentId: a.id, quietMs: now - since });
    // t146: the notice names a task, so it is ABOUT that work row (the id is data held here, not read
    // from the words); its card stands in the owner-notices list in these exact words (`silent_notice`).
    sendAlert(words, 'notice', { aboutWorkId: newestOf(work)?.id });
  }
}

function openTurnStartedAt(agentId: string): number {
  const r = getDb().prepare(`SELECT MAX(${textMs('started_at')}) AS at FROM turns WHERE agent_id = ? AND ended_at IS NULL`)
    .get(agentId) as { at: number | null } | undefined;
  return r?.at ?? 0;
}
