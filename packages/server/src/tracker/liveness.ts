// Liveness, judged on movement: the ONE reader of what the Dojo can see an agent doing, swept by the
// scheduler's background checks (`sweepSilentAgents`).
// MOVEMENT: tokens in or out (a model call's `cost_records` row); a request open on a live connection
// (the abort registry; the stream watchdog cuts a dead one, so the clock does not run while one is open);
// a tool started or finished (the agent's own assistant / tool `messages` rows). NOT movement: the status
// heartbeat (`agent/v2/loop.ts` `startStatusHeartbeat` only broadcasts; it never writes the agent row), `audit_log`
// rows, and inbound rows (a PM poke or the owner's words). A task's own movement is `work/task-freshness.ts`.
// SILENT: one notice per incident through the owner-notice door, recorded on `agents.silent_notice`, which
// decides the text, the card and the clear (the agent moving again). Not told: an agent the owner stopped,
// or one whose status says something louder (paused, error, rate-limited). Window: `agents.silent_window_minutes`.

import { getDb } from '../db/connection.js';
import { countAbortable, isStopFenced, activeRuns } from '../agent/shared-state.js';
import { isPrimaryAgent, isPMAgent, isHealerAgent, isDreamerAgent } from '../config/platform.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { noteNoticeOnce, endNotice, readNotice } from '../agent/agent-owner-cards.js';
import { notWaitingForItsTimeSql, taskScope, holdSetBySql } from '../work/tracker-view.js';
import { taskMovedAtSql, cardedSinceStallSql } from '../work/task-freshness.js';
import { agentRequests, dueOf, type OwedWork } from '../agent/v2/owed.js';
import { liveWork, parkedJobs } from '../agent/live-work.js';
import { createLogger } from '../logger.js';

const logger = createLogger('liveness');

export { DEFAULT_SILENT_WINDOW_MINUTES, silentWindowMs } from './silent-window.js';
import { silentWindowMs } from './silent-window.js';
import { heldExpr, workingExpr } from '../work/done/hold.js';

const MIN_MS = 60_000;
const textMs = (col: string): string => `CAST(strftime('%s', ${col}) AS INTEGER) * 1000`;

export interface Activity {
  lastAt: number | null;
  /** The newest movement that left a ROW (tokens, a tool start or finish); an open request is not one.
   *  Only this ends a SILENT incident. */
  lastRowAt: number | null;
  lastWhat: string;
  /** The newest finished model call, epoch ms (BROKEN's "healthy work" signal). */
  lastModelCallAt: number | null;
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

export function agentActivity(agentId: string, now = Date.now()): Activity {
  const db = getDb();
  const call = db.prepare(`SELECT ${textMs('created_at')} AS at, input_tokens + COALESCE(cache_read_tokens, 0) AS tin,
      output_tokens AS tout FROM cost_records WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(agentId) as { at: number; tin: number; tout: number } | undefined;
  const own = db.prepare(`SELECT role, content, created_at AS at FROM messages
      WHERE agent_id = ? AND role IN ('assistant', 'tool') ORDER BY created_at DESC, seq DESC LIMIT 1`)
    .get(agentId) as { role: string; content: string; at: number } | undefined;
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

/** Is the agent working on `work`: in flight, owed for it, on another live delegation of its own, paused or in error; never ended or SILENT. */
export function workerBusy(agentId: string, work: OwedWork, seen = new Set<string>()): boolean {
  const a = getDb().prepare('SELECT status, silent_notice FROM agents WHERE id = ?').get(agentId) as { status: string; silent_notice: string | null } | undefined;
  if (!a || a.status === 'terminated' || a.silent_notice !== null) return false;
  const live = liveWork(agentId), due = dueOf(agentId, Date.now(), work);
  if (['paused', 'error'].includes(a.status) || activeRuns.has(agentId) || live.turn > 0 || live.background > parkedJobs(agentId).length
    || due.now || due.next !== null) return true;
  if (seen.has(agentId)) return false;
  seen.add(agentId);
  return (getDb().prepare(`SELECT j.id FROM work j WHERE j.agent_id = ? AND j.remaining_children > 0 AND j.state NOT IN ('done', 'failed', 'abandoned')
      AND NOT EXISTS (SELECT 1 FROM work c WHERE c.parent_id = j.id AND c.root_id = ?)`).all(agentId, work.threadId ?? '') as Array<{ id: string }>)
    .some((j) => openPieces(j.id, seen).some((p) => p.alive));
}

/** SQL: piece `c` has a task on its thread still open, its agent not ended, and not ended by the owner's card: a card
 *  never ends it while the owner or the engine holds the task, or when the task is the join's own agent's. */
const ALIVE = (c: string): string => `EXISTS (SELECT 1 FROM work t JOIN agents h ON h.id = t.agent_id AND h.status <> 'terminated'
  WHERE t.kind = 'task' AND t.a2a_thread_id = ${c}.root_id AND t.state NOT IN ('done', 'failed', 'abandoned')
    AND ((t.hold_kind IS NOT NULL AND ${holdSetBySql('t')} IN ('owner', 'user', 'engine')) OR t.agent_id = ${c}.agent_id OR NOT ${cardedSinceStallSql('t')}))`;

/** Open pieces of a join, alive by their task (ALIVE), or with no task a busy helper or a question back its asker owes. */
export function openPieces(joinId: string, seen = new Set<string>()): Array<{ childId: string; alive: boolean }> {
  return (getDb().prepare(`SELECT c.id, c.agent_id AS asker, c.assignee_agent AS helper, c.root_id AS thread, ${ALIVE('c')} AS alive,
      EXISTS (SELECT 1 FROM work t WHERE t.kind = 'task' AND t.a2a_thread_id = c.root_id) AS tasked
      FROM work c WHERE c.parent_id = ? AND c.kind = 'task' AND c.state IN ('open', 'claimed', 'blocked')`).all(joinId) as
    Array<{ id: string; asker: string; helper: string | null; thread: string; alive: number; tasked: number }>).map((p) => ({
    childId: p.id, alive: p.alive === 1 || (p.tasked === 0 && !!p.helper
      && (agentRequests(p.asker, Date.now(), p.thread).length > 0 || workerBusy(p.helper, { threadId: p.thread }, seen))),
  }));
}

/** The task's own last movement, epoch ms: the stall ladder's clock (`work/task-freshness.ts`). */
export function taskLastMovedAt(taskId: string, updatedAtMs: number): number {
  try {
    const r = getDb().prepare(`SELECT ${taskMovedAtSql('w')} AS at FROM work w WHERE w.id = ?`).get(taskId) as { at: number } | undefined;
    return r?.at ?? updatedAtMs;
  } catch { return updatedAtMs; /* the row's own clock */ }
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

interface OpenWork { id: string; title: string; updated: number; opened: number /* when the agent was HANDED the work: newest of open, last fire, last movement */ }

function openWorkOf(agentId: string, now: number): OpenWork[] {
  return getDb().prepare(`SELECT w.id, COALESCE(w.title, w.id) AS title, w.updated_at AS updated,
        MAX(w.opened_at, COALESCE(w.last_run_at, 0), ${taskMovedAtSql('w')}) AS opened
      FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND w.is_paused = 0 AND NOT ${heldExpr('w')}
        AND ${notWaitingForItsTimeSql('w')}`)
    .all(agentId, now) as OpenWork[];
}

/** The owner stopped this agent and it has not started a turn since. Not measured against the agent's
 *  last row: a straggling row landing after the stopped turn ended must not make the Stop forgotten. */
function ownerStopped(agentId: string): boolean {
  if (isStopFenced(agentId)) return true;
  return !!getDb().prepare(`SELECT 1 FROM turns s WHERE s.agent_id = ? AND s.exit_reason = 'stop' AND NOT EXISTS (
      SELECT 1 FROM turns t WHERE t.agent_id = s.agent_id AND t.started_at > s.ended_at) LIMIT 1`).get(agentId);
}

/** The open task that moved most recently. */
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

/** The liveness pass: tell the owner once about each agent gone SILENT past its window, end
 *  SILENT incidents whose agent moved and BROKEN ones whose agent completed a model call. Never throws. */
export function sweepSilentAgents(now = Date.now()): void {
  let agents: Array<{ id: string; name: string; status: string }>;
  try {
    agents = getDb().prepare(`SELECT a.id, a.name, a.status FROM agents a WHERE a.status != 'terminated' AND (
        a.status = 'working' OR a.silent_notice IS NOT NULL OR a.broken_notice IS NOT NULL
        OR EXISTS (SELECT 1 FROM work w WHERE ${taskScope('w')} AND w.agent_id = a.id AND ${workingExpr('w')}))`)
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
  // SILENT is a WEDGE: something it owes is meant to be in progress (a working status or a live run,
  // never a `turns` row: a crash leaves an open row behind). An idle agent between turns is never SILENT.
  const owes = a.status === 'working' || activeRuns.has(a.id);
  // A louder status owns this agent, or there is nothing it was meant to be doing: not SILENT.
  if (['paused', 'error'].includes(a.status) || (work.length === 0 && a.status !== 'working') || !owes) {
    if (silent) endNotice(a.id, 'silent_notice');
    return;
  }
  if (silent) {
    const since = silent.since ?? silent.at;
    // Only a ROW ends the incident: a request that opens and dies without tokens is a retry loop in the
    // same wedge (an open request only ever suppresses RAISING a notice, below).
    if ((act.lastRowAt !== null && act.lastRowAt > since) || ownerStopped(a.id)) endNotice(a.id, 'silent_notice');
    return;
  }
  // The quiet runs from the newest movement, or from when the agent was handed what it holds.
  const handed = Math.max(0, ...work.map((w) => w.opened), openTurnStartedAt(a.id));
  const since = Math.max(act.lastAt ?? 0, handed);
  if (since === 0 || now - since <= silentWindowMs(a.id) || ownerStopped(a.id)) return;
  const words = silentWords(a.id, a.name, now - since, work, act);
  if (noteNoticeOnce(a.id, 'silent_notice', words, since)) {
    logger.warn('liveness: an agent is SILENT past its window; the owner is told once', { agentId: a.id, quietMs: now - since });
    void sendAlert(words, 'notice', { kind: 'broken-agent', agentId: a.id });
  }
}

function openTurnStartedAt(agentId: string): number {
  const r = getDb().prepare(`SELECT MAX(${textMs('started_at')}) AS at FROM turns WHERE agent_id = ? AND ended_at IS NULL`)
    .get(agentId) as { at: number | null } | undefined;
  return r?.at ?? 0;
}
