// v3.5 A5 — OWNER RULING 2026-10-20: "The default should be the small writer at setup." The summary
// writers are: the person's Settings pick first, then the Dojo's standard writer, then the rest. The
// "cheapest enabled" default is replaced by the writer, and the decision model never writes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { summaryWriterCandidates } from '../summary-writer-health.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, api: string, caps: string[], cost: number): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, 32768, ?, 1)`).run(id, provider, id, api, JSON.stringify(caps), cost);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
  // Free and sorted first by id: before v3.5 this was "the cheapest", and it wrote the summaries.
  model('aaa-free-cloud', 'cloud', 'free', ['chat'], 0);
  model('big-cloud', 'cloud', 'big', ['chat'], 3);
  model('std-writer', 'ollama-local', STANDARD_WRITER_MODEL.tag, ['chat'], 0);
  model('std-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, ['decision'], 0);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the summary writer defaults to the Dojo\'s standard writer', () => {
  it('with no Settings pick, the standard writer is first — not the cheapest model', () => {
    expect(summaryWriterCandidates()[0]).toBe('std-writer');
    expect(summaryWriterCandidates('big-cloud')[0]).toBe('std-writer');
  });

  it("with a Settings pick, the person's pick is first and the writer second", () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'big-cloud')").run();
    expect(summaryWriterCandidates().slice(0, 2)).toEqual(['big-cloud', 'std-writer']);
  });

  it('the decision model never writes a summary', () => {
    expect(summaryWriterCandidates()).not.toContain('std-decision');
    expect(summaryWriterCandidates('std-decision')).not.toContain('std-decision');
  });

  it('a box without the writer keeps the order it had', () => {
    db().prepare("DELETE FROM models WHERE id IN ('std-writer', 'std-decision')").run();
    expect(summaryWriterCandidates()[0]).toBe('aaa-free-cloud');
  });
});
