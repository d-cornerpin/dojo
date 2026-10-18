// ════════════════════════════════════════════════════════════════════════════════════════
// t232 — AN AGENT'S ARTIFACT FOLDER EXISTS BEFORE THE AGENT IS TOLD IT MAY WRITE THERE.
//
// `agent/manifest.ts` grants every agent `~/.dojo/uploads/<agentId>/**`, but nothing made the folder
// until a tool that writes there (image, PDF, attachments) made it itself. An agent that wrote there
// with the shell (a redirect, `cp`) failed with "no such file or directory" and went looking for
// another way, which is how a harmless report run ended in a held destructive call.
//
// The single point is the top of a turn: `runV2Turn` is the one door every agent action passes
// through, whatever woke it. The test home is the suite's own throwaway one (`DOJO_HOME`), never the
// real `~/.dojo`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../db/migrations.js';
import { runV2Turn } from '../v2/loop.js';
import { ensureArtifactDir } from '../artifact-dir.js';

const AGENT = 'brand-new-agent';
const folder = (): string => path.join(homeDir(), '.dojo', 'uploads', AGENT);

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Fresh', 'm', 'idle', '{}', 'sensei')").run(AGENT);
  fs.rmSync(folder(), { recursive: true, force: true });
});
afterEach(() => {
  mockDb.current?.close(); mockDb.current = null;
  fs.rmSync(folder(), { recursive: true, force: true });
});

describe('t232 (e) a brand-new agent\'s first turn', () => {
  it('finds its artifact folder already there', async () => {
    expect(fs.existsSync(folder())).toBe(false);
    // Nothing is waiting for this agent, so the turn has nothing to do; what matters is that the folder is
    // made at the door, before any of that is decided. A turn that stops early must not skip it.
    await runV2Turn(AGENT).catch(() => undefined);
    expect(fs.existsSync(folder())).toBe(true);
    expect(fs.statSync(folder()).isDirectory()).toBe(true);
  });

  it('is owner-only', async () => {
    await runV2Turn(AGENT).catch(() => undefined);
    expect(fs.statSync(folder()).mode & 0o777).toBe(0o700);
  });
});

describe('t232 (e) the folder is made safely', () => {
  it('leaves an existing folder and what is in it alone', async () => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'report.txt'), 'kept');
    await ensureArtifactDir(AGENT);
    expect(fs.readFileSync(path.join(folder(), 'report.txt'), 'utf8')).toBe('kept');
  });

  it('never fails the turn when the folder cannot be made', async () => {
    fs.mkdirSync(path.dirname(folder()), { recursive: true });
    fs.writeFileSync(folder(), 'a file is in the way');   // mkdir -p cannot turn a file into a folder
    await expect(ensureArtifactDir(AGENT)).resolves.toBeUndefined();
  });
});
