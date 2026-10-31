// v3.5 done-is-measured Task E1 — the PM's validation request carries the task's measured record:
// the measure (or why there is none), the ledger of items touched, and any remainder the worker
// named. The PM judges the close on that record, not on the result text.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { unvalidatedCompleteText } from '../validation-request.js';

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
    setMeasure(TASK, MEASURE, { ok: true, count: 10551 }, T0 - 60_000);
    recordMeasured(TASK, { ok: true, count: 0 }, T0);
    expect(await lines()).toContain('\n  Measure: gmail_search "label:Sweep-1": 0 remaining of 10,551 at start (measured 2026-10-24 12:04 UTC)\n');
  });

  it('items left with a remainder the worker named: the count and the worker\'s own words', async () => {
    setMeasure(TASK, MEASURE, { ok: true, count: 25 }, T0 - 60_000);
    recordMeasured(TASK, { ok: true, count: 7 }, T0);
    recordNamedRemainder('helper', TASK, 'Remainder named at close: 7 messages skipped — 7 are calendar invites the owner said to leave');
    expect(await lines()).toContain('\n  Measure: gmail_search "label:Sweep-1": 7 remaining of 25 at start (measured 2026-10-24 12:04 UTC) — named by the worker: 7 messages skipped — 7 are calendar invites the owner said to leave\n');
  });

  it('the provider failed at close: says so, with the last good reading', async () => {
    setMeasure(TASK, MEASURE, { ok: true, count: 25 }, T0 - 120_000);
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

describe('E1: an unparsable measure is never "none set"', () => {
  it('a stored measure the engine cannot read renders as could not be read', async () => {
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 5, measure_remaining = 5 WHERE id = ?').run('{"tool":"nope"}', TASK);
    const out = await lines();
    expect(out).toContain('\n  Measure: could not be read (measure unparsable)\n');
    expect(out).not.toContain('none set');
  });
});

describe('E1: the request text itself, from the real assembly', () => {
  const parts = (): import('../validation-request.js').ValidationRequestParts => ({
    title: 'the mailbox sweep', agentName: 'Worker', goal: 'no message carries the label', result: 'done',
    priority: 'normal', revertCount: 0, headExtras: '', evidenceBlock: '    1. [receipt] cleared @ x',
  });
  it('lays out the header, goal, result, evidence, Measure, Ledger and priority in order, one per line', async () => {
    setMeasure(TASK, MEASURE, { ok: true, count: 25 }, T0 - 60_000);
    recordMeasured(TASK, { ok: true, count: 0 }, T0);
    recordTouched(TASK, 'gmail_label', ['a', 'b']);
    const text = unvalidatedCompleteText(TASK, parts());
    const at = (needle: string): number => { const i = text.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const order = ['UNVALIDATED_COMPLETE: "the mailbox sweep"', '\n  Goal: no message carries the label\n', '\n  Result: done\n', '\n  Evidence:\n    1. [receipt] cleared @ x\n  Measure: gmail_search "label:Sweep-1": 0 remaining of 25 at start',
      '\n  Ledger: 2 items touched (gmail_label 2)\n  Priority=normal, revert_count=0.\n  Read the file/audit log/output referenced in evidence BEFORE validating'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('states how a measured and an unmeasured close are judged, and the real escalation route', async () => {
    const text = unvalidatedCompleteText(TASK, parts());
    expect(text).toContain('A measured task: validate when the measure reads 0, or when the named remainder\'s reason holds against the goal; reject and state the count when it does not; when you cannot tell whether the owner would want those items left, ask the owner through the main agent: send_to_agent to the main agent with the count and the worker\'s reason. An unmeasured task: judge the ledger and receipts above, not the result text.');
    expect(text).not.toContain('the same escalation you use for a block');
    expect(text).toContain(`task_id="${TASK}", valid=true)`);
    expect(text).toContain('target_status="in_progress") when it does not.');
  });
  it('pm-agent uses it, and the old record line is gone: one place states the measure', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pm = fs.readFileSync(path.join(dir, 'pm-agent.ts'), 'utf8');
    expect(pm).toContain('unvalidatedCompleteText(cTask.id');
    expect(pm).not.toContain('validationRecordLine');
    expect(fs.readFileSync(path.join(dir, 'job-loop-facts.ts'), 'utf8')).not.toContain('validationRecordLine');
  });
});
