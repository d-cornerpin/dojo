// v3.5 inspect B3 — the platform log, read across its rotation.
//
// REVIEW FOCUS 4: a question that spans `dojo.log.1` and `dojo.log` is answered from both, in
// time order. The two files are written into this worker's own scratch home (vitest.setup.ts),
// never the live box. Filters: level (that level and above), component, agent (the entry's
// agent id, or the agent's id or name in the text), pattern (matched on the REDACTED line),
// tail. The timeline carries the warn and error lines of its scope.

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
// Counted, not replaced: fix round 1 pins that only the lines a view returns are scrubbed.
vi.mock('../redact.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../redact.js')>();
  return { ...real, redactText: vi.fn(real.redactText) };
});

import { runMigrations } from '../../db/migrations.js';
import { dojoDir } from '../../home.js';
import { logs } from '../logs.js';
import { redactText } from '../redact.js';
import { timeline } from '../timeline.js';
import { seedTaskStory, at, TASK, BEARER } from './seed.js';

const line = (ms: number, level: string, component: string, message: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ timestamp: new Date(ms).toISOString(), level, component, message, ...extra });

let db: Database.Database;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-logs-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
  const logDir = dojoDir('logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'dojo.log.1'), [
    line(at(0, 30), 'info', 'scheduler', 'tick before the turn'),
    line(at(2), 'info', 'gmail', 'search ran', { agentId: 'agent-worker' }),
    line(at(3), 'warn', 'gmail', 'label refused by the provider', { agentId: 'agent-worker', meta: { status: 403 } }),
    '{not json',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(logDir, 'dojo.log'), [
    line(at(4), 'error', 'tracker', `poke for ${TASK} found no progress`),
    line(at(5, 30), 'info', 'model', 'call finished for worker', { meta: { header: `Authorization: Bearer ${BEARER}` } }),
    line(at(8), 'warn', 'gmail', 'after the turn'),
  ].join('\n') + '\n');
});

const shown = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('['));

describe('logs', () => {
  it('REVIEW FOCUS 4: around a moment reads both files, in time order, across the rotation boundary', () => {
    const out = logs({ around: 'msg-w-4' });
    const ls = shown(out);
    expect(ls.map((l) => l.slice(1, 20))).toEqual([...ls.map((l) => l.slice(1, 20))].sort());
    expect(ls.some((l) => l.includes('search ran'))).toBe(true); // from dojo.log.1
    expect(ls.some((l) => l.includes('call finished'))).toBe(true); // from dojo.log
    expect(out).not.toContain('tick before the turn');
    expect(out).not.toContain('after the turn');
    expect(out).toMatch(/1 unreadable line skipped/);
  });

  it('level keeps that level and above; component is exact', () => {
    const warn = shown(logs({ level: 'warn' }));
    expect(warn.map((l) => / (warn|error) /.test(l))).toEqual(warn.map(() => true));
    expect(warn.join('\n')).toContain('label refused by the provider');
    expect(warn.join('\n')).toContain('found no progress');
    const gmail = shown(logs({ component: 'gmail' }));
    expect(gmail).toHaveLength(3);
    expect(gmail[0]).toMatch(/^\[2026-10-19 09:02:00 UTC\] info gmail · search ran/);
  });

  it("agent matches the entry's agent id or the agent named in the text; meta is shown compact", () => {
    const out = shown(logs({ agent: 'worker' })).join('\n');
    expect(out).toContain('label refused by the provider · {"status":403}');
    expect(out).toContain('call finished for worker');
    expect(out).not.toContain('tick before the turn');
  });

  it('scrubs a token out of a line, and matches pattern on the scrubbed text', () => {
    const out = logs({ pattern: 'call finished' });
    expect(out).not.toContain(BEARER);
    expect(out).toContain('Bearer <redacted-credential>');
    expect(shown(logs({ pattern: `Bearer ${BEARER.slice(0, 6)}` }))).toHaveLength(0);
  });

  it('tail keeps the last lines that match', () => {
    const ls = shown(logs({ component: 'gmail', tail: 1 }));
    expect(ls).toHaveLength(1);
    expect(ls[0]).toContain('after the turn');
  });
});

describe('fix round 1 — filter first, scrub only what is returned', () => {
  it('a component filter scrubs the lines it keeps, not the whole log', () => {
    const scrub = vi.mocked(redactText);
    scrub.mockClear();
    const kept = shown(logs({ component: 'gmail' }));
    expect(kept).toHaveLength(3);
    expect(scrub.mock.calls.length).toBe(3);
  });
});

describe('the timeline carries the log', () => {
  it("a task's timeline has the warn and error lines of its scope, and not the info ones", () => {
    const out = timeline({ task_id: TASK }, db);
    expect(out).toMatch(/logs 2/);
    expect(out).toContain('log warn gmail · label refused by the provider');
    expect(out).toContain('log error tracker · poke for');
    expect(out).not.toContain('search ran');
  });
});
