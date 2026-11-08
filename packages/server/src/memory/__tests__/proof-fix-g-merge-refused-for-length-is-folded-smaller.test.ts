// proof-fix G (E3a overall) — A MERGE THE WRITER CANNOT SHRINK ENOUGH IS FOLDED IN SMALLER GROUPS.
//
// The paid run: eighteen top-level summaries holding 43,701 tokens where the view admits 3,562, and every pass
// refused ("the summary came out longer than it may be kept") and reclaimed nothing. A merge of n notes may be kept
// only at 0.8 of ONE child, i.e. 0.8/n of its input: four notes must shrink to a fifth of what the writer read, a
// pair to two fifths. The refusal was not `tooBig`, so the batch was never halved and never recorded: the same
// four notes went to the writer again on every pass. Nothing is dropped unsummarised.
//
// Round 1 sized the LEAF chunks to the writer. Condensation merged `minFanout` summaries per call
// whatever the writer's window: four 5K-token summaries are 20K tokens for a 16K writer whose budget
// is under 10K, so the refuse-before-dialling guard declined every batch ("summariser_refused") and
// the memory stayed over budget. A batch that does not hold is now halved, down to a pair; a pair that
// still does not hold is left for a writer that can. No fixed numbers: the writer's own room decides.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
// t268 round 5: whether the small writer fits the box's memory is not this file's question.
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => Number.MAX_SAFE_INTEGER }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
const LINE = 'The crew counted the depot and filed the manifests, bay by bay, with every seal number recorded. ';
const dials = vi.hoisted(() => ({ calls: [] as Array<{ modelId: string; systemPrompt: string; content: string }>, ratio: 0.35 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    dials.calls.push({ modelId: p.modelId, systemPrompt: p.systemPrompt, content: p.messages[0].content });
    // A writer that shrinks what it reads to a set share: a third reaches a pair's limit (two fifths), not a four's (a fifth).
    const n = Math.floor(p.messages[0].content.length * dials.ratio);
    return { content: LINE.repeat(Math.ceil(n / LINE.length)).slice(0, n), toolCalls: [], usage: {}, stopReason: 'stop' };
  },
  getContextWindow: () => 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { condenseUntilFits, rawContextSummaryTokens } from '../condense-until-fits.js';
import { rebuildContextItems } from '../compaction.js';
import { createLeafSummary } from '../dag.js';
import { insertMessage } from '../message-store.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';
import { runMigrations } from '../../db/migrations.js';
import { stoppedAgents } from '../../agent/shared-state.js';

const AGENT = 'agent-g-condense';
const SMALL = 'model-g-big';
const db = (): Database.Database => mockDb.current!;
const RAW = 43_701;   // the log's summaryTokens
const ADMITTED = 3_562;   // the log's admitted figure
const BODY = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(40);

beforeEach(() => {
  dials.calls = []; dials.ratio = 0.35;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-16k', 'p-16k', 'openai-compatible', 'api_key', 'http://localhost:11430/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-16k', 'big', 'Big', 400000, 16384, '["text","tools"]', 1, 0.1, 0.4)`).run(SMALL);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, SMALL);
  // Eighteen leaf summaries, 43,701 tokens in all (the paid run's own figures), each over its own two rows.
  for (let i = 0; i < 18; i++) {
    const ids = [1, 2].map((k) => {
      const id = `m-${i}-${k}`;
      insertMessage({ id, agentId: AGENT, role: k === 1 ? 'user' : 'assistant', lane: 'owner', senderId: k === 1 ? 'owner' : undefined, content: `[${i}.${k}] row`, turnNumber: i + 1 });
      return id;
    });
    const tokens = Math.floor(RAW / 18) + (i < RAW % 18 ? 1 : 0);
    const day = String(i + 1).padStart(2, '0');
    const made = createLeafSummary(AGENT, `[leaf ${i}] ${BODY.repeat(Math.ceil(tokens / 17))}`.slice(0, tokens * 4), tokens, ids, `2026-10-${day} 09:00:00`, `2026-10-${day} 10:00:00`);
    // Two older notes sit deeper, each alone at its depth (the log's 18 top-level notes were not all one depth).
    if (i >= 16) db().prepare('UPDATE summaries SET depth = ? WHERE id = ?').run(i - 13, typeof made === 'string' ? made : (made as { id: string }).id);
  }
});
afterEach(() => { stoppedAgents.delete(AGENT); mockDb.current?.close(); mockDb.current = null; });

const run = () => condenseUntilFits({
  agentId: AGENT, modelId: SMALL, minFanout: 4,
  measure: async () => ({ total: 90_000, summaryTokens: ADMITTED }),
  rebuild: () => rebuildContextItems(AGENT),
});

describe('proof-fix G — a merge refused for length is folded in smaller groups', () => {
  it('the paid run\'s numbers: eighteen notes, 43,701 tokens against 3,562 admitted — the pass reclaims, loses nothing, and is not a refusal', async () => {
    rebuildContextItems(AGENT);
    expect(rawContextSummaryTokens(AGENT)).toBe(RAW);
    const out = await run();
    expect(out.refusedStage, 'not "summariser_refused"').toBeNull();
    expect(out.condensedCreated, 'parents were written').toBeGreaterThan(0);
    expect(out.summaryTokensBefore - out.summaryTokensAfter, 'space was reclaimed').toBeGreaterThan(0);
    const leaves = (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = 0').get(AGENT) as { n: number }).n;
    expect(leaves, 'no leaf summary was deleted').toBe(16);
    const under = (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = 0 AND id IN (SELECT parent_id FROM summary_parents)').get(AGENT) as { n: number }).n;
    expect(under, 'leaves now sit under a parent').toBeGreaterThan(0);
  });

  it('a span no group size can shrink is recorded, and not dialled again on the next pass', async () => {
    dials.ratio = 0.9;
    await run();
    const first = dials.calls.length;
    await run();
    expect(dials.calls.length, 'the second pass dials nothing the first found unwritable').toBe(first);
  });
});
