// ════════════════════════════════════════════════════════════════════════════════════════
// t158 F — THE AGENT'S OWN RECENT SENDS ARE AN ENGINE FACT ON EVERY TURN, NOT ONLY HUMAN ONES.
//
// Ritual run 6 (S1 variant B): a PM-assigned agent finished an audit on its a2a turn and sent the
// result with `send_to_agent` (a verified receipt exists), leaving its task in progress. The PM's
// idle poke started an ENGINE turn whose first call held a single message. That turn had no sign
// that it had already delivered, re-did the whole 600-page audit, and closed the task. (The
// owner's report #7: agents "reach back to try to do very old already accomplished tasks".)
//
// The RECENT OUTBOUND block was injected only when the counterparty was a user, though its own
// comment calls it "an engine fact that survives the conversation scoping". Engine turns (pokes,
// wakes) and agent-counterparty turns, scoped hardest, never got it. It now rides every agent turn.
// The deliveries lane (per-counterparty) and OPEN WORK stay as they were.
// ════════════════════════════════════════════════════════════════════════════════════════
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
vi.mock('../../../../../prompt/registry/assembler.js', () => ({ injectRegistryMessage: () => false }));

import { runMigrations } from '../../../../../db/migrations.js';
import { writeToolReceipt } from '../../../../../receipts/store.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { injectAndRecord, type PreCallInjectionInputs } from '../pre-call-injections.js';

const AGENT = 'worker-1';
type Msg = { role: 'user' | 'assistant'; content: string };

function inputsFor(messages: Msg[], counterparty: Record<string, unknown>): PreCallInjectionInputs {
  return {
    agentId: AGENT, turnNumber: 3, modelId: 'test-model',
    messages: messages as unknown as PreCallInjectionInputs['messages'],
    systemPrompt: 'you are worker-1',
    ctx: {} as PreCallInjectionInputs['ctx'], mctx: {} as PreCallInjectionInputs['mctx'],
    volatileFrom: 1,
    counterparty: counterparty as unknown as PreCallInjectionInputs['counterparty'],
    steerAwaitingConfirm: null,
    turnCtx: { agentId: AGENT, conversationId: null, root: null } as unknown as PreCallInjectionInputs['turnCtx'],
    db: mockDb.current as unknown as PreCallInjectionInputs['db'],
  };
}
const freshState = (): AgentTurnState => advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount: 1 });
const texts = (m: Msg[]): string[] => m.map((x) => String(x.content));

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  // The deliverable the agent already sent its PM.
  writeToolReceipt({
    agentId: AGENT, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id',
    recipient: 'Project Lead', sentText: 'DELIVERABLE: the audit of all 600 pages, findings attached.',
  } as never);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t158 F — RECENT OUTBOUND rides every agent turn', () => {
  it('an ENGINE turn (the PM\'s idle poke) carries the block, and it names the send', async () => {
    const messages: Msg[] = [{ role: 'user', content: '[System] Your task has been in progress for a while. Status?' }];
    await injectAndRecord(freshState(), inputsFor(messages, { kind: 'engine', name: 'engine' }));
    const block = texts(messages).find((t) => t.startsWith('RECENT OUTBOUND (engine-verified):'));
    expect(block, 'the engine turn is told what it already sent').toBeTruthy();
    expect(block).toContain('agent -> Project Lead');
  });

  it('an AGENT-counterparty turn carries it too', async () => {
    const messages: Msg[] = [{ role: 'user', content: 'Please re-run the audit.' }];
    await injectAndRecord(freshState(), inputsFor(messages, { kind: 'agent', name: 'Project Lead', agentId: 'pm-1' }));
    expect(texts(messages).some((t) => t.startsWith('RECENT OUTBOUND (engine-verified):'))).toBe(true);
  });

  it('a HUMAN turn is byte-unchanged: the same block, once, in the same place', async () => {
    const messages: Msg[] = [{ role: 'user', content: 'Where is the audit?' }];
    await injectAndRecord(freshState(), inputsFor(messages, { kind: 'user', id: 'owner', name: 'Owner', senderId: 'owner' }));
    const blocks = texts(messages).filter((t) => t.startsWith('RECENT OUTBOUND (engine-verified):'));
    expect(blocks).toHaveLength(1);
    expect(texts(messages)[1], 'it is the first thing injected after the conversation').toBe(blocks[0]);
  });

  it('an agent that sent nothing gets no block on any turn (empty is absent)', async () => {
    mockDb.current!.prepare('DELETE FROM tool_receipts').run();
    const messages: Msg[] = [{ role: 'user', content: '[System] Status?' }];
    await injectAndRecord(freshState(), inputsFor(messages, { kind: 'engine', name: 'engine' }));
    expect(texts(messages).some((t) => t.startsWith('RECENT OUTBOUND'))).toBe(false);
  });

  it('only the per-counterparty lanes stay human-only: an engine turn gets no OPEN WORK block from this door', async () => {
    const messages: Msg[] = [{ role: 'user', content: '[System] Status?' }];
    await injectAndRecord(freshState(), inputsFor(messages, { kind: 'engine', name: 'engine' }));
    expect(texts(messages).some((t) => t.startsWith('OPEN WORK'))).toBe(false);
  });
});
