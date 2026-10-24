// v3.5 K34 inspect hook — the Dreamer's ROUGH TASKS batch shows each task through the inspect
// timeline (every record of the task, not only its tracker events), with the friction marked and
// the event ids the lesson form cites ("work_events #N") still present.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { buildRoughTasksBatch } from '../rough-tasks-batch.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const SINCE = NOW - DAY;
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function seed(): { friction: number; plain: number } {
  const db = mockDb.current!;
  db.prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-x', 'worker', 'idle', '{}')").run();
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, goal, opened_at, updated_at, provenance)
     VALUES ('task-rough-1', 'task', 'agent-x', 'agent-x', 'owner', 'owner', 'tracker', 'turn:1', 'claimed', 'action', 1, 0, 'File the summary', 'goal text', ?, ?, 'live')`,
  ).run(NOW - 2 * DAY, NOW - 2 * DAY);
  const ev = db.prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)');
  const plain = Number(ev.run('task-rough-1', 'poke', JSON.stringify({ rung: 1 }), 'engine', NOW - 7200_000).lastInsertRowid);
  const friction = Number(ev.run('task-rough-1', 'rearm_refused', JSON.stringify({ reason: 'x' }), 'engine', NOW - 3600_000).lastInsertRowid);
  // A record the plain event timeline never showed: a failed tool call whose root is the task.
  db.prepare(`INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at, root_id)
              VALUES ('aud-rough-1', 'agent-x', 'tool_call', 'gmail_label', 'error', 'Invalid label: Junk E-mail', ?, 'task-rough-1')`).run(sqlTime(NOW - 3000_000));
  return { friction, plain };
}

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the ROUGH TASKS batch reads the inspect timeline', () => {
  it('carries the task\'s other records (a failed call with its error fingerprint) beside its events, ids as the inspect timeline prints them', () => {
    const { friction } = seed();
    const text = buildRoughTasksBatch(SINCE, 100_000)!.text;
    expect(text).toContain('audit_log aud-roug');
    expect(text).toContain('error fingerprint: invalid label: junk e-mail');
    expect(text).toContain(`work_events #${friction}`);
    expect(text).toContain('rearm_refused');
  });

  it('marks the friction lines, and only those', () => {
    const { friction, plain } = seed();
    const lines = buildRoughTasksBatch(SINCE, 100_000)!.text.split('\n');
    expect(lines.find((l) => l.includes(`work_events #${friction}`))).toContain('<- friction');
    expect(lines.find((l) => l.includes(`work_events #${plain}`))).not.toContain('<- friction');
  });

  it('over the allowance, drops the oldest non-friction lines and keeps the friction', () => {
    const { friction, plain } = seed();
    const text = buildRoughTasksBatch(SINCE, 1)!.text;
    expect(text).toContain(`work_events #${friction}`);
    expect(text).not.toContain(`work_events #${plain}`);
  });
});
