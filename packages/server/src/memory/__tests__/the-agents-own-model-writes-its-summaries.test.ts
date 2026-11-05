// v3.5: OWNER RULING 2026-10-24 ("The agents model."), replacing the 2026-10-20 "small writer is the default", and the
// v3.5 field fix 3 ruling that there is no summarization model setting at all: each agent's OWN model writes its
// summaries, as in v3.4; the Dojo's small local writer is only the FALLBACK when the agent's model cannot be reached.
// The order: the agent's own model, then the standard writer, and nothing else. The decision model never writes.
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
import { summaryWriterCandidates, eligibleSummaryWriters, noteDidNotAnswerInTurn, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { updateRateLimits, clearRateLimits } from '../../router/rate-limits.js';

const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, api: string, caps: string[], cost: number): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, 32768, ?, 1)`).run(id, provider, id, api, JSON.stringify(caps), cost);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __resetSummaryWriterHealthForTests();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
  // Free and sorted first by id: before v3.5 this was "the cheapest", and it wrote the summaries.
  model('aaa-free-cloud', 'cloud', 'free', ['chat'], 0);
  model('big-cloud', 'cloud', 'big', ['chat'], 3);
  model('std-writer', 'ollama-local', STANDARD_WRITER_MODEL.tag, ['chat'], 0);
  model('std-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, ['decision'], 0);
});
afterEach(() => { clearRateLimits(); mockDb.current?.close(); mockDb.current = null; });

describe("the agent's own model writes its summaries", () => {
  // Fix round 5 (edited: its provider's other models and "the cheapest" followed; the round removed both).
  it("the agent's own model, then the standard writer, and nothing else", () => {
    expect(summaryWriterCandidates('big-cloud')).toEqual(['big-cloud', 'std-writer']);
  });

  it("the agent's model cannot be reached → the standard writer writes", () => {
    noteDidNotAnswerInTurn('big-cloud');
    expect(eligibleSummaryWriters('big-cloud', 'agent-a')[0]).toBe('std-writer');
  });

  // OWNER RULING (v3.5 field fix 3, verbatim): "I was very clear that there was not to be a summarization/compaction
  // model setting and that each agents own model would do the compaction summarization." The Settings pick is gone; a
  // box that still carries the old `compaction_model_id` row (written by an earlier build) is not read.
  it('a box whose old compaction_model_id row names another model: the agent\'s own model still writes, then the standard writer', () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'aaa-free-cloud')").run();
    expect(summaryWriterCandidates('big-cloud')).toEqual(['big-cloud', 'std-writer']);
    expect(eligibleSummaryWriters('big-cloud', 'agent-a')[0]).toBe('big-cloud');
  });

  // Fix round 3 (owner ruling, "The agents model."; edited: this clause put an auto-routed agent on the small
  // writer first): an auto-routed agent's own model is its router's standard-tier pick, in the router's own
  // fallback order; the small writer only after that model cannot be reached.
  describe('an auto-routed agent', () => {
    beforeEach(() => {
      db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud2', 'Cloud two', 'openai-compatible', 'https://example.invalid/v1', 'api_key', 1)").run();
      model('std-tier', 'cloud2', 'std', ['chat'], 2);
      model('heavy-tier', 'cloud', 'heavy', ['chat'], 9);
      db().prepare("DELETE FROM router_tier_models WHERE tier_id IN ('standard', 'heavy', 'light')").run();
      db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('standard', 'std-tier', 0), ('heavy', 'heavy-tier', 0)").run();
    });

    it('its summaries go to the model a standard-tier request gets', () => {
      for (const m of [undefined, 'auto', '__auto__']) expect(summaryWriterCandidates(m)[0]).toBe('std-tier');
    });

    // Fix round 4 (N-E): the walk is the router's own, through its standing filters and the budget.
    it('a standard-tier model the router passes over now (rate-limited, or over the budget) is passed over for summaries too', () => {
      updateRateLimits('std-tier', { 'x-ratelimit-remaining': '0', 'retry-after': '60' });
      expect(summaryWriterCandidates('auto', 'agent-auto')[0]).toBe('heavy-tier');
      clearRateLimits();
      expect(summaryWriterCandidates('auto', 'agent-auto')[0]).toBe('std-tier');
      db().prepare("INSERT INTO budgets (id, scope, limit_usd, period) VALUES ('agent_agent-auto', 'agent-auto', 0.005, 'daily')").run();
      expect(summaryWriterCandidates('auto', 'agent-auto')[0], 'std-tier (~$0.004 a request) is within it; heavy-tier is not').toBe('std-tier');
      db().prepare("UPDATE budgets SET limit_usd = 0.001 WHERE id = 'agent_agent-auto'").run();
      expect(summaryWriterCandidates('auto', 'agent-auto'), 'no tier model is within the budget: the small writer alone').toEqual(['std-writer']);
    });

    // Fix round 5 (edited: the router's next tier followed): its own model is the ONE model the router's selection
    // gives a standard-tier request now; unreachable, the small writer is next, and nothing after it.
    it('that model unreachable: the small writer, and nothing after it', () => {
      noteDidNotAnswerInTurn('std-tier');
      expect(eligibleSummaryWriters('auto', 'agent-auto')).toEqual(['std-writer']);
    });
  });

  it('the decision model never writes a summary', () => {
    expect(summaryWriterCandidates()).not.toContain('std-decision');
    expect(summaryWriterCandidates('std-decision')).not.toContain('std-decision');
  });

  // Fix round 5 (edited: the cheapest text model wrote here): no pick, no own model, no writer — no candidate at all.
  it('a box without the writer and an agent without a model: no writer, never the cheapest cloud model', () => {
    db().prepare("DELETE FROM models WHERE id IN ('std-writer', 'std-decision')").run();
    expect(summaryWriterCandidates()).toEqual([]);
  });
});
