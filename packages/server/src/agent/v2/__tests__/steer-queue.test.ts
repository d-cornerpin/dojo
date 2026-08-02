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
  nextSteer, steerFireCount, steerFired, steerFiredAny, steerFiredAtLoop, steerQueueBlocks,
  MAX_STEER_DELIVERY_ATTEMPTS, STEER_GROUPS_ENV, STEER_PRECEDENCE, TRACKER_STEER_FLOORS,
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

/** All groups on — the state this task leaves the flag in, and T6 deletes. */
function enableAll(): void { process.env[STEER_GROUPS_ENV] = 'all'; }
/** No groups on — the legacy single slot, which the staged default must be identical to. */
function enableNone(): void { process.env[STEER_GROUPS_ENV] = '0'; }
afterEach(() => { delete process.env[STEER_GROUPS_ENV]; });

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
    enableAll();
    let s = freshState();
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_A, turnNumber: 3, floor: 'ungrounded-claim', atLoop: 1 }, deps);
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_B, turnNumber: 3, floor: 'delivery-denial', atLoop: 1 }, deps);
    // Both were composed, both were persisted, both were logged as sent — and both can
    // still reach the model, in the order the precedence table declares.
    expect(deliverable(s)).toEqual([GUARD_A, GUARD_B]);
  });

  it('they deliver in DECLARED precedence order, not in the order they fired', () => {
    enableAll();
    let s = freshState();
    // Advisory first, truth guard second. Precedence, not arrival, decides.
    s = persistEngineSteer(s, { agentId: 'a1', content: 'advice', turnNumber: 3, floor: 'hoarding-advisory', atLoop: 1 }, deps);
    s = persistEngineSteer(s, { agentId: 'a1', content: GUARD_A, turnNumber: 3, floor: 'ungrounded-claim', atLoop: 1 }, deps);
    expect(deliverable(s)).toEqual([GUARD_A, 'advice']);
  });

  it('ACROSS ITERATIONS: draining one leaves the rest queued, never dropped', () => {
    enableAll();
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
    enableAll();
    let q = emptySteerQueue();
    // Two keyed entries of the SAME floor share a priority; the earlier one wins.
    q = enqueueSteer(q, { floor: 'thrash-gate', content: 'sig-A', key: 'A', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'thrash-gate', content: 'sig-B', key: 'B', atLoop: 1 });
    expect(nextSteer(q)!.content).toBe('sig-A');
  });
});

describe('the declared precedence table', () => {
  it('is a real table: unique ids, unique priorities, every floor in a group', () => {
    const ids = STEER_PRECEDENCE.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const priorities = STEER_PRECEDENCE.map((f) => f.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    for (const f of STEER_PRECEDENCE) {
      expect(f.group).toBeGreaterThanOrEqual(1);
      expect(f.why.length).toBeGreaterThan(10); // a priority with no argument is a number
    }
  });

  it('covers the whole re-derived steer surface (26 floors) in staged groups of 3-4', () => {
    // §T0-PINS F derived 26 setting sites at `1249866`, re-derived unchanged at this HEAD.
    expect(STEER_PRECEDENCE.length).toBe(26);
    const groups = new Map<number, number>();
    for (const f of STEER_PRECEDENCE) groups.set(f.group, (groups.get(f.group) ?? 0) + 1);
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const [, size] of groups) {
      expect(size).toBeGreaterThanOrEqual(3);
      expect(size).toBeLessThanOrEqual(4);
    }
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
    enableAll();
    let q = enqueueSteer(emptySteerQueue(), { floor: 'promise-floor', content: 'once', atLoop: 1 });
    const again = enqueueSteer(q, { floor: 'promise-floor', content: 'twice', atLoop: 2 });
    expect(again).toBe(q); // identity: nothing was built, nothing was recorded
    expect(steerFireCount(q, 'promise-floor')).toBe(1);
  });

  it('THE LATCH COUNTS A STEER THAT IS STILL WAITING — this is what a boolean could not do', () => {
    enableAll();
    const q = enqueueSteer(emptySteerQueue(), { floor: 'silent-closeout', content: 'x', atLoop: 1 });
    expect(steerFired(q, 'silent-closeout')).toBe(true);  // fired…
    expect(q.delivered).toEqual([]);                       // …and not yet delivered
  });

  it('a KEYED floor latches per key (the A2A enforcer: one nudge per assign id)', () => {
    enableAll();
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
    enableAll();
    let q = emptySteerQueue();
    q = enqueueSteer(q, { floor: 'spinning', content: 's1', key: 'loop-1', atLoop: 1 });
    q = enqueueSteer(q, { floor: 'spinning', content: 's2', key: 'loop-2', atLoop: 2 });
    expect(steerFireCount(q, 'spinning')).toBe(2);
  });

  it('TWO FLOORS NEVER SHARE A LATCH — the tracker pair, whose one flag disarmed either', () => {
    enableAll();
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
    enableAll();
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
    enableAll();
    const { q, entry } = pushed();
    const after = markSteerDelivered(q, entry!);
    expect(after.pending).toEqual([]);
    expect(after.delivered.map((e) => e.content)).toEqual(['speak']);
  });

  it('an UNCONFIRMED push stays queued — it rides the next iteration instead of vanishing', () => {
    enableAll();
    const { q, entry } = pushed();
    const after = markSteerAttempted(q, entry!);
    expect(after.pending.length).toBe(1);
    expect(after.pending[0].attempts).toBe(1);
    expect(after.delivered).toEqual([]);
  });

  it('after MAX attempts it is ABANDONED — recorded as written-and-never-seen, never silent', () => {
    enableAll();
    let { q } = pushed();
    for (let i = 0; i < MAX_STEER_DELIVERY_ATTEMPTS; i++) q = markSteerAttempted(q, nextSteer(q)!);
    expect(q.pending).toEqual([]);
    expect(q.abandoned.map((e) => e.content)).toEqual(['speak']);
    expect(q.delivered).toEqual([]);
    // fired-without-delivered is the fact the single slot destroyed. It survives here.
    expect(steerFired(q, 'ghosted-ask')).toBe(true);
  });

  it('negative control: marking an entry this queue does not hold changes nothing', () => {
    enableAll();
    const { q, entry } = pushed();
    const other = { ...entry!, seq: 999 };
    expect(markSteerDelivered(q, other)).toBe(q);
  });

  it('negative control: an empty queue offers nothing to drain', () => {
    expect(nextSteer(emptySteerQueue())).toBeNull();
  });

  it('giving up on the turn abandons what is waiting, on the record', () => {
    enableAll();
    let q = enqueueSteer(emptySteerQueue(), { floor: 'repetition', content: 'r', atLoop: 1 });
    q = clearSteerQueue(q);
    expect(q.pending).toEqual([]);
    expect(q.abandoned.map((e) => e.content)).toEqual(['r']);
  });
});

describe('STAGED ENABLEMENT — both branches, until T6 deletes the flag', () => {
  it('with NO groups enabled the queue IS the single slot: the second write destroys the first', () => {
    enableNone();
    let q = enqueueSteer(emptySteerQueue(), { floor: 'ungrounded-claim', content: GUARD_A, atLoop: 1 });
    q = enqueueSteer(q, { floor: 'delivery-denial', content: GUARD_B, atLoop: 1 });
    // The legacy behaviour, preserved exactly — and the loss is now VISIBLE (`abandoned`
    // is empty, `fired` holds two, `pending` holds one), which it never was before.
    expect(q.pending.map((e) => e.content)).toEqual([GUARD_B]);
    expect(q.fired.length).toBe(2);
  });

  it('a DISABLED floor still latches — the one behaviour that is deliberately not staged', () => {
    enableNone();
    const q = enqueueSteer(emptySteerQueue(), { floor: 'promise-floor', content: 'p', atLoop: 1 });
    expect(enqueueSteer(q, { floor: 'promise-floor', content: 'p2', atLoop: 2 })).toBe(q);
  });

  it('the slot-gate is live for a disabled floor and structurally dead for an enabled one', () => {
    let q = emptySteerQueue();
    enableAll();
    q = enqueueSteer(q, { floor: 'ungrounded-claim', content: 'x', atLoop: 1 });
    expect(steerQueueBlocks(q, 'compaction-recap')).toBe(false);
    enableNone();
    expect(steerQueueBlocks(q, 'compaction-recap')).toBe(true);
  });

  it('the flag reads groups by number, so one group turns on per commit', () => {
    process.env[STEER_GROUPS_ENV] = '1';
    let q = enqueueSteer(emptySteerQueue(), { floor: 'ungrounded-claim', content: 'g1', atLoop: 1 });
    // group 1 is on → retained beside a peer…
    q = enqueueSteer(q, { floor: 'delivery-denial', content: 'g1b', atLoop: 1 });
    expect(q.pending.length).toBe(2);
    // …a group-2 floor is still legacy, so its write replaces the lot.
    q = enqueueSteer(q, { floor: 'silent-closeout', content: 'g2', atLoop: 1 });
    expect(q.pending.map((e) => e.content)).toEqual(['g2']);
  });
});
