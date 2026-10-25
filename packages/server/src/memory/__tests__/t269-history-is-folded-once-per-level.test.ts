// ════════════════════════════════════════════════════════════════════════════════════════
// t269 cause 1 — THE OLDEST HISTORY IS NOT REWRITTEN ON EVERY FOLD.
//
// The measured shape (v35-summary-quality-investigation.md, H5): a deep note merged with each new
// leaf became a parent at "max depth + 1", and a lone top note was re-summarised to half its size,
// so the oldest history went through the writer again on every fold. One chain on the dev box
// reached depth 72 in about 18 hours, and at depth 9+ about 3% of the leaves' specific facts
// survived.
//
// This file drives the REAL condenser (`condenseUntilFits`) and the real DAG over 100 folds — one
// new leaf per fold, every fold under pressure (the view never admits all the notes) — with a
// writer that keeps every fact it is shown as long as its target has room for it. Only the model
// call is replaced.
//
// THE ARITHMETIC THE DEPTH CLAUSE ASSERTS: a parent merges two or more notes of ONE depth, so a
// depth-d note stands for at least 2^d leaves. With 100 leaves, 2^d ≤ 100 gives d ≤ 6
// (2^6 = 64 ≤ 100 < 128 = 2^7). And because a note is rewritten only when it is merged into the
// level above, a fact in a leaf passes through the writer at most that many times.
//
// All fixture text is invented filler; no real conversation, agent or person appears here.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t269-fold', 'dojo.db'),
  };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

/** A planted fact is an invoice-style code (INV-0000-XX); every leaf carries its own set. */
/** Writer passes per fact: how many summaries were written over an input that held it. */
const passes = new Map<string, number>();

/**
 * THE FAITHFUL WRITER BOUNDED BY ITS TARGET. It writes every planted fact it is shown, one per line,
 * under one line of narrative — and when its target has no room for all of them it keeps the newest
 * mentions (fix round 1: what a merge is asked to carry; the base run's RED used an even spread).
 */
const writer = vi.hoisted(() => ({
  /** 'greedy': the adversary of fix round 1 — it always writes as much as may be kept (1.5 × its target). */
  mode: 'faithful' as 'faithful' | 'greedy',
  write: async (p: { depth: number; targetTokens: number; content: string }) => {
    if (writer.mode === 'greedy') {
      // Every fact it is shown (newest first, as many as fit), padded to the most it may write.
      const room = Math.ceil(p.targetTokens * 1.5) * 4;
      const all = [...new Set(p.content.match(/\bINV-\d{4}-[A-Z]{2}\b/g) ?? [])].reverse();
      const facts = all.slice(0, Math.floor(room / 12));
      const body = facts.join('\n');
      const text = body + 'x'.repeat(Math.max(0, room - body.length));
      return { ok: true as const, text, tokenCount: Math.ceil(text.length / 4) };
    }
    const facts = [...new Set(p.content.match(/\bINV-\d{4}-[A-Z]{2}\b/g) ?? [])];
    (globalThis as { __t269Passes?: (f: string[]) => void }).__t269Passes?.(facts);
    const head = `Merged notes at depth ${p.depth}.`;
    const room = Math.max(0, p.targetTokens * 4 - head.length);
    const each = 'INV-0000-XX\n'.length;
    const fit = Math.min(facts.length, Math.floor(room / each));
    // Out of room, it keeps the NEWEST mentions — what a merge is asked to carry (`carriedFacts`, ruling 1b).
    const kept = fit >= facts.length ? facts : facts.slice(facts.length - fit);
    const text = [head, ...kept].join('\n');
    return { ok: true as const, text, tokenCount: Math.ceil(text.length / 4) };
  },
}));
vi.mock('../summarize.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../summarize.js')>()), generateSummary: writer.write }));
(globalThis as { __t269Passes?: (f: string[]) => void }).__t269Passes = (facts) => { for (const f of facts) passes.set(f, (passes.get(f) ?? 0) + 1); };

import { runMigrations } from '../../db/migrations.js';
import { createLeafSummary } from '../dag.js';
import { condenseUntilFits } from '../condense-until-fits.js';
import { condensedSummaryInput } from '../summarize.js';
import { rebuildContextItems } from '../compaction.js';

const AGENT = 'agent-t269-fold';
const MODEL = 'm-t269-writer';
const FOLDS = 100;
const FACTS_PER_LEAF = 40;
/** Filler with no digits, so it is narrative and never a fact. */
const FILLER = 'the conversation went on about the plan and the reply. '.repeat(40);

function seed(): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-t269', 'Writer', 'openai-compatible', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
              VALUES (?, 'p-t269', 'Writer', 'writer/x', '["text"]', 1, 131072, 'token', 0)`).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Fold Agent', ?, 'idle', '1970-01-01')").run(AGENT, MODEL);
}

const factOf = (leaf: number, i: number): string =>
  `INV-${String(leaf * FACTS_PER_LEAF + i).padStart(4, '0')}-${String.fromCharCode(65 + (leaf % 26))}${String.fromCharCode(65 + (i % 26))}`;

/** One fold: a new message row and the leaf that covers it. */
function foldOneLeaf(n: number, factsPerLeaf = FACTS_PER_LEAF): void {
  const db = mockDb.current!;
  const ms = Date.UTC(2026, 8, 1) + n * 3_600_000;
  const at = new Date(ms).toISOString();
  db.prepare(`INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier, turn_number, provenance, authorized, token_count, created_at)
              VALUES (?, ?, 'user', 'owner', 'filler', 'agent-text', 'agent-only', 1, 'live', 1, 2, ?)`).run(`msg-${n}`, AGENT, ms);
  const facts = Array.from({ length: factsPerLeaf }, (_, i) => factOf(n, i));
  const text = `[leaf ${n}] ${FILLER}\n${facts.map((f) => `The owner asked about ${f}.`).join('\n')}`;
  createLeafSummary(AGENT, text, Math.ceil(text.length / 4), [`msg-${n}`], at, at);
}

/** The top-level (not yet condensed) notes: what the summaries lane chooses from. */
function topLevel(): Array<{ depth: number; content: string }> {
  return mockDb.current!.prepare(
    `SELECT depth, content FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT parent_id FROM summary_parents)`,
  ).all(AGENT) as Array<{ depth: number; content: string }>;
}

async function runFolds(folds = FOLDS, factsPerLeaf = FACTS_PER_LEAF): Promise<void> {
  for (let n = 0; n < folds; n += 1) {
    foldOneLeaf(n, factsPerLeaf);
    await condenseUntilFits({
      agentId: AGENT, modelId: MODEL, minFanout: 4,
      // Under pressure on every fold: the view admits less than the agent holds.
      measure: async () => ({ total: 1_000_000, summaryTokens: 0 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
  }
}

beforeEach(() => {
  writer.mode = 'faithful';
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  passes.clear();
  seed();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t269 cause 1 — condensation is hierarchical: each note is merged into the level above once', () => {
  it('100 folds: the deepest note is at depth ≤ log2(100) = 6, and no fact went through the writer more than 6 times', async () => {
    await runFolds();
    const depths = (mockDb.current!.prepare('SELECT MAX(depth) AS d FROM summaries WHERE agent_id = ?').get(AGENT) as { d: number }).d;
    // 2^d ≤ leaves ⇒ d ≤ floor(log2(100)) = 6 (see the header).
    expect(depths, 'the deepest note (the base reached 196)').toBeLessThanOrEqual(Math.floor(Math.log2(FOLDS)));
    expect(depths, 'and the DAG still climbs: there is no depth ceiling').toBeGreaterThanOrEqual(3);
    const worst = Math.max(...passes.values());
    expect(worst, 'writer passes for the most-rewritten fact').toBeLessThanOrEqual(Math.floor(Math.log2(FOLDS)));
  });

  // Fix round 1 (ruling 1b) supersedes the first round's "every fact of the first ten leaves survives at the
  // top": a top-level set that holds every fact of an unbounded history grows without bound. The facts a merge
  // carries are part of its budget, newest mention first (`carriedFacts`, pinned in the cut/overlong file);
  // what is asserted here is that the newest history is at the top, whole.
  it('after 100 folds every fact of the newest leaf is at the top', async () => {
    await runFolds();
    const top = topLevel().map((s) => s.content).join('\n');
    const newest = Array.from({ length: FACTS_PER_LEAF }, (_, i) => factOf(FOLDS - 1, i));
    expect(newest.filter((f) => !top.includes(f))).toEqual([]);
  });

  /**
   * FIX ROUND 1 (ruling 1b) — CONVERGENCE. What a merge may keep is (1 − share) of its average child, where
   * share = lane room / leaf span (0.2): its ask is that over the 1.5 slack, and 1.5 × ask is the most kept.
   * Fix round 2 (N3): each child's `<summary …>` wrapper (w tokens) is part of a merge's input, so a depth-d note
   * is at most 0.8^d × L + 4w, and a settled top set (one note per depth, D depths) totals at most 5L + 4w·D —
   * whatever the history's length and its fact density. The adversary writes as much as may be kept on every merge.
   */
  it('100 folds of fact-dense notes, a writer that always writes the most it may: the top set stays ≤ 5L + 4w·D', async () => {
    writer.mode = 'greedy';
    const topTokens = (): number => (mockDb.current!.prepare(
      `SELECT COALESCE(SUM(token_count), 0) AS t FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT parent_id FROM summary_parents)`,
    ).get(AGENT) as { t: number }).t;
    const largestLeaf = (): number => (mockDb.current!.prepare('SELECT MAX(token_count) AS t FROM summaries WHERE agent_id = ? AND depth = 0').get(AGENT) as { t: number }).t;
    // w: one note's wrapper in a merge's input, measured off the builder itself; D: the depths in the top set.
    const w = Math.ceil(condensedSummaryInput([{ id: 'sum_00000000-0000-0000-0000-000000000000', agentId: AGENT, depth: 9, kind: 'condensed', content: '', tokenCount: 0, earliestAt: new Date().toISOString(), latestAt: new Date().toISOString(), descendantCount: 0, createdAt: '' }]).length / 4);
    const depths = (): number => (mockDb.current!.prepare('SELECT COUNT(DISTINCT depth) AS n FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT parent_id FROM summary_parents)').get(AGENT) as { n: number }).n;
    const bound = (): number => 5 * largestLeaf() + 4 * w * depths();
    await runFolds(50, 200);
    expect(topTokens(), 'after 50 folds').toBeLessThanOrEqual(bound());
    for (let n = 50; n < FOLDS; n += 1) {
      foldOneLeaf(n, 200);
      await condenseUntilFits({ agentId: AGENT, modelId: MODEL, minFanout: 4, measure: async () => ({ total: 1_000_000, summaryTokens: 0 }), rebuild: () => rebuildContextItems(AGENT) });
    }
    expect(topTokens(), 'after 100 folds').toBeLessThanOrEqual(bound());
  });

  it('a lone note is never re-summarised into a smaller copy of itself', async () => {
    foldOneLeaf(0);
    const out = await condenseUntilFits({
      agentId: AGENT, modelId: MODEL, minFanout: 4,
      measure: async () => ({ total: 1_000_000, summaryTokens: 0 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(out.modelCalls, 'no writer call for a lone note').toBe(0);
    expect(out.refusedStage, 'and nothing to repair: it leaves the view whole when the view has no room').toBeNull();
    expect(topLevel().map((s) => s.depth)).toEqual([0]);
  });

  it('notes of different depths are not merged into each other', async () => {
    // Two leaves merge into one depth-1 note; a third leaf beside it stays a leaf.
    foldOneLeaf(0); foldOneLeaf(1);
    await condenseUntilFits({ agentId: AGENT, modelId: MODEL, minFanout: 4,
      measure: async () => ({ total: 1_000_000, summaryTokens: 0 }), rebuild: () => rebuildContextItems(AGENT) });
    foldOneLeaf(2);
    const out = await condenseUntilFits({ agentId: AGENT, modelId: MODEL, minFanout: 4,
      measure: async () => ({ total: 1_000_000, summaryTokens: 0 }), rebuild: () => rebuildContextItems(AGENT) });
    expect(out.modelCalls).toBe(0);
    expect(topLevel().map((s) => s.depth).sort()).toEqual([0, 1]);
  });
});
