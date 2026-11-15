// With a live Trainer, the Trainer and the main agent may save, publish and delete a technique; any other agent is
// redirected to the Trainer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current, getDbPath: () => ':memory:', closeDb: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({ refreshEmbedding: vi.fn() }));
vi.mock('../../agent/effects/fs.js', async () => ({ ...(await import('node:fs')) }));
vi.mock('../../agent/access/read.js', () => ({ mayUseTechnique: vi.fn(() => true) }));

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { TECHNIQUES_DIR } from '../store.js';
import { executeSaveTechnique, executePublishTechnique } from '../tools.js';
import { techniqueHandlers } from '../../agent/tools/cat/techniques.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-tech-main-'));
  const db = new Database(path.join(tmp, 'dojo.db'));
  mockDb.current = db;
  runMigrations();
  fs.mkdirSync(TECHNIQUES_DIR, { recursive: true });
  for (const [k, v] of [['primary_agent_id', 'main-1'], ['trainer_agent_id', 'trainer-1']]) {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(k, v);
  }
  for (const id of ['main-1', 'trainer-1', 'peer-1']) {
    db.prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'sensei')").run(id, id);
  }
  clearPlatformConfigCache();
});
afterEach(() => {
  (mockDb.current as Database.Database).close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const save = (id: string, name: string) =>
  executeSaveTechnique(id, id, 'sensei', { name, display_name: name, description: 'd', instructions: '# T\nbody' });

const del = (id: string, name: string) => techniqueHandlers.delete_technique!({ agentId: id, args: { name } } as never);

describe('who may write a technique while a Trainer exists', () => {
  it('the main agent saves, publishes and deletes', async () => {
    expect(save('main-1', 'by-main')).not.toMatch(/^Refused/);
    expect(executePublishTechnique('main-1', 'sensei', { name: 'by-main' })).not.toMatch(/^Refused/);
    const r = await del('main-1', 'by-main');
    expect(r.isError, r.content).toBeFalsy();
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'by-main'))).toBe(false);
  });

  it('another agent is redirected to the Trainer on each and nothing changes', async () => {
    expect(save('peer-1', 'by-peer')).toMatch(/^Refused: save_technique is reserved for the trainer agent/);
    expect(executePublishTechnique('peer-1', 'sensei', { name: 'by-main' })).toMatch(/^Refused: publish_technique/);
    save('trainer-1', 'kept');
    const r = await del('peer-1', 'kept');
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Refused: delete_technique is reserved for the trainer agent/);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'kept'))).toBe(true);
    expect(fs.existsSync(path.join(TECHNIQUES_DIR, 'by-peer'))).toBe(false);
  });
});
