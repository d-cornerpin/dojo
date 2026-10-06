// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT REMEMBERS WHICH ASK IT ANSWERS — the durable fix the round-2 investigation named.
//
// Three rounds of the withdrawn-report red were paid with RAW CONTAINMENT: given an answer,
// `report/withdrawn-claim.ts` asks which report ids are NAMED NEAR it — the stamp's own turn,
// one turn back, and the `seq` span between ask and answer — and voids the stamp when every
// report it finds has left the standing set. That predicate is honest and measured (13 of 4,242
// answered asks over the live corpus, all 13 genuine report asks), and its own header is equally
// honest about what it costs: FIVE accepted over-void shapes and one unclosed residual, with the
// durable fix named in the text — "the `dojo_reports.ask_id` column the round-2 investigation
// named, not a wider text rule".
//
// Every one of those six is the same defect in different clothes. The platform MINTED the report
// inside a turn that was answering a specific ask, knew which ask, and wrote it nowhere — so
// containment reconstructs it afterwards from proximity and cannot be both complete and narrow.
// Migration 182 writes it down. This file is that column's proof, and it is deliberately built
// around the CONTRAST: the same fixtures `a-withdrawn-report-is-not-an-answer.test.ts` §7
// characterises as accepted collateral stop being collateral once the report is bound.
//
// WHAT IS NOT CLAIMED HERE. The containment window is not deleted and is not deprecated. Rows
// written before 182 carry no binding and nothing backfills one — a historical row's ask is only
// recoverable from the very proximity the column replaces, so a backfill would write
// containment's guess into the column built to end guessing. Those rows keep the old answer,
// permanently, and §4 is that clause.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';

const logLines: string[] = [];
vi.mock('../../logger.js', () => ({
  createLogger: (component: string) => {
    const write = (level: string) => (message: string, meta?: unknown) => {
      logLines.push(`${level} ${component}: ${message} ${meta === undefined ? '' : JSON.stringify(meta)}`);
    };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
  },
}));

import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { createReport, getReport, cancelReport, submitForApproval, attachDraft, type ReportBrief } from '../store.js';
import { answerStillStands } from '../withdrawn-claim.js';

const AGENT = 'agent-under-test';
const CONV = 'conv-1';
const BRIEF: ReportBrief = {
  title: 'a staged sub-agent was handed a task it had no tool group to perform',
  whatHappened: 'The tool door refused the call and the turn ended.',
  whatShouldHaveHappened: 'The capability should have been checked at assignment time.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Check the grant when the task is assigned, not when the tool is called.',
};

let clock = 0;
const nextAt = (): number => (clock += 1000);

/** A message row, the shape the engine writes. Returns its id. */
function seedMessage(p: {
  id: string; role: 'user' | 'assistant'; content: string;
  turnNumber?: number | null; agentId?: string;
}): string {
  getDb().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                           channel, sender_id, display_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'dashboard', 'owner', ?)`,
  ).run(p.id, p.agentId ?? AGENT, CONV, p.role, p.content, p.turnNumber ?? null, nextAt(),
    p.role === 'user' ? 'user-text' : 'agent-text');
  return p.id;
}

/** Stamp an ask with the answer that served it, the way `setAnswerMessageId` does. */
function stamp(askId: string, answerId: string, turn: number): void {
  getDb().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = ? WHERE id = ?')
    .run(answerId, turn, askId);
}

const seqOf = (id: string): number =>
  (getDb().prepare('SELECT seq FROM messages WHERE id = ?').get(id) as { seq: number }).seq;

/** `answerStillStands` for one stamped ask, read off the real rows. */
function stands(askId: string, agentId = AGENT): boolean {
  const row = getDb().prepare(
    'SELECT seq, answer_message_id AS ans FROM messages WHERE id = ?',
  ).get(askId) as { seq: number; ans: string | null };
  return answerStillStands(agentId, row.seq, row.ans);
}

/** A report minted through the real door, so the binding is written by the writer under test. */
function openReportAnswering(): string {
  const r = createReport(AGENT, 'other', `ds1-${Math.random().toString(16).slice(2, 14)}`);
  return r.id;
}

/** A pre-182 row: direct INSERT, no `ask_id`. This is the legacy population, exactly. */
function seedLegacyReport(id: string, status: string, agentId = AGENT): string {
  getDb().prepare(
    `INSERT INTO dojo_reports (id, agent_id, status, lane, signature) VALUES (?, ?, ?, 'other', ?)`,
  ).run(id, agentId, status, `sig-${id}`);
  return id;
}

/** The agent and conversation rows `messages`' foreign keys require. */
function seedOwners(agentId = AGENT, convId = CONV): void {
  const d = getDb();
  d.prepare(
    `INSERT OR IGNORE INTO agents (id, name, status, session_started_at)
     VALUES (?, ?, 'idle', '1970-01-01')`,
  ).run(agentId, agentId);
  d.prepare(
    `INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(convId, agentId);
}

beforeEach(() => {
  runMigrations();
  const d = getDb();
  d.prepare('DELETE FROM dojo_reports').run();
  d.prepare('DELETE FROM messages').run();
  seedOwners();
  logLines.length = 0;
  clock = 0;
});

// ── 1. THE COLUMN IS WRITTEN, AND IT IS WRITTEN WITH THE ASK ──────────────────────────────

describe('§1 the writer binds the ask at mint time', () => {
  it('stores the ask row the agent is answering', () => {
    const askId = seedMessage({ id: 'ask-1', role: 'user', content: 'can you file a bug for that?', turnNumber: 1 });
    const reportId = openReportAnswering();

    expect(getReport(reportId)?.askId, 'the report was minted without binding the ask it answers')
      .toBe(askId);
  });

  it('binds the LATEST ask, not the first one on the agent', () => {
    seedMessage({ id: 'ask-old', role: 'user', content: 'what is the roof quote?', turnNumber: 1 });
    seedMessage({ id: 'ans-old', role: 'assistant', content: 'It was 2,400.', turnNumber: 1 });
    const current = seedMessage({ id: 'ask-now', role: 'user', content: 'file a report about that failure', turnNumber: 2 });

    expect(getReport(openReportAnswering())?.askId,
      'the binding reached back past the ask the turn is actually answering').toBe(current);
  });

  it('answers NULL rather than inventing one when the agent has no ask at all', () => {
    // The dashboard door, a fixture, a first turn with no recorded ask. A WRONG binding is worse
    // than none: it would void an unrelated ask's anti-repetition and look authoritative.
    const reportId = openReportAnswering();
    expect(getReport(reportId)?.askId, 'a binding was invented for an agent with no asks').toBeNull();
    // …and the mint itself still worked, which is the half a throw here would have cost.
    expect(getReport(reportId)?.status).toBe('drafting');
  });

  it('does not bind an assistant row, however recent', () => {
    const askId = seedMessage({ id: 'ask-2', role: 'user', content: 'please write that up', turnNumber: 1 });
    seedMessage({ id: 'ans-2', role: 'assistant', content: 'Opening a report now.', turnNumber: 1 });

    expect(getReport(openReportAnswering())?.askId,
      'the binding took the agent\'s own reply as the ask').toBe(askId);
  });
});

// ── 2. THE BOUND ARM DECIDES, AND IT DECIDES THE RIGHT WAY ROUND ──────────────────────────

describe('§2 a bound report answers the withdrawal question by itself', () => {
  it('a cancelled bound report voids the ask it was opened for', () => {
    const askId = seedMessage({ id: 'ask-c', role: 'user', content: 'file a bug about the refusal', turnNumber: 1 });
    const reportId = openReportAnswering();
    const answerId = seedMessage({ id: 'ans-c', role: 'assistant', content: 'Written up and sitting on your dashboard as a preview card.', turnNumber: 1 });
    stamp(askId, answerId, 1);

    // Standing first — the control that makes the void below mean something.
    attachDraft(reportId, {
      lane: 'other', signature: getReport(reportId)!.signature, brief: BRIEF,
      telemetry: { report: { schema: 'dojo-telemetry-1' } }, bundlePath: '/tmp/never-opened/b.json',
    });
    submitForApproval(reportId);
    expect(stands(askId), 'an ask whose card is ON the dashboard lost its stamp').toBe(true);

    cancelReport(reportId);
    expect(stands(askId), 'the card was withdrawn and the answer still claims it exists — this is '
      + `the round-2 red. ${JSON.stringify(logLines)}`).toBe(false);
  });

  it('a standing bound report keeps it, for each standing state', () => {
    for (const state of ['awaiting_approval', 'approved', 'posted'] as const) {
      getDb().prepare('DELETE FROM dojo_reports').run();
      getDb().prepare('DELETE FROM messages').run();
      seedOwners();
      const askId = seedMessage({ id: `ask-${state}`, role: 'user', content: 'file it please', turnNumber: 1 });
      const reportId = openReportAnswering();
      const answerId = seedMessage({ id: `ans-${state}`, role: 'assistant', content: 'Filed.', turnNumber: 1 });
      stamp(askId, answerId, 1);
      getDb().prepare('UPDATE dojo_reports SET status = ? WHERE id = ?').run(state, reportId);

      expect(stands(askId), `a ${state} report's ask was voided`).toBe(true);
    }
  });

  it('re-filing after a cancel keeps the ask: one standing bound row is enough', () => {
    const askId = seedMessage({ id: 'ask-refile', role: 'user', content: 'file a bug', turnNumber: 1 });
    const dead = openReportAnswering();
    const alive = openReportAnswering();
    const answerId = seedMessage({ id: 'ans-refile', role: 'assistant', content: 'Filed.', turnNumber: 1 });
    stamp(askId, answerId, 1);
    cancelReport(dead);
    getDb().prepare('UPDATE dojo_reports SET status = \'awaiting_approval\' WHERE id = ?').run(alive);

    // Both rows name THIS ask, so this is the bound arm's own version of the window's rule: an
    // agent that lost one card and filed another is telling the truth about the one that exists.
    expect(getReport(dead)?.askId).toBe(askId);
    expect(getReport(alive)?.askId).toBe(askId);
    expect(stands(askId), 'a recovered report was treated as a withdrawn one').toBe(true);
  });
});

// ── 3. THE DURABLE WIN: THE OVER-VOID SHAPES STOP BEING COLLATERAL ────────────────────────
//
// `a-withdrawn-report-is-not-an-answer.test.ts` §7 characterises five shapes the containment
// window admits as ACCEPTED collateral — an unrelated ask losing its anti-repetition because it
// happened to sit near a dead report. That is the owner's 2026-08-09 repeat-yourself complaint
// being paid, deliberately and in small change, to close the bigger red. A binding does not need
// to pay it: it names one ask, so the ask next to it is simply not the subject.

describe('§3 the binding is NARROW where containment could not be', () => {
  it('the batch partner KEEPS its stamp — §7\'s first accepted over-void is gone', () => {
    // Two asks answered by ONE turn. `setAnswerMessageId` stamps every row it served, so under
    // containment both share a window and both die with the report. Only one was the report ask.
    const reportAsk = seedMessage({ id: 'ask-batch-1', role: 'user', content: 'file a bug about that', turnNumber: 7 });
    const reportId = openReportAnswering();
    const otherAsk = seedMessage({ id: 'ask-batch-2', role: 'user', content: 'and what is the weather?', turnNumber: 7 });
    const answerId = seedMessage({ id: 'ans-batch', role: 'assistant', content: 'Filed, and it is clear today.', turnNumber: 7 });
    stamp(reportAsk, answerId, 7);
    stamp(otherAsk, answerId, 7);
    cancelReport(reportId);

    // Non-vacuity: the binding really is on the first ask and really is cancelled.
    expect(getReport(reportId)?.askId).toBe(reportAsk);
    expect(getReport(reportId)?.status).toBe('cancelled');

    expect(stands(reportAsk), 'the withdrawn report\'s own ask kept its stamp').toBe(false);
    expect(stands(otherAsk), 'the weather question lost its anti-repetition because a report '
      + 'answered in the same turn was withdrawn — that is the collateral the binding exists to '
      + 'stop paying').toBe(true);
  });

  it('an ask answered BETWEEN the pair keeps its stamp — the span arm\'s collateral is gone', () => {
    const reportAsk = seedMessage({ id: 'ask-span-1', role: 'user', content: 'file a report on the refusal', turnNumber: 1 });
    const reportId = openReportAnswering();
    const neighbour = seedMessage({ id: 'ask-span-2', role: 'user', content: 'how many centimetres in a metre?', turnNumber: 2 });
    const neighbourAns = seedMessage({ id: 'ans-span-2', role: 'assistant', content: 'One hundred.', turnNumber: 2 });
    const reportAns = seedMessage({ id: 'ans-span-1', role: 'assistant', content: 'Filed as a card.', turnNumber: 3 });
    stamp(neighbour, neighbourAns, 2);
    stamp(reportAsk, reportAns, 3);
    cancelReport(reportId);

    // The neighbour's seq sits inside the report ask's [ask, answer] span, which is what the
    // span arm reaches across.
    expect(seqOf(neighbour)).toBeGreaterThan(seqOf(reportAsk));
    expect(seqOf(neighbour)).toBeLessThan(seqOf(reportAns));

    expect(stands(reportAsk), 'the report ask kept its stamp').toBe(false);
    expect(stands(neighbour), 'a question about centimetres lost its anti-repetition because it '
      + 'was answered between a report ask and its reply').toBe(true);
  });
});

// ── 4. THE LEGACY POPULATION IS SERVED BY CONTAINMENT, PERMANENTLY, AND SAYS SO ───────────

describe('§4 a row with no binding still gets the containment answer', () => {
  it('a pre-182 cancelled report still voids its ask through the window', () => {
    // The exact legacy shape: a row inserted with no `ask_id`, named in the answer's own turn.
    const reportId = seedLegacyReport('rep-legacy', 'cancelled');
    const askId = seedMessage({ id: 'ask-legacy', role: 'user', content: 'file a bug', turnNumber: 4 });
    const answerId = seedMessage({
      id: 'ans-legacy', role: 'assistant', turnNumber: 4,
      content: `it's already filed — sitting on your dashboard (report ${reportId.slice(0, 8)})`,
    });
    stamp(askId, answerId, 4);

    expect(getReport(reportId)?.askId, 'the legacy fixture accidentally carries a binding').toBeNull();
    expect(stands(askId), 'the containment arm stopped answering for rows that have no binding — '
      + 'this is the round-3 red reopening for every report filed before 182').toBe(false);
  });

  it('and it says out loud that containment decided it, once per agent', () => {
    // A FRESH AGENT, because the notice is once per agent PER PROCESS — `AGENT` has already
    // taken the containment path in the clause above, and reusing it here would measure the
    // dedup instead of the notice. Its own conversation for the same reason.
    const fresh = 'agent-never-seen-before';
    seedOwners(fresh, 'conv-fresh');
    seedLegacyReport('rep-say', 'cancelled', fresh);
    getDb().prepare(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                             channel, sender_id, display_kind)
       VALUES ('ask-say', ?, 'conv-fresh', 'user', 'file a bug', 2, ?, 'dashboard', 'owner', 'user-text')`,
    ).run(fresh, nextAt());
    getDb().prepare(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                             channel, sender_id, display_kind)
       VALUES ('ans-say', ?, 'conv-fresh', 'assistant', 'Filed.', 2, ?, 'dashboard', 'owner', 'agent-text')`,
    ).run(fresh, nextAt());
    stamp('ask-say', 'ans-say', 2);

    stands('ask-say', fresh);
    const said = logLines.filter(l => l.includes('the containment window decides it')
      && l.includes(fresh));
    expect(said.length, 'a box running on the weaker instrument says nothing about it').toBe(1);

    // Once per agent, not once per model call — this read runs on every one of them.
    stands('ask-say', fresh);
    stands('ask-say', fresh);
    expect(logLines.filter(l => l.includes('the containment window decides it')
      && l.includes(fresh)).length,
      'the notice repeats per call, which is how a channel gets ignored').toBe(1);
  });

  it('a bound report does NOT take the containment path at all', () => {
    const askId = seedMessage({ id: 'ask-bound', role: 'user', content: 'file a bug', turnNumber: 1 });
    const reportId = openReportAnswering();
    const answerId = seedMessage({ id: 'ans-bound', role: 'assistant', content: 'Filed.', turnNumber: 1 });
    stamp(askId, answerId, 1);
    cancelReport(reportId);

    expect(stands(askId)).toBe(false);
    expect(logLines.filter(l => l.includes('the containment window decides it')).length,
      'a bound row still fell through to containment, so the binding is not actually deciding')
      .toBe(0);
  });
});

// ── 5. THE INDEXES EXIST AND THE PLANNER USES THEM, ON A GROWN TABLE ──────────────────────
//
// G13's grown-box rule. On the 17-row table this gate reads today every plan is a scan and an
// `EXPLAIN QUERY PLAN` assertion would be vacuous — it would pass with no index at all. So the
// table is grown first, and the assertion is made where the planner has a reason to choose.

describe('§5 the reads 182 adds take their indexes on a grown table', () => {
  const GROWN = 4000;

  function growReports(): void {
    const insert = getDb().prepare(
      `INSERT INTO dojo_reports (id, agent_id, status, lane, signature, ask_id)
       VALUES (?, ?, 'posted', 'other', ?, ?)`,
    );
    const many = getDb().transaction(() => {
      for (let i = 0; i < GROWN; i++) {
        insert.run(`grown-${i}`, `other-agent-${i % 200}`, `sig-grown-${i}`, `grown-ask-${i}`);
      }
    });
    many();
  }

  const plan = (sql: string, params: unknown[]): string =>
    (getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as Array<{ detail: string }>)
      .map(r => r.detail).join(' | ');

  // ⚠ THE INDEX THIS ONE PINS BELONGS TO 171, NOT TO 182 (fix round 1, review C1).
  // `idx_dojo_reports_agent_id` was created by `171_report_read_indexes.sql:100` — explicitly FOR
  // this reader, which 171's header names ("READER it is FOR: `report/withdrawn-claim.ts`'s
  // `agentHasWithdrawnReport`") — and 171 has its own plan clause pinning it by name. 182's first
  // cut created it a second time and argued it into existence as new; that was dead SQL against a
  // paid line, and it is gone. The clause stays HERE because the cheap gate is this lane's hot
  // path and a grown-box plan assertion is worth having twice, but it pins 171's index: if this
  // reds, look at 171 before looking at 182.
  it('the cheap gate seeks on agent_id — 171s index — instead of scanning every report ever filed', () => {
    growReports();
    // Non-vacuity: the table really is grown, so a scan would really cost something.
    expect((getDb().prepare('SELECT count(*) AS n FROM dojo_reports').get() as { n: number }).n)
      .toBeGreaterThanOrEqual(GROWN);

    const detail = plan(
      `SELECT 1 AS ok FROM dojo_reports WHERE agent_id = ?
        AND status NOT IN ('awaiting_approval', 'approved', 'posted') LIMIT 1`,
      [AGENT],
    );
    expect(detail, `the gate still scans the whole table: ${detail}`).not.toMatch(/SCAN dojo_reports/);
    expect(detail, `the gate does not use the agent_id index: ${detail}`)
      .toContain('idx_dojo_reports_agent_id');
  });

  it('the bound lookup seeks on ask_id', () => {
    growReports();
    const detail = plan(
      'SELECT r.id AS id, r.status AS status FROM dojo_reports r WHERE r.agent_id = ? AND r.ask_id = ?',
      [AGENT, 'ask-1'],
    );
    expect(detail, `the bound lookup scans the table: ${detail}`).not.toMatch(/SCAN dojo_reports/);
    // ⚠ DELIBERATELY EITHER INDEX, AND THEREFORE WEAKER THAN IT READS (review M3). The planner
    // can satisfy this two-column predicate from the `agent_id` seek alone, so losing
    // `idx_dojo_reports_ask_id` would NOT red this clause. What holds that index is the PRAGMA
    // pin in the next clause — do not delete it believing this one covers it.
    expect(detail, `the bound lookup uses neither index: ${detail}`)
      .toMatch(/idx_dojo_reports_(ask_id|agent_id)/);
  });

  // THE LOAD-BEARING PIN FOR `idx_dojo_reports_ask_id` (see M3 above), and the place the two
  // owners are recorded: 182 adds the column and the ask_id index; 171 owns the agent_id index.
  it('the column and both indexes are actually in the migrated schema', () => {
    const cols = (getDb().prepare('PRAGMA table_info(dojo_reports)').all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols, 'migration 182 did not add the column').toContain('ask_id');

    const idx = (getDb().prepare('PRAGMA index_list(dojo_reports)').all() as Array<{ name: string }>)
      .map(i => i.name);
    expect(idx, 'migration 182 did not add the ask_id index').toContain('idx_dojo_reports_ask_id');
    expect(idx, 'migration 171\'s agent_id index is gone — the cheap gate is back to a scan')
      .toContain('idx_dojo_reports_agent_id');
  });
});
