// t268 re-review 4, (d) ORCHESTRATOR RULING — BOOT COUNTS AS ONE RE-TEST. A restart is a real change (Ollama or the
// provider may be back), so each agent whose summary span was WAITING for a writer at shutdown gets one try after boot;
// then the ordinary rules. An agent that was not waiting is not re-armed by the boot. The waits and re-arms live in
// memory; the "waiting" record and the not-answering marks are kept in the database. A restart is simulated the
// honest way: the module registry is reset (every in-process map is new) while the database is kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

const OWN = 'm-boot-own';
const WAITING = 'agent-boot-waiting';
const IDLE = 'agent-boot-not-waiting';
type Health = typeof import('../summary-writer-health.js');
type Wait = typeof import('../writer-wait.js');

async function restart(): Promise<{ health: Health; wait: Wait }> {
  vi.resetModules();
  return { health: await import('../summary-writer-health.js'), wait: await import('../writer-wait.js') };
}

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-boot', 'Own', 'openai-compatible', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
              VALUES (?, 'p-boot', ?, ?, '["text","tools"]', 200000, 4096, 1, 1, 1)`).run(OWN, OWN, OWN);
  for (const id of [WAITING, IDLE]) db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A worker agent', ?, 'idle', '{}')").run(id, OWN);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('(d) boot counts as one re-test', () => {
  it('an agent waiting at shutdown gets one try after boot, then the ordinary rules; one not waiting is not re-armed', async () => {
    const before = await restart();
    before.health.noteSummaryWriterOutcome(OWN, false);                 // its only writer stopped answering
    expect(before.health.spanWaitsForAWriter(WAITING), 'precondition: its span waits at shutdown').toBe(true);

    const after = await restart();                                      // the process restarts; the database stays
    expect(after.health.eligibleSummaryWriters(OWN, WAITING), 'the mark survives the restart').toEqual([]);
    after.wait.retestSpansWaitingAtShutdown();                          // boot
    expect(after.health.eligibleSummaryWriters(OWN, WAITING), 'one try after boot').toEqual([OWN]);
    expect(after.health.eligibleSummaryWriters(OWN, IDLE), 'nobody else is re-armed by the boot').toEqual([]);

    after.health.noteSummaryWriterOutcome(OWN, false);                  // that try failed: the ordinary rules
    expect(after.health.eligibleSummaryWriters(OWN, WAITING)).toEqual([]);
    after.wait.retestSpansWaitingAtShutdown();                          // the boot's one try is spent
    expect(after.health.eligibleSummaryWriters(OWN, WAITING), 'only one try per boot').toEqual([]);
  });

  it('the boot calls it', () => {
    const boot = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.ts'), 'utf8');
    expect(boot).toMatch(/retestSpansWaitingAtShutdown\(\)/);
  });
});
