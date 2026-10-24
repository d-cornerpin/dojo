// v3.5 text wave, fix round 1 (C-1) — a non-user turn that did work and replied with a task left in
// progress is told the facts and the true consequence; keeping on is first, "complete" only for done
// work, and nothing claims the engine continues it "on the next user turn".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-untracked-end', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { createTask } from '../../../../../tracker/schema.js';
import { advance, initState } from '../../../state.js';
import { nextSteer } from '../../../steer-queue.js';
import { runTrackerCloseout } from '../tracker-closeout.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-worker';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
});

describe('the untracked turn end', () => {
  it('states the facts, continuing first, and makes no false continuation claim', async () => {
    createTask({ title: 'Sort the inbox', assignedTo: AGENT, createdBy: AGENT, origin: { kind: null, sourceMessageId: null, turn: null, convKey: null } });
    const state = advance(initState({ agentId: AGENT, maxToolLoops: 75, turnNumber: 3, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]),
      { loopCount: 2, nonTrackerToolCalls: 2, trackerStatusUpdatedThisTurn: false });
    const ctx = { agentId: AGENT, db: db(), turnNumber: 3, counterparty: { kind: 'agent' } } as unknown as PostCallClassifyContext;
    const out = await runTrackerCloseout(state, ctx, { persistedContent: 'Done for now.' } as PostCallScratch);
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    const text = nextSteer(out.state.steerQueue)!.content;
    expect(text).toContain('"Sort the inbox"');
    expect(text).not.toMatch(/not closed out|REQUIRED ACTION|continue you on the next user turn/);
    expect(text).toContain('nothing is closed for you, and the PM checks in on open work');
    expect(text.indexOf('Still working on one?')).toBeLessThan(text.indexOf('status="complete"'));
  });
});
