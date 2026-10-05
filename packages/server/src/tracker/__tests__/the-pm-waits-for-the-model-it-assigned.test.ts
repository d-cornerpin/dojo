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
  patienceFloorFor, flooredThresholds, recordReassignment, PATIENCE_ENTRY,
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
// §2 — THE PM POKES. THE CENSUS IS THAT IT DOES NOTHING ELSE.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * THE POKE LADDER'S OWN SOURCE — scoped, and the scope is argued.
 *
 * `runPokeCheck` hosts TWO mechanisms: an A2A auto-task sweeper that closes stale engine-created
 * `on_deck` rows (unrelated, pre-existing, and it legitimately names that state), and the poke
 * ladder. A census over the whole function would be reading the wrong mechanism's writes, so this
 * slices from where the ladder reads its thresholds to the end of the sweep — which is exactly the
 * region both deleted shapes lived in.
 *
 * Comment lines are stripped: the tombstones inside quote the deleted writes verbatim, which is how
 * a tombstone works and must not make a census red.
 */
function pokeLadderSource(): string {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8');
  const from = src.indexOf('const patienceFloor = patienceFloorFor(');
  expect(from, 'the ladder must still be findable by its threshold read').toBeGreaterThan(0);
  const rest = src.slice(from);
  const to = rest.search(/\n(?:export )?(?:async )?function |\nexport const /);
  const body = to > 0 ? rest.slice(0, to) : rest;
  return body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

describe('§2 no path from the PM to a task\'s assignee', () => {
  /**
   * ⚠ THE CLAUSE THAT MATTERS MOST, AND IT COUNTS.
   *
   * Both shapes that died here were reachable from ONE `if` inside the poke sweep, and a
   * behavioural clause can only ever prove that today's code does not take them. This census
   * proves the writes are not in the function at all — so a future "helpful" rung cannot rebuild
   * one without turning this red.
   *
   * It counts its own patterns on purpose: `BANNED` is asserted to be the length it was written
   * with, so deleting a row to make the census pass fails the census.
   */
  const BANNED: ReadonlyArray<[string, string]> = [
    ["'on_deck'", 'moving a task back to the deck is taking it away from its assignee'],
    ['onTaskRunComplete', 'failing a scheduled run is not a poke'],
    ["intent: 'ASSIGN'", 'ASSIGN is the ownership-transfer intent; the PM may never mint one'],
    // WRITE shapes, not bare names: the ladder legitimately READS `task.assignedTo` seven times
    // (to pick a recipient, to guard on the assignee's status, to broadcast who was poked), and a
    // census that banned the read would have to be weakened the first time it misfired. The
    // property-assignment form is what a write looks like in every one of these call shapes.
    ['assignedTo:', 'the ladder may not write an assignee'],
    ['agent_id:', 'nor the column under it'],
    ['assignee_agent', 'nor the nullable column beside that one'],
    ['updateTask(', 'nor reach the helper the dashboard uses to move one'],
    ['work_update:reassign', 'nor reach for the verb'],
    ['requestUserVerdict', 'and it may not raise an owner decision either (owner ruling 2026-10-02)'],
    ['requestAssigneeDecision', 'including the one this package built and the owner struck out'],
  ];

  it('⚠ CENSUS: the poke ladder contains none of the ten writes that could move work', () => {
    expect(BANNED.length, 'the census must still check ten patterns — deleting a row is not a pass')
      .toBe(10);
    const body = pokeLadderSource();
    for (const [pattern, why] of BANNED) {
      expect(body, `${why} — found \`${pattern}\` in runPokeCheck`).not.toContain(pattern);
    }
  });

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
    const { PM_ALLOWED_WORK_OPS, PM_ONLY_WORK_OPS } = await import('../pm-agent.js');
    expect([...PM_ALLOWED_WORK_OPS], 'owner ruling 2026-10-02: no reassignment concept')
      .not.toContain('work_update:reassign');
    // And it is NOT PM-only, so removing it from the PM's list leaves it callable by the primary
    // acting for a person — the recorded failure mode is a verb that is PM-only AND unallowed,
    // which closes it to everyone (see `PRIMARY_ONLY_WORK_OPS`' own comment).
    expect(PM_ONLY_WORK_OPS.has('work_update:reassign'),
      'the human path must stay open; only the overseer loses it').toBe(false);
  });

  it('WIRE: the real sweep pokes the assignee and moves nothing', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle' });
    seedAssignee({ agentId: PRIMARY, status: 'idle' });
    seedStaleTask('t-report6', 4_000);   // past normal.autoReset (3600) on an undeclared row
    const before = taskRow('t-report6');

    await runPokeCheck();
    await flushMicrotasks();

    const after = taskRow('t-report6');
    expect(after.state, 'the assignment must NOT be taken away').toBe(before.state);
    expect(after.agent_id, 'and must NOT move to anyone, least of all the primary').toBe(SLOW_AGENT);
    expect(handoffDeliveries(), 'no ASSIGN handoff may be sent to anyone').toEqual([]);
    expect(deliveriesTo(PRIMARY), 'the primary is not a fallback bin').toEqual([]);

    // What DID happen: the top rung poked the ASSIGNEE, and said the task is still theirs.
    expect(eventCount('t-report6', 'poke'), 'the PM\'s one authority is to keep it working')
      .toBeGreaterThan(0);
    const poked = deliveriesTo(SLOW_AGENT) as Array<{ payload?: string }>;
    expect(poked.length, 'and the poke goes to the agent doing the work').toBeGreaterThan(0);
    expect(poked.map((d) => d.payload ?? '').join('\n'))
      .toContain('still yours and nobody is taking it from you');
    expect(eventCount('t-report6', 'user_verdict_requested'),
      'and the owner is not asked anything — that was struck out').toBe(0);
  });

  it('WIRE: rung 3 notifies the primary without handing it anything', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-agent.ts'), 'utf8');
    const text = src.slice(src.indexOf("case 'escalate_primary':"));
    const body = text.slice(0, text.indexOf("\n\n    case 'redrive':"))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body, 'the escalation must not instruct a reassignment').not.toContain('Reassign or unblock');
    expect(body, 'nor a cancel').not.toContain("cancel/fail it if it's no longer needed");
    expect(body, 'nor promise the owner a decision that is no longer raised')
      .not.toContain('asks the owner');
    expect(body, 'it says the work is not moving').toContain('will not move the work');
    expect(body, 'and names the reaper as the owner of a genuinely dead process')
      .toContain('reaper');
    expect(body, 'the close-out repair stays — that is not a transfer')
      .toContain('that is a close-out, not a takeover');
  });

  it('the ladder tops out: rung 4 is recorded, so it does not re-ask every minute', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle' });
    seedStaleTask('t-once', 4_000);

    await runPokeCheck();
    await flushMicrotasks();
    const afterFirst = eventCount('t-once', 'poke');
    await runPokeCheck();
    await flushMicrotasks();

    expect(eventCount('t-once', 'poke'), 'a 60-second sweep must not re-poke the top rung forever')
      .toBe(afterFirst);
    // Dead PROCESSES are the engine reaper's job, not the ladder's (owner ruling, point 4).
    expect(taskRow('t-once').agent_id, 'and the task stays with its assignee either way')
      .toBe(SLOW_AGENT);
  });

  it('WIRE: the slow sub-agent of report #6 is not even poked at this idle time', async () => {
    seedAssignee({ agentId: SLOW_AGENT, status: 'idle', firstChunkMs: 600_000, idleMs: 600_000 });
    seedStaleTask('t-slow', 1_000);   // over the stock first rung (300), under the floored one (1200)

    await runPokeCheck();
    await flushMicrotasks();

    expect(eventCount('t-slow', 'poke'),
      'poking a slow box mid-inference is the half of the fix the ruling explicitly keeps').toBe(0);
    expect(taskRow('t-slow').agent_id).toBe(SLOW_AGENT);

    // And the control: the same declared row IS poked once its own floor is passed.
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 1_500 * 1000, 't-slow');
    await runPokeCheck();
    await flushMicrotasks();
    expect(eventCount('t-slow', 'poke'), 'patience is a floor, not an exemption').toBeGreaterThan(0);
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
    // The ladder re-arm the call site used to do by itself now rides along, inseparably.
    expect(eventCount('t-moved', 'poke_remediation'),
      'the record and the re-arm must not be able to come apart').toBe(1);
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

  it('WIRE: the primary\'s reassign verb calls it, with the FROM assignee read before the write', () => {
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
