// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 7 T28 — BOB'S LAST SURFACE.
//
// THE RED, recorded on the live body at HEAD 3cafa8d before a line of this was written:
//   `sweepStoredSummaryObligations({dryRun:true})` → scanned 162, affected 0
// while these ten lines sat in five stored summaries for agent 57b52025-…, every one of
// them present tense, none of them citing an id:
//   "- Two quotes are still parked, waiting on Bob's address."
//   "DEFERRED: Fence and roof quotes — pending Bob's address before BehaviorBot can send them."
//   … (the full ten are in task-W11-report.md, verbatim)
// and every commitment row they describe was `abandoned`, the newest closed 2026-08-06.
// T20 fixed the id-CITED line and measured the id-less ones honestly — 17 of them — and
// left them. This is the fourth recurrence of the class across rounds 3, 4 and 7.
//
// WHAT IS BEING PROVEN HERE IS AS MUCH WHAT THE MATCHER REFUSES AS WHAT IT CATCHES. The
// first cut of it was measured on the worn-in body before anything was written, and it
// joined "David is still owed the final reply" to a commitment about a codeword on the
// strength of the name plus the word "final". §2 is the record of what that measurement
// bought: a phrase requirement, and an id-disagreement refusal.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t28-idless-obligations', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  annotateSummaryObligations, sweepStoredSummaryObligations,
  SUMMARY_OBLIGATION_MARK, SUMMARY_NO_MATCH_MARK,
} from '../summary-obligations.js';

const AGENT = 'behaviorbot';
const OTHER = 'kevin';

const db = (): Database.Database => mockDb.current!;

let seq = 0;
function seedCommitment(
  state: string, title: string, agentId: string = AGENT,
): string {
  const id = `cmt:${(++seq).toString(16).padStart(12, '0')}`;
  const closedAt = state === 'open' ? null : Date.now();
  db().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at, closed_at)
     VALUES (?, 'commitment', ?, 'agent', 'tracker', ?, ?, 'tracker', 0, 0, ?, ?, ?, ?)`,
  ).run(id, agentId, id, state, title, Date.now() - 86_400_000, Date.now(), closedAt);
  return id;
}

function seedSummary(id: string, content: string, agentId: string = AGENT): void {
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count,
                            earliest_at, latest_at, descendant_count, created_at)
     VALUES (?, ?, 0, 'leaf', ?, ?, datetime('now'), datetime('now'), 3, datetime('now'))`,
  ).run(id, agentId, content, Math.ceil(content.length / 4));
}

const contentOf = (id: string): string =>
  (db().prepare('SELECT content FROM summaries WHERE id = ?').get(id) as { content: string }).content;

/** The commitment title the incident's agent actually carried, 87 times over. */
const BOB_ROOF = "Email the roof quote to Bob (promise-bmshgzth1yw) once he sends his address. "
  + "Waiting on Bob's address before proceeding.";
const BOB_FENCE = "Email the fence estimate to Bob (promise-bmshmu5ygd5) once he sends his address. "
  + "Waiting on Bob's address before proceeding.";

/** The ten stored lines, verbatim from the live body on 2026-08-11. */
const STORED_BOB_LINES = [
  "- OPEN (per BehaviorBot's status): two quotes waiting on Bob's address — for **fence** and "
    + '**roof** — which BehaviorBot will send the moment Bob provides the address. [Owner of this '
    + "pending item: David's quote requests; dependent on Bob's address.]",
  "DEFERRED: Fence and roof quotes — pending Bob's address before BehaviorBot can send them.",
  '- First ask: BehaviorBot called work_update (status set to on_deck), then told David: '
    + '"Everything from last night is done (cheat sheet, desk picks, parking reminder), with one '
    + "honest hiccup: the 6:45 AM 'routine' reminder fired this morning but the message delivery "
    + 'glitched on my end and never reached your screen. The schedule is intact — it\'s set to fire '
    + "again tomorrow at 6:45 AM, and I'll make sure it lands. The two quotes are still parked "
    + "waiting on Bob's address.\"",
  '- Second ask: BehaviorBot replied "Nothing new since my last message a minute ago — routine '
    + "reminder fires again tomorrow 6:45 AM, quotes still waiting on Bob's address.\"",
  "- Two quotes are still parked, waiting on Bob's address.",
  "DEFERRED: The two quotes — parked, pending Bob's address (waiting on Bob).",
  '- Two outstanding quotes — fence and roof — are parked, waiting on Bob\'s address; BehaviorBot '
    + 'will send them the moment Bob provides the address.',
  "PENDING: Two quotes (fence, roof) — waiting on Bob's address before BehaviorBot sends them.",
  '- BehaviorBot replied: nothing outstanding on its side — tracker is clean; the only item is '
    + 'Ticky\'s paused technique-distillation batch, "which isn\'t mine." BehaviorBot added: "The '
    + 'fence and roof quotes are still parked on Bob\'s address, but that\'s on his side, not yours '
    + 'or mine."',
  'DEFERRED / STILL PENDING: Mariners score check — task 92fba53b-1f94-49bf-a51c-77a967355af6 '
    + 'created scheduled Mon Aug 10, 2026 14:06, but the turn closed without BehaviorBot messaging '
    + 'David the score. BehaviorBot stated fence and roof quotes remain parked on Bob\'s address — '
    + "on Bob's side, not BehaviorBot's.",
];

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  for (const [id, name] of [[AGENT, 'BehaviorBot'], [OTHER, 'Kevin']]) {
    fresh.prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, name);
  }
  seq = 0;
});

// ══════════════════════════════════════════════════════════════════════════════
// §1 — THE INCIDENT. Every one of the ten stored lines stops reading as live.
// ══════════════════════════════════════════════════════════════════════════════
describe('an id-less obligation line is resolved against the spine it never cited', () => {
  beforeEach(() => {
    seedCommitment('abandoned', BOB_ROOF);
    seedCommitment('abandoned', BOB_FENCE);
  });

  it('all ten stored lines carry their terminal state (they carried none at HEAD)', () => {
    for (const line of STORED_BOB_LINES) {
      const after = annotateSummaryObligations(line, AGENT);
      expect(after, line.slice(0, 60)).toContain(SUMMARY_OBLIGATION_MARK);
      expect(after, line.slice(0, 60)).toContain('abandoned');
      // T28b, argued update: the agent's own sentence is still never REWRITTEN, and that is
      // what this clause was for — but the finding now LEADS instead of trailing, because the
      // floor model read past a trailing one in 2 of 2 driven runs. The words are intact and
      // in order, after the line's markdown structure; only the finding moved.
      expect(after.endsWith(line.replace(/^(\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+)*)/, ''))).toBe(true);
      expect(after.replace(/\[work state as of [^\]]*\] /, '')).toBe(line);
    }
  });

  it('the annotation NAMES the row it matched, because a name match is an inference', () => {
    const after = annotateSummaryObligations(STORED_BOB_LINES[4], AGENT);
    expect(after).toMatch(/matched by name to \d+ commitment row\(s\), newest cmt:[0-9a-f]+\]/);
  });

  it('CONTROL — one still-open row anywhere in the match set leaves the line as written', () => {
    seedCommitment('open', BOB_ROOF.replace('promise-bmshgzth1yw', 'promise-bmsxxxxxxxx'));
    const line = STORED_BOB_LINES[4];
    expect(annotateSummaryObligations(line, AGENT)).toBe(line);
  });

  it('CONTROL — the same line against ANOTHER agent\'s spine is untouched', () => {
    const line = STORED_BOB_LINES[4];
    expect(annotateSummaryObligations(line, OTHER)).toBe(line);
  });

  it('CONTROL — with no agent named, the call is T20\'s, byte for byte', () => {
    const line = STORED_BOB_LINES[4];
    expect(annotateSummaryObligations(line)).toBe(line);
  });

  it('it is IDEMPOTENT — the hygiene pass and the write path cannot double-stamp', () => {
    const once = annotateSummaryObligations(STORED_BOB_LINES[4], AGENT);
    expect(annotateSummaryObligations(once, AGENT)).toBe(once);
  });

  it('only the obligation LINE moves; its neighbours are byte-identical', () => {
    const text = [
      'The owner runs Acme Corp (advertising and video production).',
      STORED_BOB_LINES[4],
      "The owner's favorite movie is Meet Joe Black.",
    ].join('\n');
    const out = annotateSummaryObligations(text, AGENT).split('\n');
    expect(out[0]).toBe('The owner runs Acme Corp (advertising and video production).');
    expect(out[2]).toBe("The owner's favorite movie is Meet Joe Black.");
    expect(out[1]).toContain(SUMMARY_OBLIGATION_MARK);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §2 — WHAT IT REFUSES. Each of these fired on the first cut and was measured out.
// ══════════════════════════════════════════════════════════════════════════════
describe('resemblance is not a join', () => {
  it('non-obligation prose naming the same person is byte-identical', () => {
    seedCommitment('abandoned', BOB_ROOF);
    const text = [
      "Bob's favourite film is Meet Joe Black.",
      'The owner asked Bob for the roof quote on 2026-08-01.',
    ].join('\n');
    expect(annotateSummaryObligations(text, AGENT)).toBe(text);
  });

  it('an obligation naming NOBODY on the spine is left exactly as written', () => {
    seedCommitment('abandoned', BOB_ROOF);
    const line = '- Two quotes are still parked, waiting on an address.';
    expect(annotateSummaryObligations(line, AGENT)).toBe(line);
  });

  it('the name plus one common noun is NOT enough — the phrase must be shared', () => {
    // The measured false positive, verbatim in shape: this joined on "David" + "final".
    seedCommitment('abandoned',
      'When BehavWorker delivers their codeword, send David ONE final message containing the '
      + 'Part 1 morning-walks benefit sentence AND the exact codeword they delivered.');
    const line = '- David is still owed the final reply "done" (his instruction was to reply with '
      + 'just "done" after the eight echoes).';
    expect(annotateSummaryObligations(line, AGENT)).toBe(line);
  });

  it('when both sides name a run id and the ids DISAGREE, it is not a match', () => {
    seedCommitment('abandoned',
      'Tell David about the fail-open probe project (failproj-bmsgoeiyu25-a1) ending with a fallen '
      + 'step, and hold today\'s pending BehaviorBot validation checks until his yes/no ruling.');
    const same = '- PENDING: Tell David about the fail-open probe project (failproj-bmsgoeiyu25-a1) '
      + 'ending with a fallen step, and hold today\'s pending BehaviorBot validation checks.';
    const other = '- PENDING: Tell David about the fail-open probe project (failproj-bmsfkglb1e0-a1) '
      + 'ending with a fallen step, and hold today\'s pending BehaviorBot validation checks.';
    expect(annotateSummaryObligations(same, AGENT)).toContain(SUMMARY_OBLIGATION_MARK);
    expect(annotateSummaryObligations(other, AGENT)).toBe(other);
  });

  it('a bare heading is not an obligation line', () => {
    seedCommitment('abandoned', BOB_ROOF);
    const line = "**Pending / open items for Bob's side:**";
    expect(annotateSummaryObligations(line, AGENT)).toBe(line);
  });

  it('an agent with no commitments at all is a no-op on every line', () => {
    const text = STORED_BOB_LINES.join('\n');
    expect(annotateSummaryObligations(text, AGENT)).toBe(text);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3 — THE NEUTRAL MARKER. Named, but nothing of theirs matches: say only that.
// ══════════════════════════════════════════════════════════════════════════════
describe('an obligation naming a counterparty whose deliverable is unrecognisable', () => {
  it('gets the neutral validity marker, never a death certificate', () => {
    seedCommitment('abandoned', "Email the roof quote to Bob once he sends his address. "
      + "Waiting on Bob's address before proceeding.");
    // shares the phrase "waiting on Bob's address", names no deliverable of any row
    const line = "- Still waiting on Bob's address before the walkthrough can be booked.";
    const after = annotateSummaryObligations(line, AGENT);
    expect(after).toContain(SUMMARY_NO_MATCH_MARK);
    expect(after).not.toContain('abandoned');
    // T28b: leading, not trailing; the sentence itself is byte-identical either way.
    expect(after).toBe(`- ${SUMMARY_NO_MATCH_MARK} ${line.slice(2)}`);
  });

  it('and it is idempotent too', () => {
    seedCommitment('abandoned', "Email the roof quote to Bob once he sends his address. "
      + "Waiting on Bob's address before proceeding.");
    const once = annotateSummaryObligations(
      "- Still waiting on Bob's address before the walkthrough can be booked.", AGENT);
    expect(annotateSummaryObligations(once, AGENT)).toBe(once);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §4 — THE ONE-TIME PASS IS READ BEFORE IT IS WRITTEN.
// ══════════════════════════════════════════════════════════════════════════════
describe('the stored-summary hygiene pass reports every line before it touches one', () => {
  beforeEach(() => {
    seedCommitment('abandoned', BOB_ROOF);
    seedCommitment('abandoned', BOB_FENCE);
  });

  it('a dry run names the summary, the line and the finding, and writes nothing', () => {
    seedSummary('sum_bob', STORED_BOB_LINES[4]);
    seedSummary('sum_plain', 'The owner runs Acme Corp.');
    const report = sweepStoredSummaryObligations({ dryRun: true });
    expect(report.scanned).toBe(2);
    expect(report.affected).toBe(1);
    expect(report.ids).toEqual(['sum_bob']);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].summaryId).toBe('sum_bob');
    expect(report.candidates[0].agentId).toBe(AGENT);
    expect(report.candidates[0].line).toBe(STORED_BOB_LINES[4]);
    expect(report.candidates[0].finding).toContain('abandoned');
    expect(contentOf('sum_bob')).toBe(STORED_BOB_LINES[4]);
  });

  it('applying it annotates exactly the rows the dry run named', () => {
    seedSummary('sum_bob', STORED_BOB_LINES.join('\n'));
    seedSummary('sum_plain', 'The owner runs Acme Corp.');
    const report = sweepStoredSummaryObligations({ dryRun: false });
    expect(report.affected).toBe(1);
    expect(contentOf('sum_plain')).toBe('The owner runs Acme Corp.');
    const lines = contentOf('sum_bob').split('\n');
    expect(lines).toHaveLength(STORED_BOB_LINES.length);
    for (const l of lines) expect(l).toContain(SUMMARY_OBLIGATION_MARK);
  });

  it('running it twice is a no-op the second time', () => {
    seedSummary('sum_bob', STORED_BOB_LINES[4]);
    expect(sweepStoredSummaryObligations({ dryRun: false }).affected).toBe(1);
    expect(sweepStoredSummaryObligations({ dryRun: false }).affected).toBe(0);
  });

  it('each agent is resolved against its OWN spine only', () => {
    seedCommitment('open', "Email the roof quote to Bob once he sends his address. "
      + "Waiting on Bob's address before proceeding.", OTHER);
    seedSummary('sum_mine', STORED_BOB_LINES[4], AGENT);
    seedSummary('sum_theirs', STORED_BOB_LINES[4], OTHER);
    const report = sweepStoredSummaryObligations({ dryRun: true });
    expect(report.ids).toEqual(['sum_mine']);   // theirs is still OWED, so it stays as written
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §5 — THE WRITE-TIME CONTRACT. New summaries cannot mint fresh zombies.
// ══════════════════════════════════════════════════════════════════════════════
describe('the summariser write path resolves id-less obligations too', () => {
  it('compaction passes the agent to the annotator', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../compaction.ts'), 'utf8');
    expect(src).toContain('annotateSummaryObligations(summary.text, agentId)');
  });

  it('and the render path still never rewrites a stored summary (cache law, T20)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../assembler.ts'), 'utf8');
    expect(src).not.toContain('annotateSummaryObligations');
  });
});
