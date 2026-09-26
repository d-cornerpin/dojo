// ════════════════════════════════════════════════════════════════════════════════════════
// THE LANE THE AGENT CHOSE IS THE LANE THAT POSTS (DOJO-REPORT T8 fix round).
//
// ── THE DEFECT THIS FILE EXISTS BECAUSE OF, MEASURED ON A LIVE ROW ──
// `cat/report.ts` re-derives the lane and the signature at draft time and hands the real values
// to the telemetry builder. `store.ts:attachDraft` then wrote `brief_json`, `telemetry_json` and
// `bundle_path` — and nothing else. So the ROW kept the PROVISIONAL pair `createReport` wrote at
// gather time, when the lane is hard-coded `'other'`. The T8 live run's own report, decoded:
//
//   row       `ds1-cbf0fd308acc` = sha256("0.0.0|other|tool:exec:denied")
//   telemetry `ds1-47375b28d43f` = sha256("0.0.0|wrong-answer|tool:exec:denied")
//
// Same version, same dominant failure. ONLY THE LANE DIFFERS. Two costs, both here as clauses:
//
//  1. A POSTED ISSUE CONTRADICTS ITSELF. `issue-body.ts` renders `row.lane` in its header and
//     `dojo-sig: ${row.signature}` in its trailer, while the telemetry block INSIDE THAT SAME
//     BODY carries the other lane and the other digest. A reader cannot tell which half of one
//     page is true, and a triager reading the trailer buckets it under a lane nobody chose.
//     Clause 2 refuses a body that contains two different `ds1-` tokens at all, which is the
//     defect stated as a property rather than as a list of the places it shows up.
//
//  2. THE DEDUPE LOSES THE LANE. `post.ts` searches the tracker for `row.signature`. A digest
//     always keyed on `'other'` drops the lane out of the pinned `sha256(version|lane|dominant)`
//     key, so every lane over one dominant failure collapses into a single bucket and a
//     wrong-answer report comments on a permission issue. Clause 3 drives the REAL poster and
//     reads the search URL it actually built.
//
// ── WHY THE PROOF IS THREE REPORTS AND NOT ONE ASSERTION ──
// "The row's signature changed" is satisfied by a door that writes any new string. What has to
// hold is that the digest is keyed on THE AGENT'S LANE, and the only way to see a key is to vary
// it: two reports over the same evidence drafted on DIFFERENT lanes must differ, and one drafted
// on `'other'` — gather's own provisional lane — must come back to the provisional digest. That
// triple cannot be satisfied by a door that writes a constant, a hash of the brief, or a fresh
// uuid, which a single inequality assertion would accept.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { reportHandlers } from '../../agent/tools/cat/report.js';
import {
  attachDraft, createReport, getReport, submitForApproval, approveOnce, type ReportBrief,
} from '../store.js';
import { renderIssueBody } from '../issue-body.js';
import { postApprovedReport } from '../post.js';
import { saveGithubAccount, disconnectGithub } from '../../github/account.js';
import { DOJO_REPORT_REPO_DEFAULT } from '../repo.js';
import { FAILURE_LANES, type FailureLane } from '../signature.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'kevin-drafted-lane';
/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';

const BRIEF_ARGS = {
  title: 'Delegated work declared failed seconds after successful delivery',
  what_happened: 'The tool returned success and the row went terminal anyway.',
  what_should_have_happened: 'A delivered delegation inside its window is not a failure.',
  why_it_went_wrong: 'The notice is generated from the terminal state, not the delivery record.',
  fix_ideas: 'Split delivered from answered and give the wait an explicit timeout.',
};

const BRIEF: ReportBrief = {
  title: BRIEF_ARGS.title, whatHappened: BRIEF_ARGS.what_happened,
  whatShouldHaveHappened: BRIEF_ARGS.what_should_have_happened,
  whyItWentWrong: BRIEF_ARGS.why_it_went_wrong, fixIdeas: BRIEF_ARGS.fix_ideas,
};

const call = async (args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
  reportHandlers.dojo_report({
    agentId: AGENT, name: 'dojo_report', args, callId: 'c1', toolCall: {} as ToolCall,
  });

/** Every `ds1-` token in a string, de-duplicated. The instrument clause 2 turns on the body. */
const digestsIn = (text: string): string[] =>
  [...new Set(text.match(/ds1-[0-9a-f]{12}/g) ?? [])];

/** The lane and the digest the ATTACHMENT carries, read out of the stored JSON. */
function telemetryIdentity(id: string): { lane: unknown; signature: unknown } {
  const report = (getReport(id)?.telemetry ?? {}).report as Record<string, unknown> | undefined;
  expect(report, 'no `report` section on the attachment — the clauses below would read undefined')
    .toBeTruthy();
  return { lane: report!.lane, signature: report!.signature };
}

/**
 * gather → draft on one lane, and the PROVISIONAL identity gather wrote is returned beside the
 * final one so every clause can compare the two without re-deriving either.
 */
async function draftOnLane(lane: FailureLane): Promise<{
  id: string; provisionalLane: FailureLane; provisionalSignature: string;
}> {
  const gathered = await call({ phase: 'gather' });
  expect(gathered.isError, gathered.content).toBe(false);
  const id = /Report ([0-9a-f-]{36}) opened/.exec(gathered.content)?.[1];
  expect(id, `no report id in: ${gathered.content.slice(0, 200)}`).toBeTruthy();
  const atGather = getReport(id!);
  expect(atGather, 'the row vanished between gather and the read-back').toBeTruthy();
  const drafted = await call({ phase: 'draft', report_id: id, lane, ...BRIEF_ARGS });
  expect(drafted.isError, drafted.content).toBe(false);
  return {
    id: id!, provisionalLane: atGather!.lane, provisionalSignature: atGather!.signature,
  };
}

// ── the stubbed GitHub, for the one clause that drives the poster ─────────────────────────

interface RecordedCall { method: string; url: string }
let calls: RecordedCall[] = [];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input) });
    if (String(input).includes('/search/issues')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      number: 7, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/7`,
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  runMigrations();
  const db = getDb();
  db.prepare('DELETE FROM dojo_reports').run();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-dl', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-dl', 'p-dl', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Kevin', 'm-dl', 'idle')").run(AGENT);
  calls = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  disconnectGithub();
});

// ── 1. THE ROW CARRIES THE AGENT'S CHOICE ────────────────────────────────────────────────

describe('a draft on a lane other than gather\'s provisional one moves the row', () => {
  it('writes the chosen lane and the digest derived from it, and the attachment agrees', async () => {
    const { id, provisionalLane, provisionalSignature } = await draftOnLane('wrong-answer');

    // THE SETUP IS ASSERTED FIRST. If gather ever stopped writing `'other'`, the clause below
    // would compare a value against itself and pass over nothing.
    expect(provisionalLane, 'gather no longer opens the row on the provisional lane — this '
      + 'clause has nothing left to prove').toBe('other');

    const row = getReport(id);
    expect(row?.lane, 'the row kept gather\'s provisional lane after the agent chose another')
      .toBe('wrong-answer');
    expect(row?.signature, 'the row kept the digest derived from the PROVISIONAL lane')
      .not.toBe(provisionalSignature);

    // The two halves of one posted page must be the same report.
    const attachment = telemetryIdentity(id);
    expect(row?.lane, 'the row and the attachment name different lanes').toBe(attachment.lane);
    expect(row?.signature, 'the row and the attachment carry different digests')
      .toBe(attachment.signature);
    expect(String(attachment.signature)).toMatch(/^ds1-[0-9a-f]{12}$/);
  });

  it('is keyed on the LANE — two lanes over the same evidence differ, and `other` comes back', async () => {
    const wrong = await draftOnLane('wrong-answer');
    const permission = await draftOnLane('permission');
    const other = await draftOnLane('other');

    const sig = (id: string): string => getReport(id)!.signature;

    // Same box, same agent, same evidence window, same version: the lane is the only input
    // that moved. A door that wrote a constant, a hash of the brief or a fresh id fails here.
    expect(sig(wrong.id), 'two different lanes produced the same digest — the lane is not in the key')
      .not.toBe(sig(permission.id));
    // …and the lane gather itself used must land back on gather's own digest, which is what
    // proves the derivation is the SAME one and not merely a different one.
    expect(sig(other.id), 'drafting on gather\'s own lane produced a different digest — the row '
      + 'is not being derived from `version|lane|dominant`').toBe(other.provisionalSignature);
  });

  it('every one of the five lanes reaches the row — none is silently collapsed', async () => {
    const seen = new Map<FailureLane, string>();
    for (const lane of FAILURE_LANES) {
      const { id } = await draftOnLane(lane);
      const row = getReport(id);
      expect(row?.lane, `the row refused lane ${lane}`).toBe(lane);
      seen.set(lane, row!.signature);
    }
    // Five lanes, five digests. A collision here is the dedupe bucket collapse, in miniature.
    expect(new Set(seen.values()).size, `five lanes produced ${new Set(seen.values()).size} `
      + 'digests — distinct lanes over one dominant failure are still sharing a bucket').toBe(5);
  });
});

// ── 2. THE POSTED PAGE DOES NOT CONTRADICT ITSELF ────────────────────────────────────────

describe('the issue body says one thing about one report', () => {
  it('carries exactly ONE digest — trailer, telemetry block and all', async () => {
    const { id, provisionalSignature } = await draftOnLane('wrong-answer');
    const body = renderIssueBody(getReport(id)!);

    // Non-vacuity: the instrument has to be able to see a digest at all.
    const found = digestsIn(body);
    expect(found.length, 'no `ds1-` token in the rendered body — this clause is blind').toBeGreaterThan(0);
    expect(found, `the body carries ${found.length} different digests: ${found.join(', ')} — a `
      + 'reader cannot tell which half of one page is true').toHaveLength(1);
    expect(found[0]).toBe(getReport(id)!.signature);
    expect(body, 'the digest keyed on the provisional lane is still on the page')
      .not.toContain(provisionalSignature);
  });

  it('names the agent\'s lane in its header and in its attachment, once each', async () => {
    const { id } = await draftOnLane('permission');
    const body = renderIssueBody(getReport(id)!);
    expect(body).toContain('lane: `permission`');
    expect(body).toContain('"lane": "permission"');
    // The provisional lane must not appear as a lane statement anywhere on the page. (`other`
    // is a common English word, so the assertion is on the two RENDERED FORMS, not the word.)
    expect(body).not.toContain('lane: `other`');
    expect(body).not.toContain('"lane": "other"');
  });

  it('the trailer is the row\'s own column, not the attachment\'s copy of it', async () => {
    // A row whose attachment disagrees is only reachable by hand today, and that is exactly
    // why it is worth pinning WHICH of the two the trailer is rendered from: the row is the
    // value `post.ts` dedupes on, so the published trailer has to be that one.
    const r = createReport('agent-1', 'other', 'ds1-aaaaaaaaaaaa');
    attachDraft(r.id, {
      lane: 'silence', signature: 'ds1-bbbbbbbbbbbb', brief: BRIEF,
      telemetry: { report: { schema: 'dojo-telemetry-1', signature: 'ds1-cccccccccccc', lane: 'tool-error' } },
      bundlePath: '/tmp/never-opened/bundle.json',
    });
    const body = renderIssueBody(getReport(r.id)!);
    expect(body).toContain('dojo-sig: ds1-bbbbbbbbbbbb');
    expect(body).not.toContain('dojo-sig: ds1-aaaaaaaaaaaa');
    expect(body).toContain('lane: `silence`');
  });
});

// ── 3. THE DEDUPE KEY IS THE DRAFTED ONE ─────────────────────────────────────────────────

describe('the poster looks for the digest the agent\'s lane produced', () => {
  it('searches the tracker for the row\'s drafted digest, never gather\'s provisional one', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const { id, provisionalSignature } = await draftOnLane('wrong-answer');
    const drafted = getReport(id)!.signature;
    submitForApproval(id);
    approveOnce(id);

    const outcome = await postApprovedReport(id);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('created');

    const searches = calls.filter(c => c.url.includes('/search/issues'));
    expect(searches, 'the duplicate check never ran — the assertion below is blind').toHaveLength(1);
    const query = decodeURIComponent(searches[0].url);
    expect(query, 'the poster deduped on a digest the agent never chose')
      .toContain(drafted);
    expect(query, 'the poster is still deduping on gather\'s provisional digest, so the lane is '
      + 'dropped from the pinned sha256(version|lane|dominant) key')
      .not.toContain(provisionalSignature);
  });

  it('two lanes over one dominant failure produce two DIFFERENT searches', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const queries: string[] = [];
    for (const lane of ['wrong-answer', 'permission'] as FailureLane[]) {
      calls = [];
      const { id } = await draftOnLane(lane);
      submitForApproval(id);
      approveOnce(id);
      await postApprovedReport(id);
      const search = calls.find(c => c.url.includes('/search/issues'));
      expect(search, `no search ran for lane ${lane}`).toBeTruthy();
      queries.push(decodeURIComponent(search!.url));
    }
    expect(queries[0], 'both lanes searched for the same digest — one defect\'s two lanes still '
      + 'share one bucket on the tracker').not.toBe(queries[1]);
  });
});

// ── 4. THE NEW COLUMNS OBEY THE OLD GUARD (contract C2) ──────────────────────────────────

describe('the identity is as frozen as the text is', () => {
  it('refuses to move the lane or the digest once a human is looking at the row', async () => {
    const { id } = await draftOnLane('wrong-answer');
    const before = getReport(id)!;
    expect(submitForApproval(id)?.status).toBe('awaiting_approval');

    // `attachDraft` is legal only from `drafting`. The text was already frozen there; the lane
    // and the digest now ride the same guard, because the owner reads both on the card.
    expect(attachDraft(id, {
      lane: 'silence', signature: 'ds1-000000000000', brief: BRIEF,
      telemetry: {}, bundlePath: '/tmp/z/b.json',
    }), 'a second draft was accepted on a row awaiting its owner').toBeNull();

    const after = getReport(id)!;
    expect(after.lane).toBe(before.lane);
    expect(after.signature).toBe(before.signature);
  });

  it('refuses a lane outside the closed set, and leaves the row alone', async () => {
    const { id } = await draftOnLane('wrong-answer');
    const before = getReport(id)!;
    // A row still `drafting` would accept the write, so the refusal has to come from the door.
    const r = createReport('agent-1', 'other', 'ds1-dddddddddddd');
    expect(() => attachDraft(r.id, {
      lane: 'sideways' as FailureLane, signature: 'ds1-eeeeeeeeeeee', brief: BRIEF,
      telemetry: {}, bundlePath: '/tmp/z/b.json',
    })).toThrow(/not a failure lane/);
    expect(getReport(r.id)?.lane, 'a refused lane still reached the column').toBe('other');
    expect(getReport(r.id)?.brief, 'a refused lane still wrote the brief').toBeNull();
    expect(getReport(id)!.signature).toBe(before.signature);
  });
});
