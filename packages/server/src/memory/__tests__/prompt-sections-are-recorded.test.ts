// K36 — the standing instruction is measured piece by piece, on every assembly (not only when the
// debug receipt is on): one row per agent per rendered section, with its tokens.

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
import { recordPromptSections } from '../prompt-sections.js';
import { estimateTokens } from '../budget.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-sections';
const MODEL = 'sections-model';
const DAY = 24 * 60 * 60 * 1000;

interface Row { entry_id: string; tokens: number; chars: number; measured_at: number; baseline_tokens: number | null }
const rows = (agentId = AGENT): Row[] =>
  mockDb.current!.prepare('SELECT entry_id, tokens, chars, measured_at, baseline_tokens FROM prompt_sections WHERE agent_id = ? ORDER BY entry_id').all(agentId) as Row[];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db.prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
              VALUES (?, 'p', 'm', 'M', 128000, 4096, '["tools"]')`).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Sections', 'idle', ?, '{}')").run(AGENT, MODEL);
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier, turn_number, provenance, authorized, created_at)
     VALUES ('s1', ?, 'user', 'owner', 'owner', 'hello', 'user-text', 'user-visible', 1, 'live', 1, 1785000000000)`,
  ).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('K36 — prompt_sections is written at every assembly', () => {
  it('after one assembly the table holds a row per rendered section, summing to the system prompt', async () => {
    const ctx = await assembleContext(AGENT, MODEL);
    const sys = rows().filter((r) => r.entry_id.startsWith('sys.'));
    const ids = [...new Set((ctx.systemEntryIds ?? []).filter((x): x is string => !!x))];
    expect(ids.length).toBeGreaterThan(3);
    expect(sys.map((r) => r.entry_id).sort()).toEqual([...ids].sort());
    // Each part is rounded up on its own, the whole once: they agree to within one token per part.
    const sum = sys.reduce((a, r) => a + r.tokens, 0);
    expect(Math.abs(sum - estimateTokens(ctx.systemPrompt))).toBeLessThanOrEqual((ctx.systemEntryIds ?? []).length);
    expect(sys.every((r) => r.tokens > 0 && r.chars > 0)).toBe(true);
  });

  it('records the lanes the allocator admitted, beside the sections', async () => {
    const ctx = await assembleContext(AGENT, MODEL);
    const lanes = rows().filter((r) => r.entry_id.startsWith('lane.'));
    expect(lanes.map((r) => r.entry_id)).toContain('lane.fresh-tail');
    const granted = new Set((ctx.allocation?.grants ?? []).filter((g) => g.granted > 0).map((g) => g.id));
    for (const l of lanes) expect(granted).toContain(l.entry_id);
  });

  it('a second assembly updates the rows in place (one row per agent per section)', async () => {
    await assembleContext(AGENT, MODEL);
    const first = rows().length;
    await assembleContext(AGENT, MODEL);
    expect(rows()).toHaveLength(first);
  });

  it('a section that is no longer rendered leaves the table', () => {
    const J = '\n\n---\n\n';
    recordPromptSections(AGENT, ['aaaa', 'bbbb'].join(J), ['sys.one', 'sys.two']);
    expect(rows().map((r) => r.entry_id)).toEqual(['sys.one', 'sys.two']);
    recordPromptSections(AGENT, 'aaaa', ['sys.one']);
    expect(rows().map((r) => r.entry_id)).toEqual(['sys.one']);
  });

  it('two parts from one entry are summed into its single row', () => {
    const J = '\n\n---\n\n';
    recordPromptSections(AGENT, ['x'.repeat(40), 'y'.repeat(40)].join(J), ['sys.multi', 'sys.multi']);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].chars).toBe(80 + J.length);   // each section carries the separator before it
  });

  it('the growth reference holds for a week, then moves to the last measured value', () => {
    const t0 = 1_800_000_000_000;
    recordPromptSections(AGENT, 'x'.repeat(400), ['sys.grow'], undefined, t0);
    expect(rows()[0].baseline_tokens).toBe(100);
    recordPromptSections(AGENT, 'x'.repeat(800), ['sys.grow'], undefined, t0 + 2 * DAY);
    expect(rows()[0]).toMatchObject({ tokens: 200, baseline_tokens: 100 });
    recordPromptSections(AGENT, 'x'.repeat(1200), ['sys.grow'], undefined, t0 + 8 * DAY);
    expect(rows()[0]).toMatchObject({ tokens: 300, baseline_tokens: 200 });
  });

  it('a recording fault never reaches the assembly', () => {
    mockDb.current!.exec('DROP TABLE prompt_sections');
    expect(() => recordPromptSections(AGENT, 'abc', ['sys.one'])).not.toThrow();
  });
});
