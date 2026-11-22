// A file counts as the engine's own proof for a task only when the engine recorded its writing in a turn that
// served that task. A file the engine cannot tie still goes to the reviewer, marked as such.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { freshDoneDb, doneDb, seedTask } from './helpers/done-db.js';
import { turnRow } from '../../../agent/v2/__tests__/helpers/live-turn.js';
import { engineProof, proofFor, proofLines } from '../proof.js';

const WORKER = randomUUID();
const TASK = 'task-report';
const UNTIED = ' (the engine could not tie this to the task)';
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let turns = 0;
/** The worker writes a file in a turn serving the request `rootMessage`; the engine charges it to this task. */
function fileWritten(name: string, rootMessage: string): string {
  const p = path.join(process.env.DOJO_HOME ?? '/tmp', 'tied-files', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `The ${name} report: 12 sections, totals on page 3.`);
  const turn = turnRow(WORKER, ++turns, { kind: 'ask', id: rootMessage });
  doneDb().prepare(`INSERT INTO audit_log (id, agent_id, action_type, target, result, created_at, turn_number, root_kind, root_id)
    VALUES (?, ?, 'file_write', ?, 'success', ?, ?, 'ask', ?)`).run(randomUUID(), WORKER, p, sqlTime(Date.now()), turn, rootMessage);
  doneDb().prepare("INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, 'file_write', ?, ?)")
    .run(TASK, `file:${p}`, Date.now(), Date.now());
  return p;
}

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  doneDb().prepare(`INSERT INTO agents (id, name, permissions) VALUES (?, 'Worker', '{"file_read":"*"}')`).run(WORKER);
  seedTask(TASK, WORKER);
  seedTask('task-other', WORKER);
  doneDb().prepare("UPDATE work SET opened_at = ?, source_message_id = 'msg-' || id").run(Date.now() - 60_000);
});

describe("a file made for another task is not this task's proof", () => {
  it("a file written while serving another task's request is not the engine's proof", () => {
    fileWritten('other.md', 'msg-task-other');
    expect(engineProof(TASK)).toEqual([]);
  });

  it("a file written while serving this task's request is", () => {
    const p = fileWritten('mine.md', 'msg-task-report');
    expect(engineProof(TASK).map((i) => i.ref)).toEqual([p]);
  });

  it('the file the engine could not tie goes to the reviewer marked, the tied one unmarked', () => {
    fileWritten('other.md', 'msg-task-other');
    fileWritten('mine.md', 'msg-task-report');
    const lines = proofLines(proofFor(TASK));
    expect(lines.filter((l) => l.endsWith(UNTIED))).toHaveLength(1);
    expect(lines.find((l) => l.includes('mine.md'))).not.toContain(UNTIED);
  });
});
