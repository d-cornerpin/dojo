// t90 D1 — THE PM MAY WAIT AND IT MAY ASK; IT MAY NOT TAKE THE WORK AWAY.
//
// Tracker report #6, from the owner's own box on v3.2.2: a sub-agent he had deliberately put on
// a slower model was making progress, the PM read the pace as a stall, and rung 4 of the poke
// ladder emptied the task out from under it and handed the work to the PRIMARY by A2A — with no
// owner in the loop, repeatedly, so the project could never be finished by the agent he chose.
//
// Every section carries a POLICY clause and a WIRE clause, per the standing campaign rule. The
// policy clauses pin the arithmetic and the records; the wire clauses drive the real sweep
// (`runPokeCheck`) or read the real call site, because this defect WAS a wiring fact — the old
// rung's three writes were all reachable from one `if`, and a module that merely exports the
// right functions would reproduce the report exactly.
//
// §1 the patience floor, and R6 proved as arithmetic rather than promised
// §2 the terminal rung: the owner is asked, and nothing moves
// §3 the per-task extended-patience flag
// §4 every reassignment leaves a record

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
const deliverA2ASpy = vi.fn(async () => ({ delivered: true }));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverA2ASpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { runPokeCheck, POKE_THRESHOLDS } from '../pm-agent.js';
import {
  patienceFloorFor, flooredThresholds, extendedPatience, grantExtendedPatience,
  revokeExtendedPatience, recordReassignment, PATIENCE_ENTRY,
} from '../assignee-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../../agent/stream-patience.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const SLOW_AGENT = 'slow-sub-agent';
const PRIMARY = 'primary-agent';

function createAgentsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT,
    updated_at TEXT, session_started_at TEXT)`);
}
function createMessagesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
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
  it('an UNDECLARED provider reproduces today\'s table exactly, for every priority', () => {
    const floor = Math.ceil((STREAM_FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS) / 1000);
    for (const [priority, base] of Object.entries(POKE_THRESHOLDS)) {
      expect(flooredThresholds(base, floor), `priority=${priority} must be byte-identical`)
        .toEqual(base);
    }
  });

  it('a declared SLOW provider lengthens every rung, in proportion to one legitimate call', () => {
    // 600 s before token 1 + 600 s of permitted silence = a 1,200 s step. The owner's DS4 row.
    const base = POKE_THRESHOLDS.normal;
    expect(flooredThresholds(base, 1_200)).toEqual({
      first: 1_200,       // was 300  — one step
      second: 2_400,      // was 900  — two
      escalate: 3_600,    // was 1800 — three
      autoReset: 4_800,   // was 3600 — four
    });
  });

  it('⚠ a floor NEVER shortens the ladder, however small the declaration', () => {
    // A provider declaring one second of patience must not bring the PM FORWARD. Every value is
    // a `max`, and this is the shape that would prove otherwise.
    const base = POKE_THRESHOLDS.high;
    expect(flooredThresholds(base, 1)).toEqual(base);
    expect(flooredThresholds(base, 0)).toEqual(base);
    expect(flooredThresholds(base, -5)).toEqual(base);
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
// §2 — THE TERMINAL RUNG: ASK, DO NOT TAKE
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 rung 4 asks the owner and moves nothing', () => {
  /**
   * ⚠ THE REPORT, AS A CLAUSE. Everything this asserts was FALSE on v3.2.2: the task went to
   * `on_deck`, and an A2A `ASSIGN` went to the primary telling it to re-home the work.
   */
  it('WIRE: the real sweep asks the owner — no status move, no assignee change, no A2A', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle' });
    seedAssignee({ agentId: PRIMARY, status: 'idle' });
    seedStaleTask('t-report6', 4_000);   // past normal.autoReset (3600) on an undeclared row
    const before = taskRow('t-report6');

    await runPokeCheck();
    await flushMicrotasks();

    const after = taskRow('t-report6');
    expect(after.state, 'the assignment must NOT be taken away').toBe(before.state);
    expect(after.agent_id, 'and must NOT move to anyone, least of all the primary')
      .toBe(SLOW_AGENT);
    expect(handoffDeliveries(), 'no ASSIGN handoff may be sent to anyone').toEqual([]);
    expect(deliveriesTo(PRIMARY), 'the primary is not a fallback bin').toEqual([]);

    // What DID happen: the owner was asked, and the ask names the three options and the state.
    const asks = auditRows('t-report6', PATIENCE_ENTRY.decisionRequested);
    expect(asks.length, 'the owner must be asked exactly once').toBe(1);
    const payload = asks[0].payload;
    expect(payload).toContain('WAIT');
    expect(payload).toContain('REASSIGN');
    expect(payload).toContain('CANCEL');
    expect(payload, 'the ask must say that nothing was changed').toContain('Nothing has been changed');
    expect(payload, 'and carry the prior assignee\'s last known state').toContain('last seen');
    expect(eventCount('t-report6', 'user_verdict_requested'),
      'the verdict flag is what stands the ladder down while the owner decides').toBe(1);
    expect(eventCount('t-report6', 'poke'), 'and the rung is spent, so it cannot re-ask')
      .toBeGreaterThan(0);
  });

  it('WIRE: a second sweep does not ask again', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle' });
    seedStaleTask('t-once', 4_000);

    await runPokeCheck();
    await flushMicrotasks();
    await runPokeCheck();
    await flushMicrotasks();

    expect(auditRows('t-once', PATIENCE_ENTRY.decisionRequested).length,
      'a 60-second sweep must not re-ask the owner every minute').toBe(1);
  });

  /**
   * ⚠ THE FIX, MEASURED ON THE REPORT'S OWN SCENARIO. Same task, same idle time, same priority
   * — the only difference is that the assignee's provider declares how long one of its calls may
   * take. On v3.2.2 this agent lost its task; here it is not even asked about.
   */
  it('WIRE: the slow sub-agent of report #6 reaches NO rung at this idle time', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle', firstChunkMs: 600_000, idleMs: 600_000 });
    seedStaleTask('t-slow', 4_000);   // over the stock 3600, under the floored 4800

    await runPokeCheck();
    await flushMicrotasks();

    expect(auditRows('t-slow', PATIENCE_ENTRY.decisionRequested).length,
      'a slow box must not be asked about on a fast box\'s clock').toBe(0);
    expect(taskRow('t-slow').agent_id).toBe(SLOW_AGENT);
    expect(handoffDeliveries(), 'and nothing is handed to anybody').toEqual([]);

    // And the control: the same declared row DOES reach the ask once its own floor is passed.
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 5_000 * 1000, 't-slow');
    await runPokeCheck();
    await flushMicrotasks();
    expect(auditRows('t-slow', PATIENCE_ENTRY.decisionRequested).length,
      'patience is a floor, not an exemption').toBe(1);
  });

  it('rung 3 notifies the primary without handing it the decision', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8');
    const text = src.slice(src.indexOf("case 'escalate_primary':"));
    // COMMENT LINES STRIPPED: the tombstone above this case quotes the banned sentence verbatim,
    // which is how a tombstone works and must not make the clause red. What is asserted is the
    // text the primary actually RECEIVES.
    const body = text.slice(0, text.indexOf('\n\n    default:'))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body, 'the escalation must not instruct a reassignment').not.toContain('Reassign or unblock');
    expect(body, 'nor a cancel').not.toContain("cancel/fail it if it's no longer needed");
    expect(body, 'it says the decision is the owner\'s').toContain('asks the owner');
    expect(body, 'and the close-out repair stays — that is not a transfer').toContain('that is a close-out, not a takeover');
    // No rung may carry the ownership-transfer intent any more.
    expect(src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'),
      'ASSIGN is the handoff intent and no rung may send it')
      .not.toContain("'escalate_primary' ? 'ASSIGN'");
  });

  it('WIRE: the rung\'s old three writes are gone from the source', () => {
    // The defect was three statements inside one `if`. A behavioural clause can show the owner
    // is asked; only this can show the old actions are not ALSO still happening on some path.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8');
    const rung = src.slice(src.indexOf("if (pokeType === 'auto_reset')"));
    const body = rung.slice(0, rung.indexOf('\n    }\n'));
    expect(body, 'the rung must not move the task').not.toContain("'on_deck'");
    expect(body, 'the rung must not fail a scheduled run').not.toContain('onTaskRunComplete');
    expect(body, 'the rung must not message anybody').not.toContain('deliverA2AMessage');
    expect(body, 'it asks the owner').toContain('requestAssigneeDecision');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — THE PER-TASK EXTENDED-PATIENCE FLAG
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 extended patience: the owner says "slow on purpose"', () => {
  it('the newest decision wins, and it survives as history rather than a column', () => {
    seedStaleTask('t-flag', 10);
    expect(extendedPatience('t-flag'), 'nobody has said anything yet').toBe(false);
    grantExtendedPatience('t-flag', 'user', 'assigned to the slow local model on purpose');
    expect(extendedPatience('t-flag')).toBe(true);
    revokeExtendedPatience('t-flag', 'user', 'moved back to a cloud model');
    expect(extendedPatience('t-flag'), 'a revoke after a grant must win').toBe(false);
    grantExtendedPatience('t-flag', 'user', 'and back again');
    expect(extendedPatience('t-flag'), 'and a grant after a revoke must win').toBe(true);
    // Both decisions are still on the record — the point of deriving rather than storing.
    expect(auditRows('t-flag', PATIENCE_ENTRY.extended).length).toBe(2);
    expect(auditRows('t-flag', PATIENCE_ENTRY.revoked).length).toBe(1);
  });

  it('WIRE: a flagged task is never escalated or asked about, however idle', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle' });
    seedStaleTask('t-patient', 40_000);   // eleven hours: far past every rung
    grantExtendedPatience('t-patient', 'user', 'slow agent, extended patience');

    await runPokeCheck();
    await flushMicrotasks();

    expect(auditRows('t-patient', PATIENCE_ENTRY.decisionRequested).length,
      'the owner already answered this question by setting the flag').toBe(0);
    expect(handoffDeliveries(), 'and the work is handed to nobody').toEqual([]);
    expect(deliveriesTo(PRIMARY),
      'rung 3 escalates to the primary and the flag must hold that back too').toEqual([]);
    expect(taskRow('t-patient').agent_id).toBe(SLOW_AGENT);

    // "PM skips intervention logic and ONLY NOTIFIES" — the notify half still runs, so the
    // flag is not a mute button. Rung 1/2 pokes are messages to the assignee itself.
    expect(eventCount('t-patient', 'poke'), 'the assignee is still nudged').toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 — EVERY REASSIGNMENT LEAVES A RECORD
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 a reassignment is recorded, whoever makes it', () => {
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
    // The ladder re-arm the call site used to do by itself now rides along, inseparably.
    expect(eventCount('t-moved', 'poke_remediation'),
      'the record and the re-arm must not be able to come apart').toBe(1);
  });

  it('WIRE: the reassign verb calls it, with the FROM assignee read before the write', () => {
    const src = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'tools', 'cat', 'tracker.ts',
    ), 'utf8');
    const call = src.match(/^\s*if \(!isError\) recordReassignment\(.*$/m)?.[0];
    expect(call, 'the reassign executor must record, not merely remediate').toBeTruthy();
    expect(call, 'and must name where the task came FROM').toContain('reassignTask.from_agent');
    expect(src, 'which it can only know by selecting it before patchWork moves it')
      .toContain('w.agent_id AS from_agent');
    expect(src.indexOf('w.agent_id AS from_agent'))
      .toBeLessThan(src.indexOf('if (!isError) recordReassignment('));
    // And the bare re-arm is gone: one call does both, so neither can be forgotten.
    expect(src, 'the old standalone re-arm must not survive beside it')
      .not.toContain('recordRemediation(reassignTaskId');
  });
});
