// A box with one agent whose own model is a cloud writer, the Dojo's small writer on a local Ollama, and a run of
// owner turns to fold. Each test file mocks the seams with these factories:
//   vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
//   vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
import Database from 'better-sqlite3';

export const box = { db: null as Database.Database | null, calls: [] as string[], down: new Set<string>() };
export const AGENT = 'agent-one-writer';
export const OWN = 'model-own';
export const WRITER = 'm-writer';

export const connectionMock = () => ({
  getDb: () => { if (!box.db) throw new Error('test DB not initialized'); return box.db; },
  getDbPath: () => ':memory:',
  closeDb: () => {},
});

export const modelMock = () => ({
  callModel: async (p: { modelId: string }) => {
    box.calls.push(p.modelId);
    if (box.down.has(p.modelId)) throw new Error('OpenAI call failed: fetch failed');
    return { content: 'Summary: the crew counted the depot and filed the manifests.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
});

/** A fresh database on the real migration chain, the two writers, the agent, and `turns` owner exchanges. */
export async function seedBox(turns = 24, rowBody = 'Manifest line: crate, bay, weight, seal. '.repeat(40)): Promise<void> {
  box.calls.length = 0; box.down.clear();
  box.db = new Database(':memory:');
  (await import('../../../db/migrations.js')).runMigrations(box.db);
  const { STANDARD_WRITER_MODEL } = await import('../../../services/local-standard.js');
  const { insertMessage } = await import('../../message-store.js');
  box.db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'none', 'http://localhost:11434', 1), ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://localhost:11441/v1', 1)").run();
  const model = box.db.prepare('INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled) VALUES (?, ?, ?, ?, ?, ?, 4096, 0, 1)');
  model.run(OWN, 'p-own', 'Own', 'own', '["text","tools"]', 32_000);
  model.run(WRITER, 'ollama-local', STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag, '["chat"]', 262_144);
  box.db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'A worker agent', 'idle', ?, '{}')").run(AGENT, OWN);
  for (let t = 1; t <= turns; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] ${rowBody}` });
  }
}
