// t149 round 2 (hand-up 3) — A CONDENSATION BATCH IS CUT TO WHAT THE WRITER CAN HOLD.
//
// Round 1 sized the LEAF chunks to the writer. Condensation merged `minFanout` summaries per call
// whatever the writer's window: four 5K-token summaries are 20K tokens for a 16K writer whose budget
// is under 10K, so the refuse-before-dialling guard declined every batch ("summariser_refused") and
// the memory stayed over budget. A batch that does not hold is now halved, down to a pair; a pair that
// still does not hold is left for a writer that can. No fixed numbers: the writer's own room decides.
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
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
const dials = vi.hoisted(() => ({ calls: [] as Array<{ modelId: string; systemPrompt: string; content: string }>, empty: false }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; systemPrompt: string; messages: Array<{ content: string }> }) => {
    dials.calls.push({ modelId: p.modelId, systemPrompt: p.systemPrompt, content: p.messages[0].content });
    if (dials.empty) return { content: '', toolCalls: [], usage: {} };
    return { content: 'The crew counted the depot and filed the manifests, bay by bay, with every seal number recorded.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { condenseUntilFits } from '../condense-until-fits.js';
import { rebuildContextItems } from '../compaction.js';
import { createLeafSummary } from '../dag.js';
import { insertMessage } from '../message-store.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { runMigrations } from '../../db/migrations.js';
import { stoppedAgents } from '../../agent/shared-state.js';

const AGENT = 'agent-t149-condense';
const SMALL = 'model-t149-16k';
const db = (): Database.Database => mockDb.current!;
const BODY = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(260);   // ~5K tokens

beforeEach(() => {
  dials.calls = []; dials.empty = false;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-16k', 'p-16k', 'openai-compatible', 'api_key', 'http://localhost:11430/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-16k', 'small', 'Small', 16000, 4096, '["text","tools"]', 1, 0.1, 0.4)`).run(SMALL);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, SMALL);
  // Eight leaf summaries of ~5K tokens, each over its own two rows.
  for (let i = 0; i < 8; i++) {
    const ids = [1, 2].map((k) => {
      const id = `m-${i}-${k}`;
      insertMessage({ id, agentId: AGENT, role: k === 1 ? 'user' : 'assistant', lane: 'owner', senderId: k === 1 ? 'owner' : undefined, content: `[${i}.${k}] row`, turnNumber: i + 1 });
      return id;
    });
    createLeafSummary(AGENT, `[leaf ${i}] ${BODY}`, estimateTokens(BODY), ids, `2026-10-0${i + 1} 09:00:00`, `2026-10-0${i + 1} 10:00:00`);
  }
});
afterEach(() => { stoppedAgents.delete(AGENT); mockDb.current?.close(); mockDb.current = null; });

const budgetFor = (systemPrompt: string): number =>
  Math.max(0, contextWindowPolicy(16_000, { toolPayloadTokens: 0, maxOutputTokens: 4096 }).assemblyBudgetTokens - estimateTokens(systemPrompt));

describe('t149 round 2 — condensation batches are cut to the writer', () => {
  it('four 5K-token summaries per call do not hold on a 16K writer: the batch is halved, every dial fits, and parents are written', async () => {
    const out = await condenseUntilFits({
      agentId: AGENT, modelId: SMALL, minFanout: 4, targetTokens: 6000,
      measure: async () => ({ total: 90_000, summaryTokens: 1_000 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(out.refusedStage, 'not refused for being too big').not.toBe('summariser_refused');
    expect(dials.calls.length, 'the writer was dialled').toBeGreaterThan(0);
    for (const c of dials.calls) {
      expect(estimateTokens(c.content), 'a dial that fits the writer\'s own budget').toBeLessThanOrEqual(budgetFor(c.systemPrompt));
    }
    expect(out.condensedCreated, 'parents were written, not refused').toBeGreaterThan(0);
    expect(out.refusedStage).not.toBe('summariser_refused');
  });

  it.fails('round 4: a Stop during condensation is reported as a stop and ends the walk — not as the writer refusing batch after batch', async () => {
    dials.empty = true;            // the call the owner's Stop cut comes back empty
    stoppedAgents.add(AGENT);      // and the stop stands
    const out = await condenseUntilFits({
      agentId: AGENT, modelId: SMALL, minFanout: 4, targetTokens: 6000,
      measure: async () => ({ total: 90_000, summaryTokens: 1_000 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(out.refusedStage, 'a stop is not a refusal').not.toBe('summariser_refused');
    expect(out.refusedStage).toBe('bounded_without_progress');
    expect(dials.calls.length, 'the walk ended at the first stopped call').toBe(1);
  });

  it.fails('round 4: a pair the writer cannot hold goes to a writer that can, before the batch is given up', async () => {
    db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-roomy', 'p-roomy', 'openai-compatible', 'api_key', 'http://localhost:11431/v1')").run();
    db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
      VALUES ('model-t149-roomy', 'p-roomy', 'roomy', 'Roomy', 32000, 4096, '["text","tools"]', 1, 0.5, 2)`).run();
    const drop = "SELECT id FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT id FROM summaries WHERE agent_id = ? ORDER BY earliest_at LIMIT 2)";
    for (const t of ['summary_messages', 'context_items']) {
      try { db().prepare(`DELETE FROM ${t} WHERE ${t === 'summary_messages' ? 'summary_id' : 'item_id'} IN (${drop})`).run(AGENT, AGENT); } catch { /* table shape: nothing to clear */ }
    }
    db().prepare('DELETE FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT id FROM summaries WHERE agent_id = ? ORDER BY earliest_at LIMIT 2)').run(AGENT, AGENT);
    // Two ~5K summaries become ~7K each: a pair of 14K, more than the 16K writer's room, within the 32K one's.
    db().prepare('UPDATE summaries SET content = ?, token_count = ? WHERE agent_id = ?').run(`${BODY}${BODY.slice(0, 15000)}`, estimateTokens(BODY) + estimateTokens(BODY.slice(0, 15000)), AGENT);
    const out = await condenseUntilFits({
      agentId: AGENT, modelId: SMALL, minFanout: 4, targetTokens: 6000,
      measure: async () => ({ total: 90_000, summaryTokens: 1_000 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
    expect(out.condensedCreated, 'the pair was condensed').toBeGreaterThan(0);
    expect(out.refusedStage).not.toBe('summariser_refused');
    expect(dials.calls.every((c) => c.modelId === 'model-t149-roomy'), 'by the writer that holds it; the small one was never dialled with it').toBe(true);
  });
});
