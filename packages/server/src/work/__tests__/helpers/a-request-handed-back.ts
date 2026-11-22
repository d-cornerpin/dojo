// A person's request served by a turn, and that turn's end as finalize settles it. Each file mocks
// `db/connection.js` with the reply-sender fakes (`agent/v2/__tests__/helpers/reply-sender.ts`).
import { insertMessage } from '../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../store.js';
import { settleAsksAtTurnFinalize, RE_SERVE_MARKER, type FinalizeSettlementInput } from '../../ask-settlement.js';
import { testDb, AGENT } from '../../../agent/v2/__tests__/helpers/reply-sender.js';

export const CONV = 'conv-sam';

/** Sam writes on the dashboard; the request opens with the message. */
export function samAsks(id: string): string {
  testDb().prepare("INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, 'dashboard', 'dashboard', 'owner', 'Sam')")
    .run(CONV, AGENT);
  insertMessage({ id, agentId: AGENT, role: 'user', content: 'Compare the three quotes and tell me which to take', conversationId: CONV,
    channel: 'dashboard', senderId: 'owner', lane: 'owner' } as never);
  return askIdForMessage(id);
}

export function servedBy(id: string, turn: number): void {
  claimAsk(askIdForMessage(id), AGENT);
  stampClaimingTurn(askIdForMessage(id), turn);
}

/** The turn ends with `exit` and finalize settles every request it claimed. */
export function turnEnds(turn: number, exit: string, extra: Partial<FinalizeSettlementInput> = {}): void {
  const sql = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);   // the turn's clock is the claim's
  testDb().prepare(`INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
    VALUES (?, ?, ?, ?, ?, 0)`).run(AGENT, turn, sql(Date.now() - 60_000), sql(Date.now()), exit);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn, ...extra });
}

export const askOf = (id: string): { state: string; due: number | null } =>
  testDb().prepare('SELECT state, next_attempt_at AS due FROM work WHERE id = ?').get(askIdForMessage(id)) as { state: string; due: number | null };

/** The two counts on the request's own record: model silences, and engine cuts plus crashes. */
export function countsOf(id: string): { silence: number; engine: number } {
  const n = (causes: string): number => (testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
    AND json_extract(payload, '$.marker') = ? AND COALESCE(json_extract(payload, '$.cause'), 'silence') IN (${causes})`)
    .get(askIdForMessage(id), RE_SERVE_MARKER) as { n: number }).n;
  return { silence: n("'silence'"), engine: n("'cut', 'crash'") };
}
