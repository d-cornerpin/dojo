// v3.5 K35 inspect hook — `dojo_inspect timeline` prints what the PM looked at beside its verdict,
// for an uphold (the note carries it), a throw-back (the claim event does) and a close the PM
// moved itself (the transition's evidence record does).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { upholdClaim, throwBackClaim, setTrackerStatus } from '../../work/tracker-store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { seedTaskStory, TASK, SECOND_TASK } from './seed.js';

const PM = 'agent-pm';
let db: Database.Database;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-looked-at-'));
  h.file = path.join(dir, 'dojo.db');
  db = new Database(h.file);
  h.db = db;
  runMigrations();
  seedTaskStory(db);
  openTurnContext(PM).turnNumber = 30;
  const at = Date.now();
  db.prepare("INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES ('pm-call', ?, 'owner', 'assistant', ?, 30, ?, ?)")
    .run(PM, JSON.stringify([{ type: 'tool_use', id: 'k1', name: 'work_update', input: { action: 'get', task_id: TASK } }, { type: 'tool_use', id: 'k2', name: 'file_read', input: { path: '/work/summary.md' } }]), at, at);
  db.prepare("INSERT INTO messages (id, agent_id, lane, role, content, turn_number, created_at, sent_at) VALUES ('pm-result', ?, 'owner', 'tool', ?, 30, ?, ?)")
    .run(PM, JSON.stringify([{ type: 'tool_result', tool_use_id: 'k1', content: 'fine', is_error: false }, { type: 'tool_result', tool_use_id: 'k2', content: 'fine', is_error: false }]), at + 1, at + 1);
});
afterAll(() => endTurnContext(PM));

describe('the timeline prints what the PM looked at beside its verdict', () => {
  it('an uphold', () => {
    upholdClaim(TASK, 'done', 'pm', PM, 'PM validated the close against the goal');
    const out = timeline({ task_id: TASK }, db);
    const line = out.split('\n').find((l) => l.includes('claim_upheld'))!;
    expect(line).toContain('PM validated: read the task, opened 1 file');
    expect(line.match(/read the task/g)).toHaveLength(1);   // said once, not twice
  });

  it('a throw-back keeps the PM\'s reason and adds the line', () => {
    throwBackClaim(SECOND_TASK, 'done', 'pm', PM, 'the summary file was never written');
    const line = timeline({ task_id: SECOND_TASK }, db).split('\n').find((l) => l.includes('claim_rejected'))!;
    expect(line).toContain('the summary file was never written');
    expect(line).toContain('looked at: read 1 other task, opened 1 file');   // it read the first task, not this one
  });

  it('a move the PM makes itself', () => {
    const moved = setTrackerStatus(SECOND_TASK, 'in_progress', { by: 'pm', actorId: PM, claim: 'authoritative', reason: 'PM sent it back to work' });
    expect(moved.kind).toBe('applied');
    const line = timeline({ task_id: SECOND_TASK }, db).split('\n').find((l) => l.includes('PM sent it back to work'))!;
    expect(line).toContain('looked at: read 1 other task, opened 1 file');
  });
});
