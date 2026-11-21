// A helper's answer the Dojo passes back to a person who asked by text carries the helper's file, and its record
// is rooted in the person's request, in no turn of the agent's.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { relayPiecesWhole } from '../a2a-transport.js';
import { delegatedTextRequest, helperAnswers, relayRows, ASK } from './helpers/text-relay.js';

beforeEach(() => delegatedTextRequest());

describe('a relay carries the helper\'s file and is rooted in the request', () => {
  it('the queued relay names the request as its root, has no turn, and carries the file the helper handed back', async () => {
    const file = path.join(process.env.DOJO_HOME!, 'floor-plan.pdf');
    fs.writeFileSync(file, 'plan');
    // The piece lands after the helper's message and its files are saved, so its record names them.
    await helperAnswers('Free on the 14th; the floor plan is attached.', undefined, [file]);
    await relayPiecesWhole(ASK, 'compile', null);
    const [relay] = relayRows();
    expect(relay).toMatchObject({ tool: 'a2a-join-relay', outcome: 'pending', root_kind: 'ask', root_id: 'm-ask', turn_number: null });
    const files = JSON.parse(relay.payload_json).files as string[];
    expect(files).toHaveLength(1);
    expect(path.basename(files[0])).toMatch(/floor-plan\.pdf$/);
  });
});
