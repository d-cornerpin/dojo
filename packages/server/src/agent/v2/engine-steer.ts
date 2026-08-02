// RC-19: the single sanctioned channel for an engine DIRECTIVE that expects the
// model to ACT on its text.
//
// The memory assembler strips role='system' rows from model context, so a bare
// system row is "dashboard-only theater": it shows up in logs and the dashboard
// while the model never sees it. Every such steer must reach the model via
// the steer queue (drained next iteration into a synthetic user message, the same
// mechanism the thrash gate documents at loop.ts). The recurring failure (F-18,
// the recurrence half of F-7) was that this rule lived as a comment and a list of
// corrected sites, so a new bare-system steer could always be written again. This
// helper collapses both writes into one call: any engine directive goes through
// here, and the paired conformance test (engine-steer.test.ts) fails the build if a
// new bare-system imperative steer is added without it.
//
// Keep the persisted row + broadcast for dashboard visibility; the QUEUE ENTRY is the
// load-bearing, model-visible delivery.
//
// PHASE-4 T3: the paragraph that stood here taught the rule this task deleted — that the
// newest steer overwriting the field was CORRECT because every steer was one-shot per
// turn. It was false four ways at the HEAD that carried it (§T0-PINS F: two floors were
// not one-shot, one had no latch, two shared a flag), and a comment teaching a deleted
// rule is a live instruction to the next writer. The sentence is GONE, not amended, so
// the phase-exit grep finds nothing to find. Steers now go
// into an ORDERED QUEUE with a declared precedence table (`steer-queue.ts`): two guards
// firing in one beat both deliver, highest precedence first, across iterations.

import { v4 as uuidv4 } from 'uuid';
import type { Message, WsEvent } from '@dojo/shared';
import { insertMessageIfAbsent, type NewMessage, type Persisted } from '../../memory/message-store.js';
import { advance, type AgentTurnState } from './state.js';
import { enqueueSteer, type SteerFloorId } from './steer-queue.js';

export interface EngineSteerDeps {
  broadcast: (event: WsEvent) => void;
  /** PHASE-1 T4: the steer row goes through the single writer, which holds its own
   *  connection — so the old `db` handle is gone from this interface and the seam the
   *  conformance test needs is the WRITE ITSELF. Defaulted, so production call sites
   *  pass only `broadcast`; the RC-19 test substitutes it to prove the row is still
   *  written with role='system' and the steer's content. */
  insertRow?: (m: NewMessage) => Persisted | null;
}

export interface EngineSteerParams {
  agentId: string;
  content: string;
  turnNumber: number;
  /** Which floor is speaking. Its priority and its one-shot latch both come from the
   *  declared table in `steer-queue.ts` — the site no longer carries a boolean of its own. */
  floor: SteerFloorId;
  /** `state.loopCount` at the moment the floor fired (the entry records it). */
  atLoop: number;
  /** Latch key for a KEYED floor (the A2A enforcer latches per assign id). Absent = one-shot. */
  key?: string;
}

/**
 * Persist an engine steer as BOTH a dashboard-visible role='system' row AND a
 * model-visible QUEUE ENTRY. Returns the advanced state with the steer enqueued.
 *
 * The row + broadcast are best-effort (a DB hiccup must not drop the turn); the queue
 * entry in the returned state is the delivery that actually reaches the model, so it is
 * always enqueued regardless of whether the row write succeeded. A floor that has already
 * fired this turn gets its queue back unchanged — the latch lives on the entry.
 */
export function persistEngineSteer(
  state: AgentTurnState,
  params: EngineSteerParams,
  deps: EngineSteerDeps,
): AgentTurnState {
  const { agentId, content, turnNumber } = params;
  const id = uuidv4();
  try {
    (deps.insertRow ?? insertMessageIfAbsent)({ id, agentId, role: 'system', content, turnNumber });
    const message: Message = {
      id,
      agentId,
      role: 'system',
      content,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    };
    deps.broadcast({ type: 'chat:message', agentId, message });
  } catch {
    /* dashboard visibility is best-effort; the queue entry below is the real delivery */
  }
  return advance(state, {
    steerQueue: enqueueSteer(state.steerQueue, {
      floor: params.floor, content, key: params.key, atLoop: params.atLoop,
    }),
  });
}
