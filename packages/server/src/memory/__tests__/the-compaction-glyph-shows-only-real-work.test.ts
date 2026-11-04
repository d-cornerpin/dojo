// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix 3 (#10): THE ORB'S COMPACTION GLYPH SHOWS ONLY REAL WORK.
//
// Field report 3, Problem 5: "continuous compaction in the orb" on an agent with nothing to fold. The
// leaving-view pass sent its `engine:activity` start and end around an EMPTY span: after the brake
// check and the archive step (which answers true on an empty list) nothing returned early, so the
// dashboard was told "Compacting memory" for a pass that wrote nothing. The routine check runs on
// every loop iteration of every agent, so that was a glyph per tool round.
//
// Real: the migrated DB, the rows, `checkAndCompact`'s leaving-view arm. Mocked: the broadcast (it
// is what this file reads), the summariser, the vault archive. Fixture names invented.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
const frames = vi.hoisted(() => [] as Array<{ type: string; data?: { phase?: string; kind?: string } }>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { type: string }) => { frames.push(e); } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
const generateSummarySpy = vi.fn();
vi.mock('../summarize.js', () => ({ generateSummary: (...args: unknown[]) => generateSummarySpy(...args) }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { checkAndCompact } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-glyph';
const MODEL = 'model-glyph';
const WINDOW = 200_000;

function seed(rows: number): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'openai', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window)
              VALUES (?, 'p', 'Glyph', 'glyph', 1, '["text"]', 1, ?)`).run(MODEL, WINDOW);
  db.prepare(`INSERT INTO agents (id, name, status, model_id, created_at) VALUES (?, 'Glyph', 'idle', ?, datetime('now'))`).run(AGENT, MODEL);
  const insert = db.prepare(`INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
                             VALUES (?, ?, ?, ?, 400, (unixepoch('2026-07-01T00:00:00Z') + ?) * 1000)`);
  for (let i = 0; i < rows; i++) insert.run(`m-${i}`, AGENT, i % 2 === 0 ? 'user' : 'assistant', `Message ${i} about the garden plan.`, i);
}

const activity = (): string[] => frames.filter((f) => f.type === 'engine:activity').map((f) => f.data?.phase ?? '?');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  __resetEstimateCacheForTests();
  __resetBrakesForTests();
  frames.length = 0;
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'A summary of the older span.', tokenCount: 12 }));
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the leaving-view pass', () => {
  it('sends no compaction activity for an empty span (nothing at or below throughSeq is unsummarised)', async () => {
    seed(12);
    const result = await checkAndCompact(AGENT, MODEL, WINDOW, { leaving: { cause: 'out-of-view', throughSeq: 0.5, rowsLeaving: 0 } });
    expect(result.leafCreated).toBe(0);
    expect(generateSummarySpy).not.toHaveBeenCalled();
    expect(activity(), 'a pass that folds nothing is not shown as compaction').toEqual([]);
  });

  it('CONTROL: a span with rows to fold shows its start and its end', async () => {
    seed(12);
    const result = await checkAndCompact(AGENT, MODEL, WINDOW, { leaving: { cause: 'out-of-view', throughSeq: 6, rowsLeaving: 6 } });
    expect(result.leafCreated).toBeGreaterThan(0);
    expect(activity()).toEqual(['start', 'end']);
  });
});
