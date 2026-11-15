// A continuity brief left in an agent's config (an upgraded box between boot and migration, or an
// imported body) is never rendered by the assembly, at any stored threshold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { assembleContext } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-threshold';
const MODEL = 'threshold-model';

const BRIEF =
  'The user asked about the north gym locker. We established the code and filed a task to ' +
  'confirm it with the front desk. Continue from there when the topic returns.';

function seed(validUntilTurn: number | null, turns: number): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'thr', 'Thr', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
  const config = JSON.stringify({
    continuityBrief: BRIEF,
    ...(validUntilTurn === null ? {} : { continuityBriefValidUntilTurn: validUntilTurn }),
  });
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Thr', 'idle', ?, ?)")
    .run(AGENT, MODEL, config);
  for (let t = 1; t <= turns; t++) {
    db.prepare(
      "INSERT INTO turns (agent_id, turn_number, subject_kind, answered, effectful_calls, started_at) VALUES (?, ?, 'none', 0, 0, datetime('now'))",
    ).run(AGENT, t);
  }
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES ('thr-1', ?, 'user', 'owner', 'owner', 'what was that locker code?', 'user-text',
             'user-visible', ?, 'live', 1, 1785000001000)`,
  ).run(AGENT, turns);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the assembly, end to end', () => {
  // t140: the continuity lane these clauses gated is DELETED with the continuity brief (its
  // writer in `memory/compaction.ts`, the lane in `memory/assembler.ts`, the stored keys by
  // migration 187). The three clauses that stood here — a fossil threshold must not admit the
  // lane, an in-horizon one must, an expired one must not — asked a question the assembly can
  // no longer be asked. What replaces them is the stronger statement: a brief left in a config
  // (an upgraded box between boot and migration, or an imported body) is never rendered, at ANY
  // threshold, so the bound above is no longer what stands between a stale brief and the model.
  it.each([
    ['a fossil threshold', 1598, 5],
    ['a threshold inside the horizon', 8, 5],
    ['an honestly expired threshold', 3, 9],
  ])('t140: %s renders no continuity brief at all', async (_label, validUntil, turns) => {
    seed(validUntil, turns);
    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.allocation?.admittedIds ?? []).not.toContain('lane.continuity');
    expect(JSON.stringify(ctx.messages)).not.toContain('CONTINUITY BRIEF');
    expect(JSON.stringify(ctx.messages)).not.toContain('north gym locker');
  });
});
