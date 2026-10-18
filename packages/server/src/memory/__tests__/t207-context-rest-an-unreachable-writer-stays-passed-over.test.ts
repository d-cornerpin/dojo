// ════════════════════════════════════════════════════════════════════════════════════════
// t207 (D9, ctx 4) — A SUMMARY WRITER THAT STOPPED ANSWERING STAYS PASSED OVER ACROSS A RESTART, AND ONLY A
// SUMMARY ANSWER (OR A PERSON, OR THE SETTINGS) BRINGS IT BACK.
//
// Two gaps were left after t140 and t149:
//   1. The "not answering" mark lived in one process's memory. A restart forgot it, so the first fold after
//      every restart dialled the cheapest unreachable model again and waited out its patience.
//   2. Any chat call that provider answered re-armed the writer, including an unrelated one, so a model that
//      answers chat and times out on summaries was re-armed (and re-dialled) after every turn.
//
// A restart is simulated the honest way: the module registry is reset (every in-process map is new) while the
// database is kept.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

const FREE = 'm-t207-free';
const OWN = 'm-t207-own';
const OWN_SIBLING = 'm-t207-own-sibling';
const AGENT = 'agent-t207-desk';
type Health = typeof import('../summary-writer-health.js');

/** A fresh copy of the module with the SAME database: what a restart does. */
async function restart(): Promise<Health> {
  vi.resetModules();
  return import('../summary-writer-health.js');
}

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  const db = mockDb.current;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p-free', 'Free', 'openai-compatible', 'api_key')`).run();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key')`).run();
  const model = db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
                            VALUES (?, ?, ?, ?, '["text","tools"]', 200000, 4096, 1, ?, 1)`);
  model.run(FREE, 'p-free', FREE, FREE, 0);          // the cheapest: first in line when no Settings writer is set
  model.run(OWN, 'p-own', OWN, OWN, 2);
  model.run(OWN_SIBLING, 'p-own', OWN_SIBLING, OWN_SIBLING, 3);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t207 D9 — the mark survives a restart', () => {
  it('a writer that failed before the restart is still passed over after it, and the resolver skips it', async () => {
    const before = await restart();
    // An auto-routed agent has no model of its own, and no Settings writer is set: the cheapest is first.
    expect(before.eligibleSummaryWriters(undefined, AGENT)[0], 'precondition: the cheapest is first').toBe(FREE);
    before.noteSummaryWriterOutcome(FREE, false);
    expect(before.writerPassedOver(FREE, AGENT)).toBe(true);

    const after = await restart();                       // the process restarts; the database stays
    expect(after.writerPassedOver(FREE, AGENT), 'the first fold after a restart does not dial it again').toBe(true);
    expect(after.eligibleSummaryWriters(undefined, AGENT)).not.toContain(FREE);
    expect(after.eligibleSummaryWriters(undefined, AGENT)[0]).toBe(OWN);
  });

  it('the mark is per provider: a sibling model on the failed provider is passed over too', async () => {
    const before = await restart();
    before.noteSummaryWriterOutcome(OWN, false);
    const after = await restart();
    expect(after.writerPassedOver(OWN_SIBLING, AGENT)).toBe(true);
    expect(after.writerPassedOver(FREE, AGENT)).toBe(false);
  });

  it('a SUMMARY answer from the provider clears the mark for good, restarts included', async () => {
    const before = await restart();
    before.noteSummaryWriterOutcome(FREE, false);
    before.noteSummaryWriterOutcome(FREE, true);
    const after = await restart();
    expect(after.writerPassedOver(FREE, AGENT)).toBe(false);
  });

  it('the owner changing the Settings writer re-arms it, across a restart too', async () => {
    const before = await restart();
    before.noteSummaryWriterOutcome(FREE, false);
    const after = await restart();
    expect(after.writerPassedOver(FREE, AGENT), 'precondition').toBe(true);
    mockDb.current!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(OWN);
    expect(after.writerPassedOver(FREE, AGENT)).toBe(false);
  });

  it('a person writing to the agent after the restart re-arms it for that agent only', async () => {
    const before = await restart();
    before.noteSummaryWriterOutcome(FREE, false);
    const after = await restart();
    after.noteAPersonSpoke(AGENT);
    expect(after.writerPassedOver(FREE, AGENT)).toBe(false);
    expect(after.writerPassedOver(FREE, 'agent-t207-other'), 'nobody wrote to the other agent').toBe(true);
  });
});

describe('t207 D9 — "answered" means a summary call, not any call', () => {
  it('no chat call re-arms a writer: the call step does not tell the writer health about its answers', () => {
    const SRC = path.resolve(__dirname, '../..');
    const callStep = readFileSync(path.join(SRC, 'agent/v2/steps/call-llm/index.ts'), 'utf8');
    expect(callStep).not.toMatch(/noteProviderAnswered/);
  });

  it('the health module has no "any call answered" door', async () => {
    const health = await restart();
    expect((health as Record<string, unknown>).noteProviderAnswered).toBeUndefined();
  });
});
