// The owner's Stop during a merge run ends the run at the stopped call and is never reported as the writer refusing.
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

import { mergeUntriedNotes } from '../merge-notes.js';
import { createLeafSummary } from '../dag.js';
import { insertMessage } from '../message-store.js';
import { estimateTokens } from '../budget.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';
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

describe('a Stop ends a merge run', () => {
  it('a Stop during a merge is reported as a stop and ends the run, not as the writer refusing note after note', async () => {
    db().prepare("UPDATE summaries SET content = 'A short summary of the depot.', token_count = 10 WHERE agent_id = ?").run(AGENT);   // small enough to hold: the writer IS dialled
    dials.empty = true;            // the call the owner's Stop cut comes back empty
    stoppedAgents.add(AGENT);      // and the stop stands
    const out = await mergeUntriedNotes(AGENT, SMALL);
    expect(out.stage, 'a stop is not a refusal').toBeNull();
    expect(out.created).toBe(0);
    expect(dials.calls.length, 'the run ended at the first stopped call').toBe(1);
  });
});
