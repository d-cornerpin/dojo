// t193 — B1 + B2: one rule for who may move, edit, cancel or close a task, and for what reason.
//
// Every clause below that is marked RED was ACCEPTED at v3.3.3 (`e63aa3d7`): the reassign verb
// moved blocked work with no cause, the status door moved assignees on the side, any agent edited
// or cancelled any other agent's live task, close_project closed other agents' live tasks, and
// `complete_step` closed with no result or evidence. The owner's binding answers are
// `overhaul-plans/v34-owner-decisions.md` decisions 1, 2, 3, 27 and 29.
//
// Roles are structural (the primary flag and the PM role), never names.

import { unknownArgsAgainstSchema } from '../../agent/tools/index.js';
import { unreadArgsRefusal } from '../../agent/tools/unknown-args-refusal.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
const relayed = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../agent/a2a-notice.js', () => ({
  deliverA2ANotice: async (env: Record<string, unknown>) => { relayed.push(env); return { delivered: true }; },
}));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => MAIN,
  isPrimaryAgent: (id: string) => id === MAIN,
  getPMAgentId: () => PM,
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === PM,
}));

import { trackerUpdateStatus, trackerEditTask, trackerCloseProject, trackerRequestOverride } from '../tools.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { updateTask } from '../schema.js';
import { createWorkTable, seedTrackerTask, seedTrackerProject } from '../../work/__tests__/work-fixture.js';
import { AUDIT_KIND } from '../../work/audit-trail.js';
import { PATIENCE_ENTRY } from '../assignee-patience.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

const MAIN = 'main-agent-0001';
const PM = 'pm-agent-0001';
const WORKER = 'worker-agent-0001';
const PEER = 'peer-agent-0001';
const GONE = 'gone-agent-0001';
const TASK = 'task-0000-0001';
const TITLE = 'Reconcile the quarterly supplier ledger';
const OWNER_WORDS = 'Please give the ledger task to the other worker, it should not wait';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT, task_id TEXT,
      classification TEXT, parent_agent TEXT,
      updated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT,
      action_taken TEXT, note TEXT, evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER, tool TEXT,
      channel TEXT, recipient_id TEXT, recipient_display TEXT, conversation_id TEXT,
      root_kind TEXT, root_id TEXT, message_id TEXT, receipt_id TEXT, outcome TEXT,
      detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS turns (agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS turn_artifacts (id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, kind TEXT);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, task_id TEXT, run_id TEXT, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      swept_at TEXT, served_by_turn INTEGER, answer_message_id TEXT,
      channel TEXT, sender_id TEXT, source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT, a2a_requires_response INTEGER,
      inbound_meta TEXT, sent_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  for (const [id, status] of [[MAIN, 'idle'], [PM, 'idle'], [WORKER, 'working'], [PEER, 'idle'], [GONE, 'terminated']]) {
    db.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)').run(id, `role-${id.slice(0, 4)}`, status);
  }
}

const rowOf = (id = TASK) =>
  mockDb.current!.prepare('SELECT state, agent_id, assignee_agent, title, result, evidence_json FROM work WHERE id = ?')
    .get(id) as { state: string; agent_id: string; assignee_agent: string | null; title: string; result: string | null; evidence_json: string | null };

const reassignmentsOf = (id = TASK) =>
  (mockDb.current!.prepare('SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id')
    .all(id, AUDIT_KIND) as Array<{ actor: string; payload: string }>)
    .map((e) => ({ actor: e.actor, payload: JSON.parse(e.payload) as Record<string, string> }))
    .filter((e) => e.payload.entry_kind === PATIENCE_ENTRY.reassigned);

const reassign = (actor: string, args: Record<string, unknown>) =>
  trackerHandlers['work_update:reassign']!({ agentId: actor, args: { task_id: TASK, ...args } } as never);

/** A turn of `agent` that is answering the owner's message `words` — the structural "owner asked". */
function ownerTurn(agent: string, words: string): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO messages (id, agent_id, conversation_id, role, content, channel, inbound_meta, sent_at, created_at)
              VALUES ('msg-owner-1', ?, 'conv-1', 'user', ?, 'dashboard', ?, 1000, 1000)`)
    .run(agent, words, JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }));
  db.prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
              VALUES ('ask-owner-1', 'ask', ?, 'owner', 'ask', 'msg-owner-1', 'claimed', 'ask', 1, 0, 1000, 1000)`).run(agent);
  openTurnContext(agent).root = { kind: 'ask', id: 'msg-owner-1', sourceMessageId: 'msg-owner-1', conversationId: 'conv-1' };
}

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
  relayed.length = 0;
});
afterEach(() => {
  for (const a of [MAIN, PM, WORKER, PEER]) endTurnContext(a);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// B1 — MOVING THE ASSIGNEE (dec 1, 2 and the cause vocabulary)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('B1 the reassign verb needs a cause the engine can check', () => {
  it('the main agent cannot take a BLOCKED task a live helper holds', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER, hold_kind: 'blocked', hold_reason: 'need the vendor key' });
    const taken = await reassign(MAIN, { assigned_to: MAIN, cause: 'coordination' });
    expect(taken.isError, taken.content).toBe(true);
    expect(taken.content).toContain(`is held by agent ${WORKER}. Only its holder may hand it on.`);
    const gone = await reassign(MAIN, { assigned_to: MAIN, cause: 'assignee_gone' });
    expect(gone.content).toContain(`agent ${WORKER} is still live`);
    expect(rowOf().agent_id).toBe(WORKER);
  });

  it('the main agent moves blocked work whose holder is gone; a helper is still refused', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: GONE, createdBy: PEER, hold_kind: 'blocked', hold_reason: 'need the vendor key' });
    const helper = await reassign(PEER, { assigned_to: PEER, cause: 'assignee_gone' });
    expect(helper.isError).toBe(true);
    expect(helper.content).toMatch(/escalates to the owner/);
    const r = await reassign(MAIN, { assigned_to: PEER, cause: 'assignee_gone' });
    expect(r.isError, r.content).toBe(false);
    expect(rowOf().agent_id).toBe(PEER);
  });

  it('RED: a move with no cause is refused and names the vocabulary', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    const r = await reassign(MAIN, { assigned_to: PEER });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/assignee_gone, coordination, user_requested/);
    expect(rowOf().agent_id).toBe(WORKER);
  });

  it('RED: "assignee_gone" is refused while the holder is live (a slow agent is not a gone one)', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    const r = await reassign(MAIN, { assigned_to: PEER, cause: 'assignee_gone' });
    expect(r.isError).toBe(true);
    expect(rowOf().agent_id).toBe(WORKER);
  });

  it('"assignee_gone" with a terminated holder moves the task and records cause, who, from, to', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: GONE, createdBy: MAIN });
    const r = await reassign(MAIN, { assigned_to: PEER, cause: 'assignee_gone' });
    expect(r.isError, r.content).toBe(false);
    expect(rowOf()).toMatchObject({ agent_id: PEER, assignee_agent: PEER });
    const rec = reassignmentsOf();
    expect(rec).toHaveLength(1);
    expect(rec[0]!.actor).toBe(MAIN);
    expect(rec[0]!.payload.reason).toContain('cause=assignee_gone');
    expect(rec[0]!.payload.action_taken).toContain(GONE);
    expect(rec[0]!.payload.action_taken).toContain(PEER);
  });

  it('RED: "coordination" is the HOLDER handing on its own task; nobody else may claim it', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    const taken = await reassign(MAIN, { assigned_to: PEER, cause: 'coordination' });
    expect(taken.isError).toBe(true);
    expect(rowOf().agent_id).toBe(WORKER);
    const handed = await reassign(WORKER, { assigned_to: PEER, cause: 'coordination' });
    expect(handed.isError, handed.content).toBe(false);
    expect(rowOf().agent_id).toBe(PEER);
  });

  it('RED: "user_requested" is a claim until the owner\'s own message proves it', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    // No quote, and no owner turn: refused.
    expect((await reassign(MAIN, { assigned_to: PEER, cause: 'user_requested' })).isError).toBe(true);
    // A quote, but the turn is not answering the owner: still refused.
    expect((await reassign(MAIN, { assigned_to: PEER, cause: 'user_requested', user_quote: 'give it to the other worker' })).isError).toBe(true);
    expect(rowOf().agent_id).toBe(WORKER);
  });

  it('"user_requested" lands when this turn answers the owner and the quote is his whole sentence', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'blocked', agentId: WORKER });
    ownerTurn(MAIN, OWNER_WORDS);
    const wrong = await reassign(MAIN, { assigned_to: PEER, cause: 'user_requested', user_quote: 'move everything to me' });
    expect(wrong.isError, 'words the owner did not write prove nothing').toBe(true);
    const r = await reassign(MAIN, { assigned_to: PEER, cause: 'user_requested', user_quote: `"${OWNER_WORDS}"` });
    expect(r.isError, r.content).toBe(false);
    expect(rowOf().agent_id).toBe(PEER);
    expect(reassignmentsOf()[0]!.payload.reason).toContain('cause=user_requested');
  });

  it('declined work escalates to the owner; a block that was resolved forward does not freeze the row', async () => {
    const db = mockDb.current!;
    seedTrackerTask(db, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER, a2a_thread_id: 'thread-0001' });
    // The holder's delegated piece came back FAIL — the decline OR-PM-1v2 names.
    db.prepare(`INSERT INTO work (id, kind, parent_id, agent_id, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
                VALUES ('piece-0001', 'task', 'join-0001', ?, 'a2a_thread', 'thread-0001', 'failed', 'ask', 0, 0, 1, 1)`).run(PEER);
    db.prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('piece-0001', 'transition', '{"from":"claimed","to":"failed"}', ?, 2)`).run(PEER);
    const r = await reassign(WORKER, { assigned_to: PEER, cause: 'coordination' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/declined/);
    // A different row that was blocked once and has since resumed is handed on as usual.
    seedTrackerTask(db, { id: 'task-0000-0002', title: TITLE, status: 'in_progress', agentId: WORKER });
    db.prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES ('task-0000-0002', 'transition', '{"from":"claimed","to":"blocked"}', ?, 3)`).run(WORKER);
    const ok = await trackerHandlers['work_update:reassign']!({ agentId: WORKER, args: { task_id: 'task-0000-0002', assigned_to: PEER, cause: 'coordination' } } as never);
    expect(ok.isError, ok.content).toBe(false);
  });

  it('dec 1: the PM never moves a task, whatever cause it names', async () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: GONE });
    const r = await reassign(PM, { assigned_to: PEER, cause: 'assignee_gone' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/PM does not move tasks/);
    expect(rowOf().agent_id).toBe(GONE);
  });

  it('RED: the status door no longer moves the assignee on the side: the whole call is refused (at the door since test-2 rank 3)', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    const v = unknownArgsAgainstSchema('work_update', { action: 'status', task_id: TASK, status: 'in_progress', assigned_to: PEER });
    expect(v.unread).toEqual(['assigned_to']);
    const out = unreadArgsRefusal(v.op!, v.unread);
    expect(out.startsWith('Refused'), out).toBe(true);
    expect(out).toMatch(/action="reassign"/);
    trackerUpdateStatus(MAIN, { taskId: TASK, status: 'in_progress', assignedTo: PEER });   // the writer never reads it either
    expect(rowOf()).toMatchObject({ agent_id: WORKER, assignee_agent: WORKER });
  });

  it('CONTROL: the owner\'s dashboard door (updateTask) still moves and clears the assignee', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER });
    expect(updateTask(TASK, { assignedTo: PEER })).not.toBeNull();
    expect(rowOf()).toMatchObject({ agent_id: PEER, assignee_agent: PEER });
    expect(updateTask(TASK, { assignedTo: null })).not.toBeNull();
    expect(rowOf()).toMatchObject({ agent_id: PEER, assignee_agent: null });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// dec 2 — NO TAKING, CANCELLING OR REDOING ANOTHER LIVE AGENT'S WORK
// ════════════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════════════
// dec 3 — EDITORS: HOLDER, CREATOR, PM, MAIN AGENT
// ════════════════════════════════════════════════════════════════════════════════════════

describe('dec 3 only the holder, the creator, the PM and the main agent change a task', () => {
  it("RED: a bystander agent cannot edit or re-pause another agent's task", () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: MAIN });
    const edit = trackerEditTask(PEER, { taskId: TASK, title: 'Something else entirely' });
    expect(edit.startsWith('Error'), edit).toBe(true);
    expect(rowOf().title).toBe(TITLE);
    const pause = trackerUpdateStatus(PEER, { taskId: TASK, status: 'paused', notes: 'waiting for the vendor to answer' });
    expect(pause.startsWith('Error'), pause).toBe(true);
    expect(rowOf().state).toBe('claimed');
  });

  it('the holder, the creator, the PM and the main agent may all edit', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: TITLE, status: 'in_progress', agentId: WORKER, createdBy: PEER });
    for (const [who, t] of [[WORKER, 'Edited by holder'], [PEER, 'Edited by creator'], [PM, 'Edited by the PM'], [MAIN, 'Edited by the main agent']]) {
      const out = trackerEditTask(who!, { taskId: TASK, title: t });
      expect(out.startsWith('Error'), out).toBe(false);
      expect(rowOf().title).toBe(t);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// dec 29 — CLOSE_PROJECT OVER ANOTHER LIVE AGENT'S WORK
// ════════════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════════════
// B2 / dec 27 — A STEP CLOSES WITH THE SAME PROOF AS A COMPLETE
// ════════════════════════════════════════════════════════════════════════════════════════

