// ════════════════════════════════════════════════════════════════════════════════════════
// THE HAND-OFF CANNOT BE TRUNCATED AWAY (release ritual v3.2.0, round 1 red).
//
// ── THE DEFECT THIS FILE EXISTS BECAUSE OF, MEASURED ON THREE LIVE ATTEMPTS ──
// `gather` assembled its result as [ id line · evidence bundle · "Next: call dojo_report with
// phase=\"draft\"…" ]. `definitions.ts` declares `maxResultTokens: 12000` for this tool and
// `applyMaxResultTokensCap` truncates from the END, so the instruction that drives the whole
// rest of the feature was the FIRST thing destroyed the moment the bundle got big. It got big
// on its own: the `logs` section grew 9,333 → 35,994 characters (20 → 66 entries) inside the
// SAME twenty-turn window, because a `draft` call's five-part write-up is logged verbatim by
// `Executing tool` and the next gather read it back — each report inflating the next.
//
// Attempts 2 and 3 of the blast lost the hand-off (one severed mid-word at `report`, one cut
// 3,000 characters earlier), the rows stranded in `drafting`, `listOpenReports` serves only
// `awaiting_approval` so NO CARD EVER EXISTED — and the model told the owner *"Already filed —
// the draft is sitting on your dashboard waiting for you to hit Post"*. That is the shape of
// the whole failure: a severed result does not read as broken, it reads as FINISHED.
//
// ── THE THREE PROPERTIES, AND WHY ALL THREE ARE NEEDED ──
//  1. ORDER. The id, the honest state and the whole next call ride at the HEAD, above any
//     evidence. Truncation from the end then cannot reach them, whatever the payload does.
//     BOTH results obey it: `gather`'s and — since review F2 — `draft`'s.
//  2. SIZE. Every bundle section carries a CHARACTER budget (`BUNDLE_SECTION_CHARS`), not only
//     a row cap, because the engine's cap is counted in tokens and a row is not a number of
//     tokens. A MAXIMAL bundle lands 6,874 tokens against a 12,000 cap, and `draft`'s echo of
//     the attachment lands 3,786 where it used to reach 22,025. The clauses assert that
//     arithmetic rather than trusting the comment — and that the PUBLISHED attachment is not
//     bounded with the copy of it.
//  3. HONESTY. A bound that drops evidence silently teaches the reader it saw everything, so
//     each bounded section reports `showing the K <order> of N`, K is checked against the drop
//     that actually happened, and `<order>` is checked against what that reader's `ORDER BY`
//     actually ranks (review F3). One fat row never empties a section: it is shrunk in place
//     with a marker naming what went, because "the section is empty" is not an honest answer
//     to "one row was large" (review F1).
//
// Order alone is not enough: an agent handed 48,000 characters of JSON has lost its evidence
// anyway. Size alone is not enough: any future grower re-opens the same hole. Honesty alone is
// worth nothing if the numbers in it are decorative.
//
// ── MUTANTS (planted, RED, reverted by the exact reverse edit, sha256 re-asserted) ──
// Eight, over 19 clauses. The first four are the round-1 causes; the last four are the fix
// round's, and each of those four was a real defect the review found in this file's own fix.
//
//   M1  the gather hand-off moved back to the tail        → 3 F / 16 P  (1, 2, 3)
//   M2  the `logs` character budget removed               → 5 F / 14 P  (3, 5, 8, 9, 10)
//   M3  the "NOTHING IS FILED…" truth line deleted       → 2 F / 17 P  (1, 3)
//   M4  the tool's own payload left in the logs slice     → 2 F / 17 P  (12, 14)
//   M5  the one-fat-row shrink disabled (plain `break`)   → 1 F / 18 P  (10)
//   M6  the draft arm's attachment echo left unbounded    → 2 F / 17 P  (17, 18)
//   M7  `toolFailures` note calls a hit ranking "newest"  → 1 F / 18 P  (11)
//   M8  the whole `meta` deleted again, as the first cut  → 2 F / 17 P  (14, 15)
//
// Two of the messages are the live incidents restated by the suite: M2's *"a maximal gather
// result is 35130 tokens against a 9000 target"* (2.9× the engine's cap from one unbounded
// section) and M6's *"the draft result is 22277 tokens against a 9000 target"*, which lands
// within 1% of the 22,025 the review measured by hand. M5's is the F1 defect in one line:
// *"ONE oversized row emptied the whole section"*. Full messages in
// `.superpowers/sdd/DOJO-REPORT-PLAN/ritual-red1-fix-report.md`.
//
// M1 alone leaves the size clauses green and M2 alone leaves the head clauses green, which is
// the honest shape of the red: it took BOTH the tail placement and the unbounded section to
// strand a row, so each property is held on its own rather than in one compound assertion.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The log reader is the one collector with no table behind it, so the rows are handed in. */
const logRows: { timestamp: string; level: string; component: string; message: string;
  agentId?: string; meta?: Record<string, unknown> }[] = [];

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop,
    setLogBroadcast: noop,
    readLogEntries: (opts?: { limit?: number }) => logRows.slice(0, opts?.limit ?? 100),
  };
});

import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { reportHandlers } from '../../agent/tools/cat/report.js';
import { applyMaxResultTokensCap } from '../../agent/tools/index.js';
import { toolDefinitions } from '../../agent/tools/definitions.js';
import { registryToolDefinitions } from '../../agent/tools/registry.js';
import { gatherEvidence } from '../gather.js';
import { getReport } from '../store.js';
import { FAILURE_LANES } from '../signature.js';
import {
  ATTACHMENT_ECHO_CHARS, BUNDLE_SECTION_CHARS, FIELD_TOO_LARGE, REPORT_RESULT_TARGET_TOKENS,
} from '../bounds.js';
import { COLLECTOR_CAPS } from '../window.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'kevin-handoff';

/** The engine's own numbers, read from the definition rather than copied into this file. */
const CAP_TOKENS = toolDefinitions.find(d => d.name === 'dojo_report')!.maxResultTokens!;
const CAP_CHARS = CAP_TOKENS * 4;

/**
 * THE HEAD BUDGET THIS FILE HOLDS THE TOOL TO. Any truncation that leaves this many characters
 * has to have left the whole hand-off, so the property is "the instruction is inside the first
 * 2,000 characters" — one number, checkable, and independent of how the engine happens to cut.
 */
const HEAD_CHARS = 2_000;

const BRIEF_ARGS = {
  title: 'A tool result lost its own instruction to a size cap',
  what_happened: 'The step that follows was cut off the end of a tool result.',
  what_should_have_happened: 'The instruction should survive any trim of the evidence.',
  why_it_went_wrong: 'The instruction sat behind an unbounded payload.',
  fix_ideas: 'Put the instruction first and bound the payload.',
};

const call = async (args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
  reportHandlers.dojo_report({
    agentId: AGENT, name: 'dojo_report', args, callId: 'c1', toolCall: {} as ToolCall,
  });

const idIn = (content: string): string => {
  const id = /Report ([0-9a-f-]{36}) opened/.exec(content)?.[1];
  expect(id, `no report id in: ${content.slice(0, 300)}`).toBeTruthy();
  return id!;
};

// ── seeding ─────────────────────────────────────────────────────────────────────────────
// Stamped at the DATABASE'S own `datetime('now')` (and `Date.now()` for the two epoch-ms
// tables) because the tool resolves its window against the real clock — a fixed test clock
// would put every row outside the window and every "at most" assertion would pass over an
// empty bundle, which is the vacuity `the-gather-window-is-bounded.test.ts` was rewritten for.

function base(): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-h', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-h', 'p-h', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Kevin', 'm-h', 'idle')").run(AGENT);
}

/** A log entry of a realistic weight (the dev box's `prompt cache usage` line is ~300 bytes). */
function logEntry(i: number, extra?: Record<string, unknown>): typeof logRows[number] {
  return {
    timestamp: new Date().toISOString(), level: 'info', component: 'model',
    message: 'prompt cache usage', agentId: AGENT,
    meta: { promptTokens: 30_922 + i, cachedTokens: 18_944, cacheCreationTokens: 0,
      requestType: 'agent_turn', latencyMs: 4_211, note: `call ${i} ` + 'x'.repeat(200), ...extra },
  };
}

/** A body far past every cap, in every collector at once. Newest rows are inserted last. */
function seedOversize(logCount = 200): void {
  base();
  const db = getDb();
  const longPath = `/Users/dave/Documents/${'deep-folder/'.repeat(12)}quarterly.pdf`;
  const longDetail = `denied by a gate: ${'reason text '.repeat(25)}`;
  for (let i = 1; i <= 30; i++) {
    db.prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, effectful_calls,
                          started_at, ended_at, exit_reason)
       VALUES (?, ?, 'user', 'conv', 0, 2, datetime('now'), datetime('now'), 'brake')`,
    ).run(AGENT, i);
  }
  for (let i = 1; i <= 70; i++) {
    db.prepare(
      `INSERT INTO cost_records (id, agent_id, provider_id, model_id, request_type,
                                 input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, 'p-h', 'm-h', 'agent_turn', ?, 1, 0, datetime('now'))`,
    ).run(`cr-${i}`, AGENT, i);
  }
  for (let i = 1; i <= 210; i++) {
    db.prepare(
      `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, call_id, created_at)
       VALUES (?, ?, 'file_read', ?, 'denied', ?, ?, datetime('now'))`,
    ).run(`al-${i}`, AGENT, `${longPath}?${i}`, longDetail, `call_${i}`);
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                             turn_number, provenance, authorized, token_count, created_at)
       VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 10, ?)`,
    ).run(`msg-${i}`, AGENT, JSON.stringify([
      { type: 'tool_use', id: `call_${i}`, name: 'file_read', input: { path: `${longPath}?${i}` } },
    ]), Date.now());
  }
  for (let i = 1; i <= 30; i++) {
    db.prepare(
      `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, last_at)
       VALUES (?, ?, 'file_read', ?, datetime('now'))`,
    ).run(AGENT, `sig-${i}`, i);
    db.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, opened_at, updated_at)
       VALUES (?, 'task', ?, 'owner', 'conv', 'c1', 'open', 'FYI', 0, 0, ?, ?)`,
    ).run(`w-${i}`, AGENT, Date.now(), Date.now());
  }
  for (let i = 1; i <= logCount; i++) logRows.push(logEntry(i));
}

/** What the collectors would have handed over with no size bound at all. The non-vacuity
 *  guard for every clause below: a body that was never over the cap proves nothing. */
function rawEvidenceChars(): number {
  const db = getDb();
  const rows = (sql: string, ...p: unknown[]): unknown[] => db.prepare(sql).all(...p);
  return JSON.stringify([
    logRows,
    rows('SELECT * FROM audit_log WHERE agent_id = ?', AGENT),
    rows('SELECT * FROM cost_records WHERE agent_id = ?', AGENT),
    rows('SELECT * FROM turns WHERE agent_id = ?', AGENT),
  ]).length;
}

beforeEach(() => {
  runMigrations();
  const db = getDb();
  for (const t of ['turns', 'audit_log', 'agent_tool_failures', 'cost_records', 'work', 'messages']) {
    db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(AGENT);
  }
  db.prepare('DELETE FROM dojo_reports WHERE agent_id = ?').run(AGENT);
  logRows.length = 0;
});

describe('the truth and the instruction ride at the head, where truncation cannot reach them', () => {
  it('1 — the first 2,000 characters carry the id, the not-yet-filed truth and the whole next call', async () => {
    seedOversize();
    // Non-vacuity: this really is a body that used to blow the cap. 48,000 chars is the
    // engine's own budget for this tool, so anything past it is over-cap material.
    expect(rawEvidenceChars(), 'the seeded body is not big enough to be a test of a size bound')
      .toBeGreaterThan(CAP_CHARS);

    const gathered = await call({ phase: 'gather' });
    expect(gathered.isError, gathered.content).toBe(false);
    const id = idIn(gathered.content);
    const head = gathered.content.slice(0, HEAD_CHARS);

    expect(head, 'the report id is not in the head').toContain(id);
    expect(head, 'the head does not say that nothing is filed yet').toContain('NOTHING IS FILED');
    expect(head).toContain('no preview card');
    expect(head, 'the head does not carry the next phase').toContain('phase="draft"');
    expect(head, 'the head names no report_id to draft against').toContain(`report_id="${id}"`);
    for (const lane of FAILURE_LANES) expect(head, `lane ${lane} is not offered in the head`).toContain(lane);
    expect(head, 'the shape-not-quotes rule is not in the head').toContain('no quotes from the conversation');
    expect(head, 'the head does not say a trimmed bundle is still draftable').toMatch(/does NOT block you/);
  });

  it('2 — the instruction comes BEFORE the evidence, which is the whole point of the order', async () => {
    seedOversize();
    const gathered = await call({ phase: 'gather' });
    const instructionAt = gathered.content.indexOf('phase="draft"');
    const evidenceAt = gathered.content.indexOf('EVIDENCE (local only');
    expect(instructionAt).toBeGreaterThanOrEqual(0);
    expect(evidenceAt).toBeGreaterThanOrEqual(0);
    expect(instructionAt, 'the hand-off sits behind the evidence again — a big bundle will eat it')
      .toBeLessThan(evidenceAt);
  });

  it('3 — the engine cap does not fire at all on a maximal body, and could not reach the head if it did', async () => {
    seedOversize();
    const gathered = await call({ phase: 'gather' });

    // The real production function, at the real registered cap for this tool.
    expect(applyMaxResultTokensCap('dojo_report', gathered.content),
      'the engine truncated a bounded gather result — the budgets no longer fit the cap')
      .toBe(gathered.content);

    // And the head survives a cut that DOES happen. A future grower is simulated by appending
    // to the result, so the ENGINE genuinely truncates and stamps its trailer — the exact
    // condition of the round-1 red — and the assertion is read off the first 2,000 characters
    // of what came back, because "somewhere in 48,000 characters" is not what the model reads
    // first and is not what the red destroyed.
    const cut = applyMaxResultTokensCap('dojo_report', `${gathered.content}\n${'y'.repeat(200_000)}`);
    expect(cut, 'the engine trailer never appeared — nothing was truncated').toContain('[Truncated by engine');
    const cutHead = cut.slice(0, HEAD_CHARS);
    expect(cutHead, 'a truncated result lost the not-yet-filed truth').toContain('NOTHING IS FILED');
    expect(cutHead, 'a truncated result lost the hand-off — this is the round-1 red').toContain('phase="draft"');
  });

  it('4 — the row can still go all the way to the card over that same body', async () => {
    seedOversize();
    const gathered = await call({ phase: 'gather' });
    const id = idIn(gathered.content);

    const drafted = await call({ phase: 'draft', report_id: id, lane: 'other', ...BRIEF_ARGS });
    expect(drafted.isError, drafted.content).toBe(false);
    expect(getReport(id)?.status, 'the draft did not attach').toBe('drafting');

    const submitted = await call({ phase: 'submit', report_id: id });
    expect(submitted.isError, submitted.content).toBe(false);
    expect(getReport(id)?.status, 'the row never reached the owner — no card would exist')
      .toBe('awaiting_approval');
  });
});

describe('the evidence bundle is bounded by arithmetic, not by hope', () => {
  const SECTION_TOTAL = Object.values(BUNDLE_SECTION_CHARS).reduce((a, b) => a + b, 0);

  it('5 — a maximal body renders a whole result under the target, with the margin stated', async () => {
    seedOversize();
    const raw = rawEvidenceChars();
    const gathered = await call({ phase: 'gather' });
    const tokens = Math.ceil(gathered.content.length / 4);

    expect(raw, 'non-vacuity: the raw material was not over-cap').toBeGreaterThan(CAP_CHARS);
    expect(tokens, `a maximal gather result is ${tokens} tokens against a ${REPORT_RESULT_TARGET_TOKENS} target`)
      .toBeLessThanOrEqual(REPORT_RESULT_TARGET_TOKENS);
    expect(tokens, 'the result reaches the engine cap').toBeLessThan(CAP_TOKENS);
    // The bound is doing the work, and it is doing a LOT of it.
    expect(gathered.content.length).toBeLessThan(raw / 2);
  });

  it('6 — every section of the bundle is inside its own budget', () => {
    seedOversize();
    const bundle = gatherEvidence(AGENT, {}).bundle as Record<string, unknown[]>;
    for (const [name, budget] of Object.entries(BUNDLE_SECTION_CHARS)) {
      const section = bundle[name];
      expect(Array.isArray(section), `section ${name} is missing from the bundle`).toBe(true);
      // Measured the way the result renders it: pretty-printed, at its depth in the document.
      const rendered = JSON.stringify(section, null, 2).length;
      expect(rendered, `section ${name} rendered ${rendered} chars against a ${budget} budget`)
        .toBeLessThanOrEqual(budget + 4 * section.length + 8);
      expect(section.length, `section ${name} is empty — the clause above is vacuous`).toBeGreaterThan(0);
    }
  });

  it('7 — the budgets plus the head still fit the cap the tool declares', () => {
    // The arithmetic written beside the constants, asserted: sections + the head + the drop
    // notes + the `window` object and the outer keys. Raising any budget without redoing the
    // sum fails here rather than in a live run.
    const OVERHEAD = 1_800 + 1_000 + 400;
    expect(Math.ceil((SECTION_TOTAL + OVERHEAD) / 4)).toBeLessThanOrEqual(REPORT_RESULT_TARGET_TOKENS);
    expect(REPORT_RESULT_TARGET_TOKENS, 'the target is not inside the engine cap').toBeLessThan(CAP_TOKENS);
    // The row caps are still the other half of the discipline, not replaced by this one.
    expect(COLLECTOR_CAPS.turns).toBeGreaterThan(0);
  });

  it('8 — every list section in the bundle HAS a budget, so nothing arrives unbounded', () => {
    // The census the constant's own comment promises. Without it, deleting a budget makes the
    // per-section clause above blind to exactly the section that was unbounded, which is how
    // this defect got in: `logs` had a row cap of 200 and no size bound at all.
    seedOversize(20);
    const bundle = gatherEvidence(AGENT, {}).bundle as Record<string, unknown>;
    const lists = Object.entries(bundle)
      .filter(([k, v]) => Array.isArray(v) && k !== 'bounds').map(([k]) => k);
    expect(lists.length, 'no list sections found — the census is looking at the wrong object')
      .toBeGreaterThan(0);
    for (const name of lists) {
      expect(Object.keys(BUNDLE_SECTION_CHARS), `bundle section \`${name}\` carries no character budget`)
        .toContain(name);
    }
  });

  it('9 — the drop note is true of the drop that actually happened', async () => {
    seedOversize(66);   // the exact log volume the round measured on its second attempt
    const bundle = gatherEvidence(AGENT, {}).bundle as Record<string, unknown[]>;
    const notes = bundle.bounds as unknown as string[];
    const note = notes.find(n => n.startsWith('logs:'));
    expect(note, `no drop note for logs; notes were ${JSON.stringify(notes)}`).toBeTruthy();

    const m = /logs: showing the (\d+) newest of (\d+) collected/.exec(note!);
    expect(m, `the note does not say K of N: ${note}`).toBeTruthy();
    expect(Number(m![1]), 'the note claims a count the bundle does not carry')
      .toBe((bundle.logs as unknown[]).length);
    expect(Number(m![2]), 'the note claims a window total the collector never saw').toBe(66);
    expect(Number(m![1]), 'nothing was dropped, so the note is a lie in the other direction')
      .toBeLessThan(66);
    expect(Number(m![1]), 'the bound kept nothing — a note is not a substitute for evidence')
      .toBeGreaterThan(0);
  });

  // ⚠ FIX ROUND 1, REVIEW F1. The bound keeps a prefix, so it stops at the first row that does
  // not fit — and when that row is the NEWEST one the section came back EMPTY with a note that
  // said "showing newest 0 of 12 … older entries were dropped": false twice over, and reachable
  // with one ordinary call, because nothing truncates log meta and `Executing tool` records
  // arguments verbatim. The budget still has to hold, so the row is shrunk, not admitted whole.
  it('10 — one fat row cannot empty a section: it is shrunk in place, and the note says so', () => {
    seedOversize(12);
    const FAT = 'Z'.repeat(BUNDLE_SECTION_CHARS.logs + 2_000);
    logRows.unshift(logEntry(0, { blob: FAT }));   // newest, and alone over the logs budget

    const bundle = gatherEvidence(AGENT, {}).bundle as Record<string, unknown[]>;
    const logs = bundle.logs;
    expect(logs.length, 'ONE oversized row emptied the whole section — the F1 defect').toBeGreaterThan(0);

    const kept = logs[0] as { message?: unknown; timestamp?: unknown; meta?: Record<string, unknown> };
    // The small fields are the ones worth keeping, and they survived.
    expect(kept.message, 'the shrink threw away the row instead of its fat field').toBe('prompt cache usage');
    expect(kept.timestamp).toBeTruthy();
    expect(JSON.stringify(kept), 'the fat field rode in whole — the budget does not hold').not.toContain(FAT);
    expect(JSON.stringify(kept), 'the shrink is silent — a marker must name what was cut')
      .toContain(FIELD_TOO_LARGE);

    // The budget still binds, with the same tolerance clause 6 uses.
    const rendered = JSON.stringify(logs, null, 2).length;
    expect(rendered).toBeLessThanOrEqual(BUNDLE_SECTION_CHARS.logs + 4 * logs.length + 8);

    const note = (bundle.bounds as unknown as string[]).find(n => n.startsWith('logs:'));
    expect(note, 'a shrunken section said nothing about it').toBeTruthy();
    expect(note!, 'the note blames older entries for a drop the newest row caused')
      .toMatch(/that one entry was itself over this section's size budget/);
    expect(note!, 'the note claims a count the section does not carry')
      .toContain(`showing the ${logs.length} newest of 13`);
  });

  // ⚠ FIX ROUND 1, REVIEW F3. `readFailures` orders by `hit_count DESC`, `readWork` by
  // `updated_at DESC`; a note that called either prefix "newest" would be false, and the fix is
  // the NOTE, never the product ordering. One clause over every section that dropped, so a
  // future collector with a new ordering cannot slip in wearing the wrong word.
  it('11 — every drop note names the order its own prefix is actually in', () => {
    seedOversize(66);
    const bundle = gatherEvidence(AGENT, {}).bundle as Record<string, unknown[]>;
    const notes = bundle.bounds as unknown as string[];
    const ORDER_OF: Record<string, string> = {
      logs: 'newest', turns: 'newest', auditLog: 'newest', toolCalls: 'newest', calls: 'newest',
      work: 'most recently updated', toolFailures: 'most-hit',
    };
    expect(notes.length, 'nothing dropped — this clause would be vacuous').toBeGreaterThan(2);
    for (const note of notes) {
      const name = note.slice(0, note.indexOf(':'));
      const order = ORDER_OF[name];
      expect(order, `no declared ordering for section \`${name}\``).toBeTruthy();
      expect(note, `the note for \`${name}\` describes its prefix as something other than ${order}`)
        .toContain(`showing the ${(bundle[name] as unknown[]).length} ${order} of `);
    }
    // The one that was actually wrong, named so a reader can see the case.
    const failures = notes.find(n => n.startsWith('toolFailures:'));
    expect(failures, 'toolFailures did not drop — the F3 case is untested here').toBeTruthy();
    expect(failures!, 'a hit-count ranking is being called "newest"').not.toContain('newest');
  });
});

const MARKER = 'SPARROW-LEDGER-9931';

describe('a report about a report refers to it by id and never re-swallows its text', () => {

  it('12 — this tool\'s own arguments never come back as evidence, and the call still does', () => {
    seedOversize(20);
    logRows.unshift(logEntry(0, {
      tool: 'dojo_report',
      args: { phase: 'draft', report_id: 'earlier', title: MARKER, what_happened: MARKER.repeat(80) },
    }));
    // Non-vacuity: the payload really is in what the reader hands over.
    expect(JSON.stringify(logRows)).toContain(MARKER);

    const bundle = gatherEvidence(AGENT, {}).bundle;
    const text = JSON.stringify(bundle);
    expect(text, 'the last report\'s write-up rode back into the next report\'s evidence')
      .not.toContain(MARKER);
    // The FACT of the call is evidence and stays; only the payload is replaced.
    expect(text, 'the row itself was dropped — that this tool ran is real evidence').toContain('dojo_report');
    expect(text).toContain('omitted');
  });

  it('13 — the discriminator names a tool that still exists, so a rename cannot make it vacuous', () => {
    expect(registryToolDefinitions().some(d => d.name === 'dojo_report')).toBe(true);
  });

  // ⚠ FIX ROUND 1, REVIEW F4. The first cut replaced the whole `meta`, which deleted the one
  // field a report ABOUT this tool most needs: `error`, the platform's own account of why the
  // last `dojo_report` call was rejected (`tools/index.ts:466`). Payload and explanation are
  // different things and only the payload is the agent's or the user's text.
  it('14 — the platform\'s own explanation of a failed report call survives the exclusion', () => {
    const WHY = 'lane must be one of [tool-error, wrong-answer, silence, permission, other]';
    seedOversize(8);
    logRows.unshift({
      timestamp: new Date().toISOString(), level: 'warn', component: 'tools',
      message: 'Tool call rejected by the schema-validation boundary', agentId: AGENT,
      meta: { tool: 'dojo_report', error: WHY, args: { title: MARKER } },
    });
    const text = JSON.stringify(gatherEvidence(AGENT, {}).bundle);
    expect(text, 'the agent\'s own write-up came back as evidence').not.toContain(MARKER);
    expect(text, 'the reason the last report call FAILED was deleted with the payload').toContain(WHY);
    expect(text, 'the note does not name what it actually dropped').toContain('args —');
  });

  it('15 — a row of this tool\'s that carried no payload is returned untouched, with no false claim', () => {
    seedOversize(8);
    logRows.unshift({
      timestamp: new Date().toISOString(), level: 'warn', component: 'tools',
      message: 'Blocked tools_policy-denied tool call', agentId: AGENT,
      meta: { tool: 'dojo_report' },
    });
    const logs = (gatherEvidence(AGENT, {}).bundle as Record<string, unknown[]>).logs;
    const row = logs.find(r => (r as { message?: string }).message === 'Blocked tools_policy-denied tool call');
    expect(row, 'the row vanished').toBeTruthy();
    expect((row as { meta?: Record<string, unknown> }).meta,
      'a row that never had arguments was told its arguments were omitted')
      .toEqual({ tool: 'dojo_report' });
  });
});

describe('the draft phase obeys the same two laws — order AND size', () => {
  it('16 — `submit` is named before the attachment that can grow past the cap', async () => {
    seedOversize(20);
    const id = idIn((await call({ phase: 'gather' })).content);
    const drafted = await call({ phase: 'draft', report_id: id, lane: 'permission', ...BRIEF_ARGS });
    expect(drafted.isError, drafted.content).toBe(false);

    const head = drafted.content.slice(0, HEAD_CHARS);
    expect(head, 'the draft result does not say it is still not filed').toContain('STILL NOT FILED');
    expect(head, 'the draft result does not name the submit call in its head').toContain('phase="submit"');
    expect(drafted.content.indexOf('phase="submit"'),
      'the submit hand-off sits behind the attachment — the round-1 red, one phase later')
      .toBeLessThan(drafted.content.indexOf('MACHINE-BUILT ATTACHMENT'));
  });

  // ⚠ FIX ROUND 1, REVIEW F2. Order was fixed and size was not: on a maximal window the draft
  // result measured 88,098 chars ≈ 22,025 tokens, 1.8× the cap, so the engine severed the
  // attachment echo and stamped "narrow your query, ask for less" — advice that, for this tool,
  // means draft again, against a row that accepts a second attachment. Two properties, and the
  // second is the one that keeps the first honest: the echo is TRIMMED, the stored attachment is
  // WHOLE, and the result says which is which.
  it('17 — a maximal window\'s draft result is bounded, and the engine cap does not fire', async () => {
    seedOversize(200);
    const id = idIn((await call({ phase: 'gather' })).content);
    const drafted = await call({ phase: 'draft', report_id: id, lane: 'other', ...BRIEF_ARGS });
    expect(drafted.isError, drafted.content).toBe(false);

    const tokens = Math.ceil(drafted.content.length / 4);
    expect(tokens, `the draft result is ${tokens} tokens against a ${REPORT_RESULT_TARGET_TOKENS} target`)
      .toBeLessThanOrEqual(REPORT_RESULT_TARGET_TOKENS);
    expect(applyMaxResultTokensCap('dojo_report', drafted.content),
      'the engine truncated the draft result — the echo budgets no longer fit the cap')
      .toBe(drafted.content);
    // Non-vacuity: there really was a maximal attachment to trim.
    const stored = getReport(id)!.telemetry as Record<string, unknown[]>;
    expect(stored.tools.length, 'nothing was big enough to need bounding').toBeGreaterThan(20);
  });

  it('18 — the STORED attachment is whole; only the echo is trimmed, and the result says so', async () => {
    seedOversize(200);
    const id = idIn((await call({ phase: 'gather' })).content);
    const drafted = await call({ phase: 'draft', report_id: id, lane: 'other', ...BRIEF_ARGS });

    const stored = getReport(id)!.telemetry as Record<string, unknown[]>;
    const echoed = JSON.parse(drafted.content.slice(drafted.content.indexOf('{'))) as Record<string, unknown[]>;
    // ⚠ THE LOAD-BEARING ASSERTION GOES FIRST (fix-round-2 review NIT-6). With the vacuity guard
    // ahead of it, the exact implementation this clause exists to refuse — bounding `telemetry`
    // before `attachDraft` — failed on "the echo was not trimmed … vacuous" instead of on the
    // message written for that author. Both are needed; only one of them diagnoses.
    expect(stored.tools.length, 'THE PUBLISHED ATTACHMENT WAS BOUNDED — the echo\'s trim reached the row')
      .toBe(COLLECTOR_CAPS.toolCalls);
    expect(echoed.tools.length, 'the echo was not trimmed — this clause is vacuous')
      .toBeLessThan(stored.tools.length);
    expect(echoed.echoBounds, 'the trimmed copy does not say what it left out').toBeTruthy();
    expect(JSON.stringify(echoed.echoBounds)).toContain('tools: showing the ');

    const head = drafted.content.slice(0, HEAD_CHARS);
    expect(head, 'nothing tells the agent a truncated draft result is harmless — it will draft again')
      .toMatch(/nothing is lost and nothing needs redoing: submit, do not draft/);
    expect(head, 'the head does not say the stored attachment is the complete one')
      .toContain('the stored attachment is complete');
  });

  it('19 — every array in the attachment has an echo budget, so none of it is unbounded', async () => {
    seedOversize(30);
    const id = idIn((await call({ phase: 'gather' })).content);
    await call({ phase: 'draft', report_id: id, lane: 'other', ...BRIEF_ARGS });
    const stored = getReport(id)!.telemetry as Record<string, unknown>;
    const arrays = Object.entries(stored).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
    expect(arrays.length, 'no arrays found — the census is reading the wrong object').toBeGreaterThan(0);
    for (const name of arrays) {
      expect(Object.keys(ATTACHMENT_ECHO_CHARS), `attachment array \`${name}\` carries no echo budget`)
        .toContain(name);
    }
  });
});
