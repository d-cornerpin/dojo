// A dead run's ask is handed back with what it left behind, and a delegated ask with its helpers' answers; both
// reach the turn whose root is that ask, delivered whole through the drain, never gisted as an events-lane row.
// The turn is also shown every other request in its assembled view whose helper answered, since it sees those rows.
import { askIdForMessage } from '../../../../work/store.js';
import { handBackFactsFor } from '../../../../work/hand-back-facts.js';
import { joinOrderFor } from '../../../a2a-transport.js';
import { assembledContextAsks } from '../../counterparty.js';
import { inheritedOwedListFor, INHERITED_NOTICE_INTENT } from '../../../../work/inherited-backlog.js';
import { getDb } from '../../../../db/connection.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import type { AgentTurnState } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import { broadcast } from '../../../../gateway/ws.js';

export function withHandBackFacts(state: AgentTurnState, turnCtx: TurnContext, agentId: string, turnNumber: number): AgentTurnState {
  const root = turnCtx.root;
  const askId = root?.kind === 'ask' && root.id ? askIdForMessage(root.id) : null;
  // The newest put-back of each request shown, every piece quoted whole.
  const inView = askId && turnCtx.convKey ? assembledContextAsks(agentId, turnCtx.convKey, new Date().toISOString()).map((a) => a.workId) : [];
  const orders = (askId ? [askId, ...inView.filter((id) => id !== askId)] : []).flatMap((id) => { const o = joinOrderFor(id); return o ? [{ askId: id, ...o }] : []; });
  const key = orders.length > 0 ? orders.map((o) => o.putBackId).join(',') : undefined;   // a latch only; nothing parses it
  if (steerFired(state.steerQueue, 'handed-back-ask', key)) return state;
  const facts = [askId ? handBackFactsFor(askId) : inheritedListDrivingThisTurn(turnCtx), ...orders.map((o) => o.text)].filter(Boolean).join('\n\n');
  if (!facts) return state;
  return persistEngineSteer(state, {
    agentId, content: facts, rowContent: orders.map((o) => o.firstLine).join('\n') || undefined, turnNumber, floor: 'handed-back-ask', key, atLoop: state.loopCount,
    shown: orders.map(({ askId: id, putBackId }) => ({ askId: id, putBackId })),
  }, { broadcast });
}

/** The inherited list, only on the turn the notice row drives (its stored row holds ids only). */
function inheritedListDrivingThisTurn(turnCtx: TurnContext): string | null {
  const { triggerMessageId: id } = turnCtx;   // the claim sites own the WRITE of this field (preflight/turn-classification.ts)
  if (!id) return null;
  const row = getDb().prepare('SELECT origin_intent AS intent, content FROM messages WHERE id = ?').get(id) as { intent: string | null; content: string } | undefined;
  return row?.intent === INHERITED_NOTICE_INTENT ? inheritedOwedListFor(row.content) : null;
}
