// A running turn as the product records it at its start: the in-memory bag, its `turns` row, the claim mark on
// the request it serves and the job mark on the job it carries (preflight/counterparty-and-record.ts).
import { getDb } from '../../../../db/connection.js';
import { openTurnContext, type TurnContext } from '../../../turn-context.js';
import { appendWorkEvent, askIdForMessage, stampClaimingTurn } from '../../../../work/store.js';

export function liveTurn(agentId: string, fields: Partial<TurnContext> & { turnNumber: number }): TurnContext {
  const ctx = Object.assign(openTurnContext(agentId), fields);
  const n = fields.turnNumber;
  const root = ctx.root ?? null;
  getDb().prepare(`INSERT OR IGNORE INTO turns (agent_id, turn_number, root_kind, root_id, source_message_id, answered)
    VALUES (?, ?, ?, ?, ?, 0)`).run(agentId, n, root?.kind ?? null, root?.id ?? null, root?.sourceMessageId ?? null);
  if (root?.kind === 'ask') stampClaimingTurn(askIdForMessage(root.id), n);
  if (ctx.servedJob) appendWorkEvent(ctx.servedJob, 'claim_turn', 'engine', { turn_number: n, agent_id: agentId, how: 'job' });
  return ctx;
}

const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/** A turn as its `turns` row records it, ended unless `open`, on the JS clock the rows written in it read; returns its number. */
export function turnRow(agentId: string, n: number, root: { kind: string; id: string } | null, open = false): number {
  getDb().prepare(`INSERT OR IGNORE INTO turns (agent_id, turn_number, root_kind, root_id, started_at, ended_at, exit_reason, answered)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(agentId, n, root?.kind ?? null, root?.id ?? null, sqlTime(Date.now() - 1000),
    open ? null : sqlTime(Date.now() + 1000), open ? null : 'answered');
  return n;
}
