// ════════════════════════════════════════════════════════════════════════════════════════
// THE BRIEFING'S 48-HOUR WINDOW MUST COMPARE ONE DATE SHAPE.
//
// `generateBriefing` bounded its summary window with a JS ISO string (`2026-10-25T12:00:00.000Z`),
// but `summaries.created_at` is written by `datetime('now')` as `2026-10-25 18:00:00`
// (migration 002). SQLite compares the two as text, and a space sorts before `T`, so every
// summary created on the cutoff's calendar day reads as older than the cutoff whatever its
// clock time — the window began at the next UTC midnight after the cutoff, not 48 hours back,
// and the first part of it silently missed the briefing. The audit-log count in the same
// function already compares in the column's own shape (`datetime('now', '-24 hours')`).
// ════════════════════════════════════════════════════════════════════════════════════════

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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../agent/model.js', () => ({
  callModel: vi.fn(async (_a: unknown) => ({ content: 'BRIEFING-OK' })),
}));
vi.mock('../../work/obligations.js', () => ({ buildAgedWorkBriefSection: () => null }));

import { runMigrations } from '../../db/migrations.js';
import { callModel } from '../../agent/model.js';
import { generateBriefing } from '../briefing.js';

const AGENT = 'agent-briefing-window';
const MODEL = 'model-briefing-window';
const db = (): Database.Database => mockDb.current!;

/** A depth-1 condensed summary whose `created_at` SQLite itself computes from the age. */
function insertSummary(id: string, content: string, age: string): void {
  db().prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, created_at)
                VALUES (?, ?, 1, 'condensed', ?, 10, '2026-10-01 00:00:00', '2026-10-01 01:00:00', 1, datetime('now', ?))`)
    .run(id, AGENT, content, age);
}

beforeEach(() => {
  vi.mocked(callModel).mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-bw', 'P', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
                VALUES (?, 'p-bw', 'M', 'm', '["text"]', 32000, 4096, 1)`).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Briefing Desk', ?, 'idle', '{}')").run(AGENT, MODEL);
  // One summary on each side of the boundary and one well inside, so every clause has a real
  // model call to inspect. -2879 minutes is one minute inside a true 48-hour window.
  insertSummary('sum-inside-2879', 'INSIDE-2879-MIN', '-2879 minutes');
  insertSummary('sum-outside-2881', 'OUTSIDE-2881-MIN', '-2881 minutes');
  insertSummary('sum-recent-1h', 'RECENT-1-HOUR', '-1 hours');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** The material the briefing actually sent to the model. */
async function briefingInput(): Promise<string> {
  await generateBriefing(AGENT, MODEL);
  const calls = vi.mocked(callModel).mock.calls;
  expect(calls.length, 'the briefing never reached the model').toBe(1);
  return String(calls[0][0].messages[0].content);
}

describe('the briefing 48-hour window', () => {
  it('a summary created 2879 minutes ago is in the briefing', async () => {
    expect(await briefingInput(), 'a summary one minute inside the 48-hour window was silently left out').toContain('INSIDE-2879-MIN');
  });

  it('a summary created 2881 minutes ago is NOT in the briefing', async () => {
    expect(await briefingInput()).not.toContain('OUTSIDE-2881-MIN');
  });

  it('a summary created 1 hour ago is in the briefing', async () => {
    expect(await briefingInput()).toContain('RECENT-1-HOUR');
  });
});
