// While a helper's answer waits to go to the person, the request is not owed by the agent (not on its open work, no
// compile duty) and the compile drive does not climb to a stuck notice or the platform's ghost line.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { resolveCompilePendingJoins } from '../a2a-transport.js';
import { openObligations } from '../../work/store.js';
import { stillCompileOwed } from '../v2/compile-owed-gate.js';
import { testDb, AGENT } from '../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperAnswers, relayRows, requestState, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

const ladder = () => testDb().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND json_extract(payload, '$.entry_kind') IS NOT NULL",
).get(ASK) as { n: number };

describe('a relay waiting to go is not called stuck or owed', () => {
  it('the drive leaves it alone and the agent owes nothing, however long it waits', async () => {
    await helperAnswers('The venue is free on the 14th.');
    expect(relayRows().map((r) => r.outcome)).toEqual(['pending']);
    for (let i = 0; i < 8; i++) expect(await resolveCompilePendingJoins(AGENT)).toEqual({ drives: 0, wakeWanted: false });
    expect(ladder().n).toBe(0);
    expect(requestState()).toBe('blocked');
    expect(openObligations(AGENT).map((o) => o.id)).not.toContain(ASK);
    expect(stillCompileOwed([ASK])).toEqual([]);
  });

  it('CONTROL: with no relay on its way, the request is owed', async () => {
    expect(openObligations(AGENT).map((o) => o.id)).toContain(ASK);
  });
});
