// t90 D1 — THE PM KEEPS THE AGENT WORKING. IT HAS NO OTHER AUTHORITY OVER A SLOW TASK.
//
// Tracker report #6, from the owner's own box on v3.2.2: a sub-agent he had deliberately put on a
// slower model was making progress, the PM read the pace as a stall, and rung 4 of the poke ladder
// emptied the task out from under it and handed the work to the PRIMARY by A2A — repeatedly, so the
// project could never be finished by the agent he chose.
//
// ── ⛔ THE SHAPE THIS FILE PINS IS THE OWNER'S, NOT THE REPORT'S ──
// The report's fix ideas asked for "notify the user and ask whether to wait, reassign, or cancel",
// and the first cut of this suite pinned exactly that. OWNER RULING 2026-10-02 struck it out:
// *"The user should not be bothered with these things. The PM's job is to simply keep the agent
// working on their task. Their job is not to reassign a task because they don't feel it is getting
// worked on fast enough."* The fix ideas were the reporting agent's voice. So the clauses that
// pinned an owner ask are gone with the ask, and §2's centrepiece is now a CENSUS of absence.
//
// §1 the patience floor, and R6 proved as arithmetic rather than promised  (kept verbatim)
// §2 ⚠ THE NEGATIVE CENSUS: no path from the PM to a task's assignee, counted
// §3 the human reassignment audit — the one reassignment left, and its two doors
//
// Every section carries a POLICY clause and a WIRE clause, per the standing campaign rule.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

/** ⚠ FIX ROUND 2 (N1). The PM's own log is the only place a DROPPED poke can be seen, so the
 *  logger is captured rather than silenced. `createLogger` is replaced for every component in the
 *  graph (the rest of the module is spread through), which is the house pattern from
 *  `memory/__tests__/an-absent-embedder-is-one-warn-not-a-hundred-errors.test.ts`. */
const log = vi.hoisted(() => {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger.js')>()),
  createLogger: () => log.logger,
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));

/** ⚠ THE CONTROL THAT MATTERS MOST. The old rung's handoff went out through this door; every
 *  clause in §2 and §3 asserts it was never opened. */
/** FIX ROUND 2 (N1): the spy answers in the transport's OWN result shape
 *  (`A2ADeliveryResult` = `{ delivered, reason?, threadId }`), because the defect N1 names is a
 *  `{delivered:false}` RETURN that the old always-true stub could not express. `deliverA2ADrops`
 *  makes the next call drop with the reason the hop cap uses. */
const deliverA2ADrops = { next: null as string | null };
const deliverA2ASpy = vi.fn(async (envelope?: unknown) => {
  const threadId = (envelope as { threadId?: string } | undefined)?.threadId ?? 'thread-unknown';
  const drop = deliverA2ADrops.next;
  deliverA2ADrops.next = null;
  return drop ? { delivered: false, reason: drop, threadId } : { delivered: true, threadId };
});
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverA2ASpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
vi.mock('../../agent/agent-notice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/agent-notice.js')>()),
  // t143 round 3 (I2): a PM poke is a re-drive that owes no reply and travels no thread; this door
  // records it in the spy's envelope shape (recipient, payload) and the clauses read that.
  redriveWithoutReply: async (o: { toAgentId: string; fromAgentId: string | null; content: string }) => {
    await deliverA2ASpy({ toAgent: o.toAgentId, fromAgent: o.fromAgentId, payload: o.content, requiresResponse: false });
    return true;
  },
}));


import {
  patienceFloorFor, patienceBoundMs, recordReassignment, PATIENCE_ENTRY,
} from '../assignee-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../../agent/stream-patience.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { PM_ALLOWED_WORK_OPS, PM_ONLY_WORK_OPS } from '../pm-agent.js';

const SLOW_AGENT = 'slow-sub-agent';
const PRIMARY = 'primary-agent';

function createAgentsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT,
    updated_at TEXT, session_started_at TEXT)`);
}
/** `messages.created_at` is an epoch-ms INTEGER since migration 131; the fixture must match it,
 *  or a reader that formats the column never sees what the real table would have returned. */
function createMessagesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000))`);
}
/** `models JOIN providers` — the shape `patienceFloorFor` reads, which is the shape migration
 *  163 rides and `agent/model.ts` already performs. */
function createModelTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT,
      first_chunk_timeout_ms INTEGER, stream_idle_timeout_ms INTEGER);
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY, provider_id TEXT, name TEXT);
  `);
}

/** A provider row, declared or not, with a model and an agent sitting on it. */
function seedAssignee(p: {
  agentId: string; status?: string; firstChunkMs?: number | null; idleMs?: number | null;
}): void {
  const db = mockDb.current!;
  db.prepare('INSERT OR REPLACE INTO providers (id, name, first_chunk_timeout_ms, stream_idle_timeout_ms) VALUES (?, ?, ?, ?)')
    .run(`prov-${p.agentId}`, 'P', p.firstChunkMs ?? null, p.idleMs ?? null);
  db.prepare('INSERT OR REPLACE INTO models (id, provider_id, name) VALUES (?, ?, ?)')
    .run(`model-${p.agentId}`, `prov-${p.agentId}`, 'M');
  db.prepare("INSERT OR REPLACE INTO agents (id, name, status, model_id, updated_at) VALUES (?, ?, ?, ?, '2026-01-01')")
    .run(p.agentId, p.agentId, p.status ?? 'idle', `model-${p.agentId}`);
}

function auditRows(taskId: string, entryKind: string): Array<{ payload: string }> {
  return mockDb.current!.prepare(
    `SELECT payload FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?
      ORDER BY id`,
  ).all(taskId, entryKind) as Array<{ payload: string }>;
}
function eventCount(taskId: string, kind: string): number {
  return (mockDb.current!.prepare(
    'SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, kind) as { c: number }).c;
}
function taskRow(taskId: string): { state: string; agent_id: string | null } {
  return mockDb.current!.prepare('SELECT state, agent_id FROM work WHERE id = ?')
    .get(taskId) as { state: string; agent_id: string | null };
}

/** A task stale enough to reach whichever rung the caller is aiming at. */
function seedStaleTask(id: string, idleSeconds: number, agentId = SLOW_AGENT): void {
  seedTrackerTask(mockDb.current!, { id, agentId, status: 'in_progress', title: 'the long project' });
  mockDb.current!.prepare('UPDATE work SET updated_at = ?, priority = ? WHERE id = ?')
    .run(Date.now() - idleSeconds * 1000, 'normal', id);
}

/**
 * ⚠ THE CONTROL, STATED PRECISELY. The A2A door is not the defect — rungs 1 and 2 poke the
 * ASSIGNEE through it, which is the ladder doing its job, and rung 3 notifies the primary that a
 * task is stalled (preserved behaviour, and a notification is not a handoff). What report #6 is
 * about is a HANDOFF: an `intent: 'ASSIGN'` delivery that tells the primary to take the work
 * over. So these two read the recipient and the intent rather than the call count — a clause that
 * demanded silence would fail on the ladder's legitimate pokes and would have to be weakened,
 * and a weakened clause is how the real thing comes back.
 */
function handoffDeliveries(): unknown[] {
  // `intent: 'ASSIGN'` IS the handoff — it is what tells the platform the work changed hands.
  // Deliberately not a text search: the fixed escalation text now contains the word "reassign"
  // in the sentence that FORBIDS it, and a clause that cannot tell an instruction from a
  // prohibition is a clause that will be weakened the first time it misfires.
  return deliverA2ASpy.mock.calls
    .map((c) => c[0] as { intent?: string } | undefined)
    .filter((a) => a?.intent === 'ASSIGN');
}
function deliveriesTo(agentId: string): unknown[] {
  return deliverA2ASpy.mock.calls
    .map((c) => c[0] as { toAgent?: string } | undefined)
    .filter((a) => a?.toAgent === agentId);
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  createAgentsTable(db);
  createMessagesTable(db);
  createModelTables(db);
  mockDb.current = db;
  deliverA2ASpy.mockClear();
  deliverA2ADrops.next = null;
  for (const k of Object.keys(log.calls) as Array<keyof typeof log.calls>) log.calls[k].length = 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — THE PATIENCE FLOOR
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 the patience floor is derived, and it only ever lengthens', () => {
  /**
   * ⚠ THE KEYSTONE CLAUSE (plan ruling R6: "NULL rows byte-preserve today's behavior").
   *
   * Not a promise in a comment — the arithmetic, for every priority the table carries. If this
   * clause ever goes red, every undeclared box on the planet just had its PM made more or less
   * patient by a change that was supposed to touch only declared ones.
   */
  it('an UNDECLARED provider waits the base bound, five minutes', () => {
    seedAssignee({ agentId: 'fast-agent' });
    expect(patienceBoundMs('fast-agent')).toBe(300_000);
  });

  it('a declared SLOW provider waits one legitimate call', () => {
    // 600 s before token 1 + 600 s of permitted silence = a 1,200 s step. The owner's DS4 row.
    seedAssignee({ agentId: SLOW_AGENT, firstChunkMs: 600_000, idleMs: 600_000 });
    expect(patienceBoundMs(SLOW_AGENT)).toBe(1_200_000);
  });

  it('⚠ a floor NEVER shortens the bound, however small the declaration', () => {
    seedAssignee({ agentId: 'tiny-agent', firstChunkMs: 500, idleMs: 500 });
    expect(patienceBoundMs('tiny-agent')).toBe(300_000);
  });

  it('reads the assignee\'s own provider, and calls a default a default', () => {
    seedAssignee({ agentId: SLOW_AGENT, firstChunkMs: 600_000, idleMs: 600_000 });
    const declared = patienceFloorFor(SLOW_AGENT);
    expect(declared.floorSeconds).toBe(1_200);
    expect(declared.basis, 'a provider that declared must not be called a default').toBe('declared');
    expect(declared.modelId).toBe(`model-${SLOW_AGENT}`);

    seedAssignee({ agentId: 'fast-agent' });   // both columns NULL
    const undeclared = patienceFloorFor('fast-agent');
    expect(undeclared.basis, 'and a default must not be called a declaration').toBe('default');
    expect(undeclared.floorSeconds)
      .toBe(Math.ceil((STREAM_FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS) / 1000));

    // An unknown agent buys itself no extra silence — the safe direction.
    expect(patienceFloorFor('nobody').basis).toBe('default');
    expect(patienceFloorFor(null).floorSeconds).toBe(undeclared.floorSeconds);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — THE PM POKES. THE CENSUS IS THAT IT DOES NOTHING ELSE.
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 no path from the PM to a task\'s assignee', () => {
  it('CENSUS: pm-agent.ts mints no ASSIGN intent anywhere in the file', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    // Not just the sweep: the whole module. The old rung-3 escalation sent ASSIGN from a
    // different code path than rung 4, so a file-wide count is the only honest version.
    expect(src.match(/intent:\s*'ASSIGN'/g) ?? [], 'the PM transfers ownership of nothing').toEqual([]);
    expect(src, 'and the ternary that used to choose it is gone')
      .not.toContain("'escalate_primary' ? 'ASSIGN'");
  });

  it('⚠ the PM no longer holds the reassign verb at all', async () => {
    expect([...PM_ALLOWED_WORK_OPS], 'owner ruling 2026-10-02: no reassignment concept')
      .not.toContain('work_update:reassign');
    // And it is NOT PM-only, so removing it from the PM's list leaves it callable by the primary
    // acting for a person — the recorded failure mode is a verb that is PM-only AND unallowed,
    // which closes it to everyone (see `PRIMARY_ONLY_WORK_OPS`' own comment).
    expect(PM_ONLY_WORK_OPS.has('work_update:reassign'),
      'the human path must stay open; only the overseer loses it').toBe(false);
  });

});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — THE ONE REASSIGNMENT LEFT IS A PERSON'S, AND IT IS RECORDED
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 a human reassignment is recorded at both of its doors', () => {
  it('the record names who, why, where from, where to, and the prior assignee\'s last state', () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'working' });
    seedStaleTask('t-moved', 10);

    recordReassignment({
      taskId: 't-moved', actor: 'user', fromAgentId: SLOW_AGENT, toAgentId: PRIMARY,
      reason: 'owner chose reassign at the decision ask',
    });

    const rows = auditRows('t-moved', PATIENCE_ENTRY.reassigned);
    expect(rows.length).toBe(1);
    const payload = rows[0].payload;
    expect(payload).toContain('owner chose reassign');
    expect(payload).toContain(SLOW_AGENT);
    expect(payload).toContain(PRIMARY);
    expect(payload, 'the prior assignee\'s last state is the half an owner cannot reconstruct later')
      .toContain('prior assignee last state');
    expect(payload).toContain('status=working');
  });

  it('the prior assignee\'s last activity is the newest message as a UTC date, never epoch digits', () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'working' });
    // `created_at` is epoch-ms INTEGER (migration 131): 1760000000000 ms is 2025-10-09 08:53:20 UTC.
    mockDb.current!.prepare(
      'INSERT INTO messages (agent_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    ).run(SLOW_AGENT, 'assistant', 'still thinking', 1_760_000_000_000);
    seedStaleTask('t-digits', 10);

    recordReassignment({
      taskId: 't-digits', actor: 'user', fromAgentId: SLOW_AGENT, toAgentId: PRIMARY,
      reason: 'owner moved it at the board',
    });

    const rows = auditRows('t-digits', PATIENCE_ENTRY.reassigned);
    expect(rows.length).toBe(1);
    expect(rows[0].payload, 'the note an owner reads to judge staleness must carry a date')
      .toContain('last activity 2025-10-09 08:53:20');
    expect(rows[0].payload, 'and never the raw 13 digits of the epoch-ms column')
      .not.toContain('1760000000000');

    // The control: with no message rows the agent's own `updated_at` text is still printed as-is.
    seedAssignee({ agentId: 'quiet-agent', status: 'idle' });
    seedStaleTask('t-quiet', 10);
    recordReassignment({
      taskId: 't-quiet', actor: 'user', fromAgentId: 'quiet-agent', toAgentId: PRIMARY,
      reason: 'owner moved this one too',
    });
    const quiet = auditRows('t-quiet', PATIENCE_ENTRY.reassigned);
    expect(quiet.length).toBe(1);
    expect(quiet[0].payload, 'the no-message fallback is the agents.updated_at text, unchanged')
      .toContain('last activity 2026-01-01');
  });

  it('WIRE: the dashboard\'s task update records it, reading the prior assignee first', () => {
    const src = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', 'gateway', 'routes', 'tracker.ts',
    ), 'utf8');
    expect(src, 'the dashboard door must record a reassignment').toContain('recordReassignment({');
    expect(src, 'and must read the prior assignee from the pre-write snapshot')
      .toContain("fromAgentId: prior?.assignedTo ?? null");
    expect(src.indexOf('const prior = getTask(id);'))
      .toBeLessThan(src.indexOf('recordReassignment({'));
    // ⛔ And the doors this package built and the owner struck out are GONE from the route file.
    expect(src, 'the assignee-decision door was deleted').not.toContain('assignee-decision');
    expect(src, 'and so was the extended-patience door').not.toContain('extended-patience');
  });

  it('WIRE: the reassign verb records through the row-authority gate, FROM read before the write', () => {
    // t193: the verb no longer writes or records by itself; `moveAssignee` checks the cause,
    // writes, and records cause/who/from/to. Both halves are asserted where they now live.
    const here = dirname(fileURLToPath(import.meta.url));
    const verb = readFileSync(join(here, '..', '..', 'agent', 'tools', 'cat', 'tracker.ts'), 'utf8');
    const body = verb.slice(verb.indexOf('async "work_update:reassign"('));
    expect(body, 'the reassign executor moves through the gate').toContain('moveAssignee({');
    expect(body, 'and never writes the row itself').not.toContain('patchWork(');
    const gate = readFileSync(join(here, '..', '..', 'work', 'row-authority.ts'), 'utf8');
    const move = gate.slice(gate.indexOf('export function moveAssignee('));
    // t201: the record moved to the one shared recorder (`work/move-record.ts`), which the healer's
    // orphan sweep and the scheduler's gone-assignee fire file through too; the gate still calls it.
    expect(move, 'the gate must record, not merely remediate').toContain('recordMove({');
    expect(move, 'and must name where the task came FROM').toContain('from: c.facts.holder');
    const recorder = readFileSync(join(here, '..', '..', 'work', 'move-record.ts'), 'utf8');
    expect(recorder, 'the recorder files the reassignment record and re-arm').toContain('recordReassignment({');
    expect(recorder, 'with the FROM it was given').toContain('fromAgentId: p.from');
    expect(move.indexOf('checkMove(req)'), 'which it reads before the write moves it')
      .toBeLessThan(move.indexOf('writeAssignee('));
    // And the bare re-arm is gone: one call does both, so neither can be forgotten.
    expect(verb, 'the old standalone re-arm must not survive beside it')
      .not.toContain('recordRemediation(reassignTaskId');
  });
});
