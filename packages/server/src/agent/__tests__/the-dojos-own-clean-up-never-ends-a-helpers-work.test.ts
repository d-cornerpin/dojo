// The Dojo's own clean-up (a New Session, the boot staleness sweep) never ends a helper's work: a request a helper
// still works on stays and its helper is not stopped. A request whose helpers are done but whose card lingers may be
// reaped at a New Session; its card is not cancelled, and it is not owed in the new session.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { abandonUnservableAsks } from '../../work/store.js';
import { sweepBootStaleness } from '../../work/work-reaper.js';
import { nextOwed } from '../v2/owed.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { helperAnswers } from './helpers/text-relay.js';
import { delegated, pieceOf, settled, stateOf, stopped, task, ASK, AGENT, HELPER } from './helpers/call-off-world.js';

const newSession = (): void => { testDb().prepare("UPDATE agents SET session_started_at = datetime('now', '+1 minute') WHERE id = ?").run(AGENT); };

describe("the Dojo's own clean-up never ends a helper's work", () => {
  it('a New Session and a boot sweep leave a request a helper works on, and its helper, alone', async () => {
    delegated();
    testDb().prepare("UPDATE work SET state = 'open', opened_at = ? WHERE id = ?").run(Date.now() - 3_600_000, ASK);
    newSession();
    abandonUnservableAsks();
    await sweepBootStaleness();
    await settled();
    expect([stateOf(ASK), stateOf(pieceOf()), stateOf('task-helper-1'), stopped(HELPER)]).toEqual(['open', 'open', 'claimed', false]);
  });

  it('a request whose helper is done but whose card lingers is reaped at a New Session; the card stays and nothing is owed', async () => {
    delegated();
    task('card-own');
    await helperAnswers('Here is the camping list.');
    newSession();
    abandonUnservableAsks();
    await settled();
    expect([stateOf(ASK), stateOf('card-own'), nextOwed(AGENT)]).toEqual(['abandoned', 'claimed', []]);
  });
});
