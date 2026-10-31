// A soul file that exists but cannot be read is a FAILED read of the prompt, never a blank document and
// never a file the runtime quietly overwrites with a default. (The page then shows its Retry state.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { homeDir } from '../../home.js';
import { readAgentPromptSurface } from '../agent-prompt-surface.js';

const dir = (): string => path.join(homeDir(), '.dojo', 'prompts');
const file = (): string => path.join(dir(), 'UNREADABLE-AGENT-SOUL.md');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(), 'REAL SOUL', 'utf-8');
});
afterEach(() => {
  try { fs.chmodSync(file(), 0o600); fs.unlinkSync(file()); } catch { /* gone */ }
  mockDb.current?.close();
  mockDb.current = null;
});

describe('readAgentPromptSurface', () => {
  it('reads a soul file', () => {
    expect(readAgentPromptSurface('unreadable-agent')).toBe('REAL SOUL');
  });
  it('THROWS when the soul file exists but cannot be read (not a blank)', () => {
    fs.chmodSync(file(), 0o000);
    expect(() => readAgentPromptSurface('unreadable-agent')).toThrow();
  });
});
