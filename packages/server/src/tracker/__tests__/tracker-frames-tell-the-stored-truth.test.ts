// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 8 / T34 — TRACKER FRAMES TELL THE STORED TRUTH.
//
// ── THE INCIDENT (round-8 S2 and S6, twice in one round) ──
// On reminder creation the `tracker:task_updated` frame announced
// `"status":"in_progress"`, `"scheduleStatus":"unscheduled"`, `"nextRunAt":null`,
// `"anchorTime":null`, `"scheduledStart":null` — while the stored rows settled at
// `state='on_deck'`, `schedule_status='waiting'`, `next_run_at` = the real fire time
// (S2: Wed Aug 12 5:00/5:30 PM PDT; S6: 2026-08-17T02:00:00Z). The `claimed → on_deck`
// transition landed 3 ms after the frame and produced NO second frame, so a board pane
// driven by the socket shows a scheduled reminder as an in-progress, unscheduled task
// until the page is reloaded.
//
// ── THE SEAM, READ AT HEAD ──
// `createTask` (tracker/schema.ts) broadcasts the row it just inserted, and the row is
// inserted `in_progress` with no schedule columns BY DESIGN — the caller applies the
// schedule afterwards (`trackerCreateTask`: goal patch → `setTrackerStatus('on_deck')` →
// `setNextRun(...)` → `declareDeliverableOnSchedule`). Neither `setTrackerStatus` nor
// `setNextRun` broadcasts (verified by read: they are work-store writers that run inside
// transactions), so the only frame for a brand-new scheduled row is the pre-settlement one.
//
// ── THE INVARIANT THESE CLAUSES PIN ──
// THE LAST FRAME FOR A ROW EQUALS THE STORED ROW. Not "a frame is emitted", not "the
// frame is nearly right": the last thing the wire said about this id is what a reader
// would find in the database. The fix follows the discipline the rest of the tracker
// already uses (`updateTask`, `closeProject`, `tracker/tools.ts`: read the row back after
// the writes and broadcast the FRESH row), and the no-spam bound is pinned too: an
// unscheduled creation still emits exactly ONE frame, a settling creation exactly TWO.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };

/** Every frame the seam put on the wire, in order. */
const frames: { type: string; data: Record<string, unknown> }[] = [];

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (f: { type: string; data: Record<string, unknown> }) => { frames.push(f); },
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { getTask } from '../schema.js';
import { createWorkTable } from '../../work/__tests__/work-fixture.js';

const AGENT = 'a1';
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = dirname(dirname(HERE));

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
  `);
}

/** The tool door the model actually reaches, with the args the round-8 reminders carried. */
async function openThroughTheDoor(args: Record<string, unknown>, verb = 'work_open:reminder'): Promise<string> {
  const handler = trackerHandlers[verb];
  if (!handler) throw new Error(`no handler for ${verb}`);
  const out = await handler({ agentId: AGENT, args } as Parameters<typeof handler>[0]);
  return typeof out === 'string' ? out : String((out as { content?: string })?.content ?? '');
}

/** The frames for one task id, in order. */
const framesFor = (id: string) =>
  frames.filter((f) => f.type === 'tracker:task_updated' && (f.data as { id?: string }).id === id);

const idFromResult = (text: string): string => {
  const m = /task_id=([0-9a-f-]{36})/.exec(text) ?? /id=([0-9a-f-]{36})/.exec(text);
  if (!m) throw new Error(`no task id in door result: ${text.slice(0, 300)}`);
  return m[1];
};

beforeEach(() => {
  frames.length = 0;
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

describe('T34: the LAST frame for a row equals the stored row', () => {
  it('THE S2/S6 REPLAY: a reminder scheduled for later ends on a truthful frame', async () => {
    const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({ what: 'team dinner at 7pm — traffic check', when }));

    const stored = getTask(id);
    expect(stored, 'the row must exist').toBeTruthy();
    expect(stored!.status, 'premise: a future schedule settles the row on_deck').toBe('on_deck');
    expect(stored!.scheduleStatus).toBe('waiting');
    expect(stored!.nextRunAt).toBeTruthy();

    const mine = framesFor(id);
    expect(mine.length, 'the row must be announced at all').toBeGreaterThan(0);
    const last = mine[mine.length - 1].data as Record<string, unknown>;
    expect(last.status, 'the last frame must not still say in_progress').toBe(stored!.status);
    expect(last.scheduleStatus).toBe(stored!.scheduleStatus);
    expect(last.nextRunAt).toBe(stored!.nextRunAt);
    expect(last.scheduledStart).toBe(stored!.scheduledStart);
  });

  it('and it equals the stored row WHOLE, not just on the three columns that were wrong', async () => {
    const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({ what: 'leave the office by 5', when }));
    const mine = framesFor(id);
    expect(mine[mine.length - 1].data).toEqual(getTask(id));
  });

  it('a recurring reminder settles the same way', async () => {
    const when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({
      what: 'daily weather check', when, repeat_interval: 1, repeat_unit: 'days',
    }));
    const stored = getTask(id);
    expect(stored!.scheduleStatus).toBe('waiting');
    const mine = framesFor(id);
    expect(mine[mine.length - 1].data).toEqual(stored);
  });

  it('the goal a creation records is on the last frame too (the same staleness, one column over)', async () => {
    const when = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor(
      { kind: 'task', title: 'book the vet', goal: 'Milo seen before Friday', scheduled_start: when },
      'work_open:task',
    ));
    const stored = getTask(id);
    const mine = framesFor(id);
    expect(mine[mine.length - 1].data).toEqual(stored);
  });
});

describe('T34 controls: no frame spam, and nothing else moves', () => {
  it('an UNSCHEDULED task creation still emits exactly ONE frame', async () => {
    const id = idFromResult(await openThroughTheDoor(
      { kind: 'task', title: 'tidy the uploads folder', goal: 'the uploads folder holds no test junk' },
      'work_open:task',
    ));
    expect(framesFor(id).length, 'nothing settled, so nothing to correct').toBe(1);
    expect(framesFor(id)[0].data).toEqual(getTask(id));
  });

  it('a SCHEDULED creation emits exactly TWO: the announcement and one settle frame', async () => {
    const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({ what: 'call the vet', when }));
    expect(framesFor(id).length, 'one settle frame, not a firehose').toBe(2);
  });

  it('the settle frame is LAST, and the first frame is still the pre-settlement announcement', async () => {
    const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({ what: 'pick up the prescription', when }));
    const mine = framesFor(id);
    expect((mine[0].data as { status: string }).status, 'the announcement is unchanged').toBe('in_progress');
    expect((mine[mine.length - 1].data as { status: string }).status).toBe('on_deck');
  });

  it('the stored row itself is untouched by this task: state, schedule and fire time as before', async () => {
    const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const id = idFromResult(await openThroughTheDoor({ what: 'water the plants', when }));
    const row = mockDb.current!.prepare(
      'SELECT state, schedule_status, next_run_at, scheduled_start FROM work WHERE id = ?',
    ).get(id) as Record<string, unknown>;
    expect(row.state).toBe('on_deck');
    expect(row.schedule_status).toBe('waiting');
    expect(row.next_run_at).toBe(Date.parse(when));
    expect(row.scheduled_start).toBe(Date.parse(when));
  });
});

describe('T34: both creation doors route through the same settle, so neither can drift back', () => {
  it('the agent tool door and the dashboard route both call the settle helper', () => {
    const tools = readFileSync(join(SERVER_SRC, 'tracker', 'tools.ts'), 'utf8');
    const route = readFileSync(join(SERVER_SRC, 'gateway', 'routes', 'tracker.ts'), 'utf8');
    const schema = readFileSync(join(SERVER_SRC, 'tracker', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/export function broadcastTaskSettled/);
    expect(tools, 'work_open goes through it').toMatch(/broadcastTaskSettled\(/);
    expect(route, 'POST /tasks has the same createTask-then-schedule shape').toMatch(/broadcastTaskSettled\(/);
  });
});
