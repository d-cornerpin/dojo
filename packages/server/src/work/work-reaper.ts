// The one reaper: every periodic sweep (`REAPER_KINDS`) runs off one timer, and each age cliff is declared
// once in `DEADLINES` (the test re-derives each value from its own site). The storm law is
// `selfWakeStandDown()`: self-wakes stand down while any human ask waits; it over-counts rather than
// under-counts, and an unreadable spine also means stand down.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { transition, abandonUnservableAsks, clearPhantomCountdowns, purgeDeadA2AThreads } from './store.js';
import { sweepByRowid } from '../memory/message-store.js';
// Single-sourced so the boot sweep's exclusion window cannot drift from the eligibility gate it mirrors.
import { ENGINE_EVENT_MAX_ATTEMPTS } from '../agent/v2/counterparty.js';
import { STUCK_AGENT_THRESHOLD_MINUTES } from '../agent/stuck-thresholds.js';

const logger = createLogger('work-reaper');


export type DeadlineId =
  | 'approval_stale_pending'
  | 'stuck_agent_check'
  | 'join_ttl_sweep'
  | 'stale_task_window'
  | 'wake_freshness'
  | 'join_ttl'
  | 'approval_ttl'
  | 'stuck_agent_threshold'
  | 'engine_event_expiry'
  | 'join_max_age'
  | 'commitment_aging';

export interface Deadline {
  readonly id: DeadlineId;
  readonly ms: number;
  /** The requirement this cliff encodes: what breaks if it moves. */
  readonly reason: string;
  /** The constant (or literal) this value is CARRIED from, with its file. Never invented. */
  readonly carriedFrom: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The age cliffs in ascending order, declared here but owned by the code that enforces each. Subsystems
 *  must not import them from here: one table every subsystem imported would drag the whole tree in. */
export const DEADLINES: Readonly<Record<DeadlineId, Deadline>> = {
  approval_stale_pending: {
    id: 'approval_stale_pending', ms: 5 * MIN,
    reason:
      'A destructive-approval request the primary never received (a dropped wake) or simply ignored gets ONE more wake at this age, bounded by rewake_count. Kept well under the TTL so the extra wake still has time to be acted on.',
    carriedFrom: 'STALE_PENDING_MINUTES = 5 — agent/destructive-gate.ts',
  },
  stuck_agent_check: {
    id: 'stuck_agent_check', ms: 5 * MIN,
    reason:
      'The cadence for repairing rows a dead or terminated actor left behind: agents wedged in `working`, orphaned model pointers, and (T9) ask tickets that can never be served. A CADENCE, not an age cliff, and it is in this table because the unservable-ask reaper rides it.',
    carriedFrom: 'STUCK_AGENT_CHECK_MS = 5 * 60 * 1000 — agent/runtime.ts',
  },
  join_ttl_sweep: {
    id: 'join_ttl_sweep', ms: 10 * MIN,
    reason:
      'How often the delegated-join TTL reaper looks. Also a cadence rather than an age: the AGE it enforces is `join_ttl` below. Ten minutes is what the timer in index.ts ran at before this module owned it.',
    carriedFrom: '10 * 60_000 — index.ts, the D13 join TTL reaper interval',
  },
  stale_task_window: {
    id: 'stale_task_window', ms: 30 * MIN,
    reason:
      'The window inside which a task counts as "this session\'s". Beyond it the engine stops treating the row as in-flight context, which is what stops a restart re-driving weeks of backlog.',
    carriedFrom: 'STALE_TASK_WINDOW_MINUTES = 30 — agent/v2/loop.ts',
  },
  wake_freshness: {
    id: 'wake_freshness', ms: 45 * MIN,
    reason:
      'THE STORM BOUND (2026-07-23, owner box). A lived-in box carries a deep backlog of never-served terminal rows; unbounded, the finder dredged one up per turn, the model probed the senders, the probes created REAL new threads, and the turn-end drain queued the next stale row — a self-sustaining cross-agent storm. A wake is a wake only while it is FRESH.',
    carriedFrom: "unixepoch('now', '-45 minutes') in findUnservedTerminalWake — agent/v2/counterparty.ts",
  },
  join_ttl: {
    id: 'join_ttl', ms: 60 * MIN,
    reason:
      'How long a delegated join may wait before the engine fails it CLOSED and tells the owner on the join\'s own channel. The owner is never left in silence because the asked agent died, was terminated, or dropped the ask. t114 (census U3): this deadline YIELDS TO PROOF OF LIFE — the census recorded it as the one row of these thirteen that KILLED work rather than expiring an obligation, because a delegate still grinding its piece at minute 61 was failed closed with no liveness read. The reaper now grants a patience-scaled extension while an outstanding piece\'s assignee is provably working, bounded by JOIN_LIVENESS_MAX_TOTAL_MS; past that ceiling it fails closed and says so.',
    carriedFrom: 'JOIN_TTL_MINUTES = 60 — work/store.ts, carried verbatim from the deleted PARK_TTL_MINUTES (agent/a2a-transport.ts)',
  },
  approval_ttl: {
    id: 'approval_ttl', ms: 60 * MIN,
    reason:
      'A destructive-approval request nobody decided within this window is EXPIRED with an owner-visible note, rather than left pending forever behind a worker that is waiting on it.',
    carriedFrom: 'APPROVAL_TTL_MINUTES = 60 — agent/approval-decision.ts',
  },
  stuck_agent_threshold: {
    // Read from the shared stuck-threshold table rather than restated, so the copies cannot drift.
    id: 'stuck_agent_threshold', ms: STUCK_AGENT_THRESHOLD_MINUTES * MIN,
    reason:
      'An agent row reading `working` for longer than this is a dead process\'s row, not a long turn: comfortably above the 15-minute turn budget times up to four continuations plus overshoot, with the in-process activeRuns guard as the real safety: a run live in this process is never reaped.',
    carriedFrom: 'STUCK_AGENT_THRESHOLD_MINUTES = 75 — agent/stuck-thresholds.ts (was agent/runtime.ts until PHASE-6 T10)',
  },
  engine_event_expiry: {
    id: 'engine_event_expiry', ms: 6 * HOUR,
    reason:
      'Nothing older than this horizon can EVER wake an agent. Past it an engine event is expired LOUDLY (once, via the notice path) instead of delivered, which is what stops a restart replaying historical events as pending work.',
    carriedFrom: 'ENGINE_EVENT_EXPIRY_HOURS = 6 — agent/v2/counterparty.ts',
  },
  join_max_age: {
    id: 'join_max_age', ms: 7 * DAY,
    reason:
      'Joins older than this are stale history: nothing re-fires them, and telling the owner about a week-old delegated question is noise rather than service.',
    carriedFrom: 'JOIN_MAX_AGE_DAYS = 7 — work/store.ts, carried verbatim from the deleted PARK_MAX_AGE_DAYS (agent/a2a-transport.ts)',
  },
  commitment_aging: {
    id: 'commitment_aging', ms: 7 * DAY,
    reason:
      'A promise older than this is surfaced as AGED in the daily brief. It is a MARKER computed from `opened_at`, never a state: the module this was carried from wrote `status=\'stale\'` from inside the brief generator — a read that mutated rows — and that is exactly what it must not become again.',
    carriedFrom: 'COMMITMENT_AGING_DAYS = 7 — work/store.ts, carried verbatim from the deleted STALE_AFTER_DAYS (memory/open-loops.ts)',
  },
};

export const DEADLINE_IDS: readonly DeadlineId[] = Object.keys(DEADLINES) as DeadlineId[];


/** How many people are waiting on this agent: `ask` rows in state `open`. Returns -1 if the spine cannot
 *  be read, which `selfWakeStandDown` treats as stand down; a count is never invented from a failure. */
export function humanAsksOpen(agentId: string): number {
  try {
    const row = getDb().prepare(
      `SELECT count(*) AS n FROM work WHERE kind = 'ask' AND state = 'open' AND agent_id = ?`,
    ).get(agentId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch (err) {
    logger.warn('storm law: could not read the waiting set; standing self-wakes down', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return -1;
  }
}

/** WHO is waiting, in precedence order (main user, safe senders, other agents), read off the ingest
 *  stamps; no prose is consulted. The key ORDER is the precedence. */
export interface OpenAskTiers {
  /** The primary user: dashboard, voice, or a producer that stamped `owner`. */
  mainUser: number;
  /** A safe sender: on an allowlist, authorized, but not the owner. */
  safeSenders: number;
  otherAgents: number;
}

export function openAskTiers(agentId: string): OpenAskTiers {
  const empty: OpenAskTiers = { mainUser: 0, safeSenders: 0, otherAgents: 0 };
  try {
    const rows = getDb().prepare(`
      SELECT CASE
               WHEN m.source_agent_id IS NOT NULL OR m.a2a_thread_id IS NOT NULL THEN 'otherAgents'
               WHEN json_extract(m.inbound_meta, '$.relation') = 'agent'         THEN 'otherAgents'
               WHEN json_extract(m.inbound_meta, '$.relation') = 'known_contact' THEN 'safeSenders'
               WHEN json_extract(m.inbound_meta, '$.relation') = 'owner'         THEN 'mainUser'
               WHEN m.channel IN ('dashboard','voice')                           THEN 'mainUser'
               WHEN m.channel IS NOT NULL                                        THEN 'safeSenders'
               ELSE 'mainUser'
             END AS tier, count(*) AS n
        FROM work w LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
       WHERE w.kind = 'ask' AND w.state = 'open' AND w.agent_id = ?
       GROUP BY tier
    `).all(agentId) as Array<{ tier: keyof OpenAskTiers; n: number }>;
    for (const r of rows) empty[r.tier] = r.n;
    return empty;
  } catch {
    // A count is never invented from a failure; the caller already stands down on `humanAsksOpen`'s -1.
    return empty;
  }
}

/** The storm law in one call: every caller about to queue a wakeup the platform decided on (never a real
 *  inbound) asks this first. The count and `tiers` come back so it can record what it stood down on. */
export function selfWakeStandDown(
  agentId: string,
): { standDown: boolean; humanAsksOpen: number; tiers: OpenAskTiers } {
  const n = humanAsksOpen(agentId);
  return { standDown: n !== 0, humanAsksOpen: n, tiers: openAskTiers(agentId) };
}

// The drains' `stuck` counters live in `drain_state` (`agent/drain-state.ts`), not in `work.attempts` (the
// recurrence fire count) or `messages.delivery_attempts` (the engine event's failed-delivery counter), and
// are not derived from ended turns: a deliverable can arrive mid-orchestration, so turns that ended while
// the drain stood down would count as failures to advance.


/** The base tick: the 30-second timeout/approval interval this module absorbed. Every kind runs at an exact
 *  multiple of it, and the test refuses one that does not. */
export const REAPER_BASE_TICK_MS = 30_000;

export interface ReaperKind {
  readonly id: string;
  /** How often this kind runs. Always a multiple of the base tick. */
  readonly everyMs: number;
  /** WHICH existing clock this period was taken from, and why that clock. */
  readonly cadenceFrom: string;
  /** True if running this kind can queue a WAKEUP. Those obey the storm law. */
  readonly wakes: boolean;
  readonly run: () => Promise<void>;
}

export const REAPER_KINDS: readonly ReaperKind[] = [
  {
    id: 'stale-approvals',
    everyMs: 30_000,
    cadenceFrom:
      "index.ts's 30s timeout interval, which called sweepStaleApprovals directly before this module owned it — the period is carried, not chosen",
    wakes: true, // it re-wakes the primary once for a stale pending request
    run: async () => {
      const { sweepStaleApprovals } = await import('../agent/destructive-gate.js');
      await sweepStaleApprovals();
    },
  },
  {
    id: 'unservable-asks',
    everyMs: 5 * 60_000,
    cadenceFrom:
      "STUCK_AGENT_CHECK_MS (agent/runtime.ts) — the platform's declared period for repairing rows a dead or terminated actor left behind, which is exactly what an unservable ask is. T6 concern 6 asked for a periodic home and refused to invent a cadence (#14); this is the existing clock whose CLASS matches.",
    wakes: false,
    run: async () => {
      const { abandoned, byClass } = abandonUnservableAsks();
      if (abandoned > 0) {
        logger.warn('reaper: abandoned ask ticket(s) that could never be served or closed', {
          abandoned, byClass,
        });
      }
      // Same clock and same class: a `remaining_children > 0` with no child rows is an obligation nothing
      // can discharge, so it rides this kind instead of owning a period of its own.
      const { cleared } = clearPhantomCountdowns();
      if (cleared > 0) {
        logger.warn('reaper: cleared phantom join countdown(s) with no children to count', { cleared });
      }
    },
  },
  // Non-scheduling sweeps.
  {
    id: 'orphaned-and-stale-runs',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick (SCHEDULER_INTERVAL_MS, now scheduler/clock.ts) that hosted both cleanups inside checkScheduledTasks before this module owned them — the period is carried, not chosen',
    // One kind for two functions: both close or recover a run whose actor died or went silent.
    wakes: false,
    run: async () => {
      const { cleanupOrphanedRuns, cleanupStaleRuns } = await import('../scheduler/runner.js');
      cleanupOrphanedRuns();
      cleanupStaleRuns();
    },
  },
  {
    id: 'expired-pauses',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick that hosted resumeExpiredPauses inside checkScheduledTasks; the cliff is the row\'s own paused_until, so the sweep only needs a clock fine enough to honour it',
    wakes: false,
    run: async () => {
      const { resumeExpiredPauses } = await import('../scheduler/runner.js');
      resumeExpiredPauses();
    },
  },
  {
    id: 'ladder',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick (REAPER_BASE_TICK_MS); each step\'s own clock is the worker\'s patience bound, which the ladder applies itself, so the tick is only how often it looks',
    // It hints workers, wakes the PM and the main agent, and raises the owner's card.
    wakes: true,
    run: async () => {
      const { runLadder } = await import('./done/ladder.js');
      await runLadder();
    },
  },
  {
    id: 'steered-run-delivery-close',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick, which SWEEP CORE-1 CT2 chose for this rung in the same words the other five used — "the tick is the platform\'s existing 30-second clock, a cadence carried, not re-chosen"',
    wakes: false,
    run: async () => {
      const { closeRunsThatDelivered } = await import('../scheduler/runner.js');
      await closeRunsThatDelivered();
    },
  },
  {
    id: 'join-ttl',
    everyMs: 10 * 60_000,
    cadenceFrom:
      "index.ts's D13 join TTL reaper interval (10 * 60_000), moved here whole — the period is the timer's own",
    wakes: true, // it relays a deterministic notice on the join's own channel
    run: async () => {
      const { sweepExpiredJoins } = await import('../agent/a2a-transport.js');
      await sweepExpiredJoins();
    },
  },
  {
    // The disposal rule and both its guards live in `purgeDeadA2AThreads`; this is only its clock.
    id: 'dead-a2a-threads',
    everyMs: 3_600_000,
    cadenceFrom:
      "`terminal-task-prune`'s PRUNE_INTERVAL_MS = 3600_000 — the platform's declared period for disposing of rows whose horizon is measured in DAYS (`JOIN_MAX_AGE_DAYS` here). The hour is carried from the sibling with the same shape, not chosen",
    wakes: false,
    run: async () => {
      const removed = purgeDeadA2AThreads();
      if (removed > 0) logger.info('reaper: purged dead a2a_threads row(s)', { removed });
    },
  },
];


/** Genuine human asks one agent may hold before the boot sweep stops holding them for the re-drain. */
const HUMAN_HOLD_LIMIT = 5;

/**
 * Boot staleness sweep: a box that was offline has a backlog the re-drains would treat as fresh and
 * force-wake every agent on. Anything older than thirty minutes at boot is stale history and is suppressed
 * silently; tracker rows are never touched. The 30 minutes equals `DEADLINES.stale_task_window` in value
 * but not in meaning, so the two are deliberately not merged.
 */
export function sweepBootStaleness(): { suppressed: number; swept: number; heldTotal: number; heldAgents: number } {
  const db = getDb();
  // A quick restart with a handful of genuine human asks is a person waiting, so those are HELD for the
  // re-drain; a larger backlog is stale history. Counted PER agent, and only servable rows (opened since
  // the agent's session start, the re-drain's own floor) count.
  const STALE_ASK_WHERE =
    `w.kind = 'ask' AND w.state = 'open'
     AND w.opened_at < (unixepoch('now', '-30 minutes') * 1000)
     AND w.opened_at >= (unixepoch(COALESCE((SELECT session_started_at FROM agents WHERE id = w.agent_id), '1970-01-01')) * 1000)`;
  const heldAgents = db.prepare(
    `SELECT w.agent_id AS id, COUNT(*) AS c FROM work w
      WHERE ${STALE_ASK_WHERE}
      GROUP BY w.agent_id HAVING COUNT(*) <= ${HUMAN_HOLD_LIMIT}`,
  ).all() as Array<{ id: string; c: number }>;
  const heldTotal = heldAgents.reduce((s, a) => s + a.c, 0);
  const heldIds = new Set(heldAgents.map((a) => a.id));
  const staleAsks = db.prepare(
    `SELECT w.id AS id, w.agent_id AS agent_id FROM work w WHERE ${STALE_ASK_WHERE}`,
  ).all() as Array<{ id: string; agent_id: string }>;
  let suppressed = 0;
  for (const a of staleAsks) {
    if (heldIds.has(a.agent_id)) continue;      // held for the re-drain
    const res = transition(a.id, {
      to: 'abandoned', by: 'agent', actorId: a.agent_id,
      reason: 'boot staleness sweep: older than 30 minutes at startup and beyond the hold limit',
    });
    if (res.kind === 'applied') suppressed++;
  }

  // Engine events still inside their delivery lifecycle (a future retry backoff, or recorded attempts under
  // the max) are excluded; mass backlog is swept. Keeping them cannot storm: `getPendingEngineEvent`
  // (agent/v2/counterparty.ts) never wakes on a row past the expiry horizon or at max attempts.
  // The `IS NOT NULL` guard matters: a NULL `next_attempt_at` makes the whole NOT(...) NULL and would
  // shield all plain engine backlog. `sweepByRowid` does the disposal and re-applies its own guards per
  // row, so a row claimed in between is still not ours.
  const staleRows = db.prepare(
    `SELECT m.seq AS rowid, m.agent_id AS agent_id FROM messages AS m
      WHERE m.role = 'user' AND m.lane = 'events'
        AND m.served_by_turn IS NULL AND m.swept_at IS NULL
        AND m.created_at < (unixepoch('now', '-30 minutes') * 1000)
        AND NOT ((m.next_attempt_at IS NOT NULL AND m.next_attempt_at > (unixepoch('now') * 1000))
                 OR (m.delivery_attempts > 0 AND m.delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}))`,
  ).all() as Array<{ rowid: number; agent_id: string }>;
  let swept = 0;
  for (const r of staleRows) swept += sweepByRowid({ rowid: r.rowid, agentId: r.agent_id, requireUnclaimed: true });

  if (swept > 0 || suppressed > 0 || heldTotal > 0) {
    logger.info(
      `Boot staleness sweep: drain-suppressed ${swept} stale (>30m) engine event(s) and abandoned ${suppressed} stale ask(s)` +
      `${heldTotal > 0 ? `; HELD ${heldTotal} genuine human ask(s) across ${heldAgents.length} agent(s) for the re-drain` : ''} (tracker untouched)`,
    );
  }
  return { suppressed, swept, heldTotal, heldAgents: heldAgents.length };
}

export interface ReaperTickReport {
  ran: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
}

let tickCount = 0;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * One pass of the reaper, exported so the boot path and tests can drive it. Sequential on purpose: the
 * sweeps write to the same database and two of them relay messages.
 */
export async function runReaperTick(): Promise<ReaperTickReport> {
  const report: ReaperTickReport = { ran: [], skipped: [], failed: [] };
  const tick = tickCount++;
  for (const kind of REAPER_KINDS) {
    const every = Math.max(1, Math.round(kind.everyMs / REAPER_BASE_TICK_MS));
    if (tick % every !== 0) { report.skipped.push(kind.id); continue; }
    try {
      await kind.run();
      report.ran.push(kind.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.failed.push({ id: kind.id, error });
      // Non-fatal by design: one sweep failing must not silence the others.
      logger.warn('reaper kind failed (non-fatal)', { kind: kind.id, error });
    }
  }
  return report;
}

/** Install the ONE timer. Idempotent; a second call is a no-op rather than a second clock. */
export function startReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    void runReaperTick().catch((err) => {
      logger.error('reaper tick failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, REAPER_BASE_TICK_MS);
  reaperTimer.unref?.();
  logger.info('work reaper started', {
    baseTickMs: REAPER_BASE_TICK_MS,
    kinds: REAPER_KINDS.map((k) => `${k.id}@${k.everyMs / 60_000}m`),
    deadlines: DEADLINE_IDS.length,
  });
}

export function stopReaper(): void {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
  tickCount = 0;
}
