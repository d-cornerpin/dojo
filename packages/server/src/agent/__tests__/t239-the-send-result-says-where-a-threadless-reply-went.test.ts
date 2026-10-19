// t239 (a), the tool-result half: when the transport put a threadless reply on the request it
// answers, the sender's tool result says so in plain words (the tail of the result only; no
// tool description or schema changes). A reply that carried its own thread says nothing extra.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 20_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

const deliverSpy = vi.fn();
vi.mock('../a2a-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../a2a-transport.js')>()),
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [])),
}));

import { runMigrations } from '../../db/migrations.js';
import { agentsHandlers } from '../tools/cat/agents.js';

const HELPER = 'helper-agent';
const MAIN = 'main-agent';
const THREAD = 'thread-t239-aaaa-bbbb-cccc-0001';

const sendToAgent = (args: Record<string, unknown>) =>
  agentsHandlers['send_to_agent']({ agentId: HELPER, args } as unknown as Parameters<(typeof agentsHandlers)['send_to_agent']>[0]);

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  for (const [id, name] of [[HELPER, 'Helper'], [MAIN, 'Main']] as const) {
    db.prepare(`INSERT INTO agents (id, name, model_id, status, config, session_started_at) VALUES (?, ?, 'm', 'idle', '{}', '1970-01-01')`).run(id, name);
  }
  vi.clearAllMocks();
});

describe('t239 (a) — the sender is told where a threadless reply went', () => {
  it('RED→GREEN: says the reply went on the request it answers, naming the thread', async () => {
    deliverSpy.mockResolvedValue({ delivered: true, threadId: THREAD, messageId: 'out-1', answeredRequestOnThread: true });
    const r = await sendToAgent({ agent: MAIN, intent: 'DELIVERABLE', payload: 'the finished story' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`thread ${THREAD.slice(0, 8)}`);
    expect(r.content).toMatch(/no thread_id/i);
    expect(r.content).toMatch(/the request you were answering|your assignment/i);
  });

  it('CONTROL: a reply that named its thread gets no extra sentence', async () => {
    deliverSpy.mockResolvedValue({ delivered: true, threadId: THREAD, messageId: 'out-2' });
    const r = await sendToAgent({ agent: MAIN, intent: 'DELIVERABLE', payload: 'the finished story', thread_id: THREAD });
    expect(r.content).not.toMatch(/no thread_id/i);
  });
});
