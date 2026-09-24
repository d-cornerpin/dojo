// ════════════════════════════════════════════════════════════════════════════════════════
// THE GATHER WINDOW IS BOUNDED (DOJO-REPORT T3).
//
// The agent names the window; the tool bounds it. That sentence has to hold in four places
// at once, and each block below is one of them:
//
//   1. THE CAP BINDS AND SAYS SO. Twenty turns, one hundred and twenty minutes, whatever was
//      asked for. `truncated` is the difference between a bound and a silent trim — an agent
//      that asked for a week and was given two hours must be TOLD, or it writes its brief
//      about evidence it never saw. A non-positive ask is not an ask and is not truncation.
//
//   2. THE ROW CAPS BIND. One runaway table must not crowd out every other collector's
//      evidence, so each reader carries its own LIMIT. Seeded with double the cap, the
//      window must still come back at the cap.
//
//   3. THE SPLIT HOLDS. `audit_log.target` carries the user's file paths — measured, not
//      feared: `agent/tools/cat/fs.ts` writes fifteen such rows. It must appear in the LOCAL
//      bundle and be absent from `sources`, which is the object T1's builder reads. This is
//      the flagship clause of the file, and the mutant that proves it copies `target` across.
//
//   4. THE STAMP FORMATS ARE LIVE, NOT ASSUMED. The plan's pinned SQL bound an ISO string
//      against columns that store SQLite's `datetime('now')` shape, which compares `'T'`
//      against `' '` and matches NOTHING. A window that is always empty passes every count
//      assertion trivially, so the seeded rows below are written in the PRODUCTION shape and
//      the test asserts they come BACK — an empty result here is a failure, not a pass.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { gatherEvidence } from '../gather.js';
import {
  resolveWindow, COLLECTOR_CAPS, REPORT_WINDOW_MAX_MINUTES, REPORT_WINDOW_MAX_TURNS,
} from '../window.js';

const AGENT = 'kevin-report-window';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const SECRET_PATH = '/Users/dave/taxes.pdf';

describe('resolveWindow bounds what the agent asked for', () => {
  it('gives the standing window when nothing is asked, and calls it untruncated', () => {
    const w = resolveWindow({}, NOW);
    expect(w.turns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(w.minutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(w.truncated).toBe(false);
  });

  it('honours an ask that is inside the cap, exactly', () => {
    const w = resolveWindow({ turns: 5, minutes: 15 }, NOW);
    expect(w.turns).toBe(5);
    expect(w.minutes).toBe(15);
    expect(w.truncated).toBe(false);
  });

  it('clamps an oversized turn count and reports the trim', () => {
    const w = resolveWindow({ turns: 500 }, NOW);
    expect(w.turns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(w.truncated).toBe(true);
    expect(w.askedFor).toContain('500');
  });

  it('clamps "since last Tuesday" to two hours and reports the trim', () => {
    const w = resolveWindow({ minutes: 10080 }, NOW);
    expect(w.minutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(w.truncated).toBe(true);
  });

  it('treats a negative or non-finite ask as no ask — never a window that ends before it starts', () => {
    for (const req of [{ turns: -3 }, { turns: 0 }, { minutes: Number.NaN }, { minutes: -1 }]) {
      const w = resolveWindow(req, NOW);
      expect(w.turns, JSON.stringify(req)).toBe(REPORT_WINDOW_MAX_TURNS);
      expect(w.minutes, JSON.stringify(req)).toBe(REPORT_WINDOW_MAX_MINUTES);
      // Nothing was SHORTENED — the ask was never a window. The two facts are different.
      expect(w.truncated, JSON.stringify(req)).toBe(false);
    }
  });

  it('starts the window exactly `minutes` before the injected now', () => {
    const w = resolveWindow({ minutes: 30 }, NOW);
    expect(w.sinceIso).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
    expect(NOW.getTime() - Date.parse(w.sinceIso)).toBe(30 * 60_000);
  });
});

// ── the seeded body ─────────────────────────────────────────────────────────────────────
// Stamps are written the way production writes them: `datetime('now')` TEXT for the four
// text-stamped tables, epoch MILLISECONDS for `work`. Seeding ISO here would make the test
// agree with a reader that production disagrees with.

function seed(turnCount: number): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-r', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-r', 'p-r', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Kevin', 'm-r', 'idle')").run(AGENT);
  for (let i = 1; i <= turnCount; i++) {
    db.prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, effectful_calls,
                          started_at, ended_at, exit_reason)
       VALUES (?, ?, 'user', 'conv', 0, 0, datetime('now'), datetime('now'), 'brake')`,
    ).run(AGENT, i);
  }
  db.prepare(
    `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, call_id, created_at)
     VALUES ('al-1', ?, 'file_read', ?, 'denied', 'File not found', 'call_1', datetime('now'))`,
  ).run(AGENT, SECRET_PATH);
  db.prepare(
    `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, last_at)
     VALUES (?, 'sig-1', 'file_read', 4, datetime('now'))`,
  ).run(AGENT);
  // THE ASSISTANT ROW THAT NAMES THE TOOL. Without it there are no tool-call facts at all,
  // and the privacy clauses below pass VACUOUSLY — which is exactly how the first cut of
  // this file let the `target`-into-`sources` mutant survive. Its `id` matches the audit
  // row's `call_id`, which is the join the gather relies on, and its arguments carry the
  // same secret path a second time so the arg-shape extractor is under test too.
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES ('msg-1', ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 10, 1)`,
  ).run(AGENT, JSON.stringify([
    { type: 'tool_use', id: 'call_1', name: 'file_read', input: { path: SECRET_PATH } },
  ]));
}

beforeEach(() => {
  runMigrations();
  const db = getDb();
  for (const t of ['turns', 'audit_log', 'agent_tool_failures', 'cost_records', 'work', 'messages']) {
    db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(AGENT);
  }
});

describe('the per-collector row caps bind against a seeded body', () => {
  it('returns at most COLLECTOR_CAPS.turns turn rows when twice that many exist', () => {
    seed(COLLECTOR_CAPS.turns * 2);
    const ev = gatherEvidence(AGENT, {});
    // An empty result would satisfy "at most" trivially — the stamp-format defect this
    // file exists to catch is exactly an always-empty window, so assert BOTH bounds.
    expect(ev.sources.turns.length).toBe(COLLECTOR_CAPS.turns);
  });

  it('carries the window it actually used into the telemetry sources', () => {
    seed(3);
    const ev = gatherEvidence(AGENT, { turns: 900, minutes: 900 });
    expect(ev.sources.windowTurns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(ev.sources.windowMinutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(ev.sources.windowTruncated).toBe(true);
  });

  it('reads the seeded rows back at all — the stamp formats are the production ones', () => {
    seed(2);
    const ev = gatherEvidence(AGENT, {});
    expect(ev.sources.turns.length).toBe(2);
    expect(ev.dominant.toolFailures.length).toBeGreaterThan(0);
    expect(ev.dominant.turnExits[0]).toEqual({ exitReason: 'brake', count: 2 });
  });
});

describe('the user content stays in the bundle and never reaches the telemetry sources', () => {
  // ⚠ THE NON-VACUITY GUARD COMES FIRST, AND IT IS NOT CEREMONY. The first cut of this file
  // seeded no `messages` row, so `toolCalls` was empty, so every "does not contain" clause
  // below was true about an object that had no tool facts in it at all — and the mutant that
  // copies `audit_log.target` into the `result` field SURVIVED, green, 11/11. A privacy
  // assertion over an empty collection is the most confident kind of nothing.
  it('has tool-call facts to be private ABOUT — the clauses below are not vacuous', () => {
    seed(1);
    const ev = gatherEvidence(AGENT, {});
    expect(ev.sources.toolCalls.length).toBeGreaterThan(0);
    // The `call_id` ↔ `tool_use.id` join landed: this fact came from the audit row.
    expect(ev.sources.toolCalls[0]).toMatchObject({ name: 'file_read', result: 'denied' });
  });

  it('keeps audit_log.target out of `sources` and in the local bundle', () => {
    seed(2);
    const ev = gatherEvidence(AGENT, {});
    expect(ev.sources.toolCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.bundle)).toContain('taxes.pdf');
    expect(
      JSON.stringify(ev.sources),
      'a column carrying the user\'s file path reached the object the attachment is built from',
    ).not.toContain('taxes.pdf');
  });

  it('keeps the platform-authored detail string out of `sources` too', () => {
    seed(1);
    const ev = gatherEvidence(AGENT, {});
    expect(JSON.stringify(ev.bundle)).toContain('File not found');
    expect(JSON.stringify(ev.sources)).not.toContain('File not found');
  });

  it('carries the SIZE of a path-valued argument and never the path', () => {
    seed(1);
    const shape = gatherEvidence(AGENT, {}).sources.toolCalls[0].argShape;
    // `path` is a declared property of `file_read`, so the key survives as itself.
    expect(shape).toEqual([{ key: 'path', type: 'string', bytes: JSON.stringify(SECRET_PATH).length }]);
    expect(JSON.stringify(shape)).not.toContain('taxes');
  });
});
