// v3.5 K36 inspect hook — the state page gains, per agent, the "Standing instruction" block:
// each rendered section with its tokens and its share of the prefix, biggest first, read from
// `prompt_sections` on the read-only connection the page already uses.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ db: null as unknown, file: '' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => h.db, getReadOnlyDb: () => h.db, closeDb: () => {}, getDbPath: () => h.file,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { state, STATE_SECTIONS } from '../state.js';
import { seedTaskStory } from './seed.js';

let db: Database.Database;
const section = (out: string): string => {
  const i = out.indexOf('## Standing instruction');
  const rest = out.slice(i + 1);
  const j = rest.indexOf('\n## ');
  return j < 0 ? out.slice(i) : out.slice(i, i + 1 + j);
};

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-state-si-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
});

describe('state: the Standing instruction block', () => {
  it('is a section of the page, and before any assembly says nothing is measured yet', () => {
    expect(STATE_SECTIONS).toContain('Standing instruction');
    const out = state(db);
    expect(out).toContain('## Standing instruction');
    expect(section(out)).toMatch(/not measured yet/i);
  });

  it('lists each agent\'s sections biggest first with tokens and share, and skips an agent with none', () => {
    const put = db.prepare('INSERT INTO prompt_sections (agent_id, entry_id, tokens, chars, measured_at, baseline_tokens, baseline_at) VALUES (?, ?, ?, ?, 1, ?, 1)');
    put.run('agent-primary', 'sys.soul', 600, 2400, 500);
    put.run('agent-primary', 'sys.time', 100, 400, 100);
    put.run('agent-primary', 'sys.voice-conduct', 300, 1200, 300);
    put.run('agent-primary', 'lane.vault', 50, 0, 50);
    const text = section(state(db));
    expect(text).toMatch(/primary \(agent-pr\)[^\n]*1,000 tokens/);
    const soul = text.indexOf('sys.soul'); const voice = text.indexOf('sys.voice-conduct'); const time = text.indexOf('sys.time');
    expect(soul).toBeGreaterThan(-1);
    expect(soul).toBeLessThan(voice);
    expect(voice).toBeLessThan(time);
    expect(text).toMatch(/sys\.soul · 600 tokens · 60%/);
    expect(text).toMatch(/sys\.time · 100 tokens · 10%/);
    expect(text).toMatch(/lane\.vault · 50 tokens/);
    expect(text).not.toContain('worker (agent-wo)');
  });

  it('shows what a section has grown by since its reference', () => {
    expect(section(state(db))).toMatch(/sys\.soul · 600 tokens · 60% · \+100 since the last reference/);
  });
});
