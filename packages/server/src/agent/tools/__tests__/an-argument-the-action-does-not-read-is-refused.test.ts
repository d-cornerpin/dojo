// v3.5 field fix 3, test-2 rank 3: AN ARGUMENT THE CHOSEN ACTION DOES NOT READ IS REFUSED, NEVER DROPPED.
//
// The owner's second field test: the agent passed `measure` on `work_update(action="complete_step")`.
// The unknown-argument check works per TOOL, and `measure` is declared on `work_update` (for `edit`),
// so nothing complained; the complete_step handler never reads it, the close landed, and the agent
// reported "the measure I set via complete_step didn't attach". The whole class: every multi-action
// verb declares the union of its actions' arguments, and each action reads its own subset.
//
// The fix is the same check, per ACTION: `WORK_OP_READS` (beside the operation list in
// `tools/work-verbs.ts`) names what each operation reads, a declared argument the chosen operation does
// not read refuses the whole call before anything runs, and the refusal names, from the same map, the
// operations that do read it. It replaces the one-off `assigned_to` guard on the status door.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-unread-args', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { runMigrations } from '../../../db/migrations.js';
import { executeTool, unknownArgsAgainstSchema } from '../index.js';
import { toolResultOf } from '../../tool-outcome.js';
import { WORK_OP_READS, WORK_OPS } from '../../../tools/work-verbs.js';
import { getAllToolDefinitions } from '../definitions.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { trackerHandlers } from '../cat/tracker.js';

const AGENT = 'unread-args-agent';
const TASK = 'task-unread-0001';
const MEASURE = { tool: 'gmail_search', args: { query: 'label:Inbox' }, unit: 'messages' };
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Agent', 'idle', 'sensei')").run(AGENT);
  seedTrackerTask(db(), { id: TASK, agentId: AGENT, status: 'in_progress', title: 'sort the labels', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});

async function call(name: string, args: Record<string, unknown>, as = AGENT): Promise<{ content: string; isError: boolean }> {
  const r = toolResultOf(await executeTool(as, { id: `c-${Math.random()}`, name, arguments: args } as never));
  return { content: String(r.content), isError: !!r.isError };
}
const row = (): { measure_json: string | null; title: string; agent_id: string } => db().prepare('SELECT measure_json, title, agent_id FROM work WHERE id = ?').get(TASK) as never;

describe('rank 3: a declared argument the chosen action does not read refuses the call', () => {

  it('REPLACES the one-off guard: assigned_to on status is refused by the same class, naming reassign', async () => {
    const r = await call('work_update', { action: 'status', task_id: TASK, status: 'in_progress', assigned_to: 'someone-else' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Refused: work_update\(action="status"\) does not read "assigned_to"/);
    expect(r.content).toContain('work_update(action="reassign")');
    expect(row().agent_id).toBe(AGENT);
  });

  it('CONTROLS: the doors that DO read the argument are not refused by it; navigation arguments are accepted', async () => {
    expect(unknownArgsAgainstSchema('work_update', { action: 'edit', task_id: TASK, measure: MEASURE }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_open', { kind: 'task', title: 't', measure: MEASURE }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_update', { action: 'activity', task_id: TASK, hours: 24 }).unread).toEqual([]);   // the board's window; the id is navigation
    expect(unknownArgsAgainstSchema('work_update', { action: 'get', id: TASK, verbose: true }).unread).toEqual([]);
    // No action: the shape decides, and the shape's operation reads what the shape carried.
    expect(unknownArgsAgainstSchema('work_update', { task_id: TASK, title: 'x', measure: MEASURE }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('send_to_agent', { agent: 'x', message: 'y' }).unread).toEqual([]);   // not a multi-action verb
  });
});

describe('rank 3: the map cannot drift from the handlers or the schemas', () => {
  const props = (verb: string): Set<string> => new Set(Object.keys(((getAllToolDefinitions().find((d) => d.name === verb)!.input_schema) as { properties: object }).properties));

  it('every listed argument is declared on its verb, and every declared argument is read by some operation', () => {
    for (const op of WORK_OPS) {
      const verb = op.split(':')[0];
      for (const k of WORK_OP_READS[op]) expect(props(verb).has(k), `${op} lists "${k}"`).toBe(true);
    }
    for (const verb of new Set(WORK_OPS.map((o) => o.split(':')[0]))) {
      const readSomewhere = new Set(WORK_OPS.filter((o) => o.split(':')[0] === verb).flatMap((o) => WORK_OP_READS[o]));
      expect([...props(verb)].filter((k) => !readSomewhere.has(k)), verb).toEqual([]);
    }
  });

});

// The $0 dry run: the PM's verdict on a finished, measured job carried `reason`, and the map (which listed
// only `reject_reason`) refused it ten times; the task stayed claimed and the owner was escalated. The
// validate door READS `reason` now: an uphold carries it, a rejection with no `reject_reason` uses it.
describe('a PM verdict that carries a reason is applied, never refused', () => {
  const PM = 'pm';   // the platform's default PM id (`config/platform.ts:getPMAgentId`)
  beforeEach(() => { db().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'PM', 'idle', 'sensei')").run(PM); });
  const state = (): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(TASK) as { state: string }).state;

  it('the close doors keep a note-like argument instead of refusing the call over it', () => {
    expect(unknownArgsAgainstSchema('work_update', { action: 'status', task_id: TASK, status: 'complete', result: 'r', reason: 'done' }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_update', { action: 'complete_step', task_id: TASK, result: 'r', reason: 'done' }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_update', { action: 'close_project', project_id: 'p', notes: 'done' }).unread).toEqual([]);
  });
});

// The owner's verdict doors, as the PM transcribes them: `reason` (and `feedback`) are read, never refused,
// and each lands on the verdict's own record.
describe('the owner-verdict doors read reason, never refuse it', () => {
  const run = async (op: string, args: Record<string, unknown>): Promise<string> =>
    String((await trackerHandlers[op]({ agentId: 'pm', name: 'work_validate', callId: 'x', args, toolCall: { id: 'x', name: 'work_validate', input: {} } } as never)).content);
  const note = (verdict: string): string => (db().prepare('SELECT note FROM adjudications WHERE work_id = ? AND verdict = ? ORDER BY id DESC').get(TASK, verdict) as { note: string }).note;

  it('the map reads them, so the door never refuses the call over them', () => {
    expect(unknownArgsAgainstSchema('work_validate', { action: 'apply_user_verdict', task_id: TASK, status: 'on_deck', user_quote: 'q', reason: 'r', feedback: 'f' }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_validate', { action: 'apply_user_validation', task_id: TASK, validated: true, user_quote: 'q', reason: 'r' }).unread).toEqual([]);
  });

});
