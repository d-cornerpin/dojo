// v3.5 K37 inspect hook — the timeline prints a failed call's error FINGERPRINT beside it, the
// same string the cross-agent ledger counts under, so the line and the ledger can be matched by eye
// and by `sql`. A success shows none; two errors that differ only in an id show the same one.

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
import { timeline } from '../timeline.js';
import { fingerprint } from '../../agent/v2/error-fingerprint.js';
import { seedTaskStory, TASK, at, sqlTime } from './seed.js';

const ERR_A = 'Invalid label: Junk E-mail (message 18c2f0a9d4e7b6a1 in /Users/someone/mail)';
const ERR_B = 'Invalid label: Junk E-mail (message 77d0e1f2a3b4c5d6 in /Users/other/mail)';

let db: Database.Database;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-timeline-fp-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
  const audit = db.prepare('INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  audit.run('aud-fp-a', 'agent-worker', 'tool_call', 'gmail_label', 'error', ERR_A, sqlTime(at(2, 10)), 5);
  audit.run('aud-fp-b', 'agent-worker', 'tool_call', 'user_gmail_label', 'error', ERR_B, sqlTime(at(2, 20)), 5);
  const msg = db.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES (?, 'agent-worker', 'owner', ?, ?, 5, ?, ?)`);
  msg.run('msg-fp-1', 'assistant', JSON.stringify([{ type: 'tool_use', id: 'call-fp', name: 'gmail_label', input: {} }]), at(2, 30), at(2, 30));
  msg.run('msg-fp-2', 'tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-fp', content: ERR_A, is_error: true }]), at(2, 31), at(2, 31));
});

const lines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('['));

describe('timeline prints the error fingerprint beside a failed call', () => {
  it('a failed audit line and a failed tool result both carry the fingerprint the ledger would count', () => {
    const ls = lines(timeline({ task_id: TASK }, db));
    const want = fingerprint('gmail_label', ERR_A);
    expect(want).toContain('invalid label: junk e-mail');
    const auditA = ls.find((l) => l.includes('audit_log aud-fp-a'))!;
    expect(auditA).toContain(`error fingerprint: ${want}`);
    const result = ls.find((l) => l.includes('msg msg-fp-2'))!;
    expect(result).toContain(`error fingerprint: ${want}`);
  });

  it('two errors that differ only in an id and a path, one through the user_ twin, print the same fingerprint', () => {
    const ls = lines(timeline({ task_id: TASK }, db));
    const fp = (id: string): string => /error fingerprint: (.*?)\]?$/.exec(ls.find((l) => l.includes(id))!)![1];
    expect(fp('audit_log aud-fp-b')).toBe(fp('audit_log aud-fp-a'));
  });

  it('a successful call and a bare refusal-free line print none', () => {
    const ls = lines(timeline({ task_id: TASK }, db));
    expect(ls.find((l) => l.includes('audit_log aud-3'))).not.toContain('error fingerprint');
    expect(ls.find((l) => l.includes('msg msg-w-3'))).not.toContain('error fingerprint');
  });
});
