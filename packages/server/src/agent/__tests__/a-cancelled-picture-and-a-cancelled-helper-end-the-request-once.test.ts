// A request with a helper and a picture: cancelling one leaves the request open while the other still works; cancelling
// both ends it once, as his, with nobody told.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { setCancelled } from '../../services/generation-jobs.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { failedNotices } from './helpers/text-relay.js';
import { boardCancel, delegated, endedBy, settled, stateOf, ASK, AGENT } from './helpers/call-off-world.js';

const picture = (): void => { testDb().prepare(`INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, status, source_message_id)
  VALUES ('job-pic', 'image', ?, 'm', 'p', 'a tent', 'running', 'm-ask')`).run(AGENT); };

describe('a cancelled picture and a cancelled helper end the request once', () => {
  it("the helper's job cancelled first: the request goes on with its picture; the picture cancelled too: ended as his", async () => {
    delegated(); picture();
    expect(await boardCancel('task-helper-1')).toBe(200);
    await settled();
    expect([stateOf(ASK), failedNotices()]).toEqual(['blocked', 0]);
    setCancelled('job-pic');
    await settled();
    expect([endedBy(ASK), failedNotices()]).toEqual([{ state: 'abandoned', by: 'owner' }, 0]);
  });

  it("the picture cancelled first: the request waits on its helper; the helper's job cancelled too: ended as his", async () => {
    delegated(); picture();
    setCancelled('job-pic');
    await settled();
    expect(stateOf(ASK)).toBe('blocked');
    expect(await boardCancel('task-helper-1')).toBe(200);
    await settled();
    expect([endedBy(ASK), failedNotices()]).toEqual([{ state: 'abandoned', by: 'owner' }, 0]);
  });
});
