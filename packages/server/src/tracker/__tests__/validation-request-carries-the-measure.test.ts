// v3.5 done-is-measured Task E1 — the PM's validation request carries the task's measured record:
// the measure (or why there is none), the ledger of items touched, and any remainder the worker
// named. The PM judges the close on that record, not on the result text.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-validation-measure', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => undefined) }), stopAgent: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { setMeasure, recordMeasured, recordTouched } from '../../work/ledger-store.js';
import { recordNamedRemainder } from '../measure-gate.js';
import { validationMeasureLines } from '../job-loop-facts.js';
import { estimateTokens } from '../../memory/budget.js';

const db = (): Database.Database => mockDb.current!;
const TASK = 'task-validation-measure';
const MEASURE = { tool: 'gmail_search' as const, args: { query: 'label:Sweep-1' }, unit: 'messages' };
const T0 = Date.UTC(2026, 9, 24, 12, 4, 0);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  db().prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES ('helper', 'Helper', 'idle', 'm-a', 'apprentice')`).run();
  seedTrackerTask(db(), { id: TASK, agentId: 'helper', status: 'in_progress', title: 'the mailbox sweep', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});

const lines = async (): Promise<string> => validationMeasureLines(TASK);

describe('E1: the Measure line, in its four shapes', () => {
  it('a measure that reads 0: the count at the start and when it was read', async () => {
    setMeasure(TASK, MEASURE, { ok: true, count: 10551 }, T0 - 60_000, { setBy: 'the-creator' });
    recordMeasured(TASK, { ok: true, count: 0 }, T0);
    expect(await lines()).toContain('\n  Measure: gmail_search "label:Sweep-1": 0 remaining of 10,551 at start (measured 2026-10-24 12:04 UTC)\n');
  });


  it('the provider failed at close: says so, with the last good reading', async () => {
    setMeasure(TASK, MEASURE, { ok: true, count: 25 }, T0 - 120_000, { setBy: 'the-creator' });
    recordMeasured(TASK, { ok: true, count: 9 }, T0 - 60_000);
    recordMeasured(TASK, { ok: false, error: 'Gmail 503' }, T0);
    expect(await lines()).toContain('\n  Measure: gmail_search "label:Sweep-1": could not be read at close (Gmail 503) — last good reading 9 at 2026-10-24 12:03 UTC\n');
  });

  it('no measure: says none is set and what the ledger shows', async () => {
    recordTouched(TASK, 'gmail_label', ['m1', 'm2', 'm3']);
    recordTouched(TASK, 'gmail_archive', ['m4']);
    const out = await lines();
    expect(out).toContain('\n  Measure: none set; ledger shows 4 items touched by gmail_label, gmail_archive\n');
    expect(out).toContain('\n  Ledger: 4 items touched (gmail_label 3, gmail_archive 1)');
  });
});

describe('E1: the Ledger line', () => {
  it('names each tool and its count; an empty ledger says none', async () => {
    expect(await lines()).toContain('\n  Ledger: 0 items touched (none)');
    recordTouched(TASK, 'gmail_label', ['a', 'b']);
    expect(await lines()).toContain('\n  Ledger: 2 items touched (gmail_label 2)');
  });
});

describe('v3.5 field fix 3 (#6a): the Ledger names the worker\'s files and commands', () => {
  it('a file-creation task: the ledger lists the paths written and the commands run with their exit status', async () => {
    recordTouched(TASK, 'file_write', ['file:/tmp/out/summary.md'], T0);
    recordTouched(TASK, 'exec', ['cmd:mkdir -p /tmp/out'], T0 - 1000, 'exit 0');
    const out = await lines();
    expect(out).toContain('\n  Measure: none set; ledger shows 1 items touched by file_write\n');
    // Review M1 order: failures, then the files the work wrote, then the clean commands, newest first.
    expect(out).toContain('\n  Ledger: 1 items touched (file_write 1), 1 command run'
      + '\n    file written: /tmp/out/summary.md (file_write)'
      + '\n    command run: mkdir -p /tmp/out (exec, exit 0)');
  });
  it('commands only: none set, and the ledger still says what ran', async () => {
    recordTouched(TASK, 'shell', ['cmd:ls /tmp/out'], T0, 'exit 0');
    const out = await lines();
    expect(out).toContain('\n  Measure: none set; ledger shows 1 command run\n');
    expect(out).toContain('\n  Ledger: 0 items touched (none), 1 command run\n    command run: ls /tmp/out (shell, exit 0)');
  });
});

describe('field fix 3 review M1: the review SHOWS a bounded ledger; the ledger records everything', () => {
  const many = (n: number): void => {
    for (let i = 0; i < n; i += 1) recordTouched(TASK, 'exec', [`cmd:curl https://api.example.com/items?page=${i}`], T0 + i, 'exit 0');
  };
  it('2,000 commands in a small room: the listing fits the room and counts what it could not list', async () => {
    many(2000);
    recordTouched(TASK, 'file_write', ['file:/tmp/out/summary.md'], T0 + 5000);
    recordTouched(TASK, 'shell', ['cmd:make report'], T0 + 6000, 'exit 2');
    const room = 400;
    const out = validationMeasureLines(TASK, room);
    expect(estimateTokens(out)).toBeLessThanOrEqual(room);
    // What the PM must see first: the failure, then the file the work wrote.
    expect(out).toContain('command run: make report (shell, exit 2)');
    expect(out).toContain('file written: /tmp/out/summary.md (file_write)');
    expect(out).toMatch(/and \d[\d,]* more commands? that exited 0, not listed \(all of it is on the ledger\)/);
    expect(out).toContain('\n  Ledger: 1 items touched (file_write 1), 2,001 commands run');
    // The record is untouched: every command is still on the ledger.
    expect((db().prepare('SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ?').get(TASK) as { n: number }).n).toBe(2002);
  });
  it('a bigger room lists more, newest first, and never a fixed count', async () => {
    many(200);
    const small = validationMeasureLines(TASK, 300).split('command run:').length;
    const big = validationMeasureLines(TASK, 3000).split('command run:').length;
    expect(big).toBeGreaterThan(small);
    expect(validationMeasureLines(TASK, 3000).indexOf('page=199')).toBeLessThan(validationMeasureLines(TASK, 3000).indexOf('page=198'));
  });
  it('a long script is shown by its first line and its length, never cut at a character count', async () => {
    const script = ['set -e', ...Array.from({ length: 40 }, (_, i) => `echo line ${i} >> /tmp/out/log.txt`)].join('\n');
    recordTouched(TASK, 'shell', [`cmd:${script}`], T0, 'exit 0');
    const out = validationMeasureLines(TASK, 2000);
    expect(out).toContain(`command run: set -e (+40 more lines, ${script.length.toLocaleString('en-US')} characters) (shell, exit 0)`);
    expect(out).not.toContain('echo line 3 ');
  });
});

describe('audit #5: the Ledger names what the task sent', () => {
  it('a send entry reads as what was sent and to whom, ahead of the files and clean commands', async () => {
    recordTouched(TASK, 'gmail_send', ['send:c1'], T0, 'client@example.com');
    recordTouched(TASK, 'gmail_reply', ['send:c2'], T0 + 1, null);
    recordTouched(TASK, 'file_write', ['file:/tmp/out/r.pdf'], T0 + 2);
    const out = validationMeasureLines(TASK, 4000);
    expect(out).toContain('\n  Ledger: 3 items touched (');
    expect(out).toContain('\n    sent: to client@example.com (gmail_send)');
    expect(out).toContain('\n    sent: (gmail_reply)');
    expect(out.indexOf('sent: to client')).toBeLessThan(out.indexOf('file written:'));
  });
});

describe('E1: an unparsable measure is never "none set"', () => {
  it('a stored measure the engine cannot read renders as could not be read', async () => {
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 5, measure_remaining = 5 WHERE id = ?').run('{"tool":"nope"}', TASK);
    const out = await lines();
    expect(out).toContain('\n  Measure: could not be read (measure unparsable)\n');
    expect(out).not.toContain('none set');
  });
});
