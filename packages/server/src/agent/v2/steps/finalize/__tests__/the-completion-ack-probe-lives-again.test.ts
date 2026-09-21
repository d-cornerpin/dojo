// UX-REPAIR ROUND 2 — T15. THE DORMANT COMPLETION-ACK PROBE LIVES AGAIN, AT ITS CAUSE.
//
// ── WHAT WAS DEAD, AND WHY ───────────────────────────────────────────────────────────────
// `runCompletionAck` asks one question — "did this turn finish engine-scaffolded work and
// leave the person with nothing?" — and it has not been able to ask it. Its scaffold selector
// bounded an INTEGER epoch-ms column with the TEXT `turnStartedAt`:
//
//     AND t.closed_at >= ?          .all(agentId, turnStartedAt)     // '2026-08-10 03:00:00'
//
// In SQLite every INTEGER sorts below every TEXT, so the comparison is false for every row
// that exists, `justCompletedScaffold` came back empty on every turn, and all three arms below
// it are gated on `justCompletedScaffold.length > 0`. The whole detection was unreachable.
// T2R pinned that measurement rather than fixing it (a defect with a separate cause, outside
// T2's inventory) in `post-call-classify/__tests__/the-stamped-start-ack-keeps-its-readers-
// honest.test.ts` — "pinned here so a future repair of the selector cannot land without
// meeting the stamp". This is that repair, and that pin flips here, deliberately.
//
// ── THE CAUSE, NOT THE SYMPTOM ───────────────────────────────────────────────────────────
// The class is a boundary crossing a type: an instant that starts life as ms, is spelled as
// text for one hop, and is compared against ms. Both this probe and its sibling in
// `execute/result-notes.ts` carried the SAME six-clause "has the person already been answered"
// SQL, each with its own round-trip (`unixepoch(?) * 1000`) over a column that is ALREADY ms.
// The fix is one ms-native predicate — `substantiveReplySince` in `answered-edge.ts`, beside
// `owesAnswer`, the keyed reader it is the pre-spine fallback for — and no round-trip at all.
// Two copies of one question could answer it differently; now they cannot.
//
// ── THE ACTIVATION IS A BEHAVIOUR CHANGE, AND IT IS THE DESIGNED ONE ─────────────────────
// With the selector alive, T2's `origin_intent='engine_start_ack'` stamp finally reaches this
// probe as its own comment always claimed it would ("Engine acks are excluded STRUCTURALLY by
// their origin_intent tag"). A turn whose only bubble was a stamped "On it —" now reaches the
// detection arm instead of being silently written off as answered. Per OR2 the engine still
// composes NOTHING: the arm LOGS, and the ticket stamps plus the PM ladder drive the agent to
// speak in its own voice. Both directions are proven below, and so is the OR2 half.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
const warns: Array<{ msg: string }> = [];
const infos: Array<{ msg: string }> = [];

vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t15-completion-probe-test', 'dojo.db'),
  };
});

vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (msg: string) => { infos.push({ msg }); },
    warn: (msg: string) => { warns.push({ msg }); },
    error: vi.fn(),
  }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { runCompletionAck } from '../completion-ack.js';
import { userRequestedCloseWantsReply } from '../../execute/result-notes.js';
import { substantiveReplySince } from '../../../answered-edge.js';
import type { AgentTurnState } from '../../../state.js';
import type { FinalizeContext } from '../index.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const START_ACK_INTENT = 'engine_start_ack';
const STAMPED_ACK = 'On it — pulling current HubSpot pricing to finish the comparison.';
const REAL_ANSWER = 'Pipedrive is the better fit for three people: cheaper per seat and simpler to run.';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

/** `turnStartedAt` exactly as preflight builds it: SQLite datetime text, seconds-granular. */
const asTurnStartedAt = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

const finalizeCtx = (turnStartedAt: string): FinalizeContext => ({
  agentId: AGENT, turnNumber: 4, db: mockDb.current!,
  counterparty: { kind: 'user' }, counterpartyIsAgentSender: false, turnStartedAt,
} as unknown as FinalizeContext);

const turnState = (): AgentTurnState => ({
  lastAssistantTextForIM: null, surfacedReplyThisTurn: false, explicitSendThisTurn: {},
  steerQueue: { pending: [], fired: [] },
} as unknown as AgentTurnState);

/** A scaffold task with no birthing ask, so the keyed arm falls through to the probe. */
function scaffoldTask(id: string, openedAtMs: number): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, 'agent', 'engine_scaffold', ?, 'open', 'tracker', 0, 0, 'the work', ?, ?)`,
  ).run(id, AGENT, id, openedAtMs, openedAtMs);
}

/** …and CLOSED during the turn, honouring both schema conditions for a closed row
 *  (the upheld adjudication and migration 135's `done means DELIVERED` receipt). */
function completedScaffold(id: string, openedAtMs: number, closedAtMs: number): void {
  scaffoldTask(id, openedAtMs);
  mockDb.current!.prepare(
    `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
     VALUES (?, 'done', 'upheld', 'pm', ?)`,
  ).run(id, Date.now());
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                             outcome, created_at)
     VALUES (?, ?, 4, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(`d-${id}`, AGENT, CONV);
  mockDb.current!.prepare(
    `UPDATE work SET state='done', closed_at=?, result_delivery_id=? WHERE id=?`,
  ).run(closedAtMs, `d-${id}`, id);
}

function assistantRow(id: string, content: string, atMs: number, originIntent: string | null): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, display_kind, display_tier,
                           origin_intent, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', 'agent-text', 'user-visible', ?, ?, 4, ?)`,
  ).run(id, AGENT, content, originIntent, CONV, atMs);
}

const messageCount = (): number =>
  (mockDb.current!.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c;

beforeEach(() => {
  warns.length = 0; infos.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════
// 1 — THE BOUND. Reproduced as SQL, then met by the shipped code.
// ════════════════════════════════════════════════════════════════════════

describe('the boundary is ms on both sides', () => {
  it('THE DEFECT, reproduced: an INTEGER ms column bounded by TEXT matches nothing', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    const sel = (bound: string | number): number => (mockDb.current!.prepare(
      `SELECT count(*) c FROM work t WHERE t.root_kind='engine_scaffold' AND t.kind='task'
         AND t.agent_id = ? AND t.state = 'done' AND t.closed_at >= ? AND t.repeat_interval IS NULL`,
    ).get(AGENT, bound) as { c: number }).c;
    expect(sel(asTurnStartedAt(t)), 'the bound this probe used to pass').toBe(0);
    expect(sel(t), 'the same instant, as the ms the column stores').toBe(1);
  });

  it('and `unixepoch()` on an epoch-ms number is NULL, so no round-trip is the right answer', () => {
    const row = mockDb.current!.prepare(
      `SELECT unixepoch(?) AS onMs, unixepoch(?) AS onText`,
    ).get(1786342271052, '2026-08-10 03:00:00') as { onMs: number | null; onText: number | null };
    expect(row.onMs, 'the shape a caller reaches for when the value is already ms').toBeNull();
    expect(row.onText).toBeGreaterThan(0);
  });

  it('RED→GREEN: the detection now SEES a scaffold that closed during the turn', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)));
    // Nothing else in the fixture answered the person, so the arm that fires is the loud one.
    expect(warns.some((w) => /NO user-facing reply/.test(w.msg)), 'the detection ran at all').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2 — THE PAIRED BEHAVIOUR. Both directions, plus the history control.
// ════════════════════════════════════════════════════════════════════════

describe('the probe answers "has the person already been told?" — in both directions', () => {
  it('a substantive model reply after the boundary → the completion ack is SKIPPED', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    assistantRow('answer', REAL_ANSWER, t + 2000, null);

    expect(runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)))).toBe(false);
    expect(infos.some((i) => /completion ack skipped/.test(i.msg))).toBe(true);
    expect(warns.some((w) => /NO user-facing reply/.test(w.msg))).toBe(false);
  });

  it('only a STAMPED start-ack → the completion machinery FIRES (T2\'s stamp, finally read)', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    assistantRow('ack', STAMPED_ACK, t + 1000, START_ACK_INTENT);
    expect(STAMPED_ACK.trim().length, 'it clears the probe\'s own length threshold').toBeGreaterThan(40);

    expect(runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)))).toBe(false);
    expect(warns.some((w) => /NO user-facing reply/.test(w.msg))).toBe(true);
    expect(infos.some((i) => /completion ack skipped/.test(i.msg))).toBe(false);
  });

  it('CONTROL — an UNSTAMPED "On it" is still read as an answer: the 237 historical rows do not move', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    assistantRow('ack', STAMPED_ACK, t + 1000, null);   // history: origin_intent NULL

    expect(runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)))).toBe(false);
    expect(infos.some((i) => /completion ack skipped/.test(i.msg))).toBe(true);
  });

  it('CONTROL — a reply BEFORE the boundary does not count (the window is the work\'s own)', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    assistantRow('older', REAL_ANSWER, t - 5 * 60_000, null);

    runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)));
    expect(warns.some((w) => /NO user-facing reply/.test(w.msg))).toBe(true);
  });

  it('OR2 — whichever arm runs, the engine writes no message and speaks for nobody', () => {
    for (const stamp of [START_ACK_INTENT, null]) {
      warns.length = 0; infos.length = 0;
      const t = Date.now() - 60_000;
      completedScaffold(`task-${stamp}`, t, Date.now());
      assistantRow(`ack-${stamp}`, STAMPED_ACK, t + 1000, stamp);
      const before = messageCount();
      expect(runCompletionAck(turnState(), finalizeCtx(asTurnStartedAt(t)))).toBe(false);
      expect(messageCount(), 'no engine-composed row, either way').toBe(before);
    }
  });

  it('the outer per-turn dedup still short-circuits before any of this', () => {
    const t = Date.now() - 60_000;
    completedScaffold('task-1', t, Date.now());
    const state = { ...turnState(), surfacedReplyThisTurn: true } as AgentTurnState;
    warns.length = 0; infos.length = 0;   // migrations log through the same mocked logger
    expect(runCompletionAck(state, finalizeCtx(asTurnStartedAt(t)))).toBe(false);
    expect(warns.length + infos.length, 'the gate never reached the query').toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3 — ONE PREDICATE, SHARED. The sibling keeps its behaviour byte for byte.
// ════════════════════════════════════════════════════════════════════════

describe('the two siblings ask one question, through one function', () => {
  it('the shared predicate is ms-native and answers on its own', () => {
    const t = Date.now() - 60_000;
    expect(substantiveReplySince(AGENT, t), 'nothing said yet').toBe(false);
    assistantRow('ack', STAMPED_ACK, t + 1000, START_ACK_INTENT);
    expect(substantiveReplySince(AGENT, t), 'a stamped engine ack is not an answer').toBe(false);
    assistantRow('answer', REAL_ANSWER, t + 2000, null);
    expect(substantiveReplySince(AGENT, t), 'a real answer is').toBe(true);
    expect(substantiveReplySince(AGENT, t + 3000), 'and the boundary is respected').toBe(false);
  });

  it('the sibling in result-notes.ts is unchanged in behaviour, and now shares the predicate', () => {
    const t = Date.now() - 60_000;
    scaffoldTask('task-1', t);
    assistantRow('ack', STAMPED_ACK, t + 1000, START_ACK_INTENT);
    expect(userRequestedCloseWantsReply('work_update', { action: 'status', task_id: 'task-1' }, AGENT))
      .toBe(true);
    assistantRow('answer', REAL_ANSWER, t + 2000, null);
    expect(userRequestedCloseWantsReply('work_update', { action: 'status', task_id: 'task-1' }, AGENT))
      .toBe(false);
  });

  it('neither file carries its own copy of the question, or any unixepoch round-trip', () => {
    for (const rel of ['../completion-ack.ts', '../../execute/result-notes.ts']) {
      const src = SRC(rel);
      expect(src, `${rel} calls the shared predicate`).toContain('substantiveReplySince');
      expect(src, `${rel} has no second copy of the six-clause probe`)
        .not.toContain("length(trim(content)) > 40");
      expect(src, `${rel} does no ms→text→ms round-trip`).not.toContain('unixepoch(');
    }
  });

  it('the shared predicate lives with the keyed reader it is the fallback for', () => {
    const src = SRC('../../../answered-edge.ts');
    expect(src).toContain('export function substantiveReplySince');
    expect(src, 'and it is the only copy of the clause list').toContain("length(trim(content)) > 40");
  });
});
