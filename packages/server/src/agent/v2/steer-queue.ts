// Ordered steers, declared precedence: floors firing in one beat all deliver, highest first. An entry
// leaves when confirmed in the assembled array or out of attempts; each floor latches once per turn per key.

import { withAuthorHead } from './steer-author-head.js';
/** Every floor that may steer the model. One id per floor, never two floors sharing one. */
export type SteerFloorId =
  | 'ungrounded-claim' | 'delivery-denial' | 'failed-save-claim' | 'uncommitted-promise'
  | 'false-delivery-claim' | 'handed-back-ask'
  | 'forced-reply' | 'delegation-exit'
  | 'start-ack' | 'start-ack-reminder' | 'owed-interrupt' | 'promise-floor'
  | 'a2a-missed-reply' | 'going-idle-in-progress'
  | 'output-grind' | 'empty-response' | 'dead-end' | 'add-notes-stop'
  | 'tracker-stop-directive' | 'tracker-scaffold' | 'hoarding-advisory'
  | 'redundant-closeout' | 'near-duplicate-reply';

export interface SteerFloorSpec {
  readonly id: SteerFloorId;
  /** Lower delivers first. Ties break on enqueue order (FIFO within a priority). */
  readonly priority: number;
  readonly why: string;
}

/** Bands: 10s truth guards, 20s silence floors (a human is waiting), 40s loop health, 60s continuity,
 *  70s bookkeeping, 90s advice (never blocks). */
export const STEER_PRECEDENCE: readonly SteerFloorSpec[] = [
  { id: 'ungrounded-claim',      priority: 10, why: 'reply claims a delivery no send tool made' },
  { id: 'delivery-denial',       priority: 11, why: 'reply denies a send the receipt ledger recorded' },
  { id: 'failed-save-claim',     priority: 12, why: 'reply claims a save every vault call rejected' },
  { id: 'uncommitted-promise',   priority: 13, why: 'reply says the promise is recorded and the work ledger holds nothing' },
  // Reads this turn's tool results: dojo_report writes no deliveries row, so guard 10 cannot see it.
  { id: 'false-delivery-claim',  priority: 14, why: 'reply says the artifact was delivered and the only tool that could send it ERRORED this turn' },

  { id: 'forced-reply',          priority: 20, why: 'the turn is ending with nothing said to the person waiting; the reply is required' },
  { id: 'delegation-exit',       priority: 23, why: 'work handed off, the turn about to end silently' },

  { id: 'start-ack',             priority: 25, why: 'the user has been waiting with no word this turn' },
  { id: 'start-ack-reminder',    priority: 26, why: 'the first start-ack steer was ignored' },
  { id: 'owed-interrupt',        priority: 27, why: 'a mid-turn human message may go unanswered' },
  { id: 'promise-floor',         priority: 28, why: 'the reply promised work the turn never did' },

  { id: 'a2a-missed-reply',      priority: 30, why: 'a peer asked and got prose instead of a reply' },
  { id: 'going-idle-in-progress', priority: 31, why: 'silent stop with in_progress work dangling' },
  { id: 'handed-back-ask',       priority: 32, why: 'a person waits on a message a dead run handed back: what it already did and may have sent come before acting' },

  // Above empty-response: a call that burned its whole output budget must not be diagnosed as an empty one.
  { id: 'output-grind',          priority: 39, why: 'the model spent its whole output budget reasoning, with no tool call and no answer' },
  { id: 'empty-response',        priority: 40, why: 'the model returned nothing, twice' },
  { id: 'dead-end',              priority: 43, why: 'consecutive passes whose every call came back empty or refused' },
  // Priority 60 (compaction-recap, retired) is never reused.
  { id: 'add-notes-stop',        priority: 61, why: 'went quiet after a note with the task still open' },

  { id: 'tracker-stop-directive', priority: 70, why: 'multi-step work with no tracker entry' },
  { id: 'tracker-scaffold',      priority: 71, why: 'the engine opened the work row itself' },
  // These two hold the reply once and state the fact; written again, the reply goes out.
  { id: 'redundant-closeout',    priority: 73, why: 'a short final line after this turn already delivered its answer' },
  { id: 'near-duplicate-reply',  priority: 74, why: 'a final reply matching one already sent' },
  { id: 'hoarding-advisory',     priority: 90, why: 'advice only — it never blocks and says so' },
];

const BY_ID = new Map<SteerFloorId, SteerFloorSpec>(STEER_PRECEDENCE.map((f) => [f.id, f]));

/** The table is the one authority on steer order; other orderings sort by this, never keep a copy. */
export function steerPriority(floor: SteerFloorId): number {
  return BY_ID.get(floor)!.priority;
}

/** Floors that nudge about the same subsystem (the tracker), so one of them speaking is enough. */
export const TRACKER_STEER_FLOORS: readonly SteerFloorId[] = ['tracker-scaffold', 'tracker-stop-directive'];

/** Unconfirmed pushes before an entry is abandoned, so one un-injectable steer cannot block the queue. */
export const MAX_STEER_DELIVERY_ATTEMPTS = 3;

export interface SteerEntry {
  readonly floor: SteerFloorId;
  readonly content: string;
  /** Latch key. `''` for a plain one-shot floor; the assign id / tool signature for a keyed one. */
  readonly key: string;
  readonly priority: number;
  /** Monotonic per turn: the FIFO tiebreak within a priority. */
  readonly seq: number;
  /** `state.loopCount` at enqueue. The start-ack reminder's gate reads it off the entry. */
  readonly atLoop: number;
  readonly attempts: number;
}

export interface SteerQueue {
  /** Waiting to be delivered, unordered here; `nextSteer` applies the table. */
  readonly pending: readonly SteerEntry[];
  /** THE LATCH. Every accepted enqueue, for the whole turn, delivered or not. */
  readonly fired: readonly SteerEntry[];
  readonly delivered: readonly SteerEntry[];
  /** Steers written and never delivered. */
  readonly abandoned: readonly SteerEntry[];
  readonly seq: number;
}

export function emptySteerQueue(): SteerQueue {
  return { pending: [], fired: [], delivered: [], abandoned: [], seq: 0 };
}

/** Has this floor already produced a steer this turn? A steer still WAITING counts. */
export function steerFired(q: SteerQueue, floor: SteerFloorId, key = ''): boolean {
  return q.fired.some((e) => e.floor === floor && e.key === key);
}

export function steerFiredAny(q: SteerQueue, floors: readonly SteerFloorId[]): boolean {
  return q.fired.some((e) => floors.includes(e.floor));
}

export function steerFiredAtLoop(q: SteerQueue, floor: SteerFloorId): number | null {
  const hit = q.fired.find((e) => e.floor === floor);
  return hit ? hit.atLoop : null;
}

export interface SteerRequest {
  readonly floor: SteerFloorId;
  readonly content: string;
  readonly key?: string;
  readonly atLoop: number;
}

/** Enqueue a steer unless this floor (same key) already fired this turn; pending peers survive. */
export function enqueueSteer(q: SteerQueue, req: SteerRequest): SteerQueue {
  const key = req.key ?? '';
  if (steerFired(q, req.floor, key)) return q;
  const spec = BY_ID.get(req.floor);
  if (!spec) return q; // unreachable: the id union is the table's own keys
  const entry: SteerEntry = {
    floor: req.floor, content: withAuthorHead(req.content), key,
    priority: spec.priority, seq: q.seq + 1, atLoop: req.atLoop, attempts: 0,
  };
  return {
    ...q,
    pending: [...q.pending, entry],
    fired: [...q.fired, entry],
    seq: q.seq + 1,
  };
}

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

/** Pushed but not confirmed: count the attempt, and at the limit move it to `abandoned`, a record. */
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

/** Abandon a giving-up ladder's own pending entries only: an earlier truth guard must not burn with them.
 *  The family is required so a rung can never widen its reach by leaving it off. */
export function clearSteerQueueFor(q: SteerQueue, floors: readonly SteerFloorId[]): SteerQueue {
  const mine = q.pending.filter((e) => floors.includes(e.floor));
  if (mine.length === 0) return q;
  return {
    ...q,
    pending: q.pending.filter((e) => !floors.includes(e.floor)),
    abandoned: [...q.abandoned, ...mine],
  };
}
