// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T20 — SUMMARIES STOP BEING A SECOND MEMORY OF OBLIGATIONS.
//
// Bob has a third life. T17 closed the vault door (`eee3eb6`) and closed it correctly, but by
// then the dead promise had already been copied into two conversation summaries — and the
// summarizer is INSTRUCTED to record obligations, with a worked example that is literally the
// Bob roof quote (`summarize.ts:66`). That same instruction states the law nothing implemented:
//
//     "the id is the record, the summary is the context around it"
//
// No reader anywhere resolved the ids it was told to cite. `839eedc` deleted the fenced
// OPEN-LOOPS block and its prose parser — a summariser writing the obligation ledger — and
// ADDED the citation instruction in the same commit; nothing was ever built to read it.
//
// THE PRINCIPLE, THIRD AND FINAL SURFACE. CORE-2 item 4: recall resolves hits against the
// authoritative record — no parallel memory of ANSWERS. T17: no parallel memory of
// OBLIGATIONS, for the vault. This: the same, for summaries. The spine is the only truth
// about what is owed, and the OPEN WORK block (TAIL, 60 tokens, correctly filtered) is where
// the model reads it.
//
// ⚠ AND THE CACHE TENET IS THE CRUX. Summaries ride `MessageSlot.Summaries = 300`, inside
// `volatileFrom` — the CACHEABLE PREFIX, the surface T17 deliberately did not touch (its own
// commit body: "no prompt-prefix edit — this task touches no cached surface"). So the
// resolution happens at WRITE, where the summarizer's separate model call already is, and
// stored summaries are NEVER rewritten at render time. Exactly ONE static sentence joins the
// lane header, as a registered re-blessing.
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t20-summary-obligations', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { getDepthPrompt } from '../summarize.js';
import {
  annotateSummaryObligations, sweepStoredSummaryObligations, SUMMARY_OBLIGATION_MARK,
} from '../summary-obligations.js';

const AGENT = 'kevin';
const DEAD = 'cmt:1a2b3c4d5e6f';
const LIVE = 'cmt:9f8e7d6c5b4a';

const db = (): Database.Database => mockDb.current!;

function seedCommitment(id: string, state: string, title: string): void {
  const closedAt = state === 'open' ? null : Date.now();
  db().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at, closed_at)
     VALUES (?, 'commitment', ?, 'agent', 'tracker', ?, ?, 'tracker', 0, 0, ?, ?, ?, ?)`,
  ).run(id, AGENT, id, state, title, Date.now() - 86_400_000, Date.now(), closedAt);
}

function seedSummary(id: string, content: string): void {
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count,
                            earliest_at, latest_at, descendant_count, created_at)
     VALUES (?, ?, 0, 'leaf', ?, ?, datetime('now'), datetime('now'), 3, datetime('now'))`,
  ).run(id, AGENT, content, Math.ceil(content.length / 4));
}

const contentOf = (id: string): string =>
  (db().prepare('SELECT content FROM summaries WHERE id = ?').get(id) as { content: string }).content;

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  fresh.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
});

// ══════════════════════════════════════════════════════════════════════════════
// §1 — THE CONTRACT. The summarizer stops asserting an obligation it cannot point at.
// ══════════════════════════════════════════════════════════════════════════════
describe('the summarizer contract implements its own sentence', () => {
  it('an obligation line must cite a work id or not be written at all', () => {
    const p = getDepthPrompt(0, 1200, undefined, undefined);
    expect(p).toContain('the id is the record, the summary is the context around it');
    expect(p.toLowerCase()).toContain('leave it out');
  });

  it('and the prompt says which block is the CURRENT record of what is owed', () => {
    const p = getDepthPrompt(0, 1200, undefined, undefined);
    expect(p).toContain('OPEN WORK');
  });

  it('depths 1 and 2 carry the obligation rule too — a dead line condensed upward is the same lie', () => {
    for (const depth of [1, 2]) {
      const p = getDepthPrompt(depth, 1200, undefined, undefined);
      expect(p, `depth ${depth}`).toContain('OPEN WORK');
    }
  });

  it('CONTROL: everything else the depth-0 prompt guarantees is untouched', () => {
    const p = getDepthPrompt(0, 1200, undefined, undefined);
    for (const kept of [
      'Preserve ALL proper nouns',
      'TEMPORAL ANCHORING',
      'CONVERSATION ATTRIBUTION',
      'RESOLVED:', 'DECIDED:', 'CLOSED:', 'DEFERRED:',
      'Never record "I could not see / read / receive a message"',
      'Capability / tool availability is VOLATILE state',
    ]) {
      expect(p, kept).toContain(kept);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §2 — RESOLUTION AT WRITE. The cited id is finally dereferenced.
// ══════════════════════════════════════════════════════════════════════════════
describe('a cited work id is resolved against the spine before the summary is stored', () => {
  beforeEach(() => {
    seedCommitment(DEAD, 'abandoned', 'email the roof quote to Bob (promise-bmsbcibqqem)');
    seedCommitment(LIVE, 'open', 'send Priya the offsite budget');
  });

  it('a dead obligation carries its terminal state, as of the write (the incident)', () => {
    const before = `- Two quotes are still parked, waiting on Bob's address [${DEAD}].`;
    const after = annotateSummaryObligations(before);
    expect(after).toContain(SUMMARY_OBLIGATION_MARK);
    expect(after).toContain('abandoned');
    // the agent's own words are never rewritten — the annotation is appended
    expect(after).toContain("Two quotes are still parked, waiting on Bob's address");
  });

  it('a live obligation keeps its date and says it is still open', () => {
    const after = annotateSummaryObligations(`- still owed: the offsite budget for Priya [${LIVE}].`);
    expect(after).toContain(SUMMARY_OBLIGATION_MARK);
    expect(after).toContain('open');
    expect(after).not.toContain('abandoned');
  });

  it('a cited id that resolves to NOTHING is marked unverifiable, never declared dead', () => {
    const after = annotateSummaryObligations('- still owed: something [cmt:000000000000].');
    expect(after).toContain(SUMMARY_OBLIGATION_MARK);
    expect(after.toLowerCase()).toContain('no matching record');
    expect(after).not.toContain('abandoned');
  });

  it('NON-obligation content is byte-identical — the summary is still a summary', () => {
    const text = [
      '[2026-08-10 09:00–11:30] The owner runs Acme Corp (advertising and video production).',
      "The owner's favorite movie is Meet Joe Black.",
      'RESOLVED: the 500 on /api/tracker — fixed by the migration on 2026-08-09',
    ].join('\n');
    expect(annotateSummaryObligations(text)).toBe(text);
  });

  it('an obligation line with NO cited id is left exactly as written (no prose guessing)', () => {
    const text = '- Two quotes are still parked, waiting on Bob\'s address.';
    expect(annotateSummaryObligations(text)).toBe(text);
  });

  it('it is IDEMPOTENT — the hygiene pass and the write path cannot double-stamp a line', () => {
    const once = annotateSummaryObligations(`- still owed: roof quote [${DEAD}].`);
    expect(annotateSummaryObligations(once)).toBe(once);
  });

  it('only the cited LINE moves; its neighbours are untouched', () => {
    const text = [
      'The owner asked for the fence quote on 2026-08-01.',
      `- still owed: email Bob the roof quote [${DEAD}].`,
      "The owner's favorite movie is Meet Joe Black.",
    ].join('\n');
    const out = annotateSummaryObligations(text).split('\n');
    expect(out[0]).toBe('The owner asked for the fence quote on 2026-08-01.');
    expect(out[2]).toBe("The owner's favorite movie is Meet Joe Black.");
    expect(out[1]).toContain(SUMMARY_OBLIGATION_MARK);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3 — THE ONE-TIME BOUNDED HYGIENE. Measured before it is applied.
// ══════════════════════════════════════════════════════════════════════════════
describe('the stored-summary hygiene pass counts before it writes', () => {
  beforeEach(() => {
    seedCommitment(DEAD, 'abandoned', 'email the roof quote to Bob');
  });

  it('a dry run REPORTS the affected rows and writes nothing', () => {
    seedSummary('sum_a', `- still owed: email Bob the roof quote [${DEAD}].`);
    seedSummary('sum_b', 'The owner runs Acme Corp.');
    const report = sweepStoredSummaryObligations({ dryRun: true });
    expect(report.scanned).toBe(2);
    expect(report.affected).toBe(1);
    expect(report.ids).toEqual(['sum_a']);
    expect(contentOf('sum_a')).toBe(`- still owed: email Bob the roof quote [${DEAD}].`);
  });

  it('applying it annotates exactly the rows the dry run named', () => {
    seedSummary('sum_a', `- still owed: email Bob the roof quote [${DEAD}].`);
    seedSummary('sum_b', 'The owner runs Acme Corp.');
    const report = sweepStoredSummaryObligations({ dryRun: false });
    expect(report.affected).toBe(1);
    expect(contentOf('sum_a')).toContain(SUMMARY_OBLIGATION_MARK);
    expect(contentOf('sum_b')).toBe('The owner runs Acme Corp.');
  });

  it('a summary with NO cited id is never touched — the two Bob rows are proof bodies, not targets', () => {
    seedSummary('sum_bob', "- Two quotes are still parked, waiting on Bob's address.");
    const report = sweepStoredSummaryObligations({ dryRun: true });
    expect(report.affected).toBe(0);
    expect(report.ids).toEqual([]);
  });

  it('running it twice is a no-op the second time', () => {
    seedSummary('sum_a', `- still owed: email Bob the roof quote [${DEAD}].`);
    expect(sweepStoredSummaryObligations({ dryRun: false }).affected).toBe(1);
    expect(sweepStoredSummaryObligations({ dryRun: false }).affected).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §4 — THE ONE PREFIX SENTENCE (registered re-blessing).
// ══════════════════════════════════════════════════════════════════════════════
describe('the summaries lane header says which block is current', () => {
  it('the static header carries the sentence, and nothing else in the lane moved', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../assembler.ts'), 'utf8');
    const lane = src.slice(src.indexOf("id: 'lane.summaries'"), src.indexOf("id: 'lane.attempt-ledger'"));
    expect(lane).toContain('═══ COMPRESSED HISTORY (summaries of earlier messages, not live conversation) ═══');
    expect(lane).toContain('OPEN WORK');
    // it is STATIC — no interpolation joined the header, so the prefix stays byte-stable
    const header = lane.slice(lane.indexOf('═══ COMPRESSED HISTORY'), lane.indexOf('${summaryText}'));
    expect(header.length).toBeGreaterThan(200);
    expect(header, 'the header is a literal; only the summaries themselves interpolate')
      .not.toContain('${');
  });

  it('stored summaries are NEVER rewritten at render time (cache law)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../assembler.ts'), 'utf8');
    expect(src).not.toContain('annotateSummaryObligations');
  });
});
