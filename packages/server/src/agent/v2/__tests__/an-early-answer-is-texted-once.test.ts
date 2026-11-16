// An answer the agent gives early in a long job (riding a tool call) is texted once: the turn's end does not text
// the same words again. A download link the answer left out still goes, as its own short line.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const ANSWER = 'The venue holds 120 people and is free on the 14th.';

beforeEach(() => {
  freshReplyDb(runMigrations);
});

describe('an early answer is texted once', () => {
  it('reaches the person once, though the turn ends with the same words in hand', async () => {
    const turn = imessageTurn();
    await turn.answerEarly(ANSWER);
    await turn.end();
    await deliverDueReplies(Date.now());
    expect(imessage.send.mock.calls).toEqual([[PERSON, ANSWER]]);
  });

  it('a download link the answer left out goes as its own line, after the answer', async () => {
    testDb().prepare("INSERT INTO turn_artifacts (id, agent_id, turn_number, kind, payload_json) VALUES ('l1', ?, 1, 'link', ?)")
      .run(AGENT, JSON.stringify({ url: 'https://example.com/d/plan.pdf' }));
    const turn = imessageTurn();
    await turn.answerEarly(ANSWER);
    await turn.end();
    await deliverDueReplies(Date.now());
    expect(imessage.send.mock.calls).toEqual([[PERSON, ANSWER], [PERSON, 'Download: https://example.com/d/plan.pdf']]);
  });
});
