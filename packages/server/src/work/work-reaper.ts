// ── ONE REAPER (PHASE-2 T9) ──
//
// Before this file, "when does an obligation age out" was answered in eleven places: two
// modules' module-scope constants, one constant declared inside a function body, one SQL
// literal buried in a finder, and seven `setInterval` calls in three files. Nothing could
// list the deadlines, nothing could say which clock drove which sweep, and two of the
// thirteen cliffs had been carried through a rename with no record that they were the same
// number. This module is the answer to both questions in one place:
//
//   DEADLINES     — the thirteen age cliffs, each with WHY it exists and WHERE its value
//                   came from. PHASE-2.md PINNED §4 counted them: "13 distinct deadlines,
//                   not nine — a table with nine rows leaves four deadlines outside the one
//                   reaper." Nothing here is invented (#14); every row is carried, and
//                   `work-reaper.test.ts` re-derives each value from its own site at HEAD so
//                   the two copies cannot drift apart in silence.
//
//   REAPER_KINDS  — every periodic obligation sweep, with its cadence and the clock that
//                   cadence was taken from. One timer drives all of them.
//
// ── THE STORM INVARIANTS ARE LAW, AND THEY LIVE HERE NOW ──
//
// PHASE-2.md Global Constraints: "freshness-bounded unserved selection; self-wakes stand
// down completely while any human conversation waits." Both were true in the runtime drain
// and true nowhere else, so a new sweep could re-open the 2026-07-23 production storm
// without touching the code that remembered why. `selfWakeStandDown()` is that law as a
// predicate over `work`, and every reaper kind that can WAKE an agent consults it.
//
// The law reads WORK STATE, not prose and not a JS-side authorization pass:
//     an open `work(kind='ask')` row IS a person waiting.
// It deliberately over-counts relative to `getWaitingHumanConversations` (which additionally
// filters by `deriveOrigin`'s authorized-human verdict). Over-counting stands the self-wake
// DOWN more often, and that is the only direction of error this predicate is allowed to have
// — the storm is what the other direction costs. An unreadable spine returns "stand down"
// for the same reason.
//
// ── WHY THE DRAIN'S BOUND IS DERIVED AND NOT STORED (and NOT `work.attempts`) ──
//
// PHASE-2.md T9 Step 2 as written says the E-A2/drain in-memory counters become
// `work.attempts`. `work/__tests__/single-writer-conformance.test.ts` PART C measured that
// column first and DECIDED against it: `work.attempts` IS the recurrence fire count (one
// writer, four readers, every one aliasing it to `run_count`), so a retry count sharing the
// integer would end the first retried `after_count` schedule early. That clause names T9 by
// name and it is how this task learned it.
//
// `messages.delivery_attempts` was the other candidate and it fails for the same reason
// measured the same way: it is the ENGINE EVENT's failed-DELIVERY counter, and five of them
// expire the event loudly (`ENGINE_EVENT_MAX_ATTEMPTS`). A head that failed to advance twice
// is not a delivery that failed twice; adding one to the other would expire events early.
//
// So the fact gets no new column at all. `stuck` is "how many of this agent's turns have
// ENDED since this head became the head, without serving it" — and `turns` already records
// every one of them. Deriving it from the spine is not a storage trick, it is the phase's
// own thesis applied to the last in-memory queue: **the record is the record.** It is also
// strictly better than the Map it replaces, because the Map lost the count on every restart
// — so a crash loop reset the storm protection to zero on each boot, which is the
// upgrade-day storm hazard wearing a different hat.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { transition, abandonUnservableAsks } from './store.js';
import { sweepByRowid } from '../memory/message-store.js';
// Single-sourced, never restated: the max-attempts bound the engine-event lifecycle enforces
// is read from the module that owns it, so the boot sweep's exclusion window cannot drift
// away from the eligibility gate it mirrors.
import { ENGINE_EVENT_MAX_ATTEMPTS } from '../agent/v2/counterparty.js';

const logger = createLogger('work-reaper');

// ════════════════════════════════════════════════════════════════════════════════
// THE THIRTEEN CLIFFS
// ════════════════════════════════════════════════════════════════════════════════

export type DeadlineId =
  | 'approval_stale_pending'
  | 'stuck_agent_check'
  | 'join_ttl_sweep'
  | 'close_out_idle'
  | 'stale_task_window'
  | 'wake_freshness'
  | 'join_ttl'
  | 'approval_ttl'
  | 'stuck_agent_threshold'
  | 'engine_event_expiry'
  | 'stale_request'
  | 'join_max_age'
  | 'commitment_aging';

export interface Deadline {
  readonly id: DeadlineId;
  /** The duration, in milliseconds. One unit, so two cliffs can be compared. */
  readonly ms: number;
  /** The requirement this cliff encodes — what breaks if it moves. */
  readonly reason: string;
  /** The constant (or literal) this value is CARRIED from, with its file. Never invented. */
  readonly carriedFrom: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * PINNED §4's thirteen, in ascending order of duration, each still owned by the code that
 * enforces it. This table does not REPLACE those constants — a single table that every
 * subsystem imported would drag the whole tree into one module — it DECLARES them, so the
 * reaper (and any reader) can see the full set of cliffs at once, and the test re-derives
 * every value from its own site so the declaration cannot go stale.
 */
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
  close_out_idle: {
    id: 'close_out_idle', ms: 10 * MIN,
    reason:
      'A turn that has said nothing for this long is treated as idle for close-out purposes, so the engine can require an explicit end rather than let a silent turn drift.',
    carriedFrom: 'CLOSE_OUT_IDLE_MINUTES = 10 — agent/v2/loop.ts (declared inside its function)',
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
      'How long a delegated join may wait before the engine fails it CLOSED and tells the owner on the join\'s own channel. The owner is never left in silence because the asked agent died, was terminated, or dropped the ask.',
    carriedFrom: 'JOIN_TTL_MINUTES = 60 — work/store.ts, carried verbatim from the deleted PARK_TTL_MINUTES (agent/a2a-transport.ts)',
  },
  approval_ttl: {
    id: 'approval_ttl', ms: 60 * MIN,
    reason:
      'A destructive-approval request nobody decided within this window is EXPIRED with an owner-visible note, rather than left pending forever behind a worker that is waiting on it.',
    carriedFrom: 'APPROVAL_TTL_MINUTES = 60 — agent/destructive-gate.ts',
  },
  stuck_agent_threshold: {
    id: 'stuck_agent_threshold', ms: 75 * MIN,
    reason:
      'An agent row reading `working` for longer than this is a dead process\'s row, not a long turn: comfortably above the 15-minute turn budget times up to four continuations plus overshoot, with the 30s heartbeat and the in-process activeRuns guard as the real safety.',
    carriedFrom: 'STUCK_AGENT_THRESHOLD_MINUTES = 75 — agent/runtime.ts',
  },
  engine_event_expiry: {
    id: 'engine_event_expiry', ms: 6 * HOUR,
    reason:
      'Nothing older than this horizon can EVER wake an agent. Past it an engine event is expired LOUDLY (once, via the notice path) instead of delivered, which is what stops a restart replaying historical events as pending work.',
    carriedFrom: 'ENGINE_EVENT_EXPIRY_HOURS = 6 — agent/v2/counterparty.ts',
  },
  stale_request: {
    id: 'stale_request', ms: 12 * HOUR,
    reason:
      'An override request the PM has not resolved, or a task awaiting the user\'s verdict, auto-resolves at this age so the system stays honest while humans are away. A TIMEOUT IS NOT A VERDICT: the auto-resolution is recorded as `auto_denied` and nothing is written to `adjudications`, because nobody ruled.',
    carriedFrom: 'STALE_REQUEST_HOURS = 12 — scheduler/runner.ts',
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

// ════════════════════════════════════════════════════════════════════════════════
// THE STORM LAW, ON THE SPINE
// ════════════════════════════════════════════════════════════════════════════════

/**
 * How many people are waiting on this agent right now, read from `work`.
 *
 * An `ask` in state `open` is an obligation to a person that no turn has picked up. A
 * `claimed` ask has a turn on it and that turn IS the service; every other state is
 * terminal, parked or queued. Nothing here reads prose.
 *
 * Returns -1 if the spine cannot be read — see `selfWakeStandDown`, which treats that as
 * "stand down". A count is never invented from a failure.
 */
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

/**
 * THE LAW, in one call: "self-wakes stand down completely while any human conversation
 * waits" (PHASE-2.md Global Constraints; the 2026-07-23 storm is the incident behind it —
 * the owner pleaded "stop" and the self-wake machinery kept the agent busy).
 *
 * Every caller that is about to queue a wakeup the PLATFORM decided on — never a real
 * inbound — asks this first. `humanAsksOpen` is returned alongside the verdict so the caller
 * can RECORD the number it stood down on, which is what makes the invariant able to tell a
 * healthy drain from a storm without guessing.
 */
export function selfWakeStandDown(agentId: string): { standDown: boolean; humanAsksOpen: number } {
  const n = humanAsksOpen(agentId);
  return { standDown: n !== 0, humanAsksOpen: n };
}

// ════════════════════════════════════════════════════════════════════════════════
// THE DRAIN BOUND — A REFUSED DESIGN, RECORDED SO IT IS NOT RE-ATTEMPTED
// ════════════════════════════════════════════════════════════════════════════════
//
// PHASE-2 T9 built `drainStuck(agentId, headArrivalMs) = endedTurnsSince(...) - 1` here, to
// give the two drains' `stuck` counters a restart-safe home that is not `work.attempts`. It
// is deleted, and this block is why — a landmine note, not an apology.
//
// THE ARGUMENT WAS: a drain pass happens at the end of every turn, so "consecutive passes on
// this head" == "turns ended since the head arrived, minus the one that found it". Clean,
// derivable, no column, survives a restart.
//
// THE ARGUMENT IS WRONG, AND THE BATTERY IS WHAT SAID SO. A deliverable arrives
// MID-ORCHESTRATION. The primary then runs several legitimate turns — serving the human, who
// takes priority, and during whom the drain stands down ENTIRELY under the storm law — before
// the drain ever looks at that head. Turns that happened while the drain was not looking are
// not failures to advance, and the derivation counts them anyway. By the drain's first real
// look the derived count is already past the bound, so it stands down immediately and the
// wake turn never runs.
//
//   MEASURED: `multi-agent-project`, run `bms651uo8lh`, 0/3 with the retry lane used and the
//   runner's own verdict "NOT a flake". Every other clause of its target PASSED — assign
//   auto-task created, thread-linked, status complete, peer deliverable with the codeword,
//   deliverable arrived during orchestration — and only "final owner answer integrates
//   codeword" was false: the primary never woke to integrate what the peer had delivered.
//   Restored to the consecutive-pass ladder in `agent/runtime.ts`, GREEN again.
//
// WHAT A CORRECT DERIVATION WOULD NEED is an anchor for "when did this head BECOME the head",
// and no durable column in this tree records it. So the restart-safe home is still OWED, and
// the candidates are enumerated rather than left to be rediscovered:
//   * `work.attempts`               — REFUSED by `single-writer-conformance.test.ts` PART C,
//                                     which measured it as the recurrence fire count (one
//                                     writer, four readers, all aliasing it to `run_count`).
//                                     A retry count in the same integer ends the first
//                                     retried `after_count` schedule early.
//   * `messages.delivery_attempts`  — REFUSED on its own measurement: it is the engine
//                                     event's failed-DELIVERY counter and five of them expire
//                                     the event loudly. A head that failed to advance twice
//                                     is not a delivery that failed twice.
//   * a derivation from `turns`     — REFUSED above, by a reproducing battery red.
// Everything left needs DDL, and T9 was told to write no migration. The consequence, stated
// plainly: a crash loop still resets both `stuck` ladders to zero on each boot. What survives
// a restart today is the wake FRESHNESS bound (45 min), the engine-event EXPIRY horizon
// (6 h), and the boot staleness sweep — all three of which cap the same hazard by age rather
// than by count.

// ════════════════════════════════════════════════════════════════════════════════
// THE ONE CLOCK
// ════════════════════════════════════════════════════════════════════════════════

/**
 * The base tick. NOT an invented cadence: it is the period of the sweep interval this
 * module absorbs (`index.ts`'s 30-second timeout/approval interval), which is the shortest
 * existing obligation clock in the tree, and every kind below runs at an exact multiple of
 * it (30s × 10 = 5 min, 30s × 20 = 10 min). A kind whose period is not a multiple would be
 * a cadence somebody invented, and the test refuses it.
 */
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
    id: 'stale-override-and-verdict-requests',
    everyMs: 30_000,
    cadenceFrom:
      'the 30s scheduler tick (SCHEDULER_INTERVAL_MS, tracker/pm-agent.ts) that hosted both 12h sweeps inside checkScheduledTasks before this module owned them',
    wakes: false,
    run: async () => {
      const { sweepStaleRequests } = await import('../scheduler/runner.js');
      await sweepStaleRequests();
    },
  },
  {
    id: 'unservable-asks',
    everyMs: 5 * 60_000,
    cadenceFrom:
      "STUCK_AGENT_CHECK_MS (agent/runtime.ts) — the platform's declared period for repairing rows a dead or terminated actor left behind, which is exactly what an unservable ask is. T6 concern 6 asked for a periodic home and refused to invent a cadence (#14); this is the existing clock whose CLASS matches.",
    wakes: false,
    run: async () => {
      const { abandoned } = abandonUnservableAsks();
      if (abandoned > 0) {
        logger.warn('reaper: abandoned ask ticket(s) that could never be served or closed', { abandoned });
      }
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
];

// ════════════════════════════════════════════════════════════════════════════════
// THE BOOT PASS — the staleness sweep, unified under the same gate
// ════════════════════════════════════════════════════════════════════════════════

/** How many genuine human asks a single agent may hold before the boot sweep stops HOLDING
 *  them for the re-drain and treats the backlog as stale history. Carried verbatim from the
 *  block this function absorbed (`index.ts` 4b1, D11). */
const HUMAN_HOLD_LIMIT = 5;

/**
 * BOOT STALENESS SWEEP (incident 2026-07-02), moved here whole by PHASE-2 T9.
 *
 * When the box has been offline for a while its backlog fills with unanswered rows. The boot
 * re-drain and the runtime drains treat those as freshly waiting and would force-wake EVERY
 * agent into a mass "catch up on weeks of work" storm — agents re-running ancient reminders,
 * the healer backfilling a diagnostic per past day, a sub-agent publishing without approval.
 * Anything older than thirty minutes at boot is stale history, not in-flight work, and is
 * suppressed SILENTLY (the person has no context to judge "catch up on weeks of backlog?"
 * and one wrong yes is irreversible).
 *
 * ── WHAT "UNIFIES INTO THE SAME GATE" MEANT, AND WHAT WAS ALREADY TRUE ──
 * The plan step names a "messages-only vs store-twin divergence". That divergence is ALREADY
 * DEAD and it died at T6, not here: D-A step 4 had split engine events across two physical
 * tables, so this sweep needed a second arm or a stale row in the twin survived the restart;
 * T6 folded engine events into `messages` as `lane='events'` and deleted the store arm.
 * Verified rather than assumed — `git grep -n "agent_messages|inter_agent_messages"` over
 * `index.ts` returns only prose. What T9 unifies is the CLOCK and the OWNER: the sweep was a
 * hand-rolled block inside the boot sequence, three hundred lines from the four timers that
 * repeated its siblings, and it is now one of the reaper's own passes.
 *
 * SCOPE, unchanged: this touches `work` asks and `messages` events. It NEVER touches tracker
 * rows — those are the system of record, and the PM keeps picking up stale tasks at its
 * normal pace. Nothing is completed, paused, expired or deleted.
 *
 * ⚠ THE THIRTY MINUTES IS A FOURTEENTH LITERAL AND IT IS DELIBERATELY NOT MERGED. It has the
 * same VALUE as `DEADLINES.stale_task_window` (`STALE_TASK_WINDOW_MINUTES = 30`, loop.ts) and
 * a different MEANING — that one is "the window inside which a task counts as this session's",
 * this one is "older than a quick restart". PINNED §4 counted thirteen cliffs and did not
 * count this one. Merging two thresholds because they happen to be equal today is exactly the
 * invention #14 forbids, so it stays here, named, with its reason.
 */
export function sweepBootStaleness(): { suppressed: number; swept: number; heldTotal: number; heldAgents: number } {
  const db = getDb();
  // D11: how many stale UNANSWERED asks are genuine authorized-human ones? A quick restart
  // with a handful of these is a person waiting on an answer — HOLD those for the re-drain to
  // serve (never silently drop a question). A large backlog is stale history; suppress it.
  //
  // PHASE-2 T3 put this arm on the WORK SPINE. An unanswered human ask is
  // `work(kind='ask', state='open')`, not "a role='user' row whose conv_key is NULL", and
  // suppression is `abandoned` rather than a `swept_at` stamp on the message.
  // requirement preserved, all three parts: counted PER AGENT (a global count let 6 asks
  // across 6 agents all get swept), only SERVABLE rows counted (>= the agent's session start,
  // the re-drain's own floor — holding an unservable row parked it in limbo forever), and a
  // genuine just-before-restart message stays untouched because the 30-minute floor is
  // unchanged.
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

  // D8: EXCLUDE engine events still inside their delivery lifecycle (migration 084) — rows
  // carrying proof of an in-process delivery: a future retry backoff or 1-4 recorded
  // attempts. Only the D8 abort-revert path ever writes that state, so mass stale backlog
  // (the boot-storm class this sweep exists for) has `delivery_attempts = 0` /
  // `next_attempt_at` NULL and is swept silently exactly as before. The exclusion cannot
  // weaken the storm protection: `getPendingEngineEvent`'s own eligibility requires
  // `created_at` within `DEADLINES.engine_event_expiry` AND attempts under the max, so
  // nothing older than six hours can EVER wake an agent regardless of what survives here; an
  // in-lifecycle row past the horizon is disposed LOUDLY at the first eligibility consult.
  // Exhausted rows (attempts >= max) are not excluded.
  //
  // THE `IS NOT NULL` GUARD MATTERS: without it a NULL `next_attempt_at` makes the comparison
  // NULL, the OR NULL, the AND NULL, and NOT(NULL) is NULL = row skipped — which would shield
  // ALL plain engine backlog from the sweep (verified against an aged DB copy).
  //
  // T4: the row SELECTION is carried verbatim; it names the candidates and the writer
  // module's sweep does the disposal, re-applying its own two guards per row, so a row
  // claimed in between is still not ours.
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

/** Monotonic tick counter. A kind runs when the tick is a multiple of its own period. */
let tickCount = 0;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * ONE pass of the reaper. Exported (rather than hidden behind the timer) so the boot path
 * and the tests can drive it, and so "what did the reaper do" is answerable.
 *
 * Deliberately sequential: these sweeps write to the same database and two of them relay
 * messages. Running them in parallel would trade a bounded wall-clock cost for a class of
 * interleaving nobody has reasoned about.
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
      // Non-fatal by design: one sweep failing must not silence the other twelve cliffs.
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

/** Tests and shutdown only. */
export function stopReaper(): void {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
  tickCount = 0;
}
