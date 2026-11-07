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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { WORK_OP_READS, WORK_OP_ACCEPTS, WORK_OPS, workOperation } from '../../../tools/work-verbs.js';
import { getAllToolDefinitions } from '../definitions.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { appendWorkEvent } from '../../../work/store.js';
import { requestUserVerdict, recordValidationEscalation } from '../../../work/tracker-store.js';
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
const events = (kind: string): number => (db().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = ?').get(TASK, kind) as { n: number }).n;
const row = (): { measure_json: string | null; title: string; agent_id: string } => db().prepare('SELECT measure_json, title, agent_id FROM work WHERE id = ?').get(TASK) as never;

describe('rank 3: a declared argument the chosen action does not read refuses the call', () => {
  it('measure on complete_step: refused with the facts, no close is filed, the measure is not set', async () => {
    const r = await call('work_update', { action: 'complete_step', task_id: TASK, measure: MEASURE, result: 'labels sorted' });
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Refused: work_update(action="complete_step") does not read "measure", so nothing was done. '
      + '"measure" is read by work_open(kind="task") and work_update(action="edit").');
    expect(events('validation_requested')).toBe(0);
    expect(row().measure_json).toBeNull();
  });

  it('measure and title on status: refused, both named, the row unchanged', async () => {
    const r = await call('work_update', { action: 'status', task_id: TASK, status: 'complete', result: 'done', measure: MEASURE, title: 'renamed' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('work_update(action="status") does not read "measure" or "title", so nothing was done.');
    expect(r.content).toContain('"title" is read by');
    expect(events('validation_requested')).toBe(0);
    expect(row()).toMatchObject({ measure_json: null, title: 'sort the labels' });
  });

  it('a third pair, remainder on close_project: refused, naming the doors that read it', async () => {
    const r = await call('work_update', { action: 'close_project', project_id: 'proj-x', reason: 'done', remainder: '3 left' });
    expect(r.content).toBe('Refused: work_update(action="close_project") does not read "remainder", so nothing was done. '
      + '"remainder" is read by work_update(action="status") and work_update(action="complete_step").');
  });

  it('REPLACES the one-off guard: assigned_to on status is refused by the same class, naming reassign', async () => {
    const r = await call('work_update', { action: 'status', task_id: TASK, status: 'in_progress', assigned_to: 'someone-else' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Refused: work_update\(action="status"\) does not read "assigned_to"/);
    expect(r.content).toContain('work_update(action="reassign")');
    expect(row().agent_id).toBe(AGENT);
  });

  it('the one-off guard is gone from the status door; the class is the one way', () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tracker/tools.ts'), 'utf8');
    expect(src).not.toContain('does not move a task to another agent');
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
  const handlerSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cat/tracker.ts'), 'utf8');
  const bodyOf = (op: string): string => {
    const at = handlerSrc.indexOf(`async "${op}"(`);
    expect(at, op).toBeGreaterThan(-1);
    const next = handlerSrc.indexOf('\n  async "', at + 10);
    return handlerSrc.slice(at, next < 0 ? undefined : next);
  };
  const props = (verb: string): Set<string> => new Set(Object.keys(((getAllToolDefinitions().find((d) => d.name === verb)!.input_schema) as { properties: object }).properties));

  it('every argument a handler reads directly is on its operation\'s list (so the map can never refuse a real read)', () => {
    for (const op of WORK_OPS) {
      const body = bodyOf(op);
      const reads = new Set([...body.matchAll(/\bargs\.([a-zA-Z_]+)/g)].map((m) => m[1]));
      const listed = new Set([...WORK_OP_READS[op], ...(WORK_OP_ACCEPTS[op] ?? [])]);
      const verb = op.split(':')[0];
      const missing = [...reads].filter((k) => props(verb).has(k) && !listed.has(k));
      expect(missing, op).toEqual([]);
    }
  });

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

  it('workOperation and the map agree on the operation ids', () => {
    expect(Object.keys(WORK_OP_READS).sort()).toEqual([...WORK_OPS].sort());
    expect(workOperation('work_update', { action: 'complete_step' })).toBe('work_update:complete_step');
  });
});

// The $0 dry run: the PM's verdict on a finished, measured job carried `reason`, and the map (which listed
// only `reject_reason`) refused it ten times; the task stayed claimed and the owner was escalated. The
// validate door READS `reason` now: an uphold carries it, a rejection with no `reject_reason` uses it.
describe('a PM verdict that carries a reason is applied, never refused', () => {
  const PM = 'pm';   // the platform's default PM id (`config/platform.ts:getPMAgentId`)
  beforeEach(() => { db().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'PM', 'idle', 'sensei')").run(PM); });
  const fileClose = (): void => {
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-unread-1', ?, NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
    ).run(AGENT);
    appendWorkEvent(TASK, 'validation_requested', AGENT, { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: 'd-unread-1' });
  };
  const state = (): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(TASK) as { state: string }).state;
  const lastVerdict = (verdict: string): { note: string } | undefined =>
    db().prepare('SELECT note FROM adjudications WHERE work_id = ? AND verdict = ? ORDER BY id DESC').get(TASK, verdict) as never;
  const spineReason = (): string => {
    const rows = db().prepare("SELECT payload FROM work_events WHERE work_id = ? ORDER BY id DESC").all(TASK) as { payload: string }[];
    return rows.map((r) => r.payload).join('\n');
  };

  it('valid=true with reason: the close is upheld and the reason is on the record', async () => {
    fileClose();
    const r = await call('work_validate', { action: 'validate', kind: 'complete', task_id: TASK, valid: true, reason: 'the measure reads 0 and the label is gone' }, PM);
    expect(r.content).not.toMatch(/^Refused:/);
    expect(r.content, r.content).toMatch(/^\[OK\]/);
    expect(r.isError).toBe(false);
    expect(state()).toBe('done');
    expect(lastVerdict('upheld')).toBeDefined();
    expect(spineReason()).toContain('the measure reads 0 and the label is gone');
  });

  it('valid=false with reason and no reject_reason: the close is rejected for that reason', async () => {
    fileClose();
    const r = await call('work_validate', { action: 'validate', kind: 'complete', task_id: TASK, valid: false, reason: 'two messages still carry the label; clear them and resubmit' }, PM);
    expect(r.content).not.toMatch(/^Refused:/);
    expect(r.content).toContain('two messages still carry the label; clear them and resubmit');
    expect(state()).not.toBe('done');
    expect(lastVerdict('rejected')?.note).toBe('two messages still carry the label; clear them and resubmit');
  });

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
  const payloads = (): string => (db().prepare('SELECT payload FROM work_events WHERE work_id = ? ORDER BY id').all(TASK) as { payload: string }[]).map((r) => r.payload).join('\n');
  const note = (verdict: string): string => (db().prepare('SELECT note FROM adjudications WHERE work_id = ? AND verdict = ? ORDER BY id DESC').get(TASK, verdict) as { note: string }).note;
  const setState = (state: string): void => { db().prepare('UPDATE work SET state = ? WHERE id = ?').run(state, TASK); };
  // v3.5 field fix 3 (owner ruling b): these doors apply only the owner's own words, sent after he was asked.
  // So each case records the ask and the owner's real reply, and quotes that reply.
  const ownerReplies = (content: string): void => {
    db().prepare(`INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel, authorized, provenance,
        display_kind, display_tier, inbound_meta, sent_at)
      VALUES (?, ?, 'conv-owner', 'owner', 'user', ?, 'dashboard', 1, 'live', 'unclassified', 'user-visible', ?, ?)`)
      .run(`m-${Math.random()}`, AGENT, content, JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }), Date.now() + 1000);
  };
  const askedAndAnswered = (reply: string): void => { recordValidationEscalation(TASK, 'scheduler', 'conv-owner'); ownerReplies(reply); };

  it('the map reads them, so the door never refuses the call over them', () => {
    expect(unknownArgsAgainstSchema('work_validate', { action: 'apply_user_verdict', task_id: TASK, status: 'on_deck', user_quote: 'q', reason: 'r', feedback: 'f' }).unread).toEqual([]);
    expect(unknownArgsAgainstSchema('work_validate', { action: 'apply_user_validation', task_id: TASK, validated: true, user_quote: 'q', reason: 'r' }).unread).toEqual([]);
  });

  it('apply_user_verdict: reason and feedback both ride the transition reason', async () => {
    requestUserVerdict(TASK, 'pm', { why: 'stalemate' });
    ownerReplies('Park it for now.');
    const out = await run('work_validate:apply_user_verdict', { task_id: TASK, status: 'on_deck', user_quote: 'park it for now', reason: 'the owner wants it later', feedback: 'start with the oldest label' });
    expect(out, out).toMatch(/^\[OK\]/);
    expect(payloads()).toContain('the owner wants it later');
    expect(payloads()).toContain('start with the oldest label');
  });

  it('apply_user_validation, validated=false with reason only: the reason is the feedback', async () => {
    setState('blocked');
    askedAndAnswered('No, not done.');
    const out = await run('work_validate:apply_user_validation', { task_id: TASK, validated: false, user_quote: 'no, not done', reason: 'two labels are still there' });
    expect(out, out).toMatch(/^\[OK\]/);
    expect(note('rejected')).toBe('two labels are still there');
  });

  it('apply_user_validation, validated=false with feedback and reason: both are kept', async () => {
    setState('blocked');
    askedAndAnswered('No.');
    await run('work_validate:apply_user_validation', { task_id: TASK, validated: false, user_quote: 'no', feedback: 'clear the label', reason: 'two are left' });
    expect(note('rejected')).toBe('clear the label\ntwo are left');
    expect(payloads()).toContain('clear the label\\ntwo are left');
  });

  it('apply_user_validation, validated=true with reason: the uphold carries it', async () => {
    setState('blocked');
    askedAndAnswered('Yes, it is blocked.');
    const out = await run('work_validate:apply_user_validation', { task_id: TASK, validated: true, user_quote: 'yes, it is blocked', reason: 'waiting on the vendor' });
    expect(out, out).toMatch(/^\[OK\]/);
    expect(note('upheld')).toContain('waiting on the vendor');
  });
});
