// A model that only turns speech into text cannot run an agent; a chat model that also takes audio can.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { refuseAgentModel, notForAgentsReason } from '../main-model-floor.js';

const seedModel = (id: string, caps: string): void => {
  mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, 'p', ?, ?, ?, 128000, 1024, 1, 1, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id, caps);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('p', 'P', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('whisper', '["transcription"]');
  seedModel('omni', '["tools","vision","transcription"]');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a speech-to-text model and an agent', () => {
  it('a model that only turns speech into text is refused with the not-a-chat-model words', async () => {
    expect(await refuseAgentModel('whisper')).toMatch(/Model whisper is not a chat model/);
    expect(notForAgentsReason('whisper')).toBe('not a chat model');
  });
  it('a chat model that also takes audio is accepted', async () => {
    expect(await refuseAgentModel('omni')).toBeNull();
    expect(notForAgentsReason('omni')).toBeNull();
  });
});
