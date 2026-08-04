// PHASE-4 T3 — the ordered steer queue.
//
// ── THE DEFECT THIS FILE OPENED WITH, AND ITS RED ───────────────────────────────────────
// The first clause below was written against the mechanism that existed (`state.pendingNudge`,
// one string) and run before anything was built. Its red, verbatim:
//
//   × THE ONE-SLOT LOSS > two guards firing in one beat BOTH deliver
//     AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]
//     - "[System: your reply says you already delivered something to Zorbek…]"
//       "[Engine receipt: you DID send iMessage to Zorbek 2 minutes ago…]"
//
// Both guards were composed, both were persisted, both were logged as sent, and the first
// one no longer existed. That is the loss, driven rather than argued.
//
// The clause is unchanged in what it ASSERTS. What changed is the mechanism underneath it.

import { describe, it, expect, afterEach } from 'vitest';
import type { WsEvent } from '@dojo/shared';
import { persistEngineSteer } from '../engine-steer.js';
import { initState, type AgentTurnState } from '../state.js';
import {
  clearSteerQueue, emptySteerQueue, enqueueSteer, markSteerAttempted, markSteerDelivered,
  nextSteer, steerFireCount, steerFired, steerFiredAny, steerFiredAtLoop,
  MAX_STEER_DELIVERY_ATTEMPTS, STEER_PRECEDENCE, TRACKER_STEER_FLOORS,
  type SteerQueue,
} from '../steer-queue.js';

function freshState(): AgentTurnState {
  return initState({
    agentId: 'steer-queue-test',
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'claude-sonnet-4-6',
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    imFlagSetAtRunStart: false,
    lastUserMessageContent: null,
  });
}

const deps = {
  insertRow: () => null,
  broadcast: (_e: WsEvent) => undefined,
} as unknown as Parameters<typeof persistEngineSteer>[2];

// PHASE-4 T6: `enableAll()` / `enableNone()` and the `afterEach` that cleared
// `DOJO_STEER_GROUPS` are DELETED with the flag. Every clause below now runs against the
// one behaviour the module has — retention — instead of declaring which of two it wanted.

/**
 * Every steer this state can still deliver to the model, in DELIVERY ORDER — one per
 * iteration, exactly as the loop drains it. This is the helper the red above ran against;
 * back then its whole body was `s.pendingNudge ? [s.pendingNudge] : []`.
 */
function deliverable(s: AgentTurnState): string[] {
  const out: string[] = [];
  let q = s.steerQueue;
  for (let entry = nextSteer(q); entry != null; entry = nextSteer(q)) {
    out.push(entry.content);
    q = markSteerDelivered(q, entry);
  }
  return out;
}

const GUARD_A = '[System: your reply says you already delivered something to Zorbek…]';
const GUARD_B = '[Engine receipt: you DID send iMessage to Zorbek 2 minutes ago…]';

describe('THE ONE-SLOT LOSS', () => {
  it('two guards firing in one beat BOTH deliver', () => {
    let s = freshState();
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_A, turnNumber: 3, floor: 'ungrounded-claim', atLoop: 1 }, deps);
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_B, turnNumber: 3, floor: 'delivery-denial', atLoop: 1 }, deps);
    // Both were composed, both were persisted, both were logged as sent — and both can
    // still reach the model, in the order the precedence table declares.
    expect(deliverable(s)).toEqual([GUARD_A, GUARD_B]);
  });

  it('they deliver in DECLARED precedence order, not in the order they fired', () => {
    let s = freshState();
    // Advisory first, truth guard second. Precedence, not arrival, decides.
    s = persistEngineSteer(s, { agentId: 'a1', content: 'advice', turnNumber: 3, floor: 'hoarding-advisory', atLoop: 1 }, deps);
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_A, turnNumber: 3, floor: 'ungrounded-claim', atLoop: 1 }, deps);
    expect(deliverable(s)).toEqual([GUARD_A, 'advice']);
  });

  it('ACROSS ITERATIONS: draining one leaves the rest queued, never dropped', () => {
    let q = emptySteerQueue();
    q = enqueueSteer(q, { floor: 'ungrounded-claim', content: 'first', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'silent-closeout', content: 'second', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'repetition', content: 'third', atLoop: 1 });

    // Iteration 1 delivers exactly one entry; two survive untouched.
    const one = nextSteer(q)!;
    expect(one.content).toBe('first');
    q = markSteerDelivered(q, one);
    expect(q.pending.map((e) => e.content)).toEqual(['second', 'third']);

    // Iteration 2, then 3.
    q = markSteerDelivered(q, nextSteer(q)!);
    expect(q.pending.map((e) => e.content)).toEqual(['third']);
    q = markSteerDelivered(q, nextSteer(q)!);
    expect(q.pending).toEqual([]);
    expect(q.delivered.map((e) => e.content)).toEqual(['first', 'second', 'third']);
  });

  it('FIFO within one priority band (the tiebreak is arrival, and it is deterministic)', () => {
    let q = emptySteerQueue();
    // Two keyed entries of the SAME floor share a priority; the earlier one wins.
    q = enqueueSteer(q, { floor: 'thrash-gate', content: 'sig-A', key: 'A', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'thrash-gate', content: 'sig-B', key: 'B', atLoop: 1 });
    expect(nextSteer(q)!.content).toBe('sig-A');
  });
});

describe('the declared precedence table', () => {
  it('is a real table: unique ids, unique priorities, every priority argued', () => {
    const ids = STEER_PRECEDENCE.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const priorities = STEER_PRECEDENCE.map((f) => f.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    for (const f of STEER_PRECEDENCE) {
      expect(f.why.length).toBeGreaterThan(10); // a priority with no argument is a number
    }
  });

  it('covers the whole re-derived steer surface: 26 staged + 1 converted + 1 new noun = 28 floors', () => {
    // §T0-PINS F derived 26 setting sites at `1249866`, re-derived unchanged by T3.
    //
    // PHASE-4 T4 adds the 27th, and the number moved for a reason worth stating rather than
    // just re-pinning: `reminder-silence` was NOT a steer at all when T3 counted. It was an
    // ENGINE-COMPOSED user-facing line — the engine delivering `Reminder: <the work row's own
    // description>` on the owner's lane — so a writer-derived inventory of the steer surface
    // could not see it, exactly as §T0-PINS F could not see the 27th steer DOOR. OR2's
    // conversion turns it into a floor, which is what puts it in this table.
    //
    // PHASE-4 T6: the group HISTOGRAM that stood here (seven groups of 3-5) went with the
    // staged-enablement flag. Its job was that the rollout stayed diagnosable — one group
    // per commit, a red readable against 3-5 floors — and the rollout is over. What the
    // clause still owes is the COUNT and the identity of the converted floor, both below.
    // PHASE-6 T-PROMISE adds the 28th, and it is neither a staged floor nor a conversion:
    // `uncommitted-promise` is NEW BEHAVIOUR, the fourth truth guard, and it says so. It is
    // the same grounding guard as `ungrounded-claim` with the noun changed from a SEND to a
    // PROMISE — the thing the kit scenario's `knownFailing` and `task-T0C-report.md` §7
    // hand-up 4 both asked for and neither had an owner for. THE COUNT WAS RAISED BECAUSE A
    // FLOOR WAS ADDED, never to make a red go away: the clause below names the addition, so
    // a future +1 with no name beside it still fails.
    expect(STEER_PRECEDENCE.length).toBe(28);
    expect(STEER_PRECEDENCE.filter((f) => f.id === 'reminder-silence').length).toBe(1);
    expect(STEER_PRECEDENCE.filter((f) => f.id === 'uncommitted-promise').length).toBe(1);
  });

  it('PHASE-6 T-PROMISE: the promise guard sits in the TRUTH band, below the three sends and above every silence floor', () => {
    const p = (id: string) => STEER_PRECEDENCE.find((f) => f.id === id)!.priority;
    // Below the three that are about something the person was told happened IN THE WORLD…
    expect(p('failed-save-claim')).toBeLessThan(p('uncommitted-promise'));
    // …and above every silence floor, because "the promise is recorded" is a statement of
    // fact and it is untrue, which outranks a turn merely ending quietly.
    expect(p('uncommitted-promise')).toBeLessThan(p('ghosted-ask'));
    expect(p('uncommitted-promise')).toBeLessThan(p('promise-floor'));
  });

  it('the converted reminder floor ranks with the silence floors, above the start-ack band', () => {
    const p = (id: string) => STEER_PRECEDENCE.find((f) => f.id === id)!.priority;
    // A person set an alarm: the words are the whole point of the turn, so it outranks the
    // "you have been waiting" ack and everything below it, and yields to the truth guards.
    expect(p('ungrounded-claim')).toBeLessThan(p('reminder-silence'));
    expect(p('reminder-silence')).toBeLessThan(p('start-ack'));
  });

  it('a truth guard outranks a silence floor outranks loop health outranks advice', () => {
    const p = (id: string) => STEER_PRECEDENCE.find((f) => f.id === id)!.priority;
    expect(p('ungrounded-claim')).toBeLessThan(p('silent-closeout'));
    expect(p('silent-closeout')).toBeLessThan(p('repetition'));
    expect(p('repetition')).toBeLessThan(p('tracker-closeout'));
    expect(p('tracker-closeout')).toBeLessThan(p('hoarding-advisory'));
  });
});

describe('per-floor latches, keyed on QUEUE ENTRIES', () => {
  it('a floor that already fired this turn is a no-op, and the queue comes back unchanged', () => {
    let q = enqueueSteer(emptySteerQueue(), { floor: 'promise-floor', content: 'once', atLoop: 1 });
    const again = enqueueSteer(q, { floor: 'promise-floor', content: 'twice', atLoop: 2 });
    expect(again).toBe(q); // identity: nothing was built, nothing was recorded
    expect(steerFireCount(q, 'promise-floor')).toBe(1);
  });

  it('THE LATCH COUNTS A STEER THAT IS STILL WAITING — this is what a boolean could not do', () => {
    const q = enqueueSteer(emptySteerQueue(), { floor: 'silent-closeout', content: 'x', atLoop: 1 });
    expect(steerFired(q, 'silent-closeout')).toBe(true);  // fired…
    expect(q.delivered).toEqual([]);                       // …and not yet delivered
  });

  it('a KEYED floor latches per key (the A2A enforcer: one nudge per assign id)', () => {
    let q = enqueueSteer(emptySteerQueue(), { floor: 'a2a-missed-reply', content: 'n1', key: 'assign-1', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'a2a-missed-reply', content: 'n2', key: 'assign-2', atLoop: 1 });
    expect(q.pending.length).toBe(2);
    expect(steerFired(q, 'a2a-missed-reply', 'assign-1')).toBe(true);
    expect(steerFired(q, 'a2a-missed-reply', 'assign-3')).toBe(false);
    // The branch that has NO assign id latches on the empty key — §T0-PINS F's "no latch
    // at all" case, closed.
    q = enqueueSteer(q, { floor: 'a2a-missed-reply', content: 'n3', key: '', atLoop: 1 });
    const blocked = enqueueSteer(q, { floor: 'a2a-missed-reply', content: 'n4', key: '', atLoop: 2 });
    expect(blocked).toBe(q);
  });

  it('a COUNTER latch (spinning) fires more than once and reports its own count', () => {
    let q = emptySteerQueue();
    q = enqueueSteer(q, { floor: 'spinning', content: 's1', key: 'loop-1', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'spinning', content: 's2', key: 'loop-2', atLoop: 2 });
    expect(steerFireCount(q, 'spinning')).toBe(2);
  });

  it('TWO FLOORS NEVER SHARE A LATCH — the tracker pair, whose one flag disarmed either', () => {
    let q = enqueueSteer(emptySteerQueue(), { floor: 'tracker-scaffold', content: 'scaffolded', atLoop: 1 });
    // The OLD defect: this set `nudgedForTrackerThisTurn`, so the STOP directive below
    // could never fire in the same turn even though it is a different fact.
    expect(steerFired(q, 'tracker-stop-directive')).toBe(false);
    q = enqueueSteer(q, { floor: 'tracker-stop-directive', content: 'stop', atLoop: 2 });
    expect(q.pending.length).toBe(2);
    // …while the SUBSYSTEM-level gate the shared flag was ALSO carrying still holds: one
    // of them having spoken is enough to skip the block.
    expect(steerFiredAny(q, TRACKER_STEER_FLOORS)).toBe(true);
  });

  it('records the loop the floor fired at (the start-ack reminder reads it off the entry)', () => {
    const q = enqueueSteer(emptySteerQueue(), { floor: 'start-ack', content: 'ack', atLoop: 4 });
    expect(steerFiredAtLoop(q, 'start-ack')).toBe(4);
    expect(steerFiredAtLoop(q, 'start-ack-reminder')).toBeNull();
  });
});

describe('delivered-to-model is RECORDED, not assumed', () => {
  function pushed(): { q: SteerQueue; entry: ReturnType<typeof nextSteer> } {
    const q = enqueueSteer(emptySteerQueue(), { floor: 'ghosted-ask', content: 'speak', atLoop: 1 });
    return { q, entry: nextSteer(q) };
  }

  it('a confirmed entry leaves pending and lands in delivered', () => {
    const { q, entry } = pushed();
    const after = markSteerDelivered(q, entry!);
    expect(after.pending).toEqual([]);
    expect(after.delivered.map((e) => e.content)).toEqual(['speak']);
  });

  it('an UNCONFIRMED push stays queued — it rides the next iteration instead of vanishing', () => {
    const { q, entry } = pushed();
    const after = markSteerAttempted(q, entry!);
    expect(after.pending.length).toBe(1);
    expect(after.pending[0].attempts).toBe(1);
    expect(after.delivered).toEqual([]);
  });

  it('after MAX attempts it is ABANDONED — recorded as written-and-never-seen, never silent', () => {
    let { q } = pushed();
    for (let i = 0; i < MAX_STEER_DELIVERY_ATTEMPTS; i++) q = markSteerAttempted(q, nextSteer(q)!);
    expect(q.pending).toEqual([]);
    expect(q.abandoned.map((e) => e.content)).toEqual(['speak']);
    expect(q.delivered).toEqual([]);
    // fired-without-delivered is the fact the single slot destroyed. It survives here.
    expect(steerFired(q, 'ghosted-ask')).toBe(true);
  });

  it('negative control: marking an entry this queue does not hold changes nothing', () => {
    const { q, entry } = pushed();
    const other = { ...entry!, seq: 999 };
    expect(markSteerDelivered(q, other)).toBe(q);
  });

  it('negative control: an empty queue offers nothing to drain', () => {
    expect(nextSteer(emptySteerQueue())).toBeNull();
  });

  it('giving up on the turn abandons what is waiting, on the record', () => {
    let q = enqueueSteer(emptySteerQueue(), { floor: 'repetition', content: 'r', atLoop: 1 });
    q = clearSteerQueue(q);
    expect(q.pending).toEqual([]);
    expect(q.abandoned.map((e) => e.content)).toEqual(['r']);
  });
});

// ── STRIP (PHASE-4 T6, 2026-08-02): the `STAGED ENABLEMENT — both branches` describe ──
// Four clauses died with the flag they existed to exercise:
//   • "with NO groups enabled the queue IS the single slot: the second write destroys the
//     first" — it asserted the one-slot loss still worked on demand;
//   • "a DISABLED floor still latches";
//   • "the slot-gate is live for a disabled floor and structurally dead for an enabled one";
//   • "the flag reads groups by number, so one group turns on per commit".
// requirement preserved: the latch is never staged and always on — carried by the
// `per-floor latches, keyed on QUEUE ENTRIES` describe above, which asserts the same fact
// on the only branch that now exists. The destroys-the-first clause has no requirement to
// preserve: it pinned the behaviour this phase was built to delete.
