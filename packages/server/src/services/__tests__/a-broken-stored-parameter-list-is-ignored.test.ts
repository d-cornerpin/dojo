// A stored generation_params value that is valid JSON but not the expected shape is read as "no stored list", so
// video_create falls back to the family default instead of throwing inside validation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { getModelGenerationParams, validateCanonicalParams, defaultVideoSpecFor, VIDEO_CANONICAL_PARAMS } from '../generation-params.js';

function store(json: string): void {
  mockDb.current!.prepare("UPDATE models SET generation_params = ? WHERE id = 'm'").run(json);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.exec(`
    INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'openai-compatible', 'api_key');
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m', 'p', 'Video', 'vendor/video', '["video_generation"]', 1);
  `);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a broken stored parameter list is ignored', () => {
  it('a field with no values list is ignored', () => {
    store('{"duration": {}}');
    expect(getModelGenerationParams('m')).toBeNull();
    expect(() =>
      validateCanonicalParams(
        getModelGenerationParams('m') ?? defaultVideoSpecFor('vendor/video'),
        VIDEO_CANONICAL_PARAMS,
        { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      ),
    ).not.toThrow();
  });

  it('an array is ignored', () => {
    store('[1, 2]');
    expect(getModelGenerationParams('m')).toBeNull();
  });

  it('a good list is kept', () => {
    store(JSON.stringify(defaultVideoSpecFor('vendor/video')));
    expect(getModelGenerationParams('m')).toEqual(defaultVideoSpecFor('vendor/video'));
  });

  it('text that is not JSON is ignored', () => {
    store('not json');
    expect(getModelGenerationParams('m')).toBeNull();
  });
});
