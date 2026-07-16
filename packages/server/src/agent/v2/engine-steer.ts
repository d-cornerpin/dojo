// RC-19: the single sanctioned channel for an engine DIRECTIVE that expects the
// model to ACT on its text.
//
// The memory assembler strips role='system' rows from model context, so a bare
// system row is "dashboard-only theater": it shows up in logs and the dashboard
// while the model never sees it. Every such steer must reach the model via
// `pendingNudge` (injected next iteration as a synthetic user message, the same
// mechanism the thrash gate documents at loop.ts). The recurring failure (F-18,
// the recurrence half of F-7) was that this rule lived as a comment and a list of
// corrected sites, so a new bare-system steer could always be written again. This
// helper collapses both writes into one call: any engine directive goes through
// here, and the paired conformance test (engine-steer.test.ts) fails the build if a
// new bare-system imperative steer is added without it.
//
// Keep the persisted row + broadcast for dashboard visibility; the pendingNudge is
// the load-bearing, model-visible delivery. Single-pending-nudge semantics match
// the thrash gate / going-idle sites: the most recent steer wins (advance overwrites
// the field), which is correct because these steers are one-shot per turn.

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Message, WsEvent } from '@dojo/shared';
import { advance, type AgentTurnState } from './state.js';

export interface EngineSteerDeps {
  db: Database.Database;
  broadcast: (event: WsEvent) => void;
}

export interface EngineSteerParams {
  agentId: string;
  content: string;
  turnNumber: number;
  /**
   * Extra one-shot turn flags to set alongside `pendingNudge` (e.g. the site's
   * `nudgedForXThisTurn` guard). Merged into the same atomic `advance`.
   */
  extra?: Partial<AgentTurnState>;
}

/**
 * Persist an engine steer as BOTH a dashboard-visible role='system' row AND a
 * model-visible `pendingNudge`. Returns the advanced state with `pendingNudge`
 * (and any `extra` flags) set.
 *
 * The row + broadcast are best-effort (a DB hiccup must not drop the turn); the
 * `pendingNudge` in the returned state is the delivery that actually reaches the
 * model, so it is always set regardless of whether the row write succeeded.
 */
export function persistEngineSteer(
  state: AgentTurnState,
  params: EngineSteerParams,
  deps: EngineSteerDeps,
): AgentTurnState {
  const { agentId, content, turnNumber } = params;
  const id = uuidv4();
  try {
    deps.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at) VALUES (?, ?, 'system', ?, ?, datetime('now'))`,
      )
      .run(id, agentId, content, turnNumber);
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
    /* dashboard visibility is best-effort; pendingNudge below is the real delivery */
  }
  return advance(state, { ...(params.extra ?? {}), pendingNudge: content });
}
