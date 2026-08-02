// ════════════════════════════════════════════════════════════════════════════════════════
// THE STEER QUEUE — PHASE-4 T3. The one-slot loss dies here.
//
// ── WHAT IT REPLACES, AND WHY ───────────────────────────────────────────────────────────
// `state.pendingNudge` was ONE string. 26 floors wrote it (§T0-PINS F), 23 of them
// unconditionally, and `advance()` is a bare `{...state, ...partial}` spread — so the last
// writer won BY CONSTRUCTION and every other steer fired that beat was destroyed silently.
// `engine-steer.ts` even wrote the rule down: *"the most recent steer wins … which is
// correct because these steers are one-shot per turn."* That last clause was false four
// ways at HEAD: two floors were not one-shot (a keyed latch and a counter), one had no
// latch at all, and two SHARED one flag so either silently disarmed the other.
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────────────────
// An ordered queue with a DECLARED precedence table. Two guards firing in one beat both
// deliver — highest precedence first, the other on the next iteration. Nothing is
// overwritten; a steer leaves the queue only by being CONFIRMED in the assembled array or
// by exhausting its delivery attempts, and both are recorded.
//
// Three properties the single slot could not have:
//   • ORDER IS DECLARED, not incidental. `STEER_PRECEDENCE` below is the whole table: a
//     truth guard (the model just told the user something false) outranks a silence floor,
//     which outranks loop health, which outranks bookkeeping, which outranks advice.
//   • LATCHES ARE KEYED ON QUEUE ENTRIES, not on booleans scattered through the loop. A
//     floor that has enqueued this turn IS latched — the record is the entry, so a steer
//     still waiting in the queue already counts as fired and cannot double up.
//   • DELIVERY IS RECORDED, not assumed. Phase 1 made delivery POSSIBLE (it removed the
//     unsatisfiable tail-shape gate). The drain marking an entry delivered on
//     `injectRegistryMessage` returning true only proves it was PUSHED — the array is
//     mutated afterwards. `markSteerDelivered` is called only once the receipt layer's own
//     `collectMessageLaneIds(messages)` shows the lane in the array the provider is handed.
//
// ── STAGED ENABLEMENT (research 22, binding) ────────────────────────────────────────────
// Turning 26 historically-contended behaviours on at once is the change nobody could
// diagnose. `enabledSteerGroups()` is the flag: a floor in an enabled group gets true queue
// semantics (RETAINED alongside its peers); a floor not yet enabled keeps the legacy
// last-writer-wins slot (its enqueue REPLACES the pending list, exactly as the spread did).
// At 0 groups this module is behaviour-identical to the single slot. One group per commit,
// the OR8 targeted set between groups. **The flag and BOTH branches are T6's deletion.**
//
// The ONE behaviour that is NOT staged, said out loud: the per-floor one-shot LATCH is
// always on. Twenty-four of the twenty-six floors already had one; without it the queue can
// accumulate duplicates of the same floor, which is a worse failure than the drop it
// replaces. The two floors that gain one (`compaction-recap`, which had none, and
// `a2a-missed-reply`'s no-assign-id branch, which had none) are named here rather than
// discovered later.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Every floor that may steer the model. One id per floor — never two floors sharing one. */
export type SteerFloorId =
  | 'ungrounded-claim' | 'delivery-denial' | 'failed-save-claim'
  | 'ghosted-ask' | 'ghosted-ask-answer' | 'silent-closeout' | 'delegation-exit'
  | 'start-ack' | 'start-ack-reminder' | 'owed-interrupt' | 'promise-floor'
  | 'a2a-handoff-floor' | 'a2a-missed-reply' | 'going-idle-in-progress'
  | 'empty-response' | 'thrash-gate' | 'thrash-drift' | 'spinning'
  | 'repetition' | 'no-results' | 'compaction-recap' | 'add-notes-stop'
  | 'tracker-stop-directive' | 'tracker-scaffold' | 'tracker-closeout' | 'hoarding-advisory';

export interface SteerFloorSpec {
  readonly id: SteerFloorId;
  /** Lower delivers first. Ties break on enqueue order (FIFO within a priority). */
  readonly priority: number;
  /** Staged-enablement group (1-7). T6 deletes the staging, not the priorities. */
  readonly group: number;
  /** Why this floor outranks the ones below it. */
  readonly why: string;
}

/**
 * THE DECLARED PRECEDENCE TABLE. Five bands, and the band is the argument:
 *   10s TRUTH GUARDS   — the model just told the user something untrue. Nothing outranks
 *                        stopping a false claim from standing.
 *   20s SILENCE FLOORS — a human is waiting and will hear nothing unless this delivers.
 *   40s LOOP HEALTH    — the turn is going wrong; the user is not owed anything yet.
 *   60s CONTINUITY     — the model's own working memory just changed under it.
 *   70s BOOKKEEPING    — the record is wrong; the user is unaffected.
 *   90s ADVICE         — explicitly non-blocking, and it says so in its own text.
 */
export const STEER_PRECEDENCE: readonly SteerFloorSpec[] = [
  { id: 'ungrounded-claim',      priority: 10, group: 1, why: 'reply claims a delivery no send tool made' },
  { id: 'delivery-denial',       priority: 11, group: 1, why: 'reply denies a send the receipt ledger recorded' },
  { id: 'failed-save-claim',     priority: 12, group: 1, why: 'reply claims a save every vault call rejected' },

  { id: 'ghosted-ask',           priority: 20, group: 2, why: 'a direct human ask ended in silence' },
  { id: 'ghosted-ask-answer',    priority: 21, group: 2, why: 'ghosted twice; hand the model its own recorded answer' },
  { id: 'silent-closeout',       priority: 22, group: 2, why: 'task completed, the asker heard nothing' },
  { id: 'delegation-exit',       priority: 23, group: 2, why: 'work handed off, the turn about to end silently' },

  { id: 'start-ack',             priority: 24, group: 3, why: 'the user has been waiting with no word this turn' },
  { id: 'start-ack-reminder',    priority: 25, group: 3, why: 'the first start-ack steer was ignored' },
  { id: 'owed-interrupt',        priority: 26, group: 3, why: 'a mid-turn human message may go unanswered' },
  { id: 'promise-floor',         priority: 27, group: 3, why: 'the reply promised work the turn never did' },

  { id: 'a2a-handoff-floor',     priority: 28, group: 4, why: 'user-facing turn ending silently after a handoff' },
  { id: 'a2a-missed-reply',      priority: 29, group: 4, why: 'a peer asked and got prose instead of a reply' },
  { id: 'going-idle-in-progress', priority: 30, group: 4, why: 'silent stop with in_progress work dangling' },

  { id: 'empty-response',        priority: 40, group: 5, why: 'the model returned nothing, twice' },
  { id: 'thrash-gate',           priority: 41, group: 5, why: 'a tool signature is now refused' },
  { id: 'thrash-drift',          priority: 42, group: 5, why: 'signature-varying spiral accruing to the hard limit' },
  { id: 'spinning',              priority: 43, group: 5, why: 'no progress across iterations' },

  { id: 'repetition',            priority: 44, group: 6, why: 'two identical responses in a row' },
  { id: 'no-results',            priority: 45, group: 6, why: 'consecutive searches returning nothing' },
  { id: 'compaction-recap',      priority: 60, group: 6, why: 'memory was rebuilt mid-turn under the model' },
  { id: 'add-notes-stop',        priority: 61, group: 6, why: 'went quiet after a note with the task still open' },

  { id: 'tracker-stop-directive', priority: 70, group: 7, why: 'multi-step work with no tracker entry' },
  { id: 'tracker-scaffold',      priority: 71, group: 7, why: 'the engine opened the work row itself' },
  { id: 'tracker-closeout',      priority: 72, group: 7, why: 'in_progress tasks left open on a non-user turn' },
  { id: 'hoarding-advisory',     priority: 90, group: 7, why: 'advice only — it never blocks and says so' },
];

const BY_ID = new Map<SteerFloorId, SteerFloorSpec>(STEER_PRECEDENCE.map((f) => [f.id, f]));

/** The floors that all nudge about the SAME subsystem, so one of them speaking is enough.
 *  This is the requirement the shared `nudgedForTrackerThisTurn` flag was carrying BESIDE
 *  its latch duty; splitting the latch per floor would have dropped it silently. */
export const TRACKER_STEER_FLOORS: readonly SteerFloorId[] = ['tracker-scaffold', 'tracker-stop-directive'];

/** How many times a steer may be pushed without the receipt confirming it before the queue
 *  gives up on it. Three, so a transient assembly drop is survived and a permanently
 *  un-injectable entry cannot block the queue behind it forever. */
export const MAX_STEER_DELIVERY_ATTEMPTS = 3;

export interface SteerEntry {
  readonly floor: SteerFloorId;
  readonly content: string;
  /** Latch key. `''` for a plain one-shot floor; the assign id / tool signature for a keyed one. */
  readonly key: string;
  readonly priority: number;
  /** Monotonic per turn — the FIFO tiebreak within a priority. */
  readonly seq: number;
  /** `state.loopCount` at enqueue. The start-ack reminder's gate reads it off the entry. */
  readonly atLoop: number;
  /** Pushes into the assembled array that the receipt did not confirm. */
  readonly attempts: number;
}

export interface SteerQueue {
  /** Waiting to be delivered, unordered here — `nextSteer` applies the table. */
  readonly pending: readonly SteerEntry[];
  /** THE LATCH. Every accepted enqueue, for the whole turn, delivered or not. */
  readonly fired: readonly SteerEntry[];
  /** Confirmed present in the array the provider was handed. */
  readonly delivered: readonly SteerEntry[];
  /** Steers written and never delivered — the honest record the single slot could not keep. */
  readonly abandoned: readonly SteerEntry[];
  readonly seq: number;
}

export function emptySteerQueue(): SteerQueue {
  return { pending: [], fired: [], delivered: [], abandoned: [], seq: 0 };
}

// ── Staged enablement ───────────────────────────────────────────────────────────────────

/** The number of groups turned on. Bumped by ONE per commit; ENABLED-ALL is 7. T6 deletes
 *  this constant, `enabledSteerGroups`, and the `else` branch in `enqueueSteer`. */
const ENABLED_GROUPS_DEFAULT = 1;

/** Test/ops override: `DOJO_STEER_GROUPS=0|1|…|7|all`. Both branches must stay exercisable
 *  by a test until T6 removes them, and a compile-time constant alone cannot do that. */
export const STEER_GROUPS_ENV = 'DOJO_STEER_GROUPS';

export function enabledSteerGroups(): number {
  const raw = process.env[STEER_GROUPS_ENV];
  if (raw == null || raw === '') return ENABLED_GROUPS_DEFAULT;
  if (raw.toLowerCase() === 'all') return Number.MAX_SAFE_INTEGER;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : ENABLED_GROUPS_DEFAULT;
}

/** True when this floor's steer is RETAINED beside its peers rather than replacing them. */
export function isSteerFloorEnabled(floor: SteerFloorId): boolean {
  const spec = BY_ID.get(floor);
  return spec != null && spec.group <= enabledSteerGroups();
}

// ── Latch reads (keyed on entries, never on booleans) ────────────────────────────────────

/** Has this floor already produced a steer this turn? A steer still WAITING counts. */
export function steerFired(q: SteerQueue, floor: SteerFloorId, key = ''): boolean {
  return q.fired.some((e) => e.floor === floor && e.key === key);
}

/** Has ANY of these floors steered this turn (the subsystem-level gate)? */
export function steerFiredAny(q: SteerQueue, floors: readonly SteerFloorId[]): boolean {
  return q.fired.some((e) => floors.includes(e.floor));
}

/** How many times this floor has steered this turn — the counter latch (`spinning`). */
export function steerFireCount(q: SteerQueue, floor: SteerFloorId): number {
  return q.fired.reduce((n, e) => (e.floor === floor ? n + 1 : n), 0);
}

/** The `loopCount` this floor first steered at, or null. */
export function steerFiredAtLoop(q: SteerQueue, floor: SteerFloorId): number | null {
  const hit = q.fired.find((e) => e.floor === floor);
  return hit ? hit.atLoop : null;
}

/**
 * The legacy slot-gate, for floors not yet enabled. Three sites read the slot before
 * writing (`compaction-recap` DROPPED itself when occupied; the two start-ack sites
 * DEFERRED). While a floor is disabled it keeps that behaviour exactly; once enabled the
 * gate is structurally false, because the queue holds both.
 */
export function steerQueueBlocks(q: SteerQueue, floor: SteerFloorId): boolean {
  return !isSteerFloorEnabled(floor) && q.pending.length > 0;
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────

export interface SteerRequest {
  readonly floor: SteerFloorId;
  readonly content: string;
  readonly key?: string;
  readonly atLoop: number;
}

/**
 * Enqueue a steer. The one-shot latch is checked FIRST and is never staged: a floor that
 * has already fired this turn (same key) is a no-op, and the caller gets its queue back
 * unchanged. Otherwise the entry is recorded in `fired` (the latch) and:
 *   • enabled floor  → APPENDED to `pending`; its peers survive. The point of the queue.
 *   • disabled floor → REPLACES `pending`; the legacy single slot, last writer wins.
 */
export function enqueueSteer(q: SteerQueue, req: SteerRequest): SteerQueue {
  const key = req.key ?? '';
  if (steerFired(q, req.floor, key)) return q;
  const spec = BY_ID.get(req.floor);
  if (!spec) return q; // unreachable: the id union is the table's own keys
  const entry: SteerEntry = {
    floor: req.floor, content: req.content, key,
    priority: spec.priority, seq: q.seq + 1, atLoop: req.atLoop, attempts: 0,
  };
  return {
    ...q,
    pending: isSteerFloorEnabled(req.floor) ? [...q.pending, entry] : [entry],
    fired: [...q.fired, entry],
    seq: q.seq + 1,
  };
}

/** The next steer to deliver: highest precedence, FIFO within a priority. */
export function nextSteer(q: SteerQueue): SteerEntry | null {
  if (q.pending.length === 0) return null;
  return [...q.pending].sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq))[0];
}

/** Confirmed in the array the provider was handed. It leaves `pending` and is recorded. */
export function markSteerDelivered(q: SteerQueue, entry: SteerEntry): SteerQueue {
  if (!q.pending.some((e) => e.seq === entry.seq)) return q;
  return {
    ...q,
    pending: q.pending.filter((e) => e.seq !== entry.seq),
    delivered: [...q.delivered, entry],
  };
}

/**
 * Pushed, and the receipt did NOT show it in the array. The attempt is counted; at
 * `MAX_STEER_DELIVERY_ATTEMPTS` the entry is ABANDONED rather than left to block the
 * queue behind it. Abandoned is a record, not a deletion: `fired` without `delivered` is
 * exactly "written, never seen by the model", which is the fact the single slot destroyed.
 */
export function markSteerAttempted(q: SteerQueue, entry: SteerEntry): SteerQueue {
  const attempts = entry.attempts + 1;
  if (attempts >= MAX_STEER_DELIVERY_ATTEMPTS) {
    return {
      ...q,
      pending: q.pending.filter((e) => e.seq !== entry.seq),
      abandoned: [...q.abandoned, { ...entry, attempts }],
    };
  }
  return { ...q, pending: q.pending.map((e) => (e.seq === entry.seq ? { ...e, attempts } : e)) };
}

/** Drop everything still waiting (the turn is giving up). Latches and records stand. */
export function clearSteerQueue(q: SteerQueue): SteerQueue {
  if (q.pending.length === 0) return q;
  return { ...q, pending: [], abandoned: [...q.abandoned, ...q.pending] };
}
