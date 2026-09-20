// ════════════════════════════════════════════════════════════════════════════════════════
// T82a (ANSWER-ANYWAY) — THE COMPACTION TRIGGER LEARNS THE BOX.
//
// `checkAndCompact`'s own reactive threshold (`memory/compaction.ts`'s `runCheckAndCompact`)
// has always compared the assembled-context estimate against `CONTEXT_THRESHOLD *
// contextWindow` — a number that knows the model's declared context WINDOW and nothing about
// the box's declared SPEED. This is the "compaction trigger" half of the incident: a total
// comfortably under 96% of a big window never fires compaction at all, on any caller
// (force or the routine background drain), no matter how slow the box serving that window is.
//
// This suite drives the REAL `checkAndCompact` against a REAL (in-memory) migrated DB, with
// a real provider row, and proves the SAME assembled-token total that does nothing on a
// provider that has declared nothing DOES trigger a real compaction once that provider
// declares the incident's own 600s/180tps pair — with no `force` option anywhere in sight.
//
// What is real: the DB, the message rows, the provider/model join `getProviderCeilingTokens`
// reads, the compaction control flow (`runCheckAndCompact`'s guards, `runLeafCompaction`).
// What is mocked: the summarizer LLM call, the vault archive, the broadcast — none of them
// participate in the threshold decision this file is about.
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

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const generateSummarySpy = vi.fn();
vi.mock('../summarize.js', () => ({
  generateSummary: (...args: unknown[]) => generateSummarySpy(...args),
}));

vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

vi.mock('../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { checkAndCompact } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t82a-compaction-trigger';
const MODEL = 'test-model';
const CONTEXT_WINDOW = 200_000; // getFreshTailCount(200_000) === 80

// 80 fresh-tail rows at 750 tokens each = 60,000 — well under the RAW 96%-of-200K threshold
// (192,000) and well OVER the provider-aware ceiling the fixture produces (51,300).
const FRESH_TAIL_ROWS = 80;
const FRESH_TAIL_TOKENS_EACH = 750;
// Ten more rows OLDER than the fresh tail: enough to clear the two "nothing worth compacting"
// guards (MIN_COMPACTABLE_ROWS = 6) without crossing the routine GAP trigger on its own
// (UNCOMPACTED_GAP_THRESHOLD = 30) — isolating the TOKEN trigger as the only thing that can
// fire compaction in this fixture.
const OUTSIDE_TAIL_ROWS = 10;

function seedAgent(db: Database.Database, opts: { declareCeiling: boolean }): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
    .run(AGENT, 'Compaction Trigger Test');
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
    VALUES ('testprov', 'Test', 'openai', 'api_key', ?, ?)
  `).run(opts.declareCeiling ? 600_000 : null, opts.declareCeiling ? 180 : null);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window)
    VALUES (?, 'testprov', 'Test Model', ?, 1, '["text"]', 1, ?)
  `).run(MODEL, MODEL, CONTEXT_WINDOW);

  const insert = db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, (unixepoch('2026-07-01T00:00:00Z') + ?) * 1000)
  `);
  let i = 0;
  for (let n = 0; n < OUTSIDE_TAIL_ROWS; n++, i++) {
    insert.run(`outside-${n}`, AGENT, n % 2 === 0 ? 'user' : 'assistant', `Older message ${n}`, 500, i);
  }
  for (let n = 0; n < FRESH_TAIL_ROWS; n++, i++) {
    insert.run(`tail-${n}`, AGENT, n % 2 === 0 ? 'user' : 'assistant', `Recent message ${n}: filler`, FRESH_TAIL_TOKENS_EACH, i);
  }
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'A summary of the older span.', tokenCount: 12 }));
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.clearAllMocks();
});

describe('checkAndCompact — the reactive trigger keys on the provider-aware ceiling (T82a)', () => {
  it('CONTROL (byte-preservation, R6): a NULL provider row does not fire — same total, same threshold as today', async () => {
    const db = mockDb.current!;
    seedAgent(db, { declareCeiling: false });

    const result = await checkAndCompact(AGENT, MODEL, CONTEXT_WINDOW);

    expect(result.leafCreated).toBe(0);
    expect(generateSummarySpy).not.toHaveBeenCalled();
  });

  it('RED: the SAME assembled total fires compaction, with no force option, once the provider declares 600s/180tps', async () => {
    const db = mockDb.current!;
    seedAgent(db, { declareCeiling: true });

    const result = await checkAndCompact(AGENT, MODEL, CONTEXT_WINDOW);

    expect(result.leafCreated).toBeGreaterThan(0);
    expect(generateSummarySpy).toHaveBeenCalled();
  });
});
