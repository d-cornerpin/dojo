// A waiting writer is asked again when the server boots: a restart is a real change (Ollama or the provider may be
// back), so the marks about a writer now (not answering, no room) go and the next pass tries it; a failed try marks
// it again. A span no writer can hold stays waiting across the boot. The restart is simulated by resetting the
// module registry while the database is kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

const OWN = 'm-boot-own';
const AGENT = 'agent-boot-waiting';
const restart = async (): Promise<typeof import('../writer.js')> => { vi.resetModules(); return import('../writer.js'); };

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  (await import('../../db/migrations.js')).runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-boot', 'Own', 'openai-compatible', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
              VALUES (?, 'p-boot', ?, ?, '["text","tools"]', 200000, 4096, 1, 1, 1)`).run(OWN, OWN, OWN);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A worker agent', ?, 'idle', '{}')").run(AGENT, OWN);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a waiting writer is retried when the server boots', () => {
  it('the mark survives until the boot; the boot lets the writer be tried; a span verdict stays', async () => {
    const before = await restart();
    before.markWaiting(AGENT, OWN, '', 'not-answering');
    before.markWaiting(AGENT, OWN, 'span-a', 'cannot-hold');
    expect(before.spanWaitsForAWriter(AGENT), 'precondition: its span waits at shutdown').toBe(true);

    const after = await restart();
    expect(after.pickWriter(AGENT), 'until the boot signal, it still waits').toBeNull();
    after.clearOn({ kind: 'boot' });
    expect(after.pickWriter(AGENT), 'one try after boot').toBe(OWN);
    expect(after.waiting(AGENT, OWN, 'span-a'), 'a span no writer can hold is not a boot question').toBe('cannot-hold');
  });
});
