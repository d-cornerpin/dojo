// ════════════════════════════════════════════════════════════════════════════════════════
// t207 (D6, conv 2) — THE OTHER-THREADS LANE NAMES WHAT IS REAL, NOT A FIXED NUMBER OF THREADS.
//
// The lane carried three fixed numbers: 3 rows, a 7-day window and a 40-row read. A person who messaged
// eight days ago and was never answered was not named at all, and a fourth waiting person was a count.
// The real signal needs no constant, and it is derivable from stored rows:
//   1. every thread where the person spoke last and nothing answered (WAITING), however old;
//   2. then every thread touched since the agent's last turn in THIS conversation;
//   3. then a count of the rest, never silent.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../services/capability-registry.js', () => ({
  listChannelStatuses: () => [{ name: 'imessage', displayName: 'iMessage', configured: true, inboundLive: true }],
}));
vi.mock('../../agent/access/read.js', () => ({ toolCategoryGranted: () => true }));

import { runMigrations } from '../../db/migrations.js';
import * as lane from '../other-threads-lane.js';
import { buildOtherThreadsInjection, readOtherThreads } from '../other-threads-lane.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = 'threaded';
const SERVED = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;
const hoursAgo = (h: number): number => Date.now() - h * 3_600_000;
const daysAgo = (d: number): number => hoursAgo(d * 24);

function thread(id: string, name: string, role: 'user' | 'assistant', atMs: number, channel = 'imessage'): void {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, AGENT, channel, channel, `id-${id}`, name);
  message(id, role, atMs);
}
function message(conversationId: string, role: 'user' | 'assistant', atMs: number): void {
  db().prepare(`INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at, display_kind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`m-${Math.random().toString(36).slice(2)}`, AGENT, conversationId, role, 'a body', atMs, role === 'user' ? 'user-text' : 'agent-text');
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'the owner')").run();
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`).run(SERVED, AGENT);
  message(SERVED, 'user', hoursAgo(50));
  message(SERVED, 'assistant', hoursAgo(10));       // the agent's last turn in THIS conversation
});

describe('t207 — waiting threads are always named', () => {
  it('six people waiting: all six are named, none is a count', () => {
    for (let i = 0; i < 6; i++) thread(`w${i}`, `contact ${i}`, 'user', hoursAgo(5 + i));
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows.map((r) => r.label).sort()).toEqual([0, 1, 2, 3, 4, 5].map((i) => `contact ${i} (imessage)`));
    expect(read.hidden).toBe(0);
    expect(buildOtherThreadsInjection(AGENT, SERVED)).not.toMatch(/more thread/);
  });

  it('a person who messaged eight days ago and was never answered is named', () => {
    thread('old', 'an old contact', 'user', daysAgo(8));
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows.map((r) => r.label)).toEqual(['an old contact (imessage)']);
    expect(read.rows[0].theySpokeLast).toBe(true);
  });
});

describe('t207 — then what moved since the agent last spoke here; the rest is counted', () => {
  it('a thread answered but touched since the agent\'s last turn here is named; an older answered one is only counted', () => {
    thread('recent', 'recent contact', 'assistant', hoursAgo(2));      // after the agent's last turn here
    thread('quiet', 'quiet contact', 'assistant', hoursAgo(30));        // before it, answered: nothing new
    const read = readOtherThreads(AGENT, SERVED);
    expect(read.rows.map((r) => r.label)).toEqual(['recent contact (imessage)']);
    expect(read.hidden).toBe(1);
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toMatch(/and 1 more thread/);
  });

  it('waiting threads come first, then the touched ones, newest first inside each', () => {
    thread('t1', 'touched early', 'assistant', hoursAgo(4));
    thread('t2', 'touched late', 'assistant', hoursAgo(1));
    thread('w1', 'waiting old', 'user', daysAgo(20));
    thread('w2', 'waiting new', 'user', hoursAgo(6));
    expect(readOtherThreads(AGENT, SERVED).rows.map((r) => r.label)).toEqual([
      'waiting new (imessage)', 'waiting old (imessage)', 'touched late (imessage)', 'touched early (imessage)',
    ]);
  });

  it('with nothing waiting and nothing new there is no block at all', () => {
    thread('quiet', 'quiet contact', 'assistant', hoursAgo(30));
    expect(buildOtherThreadsInjection(AGENT, SERVED)).toBeNull();
  });
});

describe('t207 — the old fixed numbers are gone', () => {
  it('no row cap, window or read cap is exported or used', () => {
    for (const name of ['OTHER_THREADS_MAX_ROWS', 'OTHER_THREADS_WINDOW_DAYS', 'OTHER_THREADS_READ_CAP', 'otherThreadsWorstCaseChars']) {
      expect((lane as Record<string, unknown>)[name], name).toBeUndefined();
    }
    const text = fs.readFileSync(path.join(SRC, 'memory/other-threads-lane.ts'), 'utf8');
    expect(text).not.toMatch(/OTHER_THREADS_(MAX_ROWS|WINDOW_DAYS|READ_CAP)/);
  });
});
