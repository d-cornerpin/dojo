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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-hl6-audit-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { trackerListActive } from '../../tracker/tools.js';
import { COMMITMENT_POSITION_NONE, commitmentPositionLine } from '../../work/obligation-memory.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

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
// §1 — MIGRATION 1: the static header stops claiming an authority it does not have.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the summaries-lane header is demoted to a pointer', () => {
  const laneSource = (): string => {
    const src = read('memory/assembler.ts');
    return src.slice(src.indexOf("id: 'lane.summaries'"), src.indexOf("id: 'lane.attempt-ledger'"));
  };

  it('the HEAD sentence is gone — OPEN WORK is no longer named as the current record of what is owed', () => {
    expect(laneSource()).not.toContain('the OPEN WORK block is the current record of what is owed');
  });

  it('the load moved to a POINTER at the complete snapshot, named by the block it points at', () => {
    const lane = laneSource();
    expect(lane).toContain('Obligation lines here are HISTORICAL');
    expect(lane).toContain('OPEN COMMITMENTS');
  });

  it('the header is STILL STATIC — one literal, no interpolation (the cache law is unmoved)', () => {
    const lane = laneSource();
    const header = lane.slice(lane.indexOf('═══ COMPRESSED HISTORY'), lane.indexOf('${summaryText}'));
    expect(header.length).toBeGreaterThan(200);
    expect(header, 'the header is a literal; only the summaries themselves interpolate')
      .not.toContain('${');
  });

  it('stored summaries are still never rewritten at render time (T20\'s law, unchanged)', () => {
    expect(read('memory/assembler.ts')).not.toContain('annotateSummaryObligations');
  });
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
    seedCommitment({ id: 'cmt:bbbbbbbbbbbb', title: 'Send David the venue shortlist', state: 'open' });
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
    expect(read('tracker/tools.ts')).toContain('commitmentPositionLine');
    expect(read('tracker/tools.ts')).not.toContain('open commitments');
  });

  it('IT COSTS ZERO CACHED BYTES: the sentence is a tool RESULT, in no prompt surface', () => {
    // The [FILED] precedent, measured the same way (W18's release verification): a `return`
    // value is not a tool description and not a registry entry, so it never enters the
    // cacheable prefix. If this ever appears in either, the migration has quietly become a
    // prefix change and must be re-registered.
    expect(read('agent/tools/definitions.ts')).not.toContain(COMMITMENT_POSITION_NONE);
    expect(read('tools/tool-docs.ts')).not.toContain(COMMITMENT_POSITION_NONE);
    expect(read('prompt/registry/entries.ts')).not.toContain(COMMITMENT_POSITION_NONE);
    expect(read('prompt/assembler.ts')).not.toContain(COMMITMENT_POSITION_NONE);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE THREE KEEPS. A verdict nobody can check is a verdict nobody keeps.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the audit\'s KEEP verdicts are pinned, not asserted', () => {
  it('T23 — the consent sentence stays, in both its homes, byte-for-byte', () => {
    const sentence =
      "If your proposal asked the user a question about a specific item, a generic approval "
      + "('yes', 'go ahead') covers only the items you marked unambiguous — act on those, and "
      + 're-ask or leave the questioned item.';
    expect(read('prompt/assembler.ts')).toContain(sentence);
    expect(read('prompt/templates.ts')).toContain('generic approval');
  });

  it('T33 — the standing-promise steer text is unchanged', () => {
    const floor = read('agent/v2/steps/post-call-classify/promise-floor.ts');
    expect(floor).toContain('Your reply made a STANDING promise to the user');
    expect(floor).toContain('A promise that lives only in this conversation does not survive a ');
    expect(floor).toContain('Do not repeat the promise without recording it.');
  });

  it('T36 — the standing-state steer text is unchanged, bounded retry included', () => {
    const floor = read('agent/v2/steps/post-call-classify/promise-floor.ts');
    expect(floor).toContain('Your reply told the user what is currently scheduled or owed');
    expect(floor).toContain('This round is for ');
    expect(floor).toContain('do not pick up new work you were not asked for.');
  });

  it('T33/T36 keep the capability half AT the door, where T29 put it', () => {
    // W13's own residual hands the capability class to the door texts by name. This pins that
    // the door still speaks it, so "keep the steer" cannot quietly mean "and lose the door".
    expect(read('agent/tools/gates.ts')).toContain('sms_send');
    expect(read('agent/tools/cat/comms.ts')).toContain('sms_send');
  });
});
