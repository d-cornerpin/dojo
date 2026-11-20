// The single sanctioned channel for an engine directive; the paired conformance test fails a bypass.
// The assembler strips role='system' rows from model context, so only the steer-queue entry reaches it.

import { v4 as uuidv4 } from 'uuid';
import type { Message, WsEvent } from '@dojo/shared';
import { insertMessageIfAbsent, type NewMessage, type Persisted } from '../../memory/message-store.js';
import { advance, type AgentTurnState } from './state.js';
import { enqueueSteer, type SteerFloorId, type SteerShown } from './steer-queue.js';

export interface EngineSteerDeps {
  broadcast: (event: WsEvent) => void;
  // Defaulted seam the conformance test substitutes to prove the row is written (role='system').
  insertRow?: (m: NewMessage) => Persisted | null;
}

export interface EngineSteerParams {
  agentId: string;
  content: string;
  turnNumber: number;
  // Which floor is speaking: its priority and one-shot latch come from the declared table
  // in `steer-queue.ts`; the site carries no boolean of its own.
  floor: SteerFloorId;
  atLoop: number;
  /** Latch key for a KEYED floor (the A2A enforcer latches per assign id). Absent = one-shot. */
  key?: string;
  /** The stored row's text when it differs from the delivered steer (a long order is stored as its first line). */
  rowContent?: string;
  /** The request whose put-back this steer carries; recorded as shown when the steer reaches a model call. */
  shown?: SteerShown;
}

// Row and broadcast are best-effort; the queue entry is the always-enqueued delivery; the latch dedups.
export function persistEngineSteer(
  state: AgentTurnState,
  params: EngineSteerParams,
  deps: EngineSteerDeps,
): AgentTurnState {
  const { agentId, content, turnNumber } = params;
  const rowContent = params.rowContent ?? content;
  const id = uuidv4();
  try {
    (deps.insertRow ?? insertMessageIfAbsent)({ id, agentId, role: 'system', content: rowContent, turnNumber });
    const message: Message = {
      id,
      agentId,
      role: 'system',
      content: rowContent,
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
      floor: params.floor, content, key: params.key, atLoop: params.atLoop, shown: params.shown,
    }),
  });
}
