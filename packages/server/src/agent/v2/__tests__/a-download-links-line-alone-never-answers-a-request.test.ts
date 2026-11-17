// The "Download:" line that follows an early answer is not the answer: when the answer failed for good and only the
// links went, the request does not close as answered.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: { lastAssistantTextForIM: string }) => ({ ...s, lastAssistantTextForIM: `${s.lastAssistantTextForIM}\n\nDownload: https://example.com/menu.pdf` }) }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { queueReply } from '../deliveries.js';
import { freshReplyDb, imessage, replyRows, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, turnRow } from './helpers/text-request.js';
import { asTurn } from '../../turn-context.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { settleAsksAtTurnFinalize } from '../../../work/ask-settlement.js';
import { personTurn } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

/** An answer given early in turn 1, while the turn still runs, that fails all five tries. */
async function earlyAnswerFailsForGood(): Promise<void> {
  await queueReply({ agentId: AGENT, turnNumber: 1, root: { kind: 'ask', id: 'ask-1', sourceMessageId: null, conversationId: CONV }, text: 'the table is booked', address: { channel: 'imessage', to: PERSON } });
  imessage.send.mockResolvedValue(false);
  let now = Date.now();
  for (const wait of [30_000, 120_000, 600_000, 1_800_000, 0]) {
    await deliverDueReplies(now);
    now += wait;
  }
  imessage.send.mockResolvedValue(true);
  vi.setSystemTime(now);
}

const endTurnRecord = (): void => { testDb().prepare("UPDATE turns SET ended_at = datetime('now'), exit_reason = 'answered', answered = 1 WHERE turn_number = 1").run(); };

describe('a download links line alone never answers a request', () => {
  it('the links go, the answer did not: the request ends failed, not done', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1, false);
    await earlyAnswerFailsForGood();

    endTurnRecord();
    const [turnState, ctx] = personTurn('the table is booked', { channel: 'imessage' }, 1) as unknown as [never, { turnCtx: Record<string, unknown> }];
    ctx.turnCtx.earlyAnswerRowId = replyRows()[0].id;
    const root = { kind: 'ask' as const, id: 'ask-1', sourceMessageId: null, conversationId: CONV };
    await asTurn(AGENT, { turnNumber: 1, root, convKey: null }, () => routeTerminalReply(turnState, ctx as never));
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1 });
    await deliverDueReplies(Date.now());

    expect(imessage.send).toHaveBeenLastCalledWith(PERSON, 'Download: https://example.com/menu.pdf');
    expect(askRow(ask).state).toBe('failed');
  });
});
