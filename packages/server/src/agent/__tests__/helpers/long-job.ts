// A long job on the helper agent of `agent-requests.ts` (same mocks): a person's request arrives, each stretch runs
// through the real preflight, parks through the real park or ends as told, and finalize settles it.
import { HELPER, preflightCtx, testDb } from './agent-requests.js';

const product = async () => ({
  ...await import('../../../memory/message-store.js'), ...await import('../../../work/store.js'),
  ...await import('../../turn-context.js'), ...await import('../../v2/steps/preflight/index.js'),
  ...await import('../../v2/steps/teardown/finalize-record.js'), ...await import('../../v2/engine-exit.js'),
  ...await import('../../v2/state.js'), ...await import('../../../work/job-continuation.js'),
  ...await import('../../v2/steps/pre-call-gates/index.js'),
});

/** The owner writes on the dashboard; his request opens with the message. */
export async function ownerAsks(id: string, content = 'Rename every file in the archive folder'): Promise<string> {
  const { insertMessage, askIdForMessage } = await product();
  testDb().prepare(`INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
    VALUES ('conv-owner', ?, 'dashboard', NULL, 'owner', datetime('now'))`).run(HELPER);
  insertMessage({ id, agentId: HELPER, role: 'user', content, lane: 'owner', channel: 'dashboard', senderId: 'owner', conversationId: 'conv-owner' });
  return askIdForMessage(id);
}

/** How a stretch ends: it parks its job, it ends with nothing moved, it answers in its conversation, its first call
 *  meets a rate limit, the Dojo dies, or the real checkpoint gate decides at the stretch's first step. */
export type StretchEnd = 'parks' | 'stalls' | 'answers' | { limitUntil: number } | 'crash' | 'gate';
export interface StretchSeen { root: string | null; kind: string | undefined; servedJob: string | null; parkedOn: string | null }

/** One turn: null when the preflight found nothing to serve. `before` runs inside the turn, before it ends. */
export async function stretch(end: StretchEnd = 'parks', before?: () => unknown): Promise<StretchSeen | null> {
  const p = await product();
  p.endTurnContext(HELPER);
  const bag = p.openTurnContext(HELPER);
  const out = await p.runPreflight(bag, preflightCtx());
  if (out.directive !== 'proceed') { p.endTurnContext(HELPER); return null; }
  await before?.();
  let state = bag.state!;
  if (end === 'parks') { p.parkJob(HELPER, 'turn-budget-continuation', Date.now()); state = p.latchEngineCut(state, 'iteration_cap'); }
  if (end === 'stalls') state = p.latchEngineCut(state, 'iteration_cap');
  if (end === 'answers') {
    const id = `reply-${bag.turnNumber}`;
    p.insertMessage({ id, agentId: HELPER, role: 'assistant', content: 'All the archive files are renamed by their date now.', conversationId: bag.conversationId ?? null, turnNumber: bag.turnNumber });
    delivered(bag.turnNumber!, bag.conversationId ?? null, id);
    out.outputs.noteTerminalAnswer(id, 'the stretch\'s answer');
  }
  if (end === 'gate') state = (await p.runPreCallGates(p.advance(state, { loopCount: 1 }), out.outputs.preCallGatesContext())).state;
  if (typeof end === 'object') { bag.retryAt = end.limitUntil; state = p.advance(p.latchEngineCut(state, 'provider_error'), { loopCount: 1 }); }
  const seen = { root: bag.root?.id ?? null, kind: bag.root?.kind, servedJob: bag.servedJob, parkedOn: bag.jobParked };
  if (end !== 'crash') await p.finalizeTurnRecord(state, out.outputs.teardownContext());
  p.endTurnContext(HELPER);
  return seen;
}

/** A reply of turn `turn` delivered in `conversationId` (the dashboard's delivery record). */
export function delivered(turn: number, conversationId: string | null, messageId: string | null = null): void {
  testDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, message_id, created_at)
    VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, 'delivered', ?, datetime('now'))`).run(`d-${turn}-${Math.random()}`, HELPER, turn, conversationId, messageId);
}

export const rowOf = (id: string) => testDb().prepare('SELECT state, next_attempt_at AS due, hold_kind AS hold FROM work WHERE id = ?')
  .get(id) as { state: string; due: number | null; hold: string | null };
export const tasksOf = (messageId: string) => (testDb().prepare(
  "SELECT id FROM work WHERE kind = 'task' AND agent_id = ? AND source_message_id = ? ORDER BY opened_at").all(HELPER, messageId) as Array<{ id: string }>).map((r) => r.id);
