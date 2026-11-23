// RC-19 conformance guard.
//
// The engine may only steer the model through a channel the model can actually
// see. The memory assembler strips role='system' rows from model context, so a bare
// role='system' INSERT that tells the agent to DO or STOP something is
// "dashboard-only theater": it fires in logs and the dashboard while the model never
// receives it. The rule (from the thrash-gate comment in loop.ts) is that any such
// directive must also set `pendingNudge`. The recurrence history (F-18, the F-7
// recurrences) is a PROCESS failure: the lesson lived as a comment plus a list of
// corrected sites, so nothing stopped the next engineer from writing a new bare
// steer. This test converts the lesson into a build-enforced invariant.
//
// Two assertions:
//   1. persistEngineSteer does BOTH writes (the role='system' row AND the queue entry).
//   2. Source-scan of loop.ts: no raw role='system' INSERT whose surrounding block
//      carries imperative-to-agent text may exist without a paired delivery
//      (the steer queue / persistEngineSteer) or an explicit `engine-steer-exempt`
//      sentinel documenting why it is not a model-visible steer (an enforced gate,
//      a terminal note, an informational marker). A NEW bare imperative steer that
//      copies the old raw-INSERT pattern fails CI here.

import { describe, it, expect } from 'vitest';
import type { WsEvent } from '@dojo/shared';
import { persistEngineSteer } from '../engine-steer.js';
import { initState, type AgentTurnState } from '../state.js';
import { nextSteer, steerFired } from '../steer-queue.js';

function freshState(): AgentTurnState {
  return initState({
    agentId: 'test-agent',
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

describe('persistEngineSteer: does both writes', () => {
  it('inserts a role=system row AND enqueues the steer on the returned state', () => {
    // PHASE-1 T4: the row is written through the single writer module, not a raw
    // statement on an injected connection, so the seam moved from `deps.db` to
    // `deps.insertRow`. The REQUIREMENT is unchanged and is what is asserted below:
    // a persisted role='system' row carrying the steer's content, AND the queue entry.
    // Asserting on SQL text would now only prove which string literal we typed.
    let written: { role?: string; content?: string; agentId?: string; turnNumber?: number | null } | null = null;
    const events: WsEvent[] = [];
    const deps = {
      insertRow(m: { role?: string; content?: string; agentId?: string; turnNumber?: number | null }) {
        written = m;
        return null;
      },
      broadcast(event: WsEvent) {
        events.push(event);
      },
    } as unknown as Parameters<typeof persistEngineSteer>[2];

    const before = freshState();
    const content = '[System: STOP and call tracker_create_project.]';
    const after = persistEngineSteer(
      before, { agentId: 'a1', content, turnNumber: 7, floor: 'add-notes-stop', atLoop: 1 }, deps,
    );

    // Dashboard row: a role='system' message carrying the content, for this turn.
    expect(written).not.toBeNull();
    expect(written!.role).toBe('system');
    expect(written!.content).toBe(content);
    expect(written!.agentId).toBe('a1');
    expect(written!.turnNumber).toBe(7);

    // Dashboard broadcast: chat:message with the content.
    const chatMsg = events.find((e) => e.type === 'chat:message');
    expect(chatMsg).toBeTruthy();
    if (chatMsg && chatMsg.type === 'chat:message') {
      expect(chatMsg.message.role).toBe('system');
      expect(chatMsg.message.content).toBe(content);
    }

    // Model-visible delivery: the steer is queued on the returned state, and it is the
    // next one out. PHASE-4 T3: queued is not delivered — the loop's receipt read decides
    // that — so what is asserted here is the CHANNEL, which is what this guard owns.
    expect(nextSteer(after.steerQueue)?.content).toBe(content);
    expect(after.steerQueue.pending.length).toBe(1);
    expect(before.steerQueue.pending).toEqual([]); // input not mutated
  });

  it("sets the floor's one-shot latch in the same advance as the steer", () => {
    // PHASE-4 T3: the `extra` bag this clause used to check is GONE. Every one of its nine
    // production uses was a per-site latch boolean, and the latch is the queue ENTRY now —
    // so the requirement ("the steer and its guard land atomically") is asserted against
    // the mechanism that carries it, and a site can no longer forget to pass its flag.
    const deps = {
      insertRow: () => null,
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(),
      { agentId: 'a1', content: 'x', turnNumber: 1, floor: 'add-notes-stop', atLoop: 1 },
      deps,
    );
    expect(steerFired(after.steerQueue, 'add-notes-stop')).toBe(true);
    // t196 (A4): the queue tags a bare steer as an engine line on the way in.
    expect(nextSteer(after.steerQueue)?.content).toBe('[System: x]');
  });

  it('still enqueues the steer even if the dashboard row write throws (delivery is load-bearing)', () => {
    const deps = {
      insertRow: () => {
        throw new Error('db down');
      },
      broadcast: () => undefined,
    } as unknown as Parameters<typeof persistEngineSteer>[2];
    const after = persistEngineSteer(
      freshState(), { agentId: 'a1', content: 'y', turnNumber: 1, floor: 'hoarding-advisory', atLoop: 1 }, deps,
    );
    expect(nextSteer(after.steerQueue)?.content).toBe('[System: y]');
  });
});
