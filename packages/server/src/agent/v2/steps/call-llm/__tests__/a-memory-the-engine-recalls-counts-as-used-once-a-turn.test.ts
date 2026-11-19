// A memory the engine shows as relevant counts as used once in the turn it reaches the model, however
// many model calls that turn makes; a recall block that did not reach the model counts nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { injectAndRecord, type PreCallInjectionInputs } from '../pre-call-injections.js';

const AGENT = 'worker-1';
const RECALL = '[RELEVANT MEMORY]\n- [vault:note] Gate code: 4410';

function inputsFor(recallLane: string | null): PreCallInjectionInputs {
  return {
    agentId: AGENT, turnNumber: 3, modelId: 'test-model',
    messages: [{ role: 'user', content: 'What is the gate code?' }] as unknown as PreCallInjectionInputs['messages'],
    systemPrompt: 'you are worker-1',
    ctx: { recallLane, recalledVaultIds: ['mem-gate'] } as PreCallInjectionInputs['ctx'],
    mctx: {} as PreCallInjectionInputs['mctx'],
    volatileFrom: 1,
    counterparty: { kind: 'engine', name: 'engine' } as unknown as PreCallInjectionInputs['counterparty'],
    steerAwaitingConfirm: null,
    turnCtx: { agentId: AGENT, conversationId: null, root: null } as unknown as PreCallInjectionInputs['turnCtx'],
    db: mockDb.current as unknown as PreCallInjectionInputs['db'],
  };
}
const freshState = (): AgentTurnState => advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount: 1 });
const uses = (): number => (mockDb.current!.prepare("SELECT retrieval_count FROM vault_entries WHERE id = 'mem-gate'").get() as { retrieval_count: number }).retrieval_count;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  mockDb.current.prepare(`INSERT INTO vault_entries (id, agent_id, type, content, source) VALUES ('mem-gate', ?, 'note', 'Gate code: 4410', 'agent')`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a memory the engine recalls counts as used once a turn', () => {
  it('three model calls in one turn count one use', async () => {
    let state = freshState();
    for (let call = 1; call <= 3; call++) {
      state = (await injectAndRecord(advance(state, { loopCount: call }), inputsFor(RECALL))).state;
    }
    expect(uses()).toBe(1);
    expect(mockDb.current!.prepare("SELECT last_retrieved_at FROM vault_entries WHERE id = 'mem-gate'").get()).toMatchObject({ last_retrieved_at: expect.any(String) });
  });

  it('a recall block that did not reach the model counts nothing', async () => {
    await injectAndRecord(freshState(), inputsFor(null));
    expect(uses()).toBe(0);
  });
});
