// t209 / owner decision 33 — every Dojo-supplied soul is REPLACED with the shipped version on
// update, even if edited, once per version. The main agent's soul (written from the owner's
// setup answers) is never touched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-t209-souls';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t209-souls');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { getSoulContent, soulFileForAgent, readSoulFile } from '../assembler.js';
import { refreshShippedSoulsOnce } from '../shipped-souls.js';

const HOME = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');
const PRIMARY = 'main-agent';
const PM = 'pm-agent';
const TRAINER = 'trainer-agent';
const HEALER = 'healer-agent';
const IMAGINER = 'imaginer-agent';
const OWNER_SOUL = 'The owner wrote this identity during setup. Keep it exactly.\n';
const EDIT = 'An older version of this soul, edited by hand.\n';

function setConfig(key: string, value: string): void {
  mockDb.current!
    .prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

const FILES: Array<[string, string]> = [
  [PM, 'PM-SOUL.md'], [TRAINER, 'TRAINER-SOUL.md'], [HEALER, 'HEALER-SOUL.md'], [IMAGINER, 'IMAGINER-SOUL.md'],
];

beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PROMPTS, { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', 'Primary');
  setConfig('pm_agent_id', PM);
  setConfig('pm_agent_name', 'ProjectManager');
  setConfig('trainer_agent_id', TRAINER);
  setConfig('healer_agent_id', HEALER);
  setConfig('imaginer_agent_id', IMAGINER);
  setConfig('owner_name', 'Owner');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('dec 33: Dojo-supplied souls are replaced on update, the main soul is not', () => {
  it('an edited soul from an older version is replaced by the shipped one; the primary soul is byte-identical', () => {
    // What the shipped, substituted seed is (first read writes it).
    const shipped: Record<string, string> = {};
    for (const [id, file] of FILES) {
      shipped[file] = readSoulFile(soulFileForAgent(id)!);
      fs.writeFileSync(path.join(PROMPTS, file), EDIT, 'utf-8');
    }
    fs.writeFileSync(path.join(PROMPTS, 'SOUL.md'), OWNER_SOUL, 'utf-8');
    setConfig('shipped_souls_version', '3.3.3');

    const replaced = refreshShippedSoulsOnce('3.4.0');

    for (const [, file] of FILES) {
      expect(fs.readFileSync(path.join(PROMPTS, file), 'utf-8')).toBe(shipped[file]);
      expect(shipped[file]).not.toContain('{{');
    }
    expect(replaced.sort()).toEqual(FILES.map(([, f]) => f).sort());
    expect(fs.readFileSync(path.join(PROMPTS, 'SOUL.md'), 'utf-8')).toBe(OWNER_SOUL);
    expect(getSoulContent(PM)).toBe(readSoulFile(soulFileForAgent(PM)!).replace(/\{\{agent_name\}\}/g, 'ProjectManager'));
  });

  it('a box that never recorded a version (an old build) is refreshed too', () => {
    fs.writeFileSync(path.join(PROMPTS, 'PM-SOUL.md'), EDIT, 'utf-8');
    refreshShippedSoulsOnce('3.4.0');
    expect(fs.readFileSync(path.join(PROMPTS, 'PM-SOUL.md'), 'utf-8')).not.toBe(EDIT);
  });

  it('once per version: an edit made after the refresh survives a second boot of the same version, and the next version replaces it again', () => {
    fs.writeFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), EDIT, 'utf-8');
    refreshShippedSoulsOnce('3.4.0');
    const afterFirst = fs.readFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), 'utf-8');
    expect(afterFirst).not.toBe(EDIT);

    const edited = 'edited again after the update\n';
    fs.writeFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), edited, 'utf-8');
    expect(refreshShippedSoulsOnce('3.4.0')).toEqual([]);
    expect(fs.readFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), 'utf-8')).toBe(edited);

    refreshShippedSoulsOnce('3.4.1');
    expect(fs.readFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), 'utf-8')).toBe(afterFirst);
  });

  it('an unreadable version never stamps or replaces anything', () => {
    fs.writeFileSync(path.join(PROMPTS, 'PM-SOUL.md'), EDIT, 'utf-8');
    expect(refreshShippedSoulsOnce('<unreadable>')).toEqual([]);
    expect(fs.readFileSync(path.join(PROMPTS, 'PM-SOUL.md'), 'utf-8')).toBe(EDIT);
  });

  it('a soul file that is absent is left to the first-read seed (nothing is created here)', () => {
    refreshShippedSoulsOnce('3.4.0');
    expect(fs.existsSync(path.join(PROMPTS, 'PM-SOUL.md'))).toBe(false);
  });
});
