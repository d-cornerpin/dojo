// The model a service agent starts on is never one that is not a chat model.
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
import { serviceAgentModelId } from '../main-model-floor.js';

const seedModel = (id: string, caps: string, cost: number): void => {
  mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, 'p', ?, ?, ?, 128000, 1024, ?, 1, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id, caps, cost);
};
const setting = (value: string): void => {
  mockDb.current!.prepare("INSERT INTO config (key, value, updated_at) VALUES ('healer_model_id', ?, datetime('now'))").run(value);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('p', 'P', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('video', '["video_generation"]', 0);
  seedModel('chat', '["chat","tools"]', 2);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the model a service agent starts on', () => {
  it('a setting that holds a model which is not a chat model is replaced by the cheapest chat model', () => {
    setting('video');
    expect(serviceAgentModelId('healer_model_id', 'no-such-primary')).toBe('chat');
  });
  it('a setting that holds a chat model stays', () => {
    setting('chat');
    expect(serviceAgentModelId('healer_model_id', 'no-such-primary')).toBe('chat');
  });
});
