// ════════════════════════════════════════════════════════════════════════════════════════
// THE AGENT'S WORDS NEVER REACH THE TELEMETRY (DOJO-REPORT T3).
//
// Owner ruling D1 splits what leaves the box into two halves with two different provenances:
// the BRIEF is written by the agent and gated by a human, and the ATTACHMENT is built by the
// machine from a declared whitelist. The whole privacy argument rests on those two never
// mixing — a whitelist is worthless if the builder can be handed a sentence.
//
// T1 made that structural (`buildTelemetry` has no parameter an agent string could occupy)
// and proved it over synthetic sources. What was NOT proved anywhere is the property this
// file holds: that the LIVE handler, driven end to end through its three phases with five
// distinctive strings in the five brief fields, puts those strings in the report row and in
// nothing else. `the-report-tool-cannot-post.test.ts` is the structural half of T3's claim;
// this is the behavioural half, and it drives the tool rather than reading it.
//
// The markers are deliberately ugly and unique. A substring search for "SEVENTEEN" across a
// serialized attachment is a crude instrument, and crude is what is wanted: it cannot be
// satisfied by a clever encoding, and it fails the moment any path — a future "helpful"
// summary field, a spread, a debug echo — carries one word of the agent's text across.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { reportHandlers } from '../../agent/tools/cat/report.js';
import { getReport, listOpenReports } from '../store.js';
import { readBundle } from '../bundle.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'kevin-report-words';

/** The five markers, one per brief field. Nothing else in the tree contains them. */
const MARK = {
  title: 'MARKER-ALPHA-SEVENTEEN refused a call it had just demanded',
  what_happened: 'MARKER-BRAVO-SEVENTEEN the door refused the call',
  what_should_have_happened: 'MARKER-CHARLIE-SEVENTEEN it should have opened the task',
  why_it_went_wrong: 'MARKER-DELTA-SEVENTEEN the grant floor omitted the category',
  fix_ideas: 'MARKER-ECHO-SEVENTEEN add the label to the creation default',
};
const ALL_MARKERS = Object.values(MARK);

const call = async (args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
  reportHandlers.dojo_report({
    agentId: AGENT, name: 'dojo_report', args, callId: 'c1', toolCall: {} as ToolCall,
  });

beforeEach(() => {
  runMigrations();
  const db = getDb();
  db.prepare('DELETE FROM dojo_reports').run();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-w', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-w', 'p-w', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Kevin', 'm-w', 'idle')").run(AGENT);
});

/** Drive gather → draft and hand back the report id. */
async function driveToDraft(): Promise<string> {
  const gathered = await call({ phase: 'gather' });
  expect(gathered.isError, gathered.content).toBe(false);
  const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
  expect(id, `no report id in: ${gathered.content.slice(0, 200)}`).toBeTruthy();
  const drafted = await call({ phase: 'draft', report_id: id, lane: 'permission', ...MARK });
  expect(drafted.isError, drafted.content).toBe(false);
  return id!;
}

describe('the agent\'s five strings land in the brief and only in the brief', () => {
  it('stores every marker in the report brief', async () => {
    const id = await driveToDraft();
    const row = getReport(id);
    expect(row?.brief).toEqual({
      title: MARK.title, whatHappened: MARK.what_happened,
      whatShouldHaveHappened: MARK.what_should_have_happened,
      whyItWentWrong: MARK.why_it_went_wrong, fixIdeas: MARK.fix_ideas,
    });
  });

  it('puts NOT ONE of them in the machine-built attachment', async () => {
    const id = await driveToDraft();
    const telemetry = JSON.stringify(getReport(id)?.telemetry);
    for (const marker of ALL_MARKERS) {
      expect(telemetry, `the attachment carries the agent's own text: ${marker}`).not.toContain(marker);
    }
    // The marker word on its own, in case a field ever carries a fragment rather than the whole.
    expect(telemetry).not.toContain('SEVENTEEN');
    // …and the attachment is not empty, so the clause above is not passing vacuously.
    expect(telemetry.length).toBeGreaterThan(100);
    expect(JSON.parse(telemetry!)).toHaveProperty('report.lane', 'permission');
  });

  // ⚠ THE SETUP IS ASSERTED BEFORE THE PROPERTY IS, and the ordering is the whole clause.
  // The first cut read `getReport(id)?.bundlePath ? readBundle(id) : null` and stringified
  // the result: with an empty `bundle_path` that is the string `"null"`, which contains no
  // marker, so the assertion passed over nothing while the agent's five markers sat in
  // `bundle.json` on disk. Worse, T2's own contract C7 documents a null `readBundle` as
  // NORMAL for a live report (the 50-directory sweep), so the clause disarmed itself under
  // a condition the design calls routine. A missing bundle must fail the SETUP — loudly,
  // naming what is missing — and never quietly satisfy the assertion.
  it('puts none of them in the local evidence bundle either — the agent writes only the brief', async () => {
    const id = await driveToDraft();
    const row = getReport(id);
    expect(row?.bundlePath, 'no bundle_path was recorded — the assertion below would pass over nothing').toBeTruthy();
    const bundle = readBundle(id);
    expect(bundle, 'readBundle answered null — the assertion below would pass over the string "null"').not.toBeNull();
    // A positive control: this IS the right report's bundle, so "the markers are absent"
    // is a fact about a populated document rather than about an empty one.
    const text = JSON.stringify(bundle);
    expect(text.length, 'the bundle is empty — nothing to be private about').toBeGreaterThan(100);
    expect(text).toContain('window');
    expect(text).not.toContain('SEVENTEEN');
  });
});

// ── I1: the window on the artifact is the window the agent asked for ────────────────────
// The brief pins it — "`truncated: true` is set (and surfaced in the telemetry as
// `window.truncated`) whenever a cap bit". The first cut re-gathered at `draft` with `{}`,
// so `resolveWindow` never capped anything and the field was a CONSTANT `false` on every
// attachment the feature could produce: the agent was told the truth in prose and the
// public page was told `false`. These clauses run THROUGH THE HANDLER, because the shipped
// assertion ran against a direct `gatherEvidence` call and proved plumbing production never
// reached.
describe('the window stamped on the attachment is the one the agent asked for', () => {
  it('a capped ask reaches the STORED attachment as truncated: true', async () => {
    const gathered = await call({ phase: 'gather', turns: 500, minutes: 10080 });
    expect(gathered.content).toContain('The window is capped');
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    const drafted = await call({ phase: 'draft', report_id: id, lane: 'other', ...MARK });
    expect(drafted.isError, drafted.content).toBe(false);

    const window = (getReport(id!)?.telemetry as { window?: Record<string, unknown> } | null)?.window;
    expect(window, 'the attachment carries no window block at all').toBeDefined();
    expect(window).toEqual({ minutes: 120, turns: 20, truncated: true });
  });

  it('an ask inside the cap is NOT reported as truncated', async () => {
    const gathered = await call({ phase: 'gather', turns: 5, minutes: 15 });
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    await call({ phase: 'draft', report_id: id, lane: 'other', ...MARK });
    const window = (getReport(id!)?.telemetry as { window?: Record<string, unknown> } | null)?.window;
    expect(window).toEqual({ minutes: 15, turns: 5, truncated: false });
  });

  it('refuses to draft when the resolved window is no longer held, rather than inventing one', async () => {
    const gathered = await call({ phase: 'gather', turns: 500 });
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    // Thirty-two newer reports evict the ask, which is the same state a restart leaves.
    for (let i = 0; i < 33; i++) await call({ phase: 'gather' });
    const drafted = await call({ phase: 'draft', report_id: id, lane: 'other', ...MARK });
    expect(drafted.isError).toBe(true);
    expect(drafted.content).toContain('no longer held');
    // And nothing was written: a refused draft leaves the row exactly as it was.
    expect(getReport(id!)?.brief).toBeNull();
  });
});

describe('the three phases are a one-way street to the owner', () => {
  it('draft refuses a lane outside the fixed list, before anything is written', async () => {
    const gathered = await call({ phase: 'gather' });
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    const bad = await call({ phase: 'draft', report_id: id, lane: 'catastrophe', ...MARK });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('lane must be one of');
    expect(getReport(id!)?.brief).toBeNull();
  });

  it('draft refuses a half-written brief and names every empty field at once', async () => {
    const gathered = await call({ phase: 'gather' });
    const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
    const bad = await call({ phase: 'draft', report_id: id, lane: 'other', title: MARK.title });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('what_happened');
    expect(bad.content).toContain('fix_ideas');
  });

  it('submit hands the report to the owner and says the agent cannot press Post', async () => {
    const id = await driveToDraft();
    const submitted = await call({ phase: 'submit', report_id: id });
    expect(submitted.isError, submitted.content).toBe(false);
    expect(submitted.content).toContain('You cannot press it');
    expect(getReport(id)?.status).toBe('awaiting_approval');
    expect(listOpenReports().map(r => r.id)).toContain(id);
  });

  it('a second submit is refused — the tool cannot re-ring the bell', async () => {
    const id = await driveToDraft();
    await call({ phase: 'submit', report_id: id });
    const again = await call({ phase: 'submit', report_id: id });
    expect(again.isError).toBe(true);
    expect(getReport(id)?.status).toBe('awaiting_approval');
  });

  it('refuses to touch another agent\'s report', async () => {
    const id = await driveToDraft();
    const stranger = await reportHandlers.dojo_report({
      agentId: 'someone-else', name: 'dojo_report', args: { phase: 'submit', report_id: id },
      callId: 'c2', toolCall: {} as ToolCall,
    });
    expect(stranger.isError).toBe(true);
    expect(stranger.content).toContain('belongs to another agent');
  });

  it('answers an unknown phase with the three that exist, and never invents a fourth', async () => {
    const out = await call({ phase: 'post' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('gather, draft, submit');
  });
});
