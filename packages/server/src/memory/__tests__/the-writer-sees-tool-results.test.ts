// ════════════════════════════════════════════════════════════════════════════════════════
// t269 cause 2 — THE SUMMARY WRITER SEES WHAT TOOLS RETURNED, NOT THEIR FIRST 200 CHARACTERS.
//
// The measured shape (v35-summary-quality-investigation.md, cause 2): `condenseToolJsonForSummary`
// handed the writer `body.slice(0, 200)` of every tool result — 46% of all source characters on the
// dev box, a median 62% of the span in 1,519 leaves. The writer cannot keep what it never read.
//
// Now a result is given whole while the span fits the writer's job window; a span that does not fit
// scales every kept text by the same share (results with the authored text, the arithmetic
// `fitInputToBudget` already does), and a result cut that way keeps its head and its tail, the facts
// of the part not shown, and the id the agent can read the whole result back with.
//
// All fixture text is invented filler; no real conversation, agent or person appears here.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { buildLeafSummaryInput, condenseToolJsonForSummary } from '../compaction.js';
import { estimateTokens } from '../budget.js';
import type { Message } from '@dojo/shared';

const AGENT = 'agent-t269-results';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Results', 'idle')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const result = (body: string, id = 'toolu_t269_a'): string =>
  JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: body }]);
function row(content: string, role: Message['role'] = 'user'): Message {
  const stored = insertMessage({ agentId: AGENT, role, lane: 'owner', content });
  return { id: stored.id, agentId: AGENT, role, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-10-15 07:44:37' } as Message;
}

/** A page of search output whose answer sits well past character 200. */
const PAGE = `${'Result listing for the supplier query, page one of three. '.repeat(8)}\nMatch: order ORD-55821 shipped on 2026-10-12, balance due 1,284.50, tracking TRK-9QX-4471.\n${'More rows of the listing that say nothing new. '.repeat(6)}`;

describe('t269 cause 2 — the writer is handed the tool results of its span', () => {
  it('a key fact after character 200 of a tool result reaches the summary input', () => {
    expect(PAGE.indexOf('ORD-55821')).toBeGreaterThan(200);
    const input = buildLeafSummaryInput([row(result(PAGE))]);
    expect(input).toContain('ORD-55821');
    expect(input).toContain('TRK-9QX-4471');
    expect(input).toContain('1,284.50');
  });

  it('a result that fits is given whole, exactly', () => {
    expect(condenseToolJsonForSummary(result(PAGE))).toContain(PAGE);
  });

  it('a span over the job window: a long result keeps its head and tail, the facts of the part not shown, and its id', () => {
    const middle = 'ZONE-7731 holds the reorder code RC-40-ALPHA and the amount 9,900.00.';
    const long = `HEAD-OF-RESULT ${'x'.repeat(30_000)} ${middle} ${'y'.repeat(30_000)} TAIL-OF-RESULT`;
    const budget = 4000;
    const input = buildLeafSummaryInput([row(result(long, 'toolu_t269_long'))], budget);
    expect(estimateTokens(input)).toBeLessThanOrEqual(budget);
    expect(input).toContain('HEAD-OF-RESULT');
    expect(input).toContain('TAIL-OF-RESULT');
    // the middle is not shown, but its facts are carried, and the id names where the whole is
    expect(input).not.toContain(middle);
    for (const fact of ['ZONE-7731', 'RC-40-ALPHA', '9,900.00']) expect(input).toContain(fact);
    expect(input).toContain('toolu_t269_long');
  });

  it('how much of a long result is shown follows the window (arithmetic, not a fixed literal)', () => {
    const long = `START ${'z'.repeat(60_000)} END`;
    const shown = (budget: number): number => {
      const input = buildLeafSummaryInput([row(result(long, 'toolu_t269_scale'))], budget);
      return (input.match(/z/g) ?? []).length;
    };
    const small = shown(3000);
    const large = shown(12_000);
    expect(small).toBeGreaterThan(200);
    expect(large).toBeGreaterThan(small * 2);
  });
});
