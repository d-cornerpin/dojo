// The thrash refusal asks where the work stands; it does not ask the agent to close it. Continuing
// is named first, and "done" only for work that is done.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-closeout-text', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { createTask } from '../../../../../tracker/schema.js';
import { runRefusalGates } from '../refusal-gates.js';
import { canonicalToolSignature } from '../../../classifiers/loop.js';
import { advance, initState } from '../../../state.js';

const AGENT = 'agent-gate';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
});

describe('the thrash refusal', () => {

  it('fix round 1 (I-2): the thrash refusal puts continuing first and offers complete only for done work', () => {
    const call = { id: 'c2', name: 'gmail_search', arguments: { query: 'in:inbox' } };
    const state = advance(initState({ agentId: AGENT, turnNumber: 1, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
      { thrashGatedSignatures: [canonicalToolSignature(call.name, call.arguments)] });
    const ctx = { agentId: AGENT, turnNumber: 1, turnCtx: {}, counterparty: null, refusedOnceSigs: new Set<string>(), engineBlockEscapeHatch: '' };
    const text = runRefusalGates(state as never, call as never, ctx as never, false).refusal?.content ?? '';
    expect(text).toContain('BLOCKED by engine thrash gate');
    expect(text).toContain('(a) Continue the work from that result');
    expect(text).toContain('(d) Only if the work is done:');
    expect(text).not.toContain("using the data you've already gathered");
  });
});
