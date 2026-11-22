// A reply that only promises to start is not pushed to "do the work now" while the owner holds the task behind the
// request, or while the request waits on a helper it was handed to; with no hold, or a hold the agent set itself, the
// promise floor steers as before.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), insertMessageIfAbsent: vi.fn(), insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));

import { runMigrations } from '../../../../../db/migrations.js';
import { getDb } from '../../../../../db/connection.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';
import { setHold } from '../../../../../work/done/hold.js';
import { openAsk, claimAsk, openDelegationJoin } from '../../../../../work/store.js';
import { endTurn, modelSays, steered } from './post-call-kit.js';
import { turnRow } from '../../../__tests__/helpers/live-turn.js';
import { FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const PROMISE = 'On it. I will start on the move plan now.';
const servingRequest = (id: string) => ({ root: { kind: 'ask', id, sourceMessageId: id, conversationId: 'conv-1' } });
const taskFor = (request: string): string => openTrackerTask({
  title: 'Plan the move', status: 'in_progress', assignedTo: FXID.n4, createdBy: FXID.n4,
  origin: { kind: 'user', sourceMessageId: request, turn: 7, convKey: 'ck-1' },
});

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR IGNORE INTO agents (id, name, status, classification) VALUES (?, 'the agent', 'idle', 'sensei')").run(FXID.n4);
});

describe('a promise to start and the owner\'s hold', () => {
  it('the owner holds the task behind the request: no steer', async () => {
    const request = randomUUID();
    expect(setHold(taskFor(request), 'paused', 'wait for my word', 'owner').ok).toBe(true);
    modelSays({ only_promises_to_start: true });
    expect(steered(await endTurn(PROMISE, [], undefined, servingRequest(request)))).not.toContain('promise-floor');
  });

  it('the task is not held: the promise is steered once', async () => {
    const request = randomUUID();
    taskFor(request);
    modelSays({ only_promises_to_start: true });
    expect(steered(await endTurn(PROMISE, [], undefined, servingRequest(request))).filter((f) => f === 'promise-floor')).toHaveLength(1);
  });

  it('the turn handed the request to a helper: "the helper is on it" is not steered to do the work itself', async () => {
    const request = randomUUID();
    const ask = openAsk({ agentId: FXID.n4, messageId: request, conversationId: null, requesterId: null, openedAt: Date.now(), title: null });
    claimAsk(ask, FXID.n4);
    openDelegationJoin({ parentWorkId: ask, agentId: FXID.n4, replyConversationId: null, ttlAt: Date.now() + 3_600_000,
      threads: [{ threadId: randomUUID(), assigneeAgent: 'agent-helper', intent: 'ASSIGN', hopCount: 0 }] });
    turnRow(FXID.n4, 7, { kind: 'ask', id: request }, true);   // the kit's turn, on the request
    modelSays({ only_promises_to_start: true });
    expect(steered(await endTurn("Helper's on it; I'll text you the short list when she reports back.", [], undefined, servingRequest(request)))).not.toContain('promise-floor');
    getDb().prepare('DELETE FROM turns WHERE agent_id = ?').run(FXID.n4);
  });

  it('a hold the agent set itself is not the owner\'s: the promise is steered', async () => {
    const request = randomUUID();
    expect(setHold(taskFor(request), 'blocked', 'waiting on the movers to call back', FXID.n4).ok).toBe(true);
    modelSays({ only_promises_to_start: true });
    expect(steered(await endTurn(PROMISE, [], undefined, servingRequest(request)))).toContain('promise-floor');
  });
});
