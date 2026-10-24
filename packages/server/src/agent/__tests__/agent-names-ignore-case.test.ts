// ════════════════════════════════════════════════════════════════════════════════════════
// E21 — AGENT NAMES IGNORE CAPITAL LETTERS, EVERYWHERE AN AGENT IS FOUND BY NAME.
//
// Most doors already resolved a name case-insensitively (`resolveAgentRef`). Three did not, and
// the difference is invisible to the person who typed the name: an agent called "Worker-B" was
// reachable as "Worker-B" but "worker-b" answered "No agent found", the transport silently
// dropped the same message, and the Healer's boot cleanup left a clone whose name differed from
// its own by one capital letter.
//
// A typical owner's expectation: a name is a name. The same agent answers to it however it is
// capitalised, a miss says which live names it might have meant, and two agents that differ only
// by case do not make the send ambiguous (the newest wins, and the sender is told which).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])),
  queueEmbedding: vi.fn(),
}));
const handleMessage = vi.fn(async () => undefined);
vi.mock('../runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage }),
}));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { agentsHandlers } from '../tools/cat/agents.js';

const SENDER = 'sender-agent';

function addAgent(id: string, name: string, createdAt: string, status = 'idle'): void {
  mockDb.current!.prepare(
    `INSERT INTO agents (id, name, model_id, status, config, session_started_at, created_at) VALUES (?, ?, 'm', ?, '{}', '1970-01-01', ?)`,
  ).run(id, name, status, createdAt);
}

const sendToAgent = (args: Record<string, unknown>) =>
  agentsHandlers['send_to_agent']({ agentId: SENDER, args } as unknown as Parameters<(typeof agentsHandlers)['send_to_agent']>[0]);

const envelope = (toAgent: string) => ({
  intent: 'FYI' as const, threadId: '', requiresResponse: false, payload: 'a note for you', toAgent, fromAgent: SENDER,
});

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  addAgent(SENDER, 'Sender', '2026-01-01 00:00:00');
  addAgent('wb-1', 'Worker-B', '2026-01-02 00:00:00');
  addAgent('wc-1', 'Worker-C', '2026-01-02 00:00:00');
  handleMessage.mockClear();
});

describe('E21 — the transport finds an agent by name without regard to case', () => {
  it('toAgent "WORKER-B" reaches the agent called "Worker-B"', async () => {
    const r = await deliverA2AMessage(envelope('WORKER-B'));
    expect(r.reason).toBeUndefined();
    expect(r.delivered).toBe(true);
  });

  it('the exact spelling still works', async () => {
    expect((await deliverA2AMessage(envelope('Worker-B'))).delivered).toBe(true);
  });

  it('a name that matches no live agent is still dropped as not found', async () => {
    const r = await deliverA2AMessage(envelope('worker-z'));
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('AGENT_NOT_FOUND');
  });

  it('a terminated agent is not found by any capitalisation', async () => {
    addAgent('wd-1', 'Worker-D', '2026-01-02 00:00:00', 'terminated');
    expect((await deliverA2AMessage(envelope('worker-d'))).reason).toBe('AGENT_NOT_FOUND');
  });
});

describe('E21 — send_to_agent finds an agent by name without regard to case', () => {
  it('"worker-b" delivers, and the result names the agent it reached', async () => {
    const r = await sendToAgent({ agent: 'worker-b', intent: 'FYI', payload: 'a note for you' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Message delivered');
  });

  it('a miss names the live agents it might have meant', async () => {
    const r = await sendToAgent({ agent: 'worker_b', intent: 'FYI', payload: 'a note for you' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('No agent found with ID or name "worker_b"');
    expect(r.content).toContain('live agents: Worker-B');
  });

  it('a miss with nothing close still lists who is live, so the sender can choose', async () => {
    const r = await sendToAgent({ agent: 'zzzz', intent: 'FYI', payload: 'a note for you' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Worker-B');
    expect(r.content).toContain('Worker-C');
  });

  it('an injured agent is refused under any capitalisation of its name', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'error', created_at = '2026-01-02 00:00:00' WHERE id = 'wc-1'").run();
    const r = await sendToAgent({ agent: 'WORKER-C', intent: 'FYI', payload: 'a note for you' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('INJURED');
    expect(r.content).toContain('Message NOT delivered');
  });

  it('two live agents differing only by case: the newest wins and the result says which', async () => {
    addAgent('wb-2', 'worker-b', '2026-02-01 00:00:00');
    const r = await sendToAgent({ agent: 'WORKER-B', intent: 'FYI', payload: 'a note for you' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('differing only by capital letters');
    expect(r.content).toContain('wb-2');
    // and the transport agrees with the tool about who "the newest" is
    const row = mockDb.current!.prepare("SELECT agent_id FROM messages WHERE role = 'user' AND content LIKE '%a note for you%' ORDER BY rowid DESC LIMIT 1").get() as { agent_id: string } | undefined;
    expect(row?.agent_id).toBe('wb-2');
  });
});
