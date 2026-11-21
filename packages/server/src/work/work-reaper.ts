// The one reaper: every periodic sweep (`REAPER_KINDS`) runs off one timer. The storm law is
// `selfWakeStandDown()`: self-wakes stand down while any person is due an answer, and an unreadable read
// also means stand down.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { transition, abandonUnservableAsks, clearPhantomCountdowns, purgeDeadA2AThreads } from './store.js';
import { sweepByRowid } from '../memory/message-store.js';
// Single-sourced so the boot sweep's exclusion window cannot drift from the eligibility gate it mirrors.
import { ENGINE_EVENT_MAX_ATTEMPTS } from '../agent/v2/counterparty.js';
import { personsWaiting } from '../agent/v2/owed.js';
import { tellOwner } from '../healer/owner-notices.js';
import { senderWords } from './inherited-backlog.js';

const logger = createLogger('work-reaper');


/** The storm law in one call: every caller about to queue a wakeup the platform decided on (never a real
 *  inbound) asks this first, and records the count it stood down on. */
export function selfWakeStandDown(agentId: string): { standDown: boolean; humanAsksOpen: number } {
  const n = personsWaiting(agentId);
  return { standDown: n !== 0, humanAsksOpen: n };
}

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
    id: 'steps-after-a-dead-step',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick that checked a due step\'s dead dependency inside checkScheduledTasks; the period is carried, not chosen',
    wakes: true, // each hand-in arms the decider's review
    run: async () => {
      const { handInStepsAfterADeadStep } = await import('./done/effects.js');
      const handed = await handInStepsAfterADeadStep();
      if (handed > 0) logger.info('reaper: handed in step(s) whose earlier step can never finish', { handed });
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

/** One card for the boot's dropped messages: how many, and from whom, the most first. */
function tellOwnerBootDropped(n: number, droppedFrom: Map<string, number>): void {
  // The five largest senders by name, then how many more.
  const sorted = [...droppedFrom].sort((a, b) => b[1] - a[1]);
  const rest = sorted.length - 5;
  const list = sorted.slice(0, 5).map(([who, k]) => `${k} from ${who}`).join(', ')
    + (rest > 0 ? `, and ${rest} more sender${rest === 1 ? '' : 's'}` : '');
  tellOwner(`bootdropped:${Date.now()}`, `When the Dojo started it dropped ${n} old unanswered message${n === 1 ? '' : 's'} `
    + `(more than 30 minutes old): ${list}. Nothing was sent to anyone about them.`);
}

/**
 * Boot staleness sweep: a box that was offline has a backlog the re-drains would treat as fresh and
 * force-wake every agent on. Anything older than thirty minutes at boot is stale history and is suppressed
 * silently; tracker rows are never touched.
 */
export function sweepBootStaleness(): { suppressed: number; swept: number; heldTotal: number; heldAgents: number } {
  const db = getDb();
  // A quick restart with a handful of genuine human asks is a person waiting, so those are HELD for the
  // re-drain; a larger backlog is stale history. Counted PER agent, and only servable rows (opened since
  // the agent's session start, the re-drain's own floor) count. An ask that waits on its own due time is kept.
  const STALE_ASK_WHERE =
    `w.kind = 'ask' AND w.state = 'open' AND w.next_attempt_at IS NULL
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
    `SELECT w.id AS id, w.agent_id AS agent_id, COALESCE(c.counterparty_name, c.counterparty_id, m.channel) AS sender, m.sender_id AS sender_id
       FROM work w LEFT JOIN conversations c ON c.id = w.conversation_id
       LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      WHERE ${STALE_ASK_WHERE}`,
  ).all() as Array<{ id: string; agent_id: string; sender: string | null; sender_id: string | null }>;
  let suppressed = 0;
  const droppedFrom = new Map<string, number>();
  for (const a of staleAsks) {
    if (heldIds.has(a.agent_id)) continue;      // held for the re-drain
    const res = transition(a.id, {
      to: 'abandoned', by: 'agent', actorId: a.agent_id,
      reason: 'boot staleness sweep: older than 30 minutes at startup and beyond the hold limit',
    });
    if (res.kind !== 'applied') continue;
    suppressed++;
    const who = senderWords(a.sender, a.sender_id);
    droppedFrom.set(who, (droppedFrom.get(who) ?? 0) + 1);
  }

  // Another agent's request never served is stale history too, closed silently: it is not a person's message.
  // Engine events still inside their delivery lifecycle (a future retry backoff, or recorded attempts under
  // the max) are excluded, and so is a reminder, which runs its own lifecycle; mass backlog is swept. Keeping them cannot storm: `getPendingEngineEvent`
  // (agent/v2/counterparty.ts) never wakes on a row past the expiry horizon or at max attempts.
  // The `IS NOT NULL` guard matters: a NULL `next_attempt_at` makes the whole NOT(...) NULL and would
  // shield all plain engine backlog. `sweepByRowid` does the disposal and re-applies its own guards per
  // row, so a row claimed in between is still not ours.
  const staleRows = db.prepare(
    `SELECT m.seq AS rowid, m.agent_id AS agent_id FROM messages AS m
      WHERE m.role = 'user' AND (m.lane = 'events' OR (m.lane = 'a2a' AND m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')))
        AND m.served_by_turn IS NULL AND m.swept_at IS NULL AND m.origin_intent IS NOT 'scheduler'
        AND m.created_at < (unixepoch('now', '-30 minutes') * 1000)
        AND NOT ((m.next_attempt_at IS NOT NULL AND m.next_attempt_at > (unixepoch('now') * 1000))
                 OR (m.delivery_attempts > 0 AND m.delivery_attempts < ${ENGINE_EVENT_MAX_ATTEMPTS}))`,
  ).all() as Array<{ rowid: number; agent_id: string }>;
  let swept = 0;
  for (const r of staleRows) swept += sweepByRowid({ rowid: r.rowid, agentId: r.agent_id, requireUnclaimed: true });
  if (suppressed > 0) tellOwnerBootDropped(suppressed, droppedFrom);

  // A pending row with nothing to send is a send an earlier version began and never finished; nothing will
  // finish it, so past the boot window it is closed as failed, with its reach unknown.
  const closed = db.prepare(
    `UPDATE deliveries SET outcome = 'failed', updated_at = datetime('now'),
            detail = 'left unresolved by an earlier version; whether it reached the person is not known: ' || COALESCE(detail, '')
      WHERE outcome = 'pending' AND payload_json IS NULL AND created_at < datetime('now', '-30 minutes')`,
  ).run().changes;
  if (closed > 0) logger.info(`Boot staleness sweep: closed ${closed} unfinished send(s) an earlier version left pending`);

  if (swept > 0 || suppressed > 0 || heldTotal > 0) {
    logger.info(
      `Boot staleness sweep: drain-suppressed ${swept} stale (>30m) engine event(s) and agent request(s), and abandoned ${suppressed} stale ask(s)` +
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
  });
}

export function stopReaper(): void {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
  tickCount = 0;
}
