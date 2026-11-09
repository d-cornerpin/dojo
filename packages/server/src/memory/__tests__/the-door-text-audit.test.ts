// ════════════════════════════════════════════════════════════════════════════════════════
// HARNESS-LEARNINGS HL6 — THE DECISION-MOMENT DOOR-TEXT AUDIT (bounded).
//
// dsh's stated rule (findings report P1/F4, their words): "the failure arrives mid-task; a
// static instruction does not reliably reach the retry decision, while the error message is
// present exactly when the model must act." The dojo's own record agrees, and this suite is
// the audit's VERDICTS made enforceable rather than merely written down. Four static conduct
// additions of this phase were enumerated; three are KEPT with an argument and one MIGRATES,
// and both halves are pinned here so a later reader cannot quietly reverse either.
//
// ── THE ONE MIGRATION: T20's SUMMARIES-HEADER SENTENCE ──
// It read: "Obligation lines here are HISTORICAL — the OPEN WORK block is the current record
// of what is owed, whatever tense a summary uses." It under-delivered three separate times:
// W8's own driven replay in the sitting it landed (the model read the board, got "No active
// tasks.", and asserted the dead Bob quotes four seconds later), then T28's 2/2 and T28b's
// 2/2. And its second clause is now WRONG on its face, which is the truth argument this
// migration lands on independently of any behavioural claim: OPEN WORK is not the current
// record of what is owed. It is conversation-scoped, capped at 600 chars with a declared
// drop order, filtered to rows inside the ageing horizon, and excludes `claimed`
// (`work/obligations.ts`, `work/store.ts` `openObligations`). HL5's snapshot IS complete —
// every commitment with no `closed_at`, no scope, no cutoff — so the sentence is demoted to
// a pointer at the surface that can actually carry the claim.
//
// ── THE SECOND MIGRATION, AND IT COSTS NO PREFIX BYTES: THE BOARD-READ DOOR ──
// W8's replay is the sharpest datum in the whole record because the model DID the right
// thing: it asked the board. `work_update(action="list")` answered "No active tasks." and
// said nothing about commitments — because that tool lists tasks and projects and has never
// listed commitments at all. So a model that checks its work before speaking is told the
// truth about two thirds of the board and left to infer the third. This is exactly F4's
// shape: the instruction has to be present where the decision is, and the decision is the
// tool result. The line is a `return` value, not a tool description and not a registry
// entry, so it moves zero cached bytes — the [FILED] precedent (W17/W18), measured.
//
// ── THE THREE KEEPS, PINNED SO THEY ARE DECISIONS AND NOT DRIFT ──
// T23's consent sentence: INCONCLUSIVE is not under-delivered — W9 drove it three times and
// the S5 shape never reproduced, so the clause never had an antecedent to bite on. And no
// decision-moment door can carry it: the fact it turns on ("your own proposal marked THIS
// item as needing his call") lives in the previous assistant turn, not in any tool call's
// arguments, so no per-call door can see it. Static is the only surface that can.
// T33's and T36's steer texts: they are not static conduct rules at all — they are already
// decision-moment texts that arrive on the granted round. T33's residual (a false
// present-tense STATE claim) is T36's subject; the capability half W13 handed to the door
// texts by name is already AT the door (T29, `agent/tools/gates.ts` / `cat/comms.ts`). T36's
// one bounded retry on its own wording was already spent (W14) and measured changing nothing,
// and HL7 forbids a second tweak on a published null.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-hl6-audit-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { trackerListActive } from '../../tracker/tools.js';
import { COMMITMENT_POSITION_NONE, commitmentPositionLine } from '../../work/obligation-memory.js';
import { FX } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = 'hl6-agent';
let seq = 0;

function seedCommitment(p: { id: string; title: string; state: string }): void {
  const db = mockDb.current!;
  const terminal = ['done', 'failed', 'abandoned'].includes(p.state);
  const at = Date.now();
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, opened_at, updated_at,
                       closed_at, provenance)
     VALUES (?, 'commitment', ?, 'agent', ?, 'commitment', ?, ?, 'commitment', 0, 0, ?, ?, ?, ?, 'live')`,
  ).run(p.id, AGENT, AGENT, `turn:${++seq}`, p.state, p.title, at, at, terminal ? at : null);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, ?, 'idle', '1970-01-01')`,
  ).run(AGENT, AGENT);
  seq = 0;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — MIGRATION 2: the board-read door answers the question it was asked.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the board-read result states the commitment position', () => {
  it('W8\'s SHAPE: an empty tracker and closed commitments no longer read as "nothing said about promises"', () => {
    seedCommitment({ id: 'cmt:aaaaaaaaaaaa', title: 'Email the roof quote to Bob', state: 'abandoned' });
    const out = trackerListActive(AGENT, {});
    expect(out).toContain('No active tasks.');
    expect(out).toContain(COMMITMENT_POSITION_NONE);
  });

  it('with live commitments it states the COUNT and points at the one place they are listed', () => {
    seedCommitment({ id: 'cmt:bbbbbbbbbbbb', title: `Send ${FX.n11} the venue shortlist`, state: 'open' });
    seedCommitment({ id: 'cmt:cccccccccccc', title: 'Email the fence estimate', state: 'open' });
    const out = trackerListActive(AGENT, {});
    expect(out).toMatch(/2 open commitments/);
    expect(out).not.toContain(COMMITMENT_POSITION_NONE);
  });

  it('an agent with no commitment history is told nothing about commitments — no noise', () => {
    const out = trackerListActive(AGENT, {});
    expect(out).not.toContain(COMMITMENT_POSITION_NONE);
    expect(out).not.toMatch(/open commitments/);
  });

  it('the line is ONE renderer, shared with the snapshot — not a second answer to one question', () => {
    // `commitmentPositionLine` is exported from the module that owns "what does the spine say
    // is owed". A second copy of the sentence in `tracker/tools.ts` would be the parallel
    // memory this whole class of task exists to prevent.
    seedCommitment({ id: 'cmt:dddddddddddd', title: 'x', state: 'abandoned' });
    expect(commitmentPositionLine(AGENT)).toBe(COMMITMENT_POSITION_NONE);
  });
});
