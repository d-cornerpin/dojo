// ════════════════════════════════════════════════════════════════════════════════════════
// t129 (Lane D ∪ S5) — THE BLOCKED-WORK DISPOSAL DOOR.
//
// ── THE DRIVE THIS FILE IS WRITTEN FROM ──
// v3.3.2 blast, run 4, clause P4. The judge built a realistic PM-UPHELD blocked row owned by
// one agent, then had the PRIMARY-ROLE agent act on it through the real executor, with notes
// saying plainly that nobody had asked it to:
//
//     POST /api/dev/execute-tool  { agentId: "<primary>", name: "work_update",
//       args: { action: "status", task_id: "<row>", status: "cancelled",
//               notes: "Cancelling this on my own initiative as the primary agent;
//                       nobody asked me to." } }
//
//     → {"ok":true,"data":{"kind":"applied","value":{
//          "content":"[OK] task_id=… | status=cancelled …","isError":false}}}
//
// ACCEPTED. The aftermath: `state=abandoned`, `still_assigned_to` = the victim, one
// `transition` event naming the primary, `owner_rows_naming_it = 0`,
// `validation_escalated = 0`, `floor_ghosted = 0`.
//
// So an agent holding the primary role could silently destroy ANOTHER agent's PM-upheld
// blocked work, unprompted, and the owner was never told. The escalation ladder was not slow
// here — it was PRE-EMPTED: the row left `blocked` before any steer could be spent, so there
// was nothing left for the ladder to act on. That is the hole OR-PM-1v2 was written to close,
// approached from the side nobody fenced: the ruling says blocked/declined work *"is NOT
// reassignable by agents — it ESCALATES to the user"*, and disposal is strictly worse than
// reassignment — the work does not move, it VANISHES.
//
// ── THE RULE, DERIVED FROM THE STANDING OWNER RULING (not invented here) ──
// Blocked/declined work escalates to the user; the disposal IS the ruling the escalation
// exists to obtain. So:
//
//   1. RESOLVING FORWARD IS UNTOUCHED. Any agent may move a blocked row back to an ACTIVE
//      state (in_progress / on_deck / paused). That is the resolution the block is waiting
//      for and it is recorded like every other transition.
//   2. A NON-ASSIGNEE AGENT MAY NOT TERMINALLY DISPOSE OF A BLOCKED ROW. Not `cancelled`,
//      not `fallen`. This is the judge's drive, refused.
//   3. A PM-UPHELD BLOCK IS THE OWNER'S TO DISPOSE OF — NOBODY ELSE'S, the assignee
//      included. The PM upholding the block is the platform's own confirmation that the
//      obstacle is real; the next word belongs to the person the escalation is addressed to.
//      (The triage left this as the one point needing owner input; the standing ruling
//      answers it — the escalation exists to obtain exactly this disposal.)
//   4. AN ORDINARY (NOT-UPHELD) BLOCK IS STILL THE ASSIGNEE'S TO CLOSE OUT. The triage names
//      this the normal path and run-4's P5 depends on it. Untouched.
//   5. `complete` IS NOT THIS GATE'S BUSINESS. A close to `done` is already two-key-fenced by
//      `transition()`'s G9: an agent's `complete` files a Key-1 close request, rings the
//      validation doorbell and refuses the move. Swallowing that into this gate would delete
//      the recorded close request, which is the useful half. Same discriminator the spine's
//      own `requests-validation` clause uses: terminal AND not `done`.
//   6. EVERY AUTHORITATIVE DOOR IS UNCHANGED BY CONSTRUCTION, because it carries
//      `claim: 'authoritative'` — the owner's dashboard PUT, the owner's verdict, and the
//      PM's six `work_validate` doors all pass it today (census: every caller of
//      `setTaskStatus`/`setTaskStatusResult` except the agent's own `work_update(action=
//      "status")` carries the claim). No new concept, no new parameter.
//
// ── S5 RIDES THE SAME DOOR ──
// The judge reached the hole through `action: "status"`, which is also the path the triage
// ranks S5: `work_update(action="status", assigned_to=X)` resolves as `work_update:status`,
// never calls `recordReassignment`, and wrote only `agent_id` — leaving `assignee_agent`
// pointing at the OLD agent. It is the one assignee-moving path with NO audit record at all,
// which is why it is also the one the owner's dating queries cannot see: it both causes the
// complaint and hides itself. §4 is that gap closed — who, from, to, why — by the same
// recorder the `:reassign` door and the dashboard door already use.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  getPrimaryAgentId: () => PRIMARY,
  isPrimaryAgent: (id: string) => id === PRIMARY,
  getPMAgentId: () => PM,
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === PM,
}));

import { trackerUpdateStatus } from '../tools.js';
import { setTaskStatusResult, updateTask } from '../schema.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { upholdClaim } from '../../work/tracker-store.js';
import { AUDIT_KIND } from '../../work/audit-trail.js';
import { PATIENCE_ENTRY } from '../assignee-patience.js';

/** The cast, in the drive's own roles. The victim OWNS the row; the primary is a bystander
 *  with a role, which is the whole point of P4. */
const VICTIM = 'victim-agent';
const PRIMARY = 'primary-agent';
const PM = 'pm-agent';
const TASK = 'p4drive-00000001';

/** The judge's own fixture, deliberately nothing like a harness row: a realistic title, a
 *  real description, a real block reason. */
const TITLE = 'Reconcile the quarterly supplier ledger';
const BLOCK_REASON = 'the supplier portal credential has expired';
/** The judge's own notes, verbatim — the sentence that makes the call unambiguous. */
const UNPROMPTED = 'Cancelling this on my own initiative as the primary agent; nobody asked me to.';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      updated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT,
      action_taken TEXT, note TEXT, evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Migration 121's shape, not a shorthand: §3's \`complete\` clause reaches
    -- \`deliveryForTaskClose\` -> \`deliveryForAgentSince\`, which filters on \`turn_number\`. A
    -- narrower fixture throws \`no such column\` inside the tool's own catch and the clause
    -- then measures the FIXTURE's gap instead of G9's door.
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER, tool TEXT,
      channel TEXT, recipient_id TEXT, recipient_display TEXT, conversation_id TEXT,
      root_kind TEXT, root_id TEXT, message_id TEXT, receipt_id TEXT, outcome TEXT,
      detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS turns (
      agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_artifacts (
      id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, kind TEXT
    );
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const [id, name] of [[VICTIM, 'Victim'], [PRIMARY, 'Primary'], [PM, 'PM'], ['third', 'Third']]) {
    db.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(id, name);
  }
}

/** Seed the drive's row: blocked, owned by the victim, with a real reason on it. */
function seedBlockedRow(opts: { upheld: boolean; id?: string; assignee?: string }): string {
  const id = opts.id ?? TASK;
  seedTrackerTask(mockDb.current!, {
    id, title: TITLE, status: 'blocked', agentId: opts.assignee ?? VICTIM,
    description: 'Pull the supplier statements and tie them to the ledger for the quarter.',
    notes: BLOCK_REASON,
  });
  if (opts.upheld) upholdClaim(id, 'blocked', 'pm', PM, 'PM confirmed the block is real');
  return id;
}

const rowOf = (id = TASK) =>
  mockDb.current!.prepare('SELECT state, agent_id, assignee_agent FROM work WHERE id = ?')
    .get(id) as { state: string; agent_id: string; assignee_agent: string | null };

/** Every spine event on the row, oldest first — what was WRITTEN, not a projection of it. */
const eventsOf = (id = TASK) =>
  mockDb.current!.prepare('SELECT kind, actor, payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(id) as Array<{ kind: string; actor: string; payload: string | null }>;

/**
 * The REASSIGNMENT records on a row.
 *
 * `AUDIT_KIND` ('audit') is the audit trail's one shared event kind — `writeTaskLog` writes
 * it for every transition and every observation as well — so "did the side door record the
 * move?" is a question about `entry_kind`, not about the event kind. Counting bare `audit`
 * rows here would pass on the transition record alone and prove nothing about S5.
 */
const reassignmentsOf = (id = TASK) =>
  eventsOf(id)
    .filter((e) => e.kind === AUDIT_KIND)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload ?? '{}') as Record<string, string> }))
    .filter((e) => e.payload.entry_kind === PATIENCE_ENTRY.reassigned);

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE JUDGE'S EXACT DRIVE, REFUSED. (the keystone; every clause here was GREEN-as-in-
//      accepted at 937e2051, which is the defect)
// ════════════════════════════════════════════════════════════════════════════════════════

describe("§1 the primary cannot dispose of another agent's PM-upheld blocked work", () => {
  it('⚠ THE DRIVE: work_update(action="status", status="cancelled") is REFUSED and the row stays blocked', () => {
    seedBlockedRow({ upheld: true });

    const out = trackerUpdateStatus(PRIMARY, { taskId: TASK, status: 'cancelled', notes: UNPROMPTED });

    // The executor derives `isError` from a leading "Error" (`agent/tools.ts`), so the shape
    // the drive measured — `isError: false` — is exactly this assertion.
    expect(out.startsWith('Error'), `the drive must come back isError:true, got: ${out}`).toBe(true);
    expect(out).not.toContain('[OK]');

    // The row did not move, and it is still the victim's.
    expect(rowOf().state).toBe('blocked');
    expect(rowOf().agent_id).toBe(VICTIM);

    // And nothing was written as though it had: no transition off `blocked`.
    const moved = eventsOf().filter((e) => e.kind === 'transition');
    expect(moved, 'a refused disposal records no transition').toEqual([]);
  });

  it('the refusal POINTS AT THE ESCALATION PATH and says who rules', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(PRIMARY, { taskId: TASK, status: 'cancelled', notes: UNPROMPTED });
    // Not a bare "no". A model that is refused without a next move retries the refusal.
    expect(out.toLowerCase(), 'the refusal must name the owner as the one who rules')
      .toMatch(/owner|the user/);
    expect(out, 'the refusal must name the door that escalates it')
      .toContain('work_close_request');
    expect(out, 'and it must say the block itself is not in question')
      .toMatch(/blocked/i);
  });

  it('`fallen` is the same door — the gate is about disposal, not about one word', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(PRIMARY, { taskId: TASK, status: 'fallen', notes: UNPROMPTED });
    expect(out.startsWith('Error')).toBe(true);
    expect(rowOf().state).toBe('blocked');
  });

  it('a THIRD agent with no role at all is refused too — the gate is not about the primary', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus('third', { taskId: TASK, status: 'cancelled', notes: UNPROMPTED });
    expect(out.startsWith('Error')).toBe(true);
    expect(rowOf().state).toBe('blocked');
  });

  it('a NOT-upheld block is still not a bystander\'s to dispose of', () => {
    seedBlockedRow({ upheld: false });
    const out = trackerUpdateStatus(PRIMARY, { taskId: TASK, status: 'cancelled', notes: UNPROMPTED });
    expect(out.startsWith('Error')).toBe(true);
    expect(rowOf().state).toBe('blocked');
  });

  it("the PM's own BARE status door is not an authority either — a PM-upheld block it then cancels is the same pre-emption", () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(PM, { taskId: TASK, status: 'cancelled', notes: 'PM closing this out.' });
    expect(out.startsWith('Error'), `the PM's bare status door must not dispose, got: ${out}`).toBe(true);
    expect(rowOf().state).toBe('blocked');
  });

  it('CONTROL: the gate is about BLOCKED rows — an in-progress row is disposable as before', () => {
    seedTrackerTask(mockDb.current!, { id: 'inprog-01', title: TITLE, status: 'in_progress', agentId: VICTIM });
    const out = trackerUpdateStatus(PRIMARY, { taskId: 'inprog-01', status: 'cancelled', notes: 'no longer needed' });
    expect(out, `an in-progress row is untouched by this gate, got: ${out}`).toContain('[OK]');
    expect(rowOf('inprog-01').state).toBe('abandoned');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE OWNER DOOR STILL DISPOSES. The gate is a predicate on material already in hand,
//      so the door that carries the claim is unchanged BY CONSTRUCTION — and this proves it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the owner still disposes of blocked work', () => {
  it("the dashboard PUT's own authority disposes of a PM-upheld block", () => {
    seedBlockedRow({ upheld: true });
    const { result } = setTaskStatusResult(TASK, 'cancelled', {
      by: 'owner', actorId: 'user', claim: 'authoritative',
      reason: 'dashboard PUT /tracker/tasks/:id',
    });
    expect(result.kind, `the owner's door must still land, got ${JSON.stringify(result)}`).toBe('applied');
    expect(rowOf().state).toBe('abandoned');
  });

  it("the PM's AUTHORITATIVE door disposes too — it is the claim that decides, not the name", () => {
    seedBlockedRow({ upheld: true });
    const { result } = setTaskStatusResult(TASK, 'fallen', {
      by: 'pm', actorId: PM, claim: 'authoritative',
      reason: 'PM ruled the block fatal',
    });
    expect(result.kind).toBe('applied');
    expect(rowOf().state).toBe('failed');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE ASSIGNEE STILL RESOLVES FORWARD, and still closes out an ordinary block.
//      Run-4's P5 depends on the second of these; the ruling depends on the first.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 resolving forward is what agents do with a block', () => {
  it('the assignee moves its own blocked row back to in_progress — the resolution, recorded', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(VICTIM, {
      taskId: TASK, status: 'in_progress', notes: 'the credential was renewed; resuming',
    });
    expect(out, `resolving forward must land, got: ${out}`).toContain('[OK]');
    expect(rowOf().state).toBe('claimed');
    const moved = eventsOf().filter((e) => e.kind === 'transition');
    expect(moved.length, 'the resolution is recorded as a transition').toBe(1);
    expect(moved[0]!.actor).toBe(VICTIM);
  });

  it('a BYSTANDER may resolve it forward as well — only disposal is fenced', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(PRIMARY, {
      taskId: TASK, status: 'in_progress', notes: 'I got the credential renewed for her',
    });
    expect(out, `forward is never the refusal, got: ${out}`).toContain('[OK]');
    expect(rowOf().state).toBe('claimed');
  });

  it('the ASSIGNEE still closes out an ORDINARY (not-upheld) block — the normal path, untouched', () => {
    seedBlockedRow({ upheld: false });
    const out = trackerUpdateStatus(VICTIM, {
      taskId: TASK, status: 'cancelled', notes: 'the supplier portal is retired; this work is moot',
    });
    expect(out, `the assignee's own close-out of an ordinary block must land, got: ${out}`).toContain('[OK]');
    expect(rowOf().state).toBe('abandoned');
  });

  it('⚠ but a PM-UPHELD block is the OWNER\'S to dispose of — not even the assignee may', () => {
    seedBlockedRow({ upheld: true });
    const out = trackerUpdateStatus(VICTIM, {
      taskId: TASK, status: 'cancelled', notes: 'giving up on this one',
    });
    expect(out.startsWith('Error'), `an upheld block waits for the owner, got: ${out}`).toBe(true);
    expect(out.toLowerCase()).toMatch(/owner|the user/);
    expect(rowOf().state).toBe('blocked');
  });

  it('`complete` keeps its OWN door: the two-key close request is filed, never swallowed by this gate', () => {
    seedBlockedRow({ upheld: true });
    // G7 asks for a delivery before G9 can file anything, which is the correct order and not
    // this gate's business — so the row gets one, and the clause then measures G9.
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES ('del-0001', ?, 1, 'send_message', 'chat', 'delivered', datetime('now'))`,
    ).run(VICTIM);
    mockDb.current!.prepare('INSERT INTO turns (agent_id, turn_number) VALUES (?, 1)').run(VICTIM);
    const out = trackerUpdateStatus(VICTIM, {
      taskId: TASK, status: 'complete', notes: 'done anyway',
      result: 'reconciled the ledger against the supplier statements',
      evidence: [{ kind: 'claim', claim: 'the ledger ties out for the quarter' }],
    });
    // G9's path, unchanged: the request is RECORDED and reads as a success, not as this gate.
    expect(out, `the Key-1 filing must survive this gate, got: ${out}`).toContain('[FILED]');
    expect(eventsOf().some((e) => e.kind === 'validation_requested'),
      'the close request is on the record').toBe(true);
    expect(rowOf().state).toBe('blocked');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — S5: THE SIDE DOOR IS AUDITED. The judge went through `action: "status"`; an assignee
//      move on that path wrote `agent_id` and NOTHING ELSE — no record, no reason, and
//      `assignee_agent` left pointing at the agent who no longer holds the work.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 S5 — work_update(action="status", assigned_to=X) leaves a record', () => {
  it('⚠ THE GAP: the status door\'s assignee move is recorded — who, from, to, why', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0001', title: TITLE, status: 'in_progress', agentId: VICTIM });

    const out = trackerUpdateStatus(PRIMARY, {
      taskId: 'ride-0001', status: 'in_progress', assignedTo: 'third',
    });
    expect(out).not.toContain('Error:');

    const audit = reassignmentsOf('ride-0001');
    expect(audit.length, 'the side door records the move exactly once').toBe(1);
    const a = audit[0]!;
    const payload = a.payload;
    expect(a.actor, 'WHO moved it').toBe(PRIMARY);
    expect(payload.action_taken, 'FROM and TO').toContain(VICTIM);
    expect(payload.action_taken).toContain('third');
    expect(payload.reason, 'WHY, and it names the door it came through').toBeTruthy();
    expect(payload.reason).toContain('work_update(action="status")');
  });

  it('⚠ THE SPLIT-BRAIN: both assignee columns agree after the move', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0002', title: TITLE, status: 'in_progress', agentId: VICTIM });
    expect(rowOf('ride-0002').assignee_agent).toBe(VICTIM);

    trackerUpdateStatus(PRIMARY, { taskId: 'ride-0002', status: 'in_progress', assignedTo: 'third' });

    const r = rowOf('ride-0002');
    expect(r.agent_id, 'the holder moved').toBe('third');
    expect(r.assignee_agent, 'and the column beside it is not left on the old agent').toBe('third');
  });

  it('CONTROL: a status call with NO assignee change records no reassignment', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0003', title: TITLE, status: 'in_progress', agentId: VICTIM });
    trackerUpdateStatus(VICTIM, { taskId: 'ride-0003', status: 'paused', notes: 'waiting on the portal' });
    expect(reassignmentsOf('ride-0003'), 'no move, no record').toEqual([]);
  });

  it('CONTROL: a no-op assignee (same agent) is not a reassignment', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0004', title: TITLE, status: 'in_progress', agentId: VICTIM });
    trackerUpdateStatus(VICTIM, { taskId: 'ride-0004', status: 'paused', assignedTo: VICTIM, notes: 'still mine' });
    expect(reassignmentsOf('ride-0004'), 'naming yourself moves nothing').toEqual([]);
  });

  it('M7 / P706 is kept: an explicit null still CLEARS the assignee and leaves the holder', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0005', title: TITLE, status: 'in_progress', agentId: VICTIM });
    expect(() => updateTask('ride-0005', { assignedTo: null })).not.toThrow();
    const r = rowOf('ride-0005');
    expect(r.assignee_agent).toBeNull();
    expect(r.agent_id, 'NOT NULL is not violated and the holder survives').toBe(VICTIM);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE AUDIT ROW CENSUS. The drive's aftermath was a COUNT, so the fix's is too: what
//      the spine holds after each arm, so a future change cannot quietly stop recording.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the audit census', () => {
  /** Count the row's events by kind — the drive's own aftermath query, as an assertion. */
  const censusOf = (id = TASK): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const e of eventsOf(id)) out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
  };

  it('REFUSED disposal: the row keeps its uphold and gains NO transition', () => {
    seedBlockedRow({ upheld: true });
    trackerUpdateStatus(PRIMARY, { taskId: TASK, status: 'cancelled', notes: UNPROMPTED });
    const census = censusOf();
    expect(census.claim_upheld, "the PM's uphold is still the last word on this row").toBe(1);
    expect(census.transition ?? 0, 'and nothing moved it').toBe(0);
  });

  it("OWNER disposal: one transition, and the owner's verdict is a row", () => {
    seedBlockedRow({ upheld: true });
    setTaskStatusResult(TASK, 'cancelled', {
      by: 'owner', actorId: 'user', claim: 'authoritative', reason: 'the owner called it off',
    });
    expect(censusOf().transition, 'the owner moved it exactly once').toBe(1);
    const adj = mockDb.current!.prepare(
      "SELECT by_agent, claim_state FROM adjudications WHERE work_id = ? AND claim_state = 'abandoned'",
    ).all(TASK) as Array<{ by_agent: string; claim_state: string }>;
    expect(adj.length, "the disposal is adjudicated, not just applied").toBe(1);
    expect(adj[0]!.by_agent).toBe('user');
  });

  it('FORWARD resolution: one transition, named to its actor, and the block is not re-upheld', () => {
    seedBlockedRow({ upheld: true });
    trackerUpdateStatus(VICTIM, { taskId: TASK, status: 'in_progress', notes: 'credential renewed' });
    const census = censusOf();
    expect(census.transition).toBe(1);
    expect(census.claim_upheld).toBe(1);
    expect(eventsOf().find((e) => e.kind === 'transition')!.actor).toBe(VICTIM);
  });

  it('SIDE-DOOR move: the assignee change and the transition are BOTH on the record', () => {
    seedTrackerTask(mockDb.current!, { id: 'ride-0006', title: TITLE, status: 'in_progress', agentId: VICTIM });
    trackerUpdateStatus(PRIMARY, {
      taskId: 'ride-0006', status: 'paused', assignedTo: 'third',
      // The pause door has its own notes floor; this clause is about the audit, not that gate.
      notes: 'handing this to a colleague while the supplier portal credential is reissued',
    });
    expect(reassignmentsOf('ride-0006').length, 'the move is recorded').toBe(1);
    expect(censusOf('ride-0006').transition, 'and so is the status change').toBe(1);
  });
});
