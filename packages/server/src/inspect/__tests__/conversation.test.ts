// v3.5 inspect B1 — any agent's conversation: another agent's rows with their tags, the
// shared window (around, since/until), a pattern, engine rows on or off, the paging anchors,
// the redaction, and an agent that no longer exists.

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
import { conversation } from '../conversation.js';
import { seedTaskStory, BEARER, sqlTime, at } from './seed.js';

let db: Database.Database;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-conversation-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
});

describe('conversation', () => {
  it("reads ANOTHER agent's rows, whole and tagged, oldest first", () => {
    const out = conversation({ agent: 'worker', since: sqlTime(at(0)), until: sqlTime(at(10)) }, db);
    expect(out).toMatch(/Conversation of worker \(agent-wo\), 2026-10-19 09:00:00 UTC → 2026-10-19 09:10:00 UTC: 5 messages\./);
    expect(out).toMatch(/\[2026-10-19 09:01:00 UTC\] \(USER · pm \(agent-pm\) \(agent\) · msg msg-w-1 · turn 5 · thread thread-1 ASSIGN\) \[A2A:ASSIGN\]/);
    expect(out).toMatch(/\(ASSISTANT · msg msg-w-2 · turn 5\) calls gmail_label \{"n":12\}/);
    expect(out).toMatch(/\(TOOL · msg msg-w-3 · turn 5\) gmail_label \(ok\): labelled 12/);
    expect(out.indexOf('msg-w-1')).toBeLessThan(out.indexOf('msg-w-4'));
  });

  it('passes every row through the redaction', () => {
    const out = conversation({ agent: 'worker', since: sqlTime(at(0)) }, db);
    expect(out).toContain('msg msg-w-4');
    expect(out).not.toContain(BEARER);
  });

  it('honours around: the turn the anchor message belongs to, with the anchors either side', () => {
    const out = conversation({ agent: 'primary', around: 'msg-p-2' }, db);
    expect(out).toMatch(/around message msg-p-2 \(turn 9\): 2 messages/);
    expect(out).toContain('how did the inbox labelling go?');
    expect(out).toMatch(/Earlier: nothing, this is the start · Later: nothing yet\./);
  });

  it('honours pattern, across all time when no window is given', () => {
    const out = conversation({ agent: 'worker', pattern: 'LABELLED' }, db);
    expect(out).toMatch(/matching "LABELLED": 1 message\./);
    expect(out).toContain('msg msg-w-3');
    expect(out).toMatch(/Earlier: around "msg-w-2" · Later: around "msg-w-4"\./);
  });

  it('leaves engine notices and tool rows out on request, and keeps them by default', () => {
    expect(conversation({ agent: 'worker', since: sqlTime(at(0)) }, db)).toContain('[Engine hint: an engine notice]');
    const quiet = conversation({ agent: 'worker', since: sqlTime(at(0)), include_engine: false }, db);
    expect(quiet).not.toContain('[Engine hint');
    expect(quiet).not.toContain('msg msg-w-3');
    expect(quiet).toMatch(/3 messages\./);
  });

  it('REVIEW FOCUS 3: a deleted agent is answered from the rows that remain', () => {
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM agents WHERE id = 'agent-worker'").run();
    db.pragma('foreign_keys = ON');
    const out = conversation({ agent: 'agent-worker', since: sqlTime(at(0)) }, db);
    expect(out).toMatch(/Conversation of agent-worker \(agent deleted\)/);
    expect(out).toContain('msg msg-w-1');
    expect(conversation({ agent: 'agent-gone' }, db)).toMatch(/No messages for agent-gone \(agent deleted\)/);
  });
});
