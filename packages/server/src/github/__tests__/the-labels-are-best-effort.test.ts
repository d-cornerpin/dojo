// ════════════════════════════════════════════════════════════════════════════════════════
// AN OUTSIDE USER CAN FILE A REPORT (DOJO-REPORT T8 fix round).
//
// ── THE DEFECT, AND WHY IT IS A RELEASE BLOCKER RATHER THAN A DEV-BOX ACCIDENT ──
// GitHub needs WRITE access to the repository to set `labels` on a new issue. It needs nothing at
// all to OPEN one on a public repository. `post.ts` always passes labels and the list is never
// empty — it always contains `dojo-report` — so the request `createIssue` sent was one that only
// a collaborator on the destination repository could make.
//
// The owner met it live. 00:24Z, 2026-09-26: connected as `dcliff9`, filing against
// `d-cornerpin/dojo-report-live-test`, which `d-cornerpin` owns and on which `dcliff9` holds
// `pull` only. HTTP 403, nothing posted, one sentence in the log. And every ordinary user of a
// shipped Dojo stands in exactly that relation to `d-cornerpin/dojo`: a reporting feature only
// its own maintainers can use is not a reporting feature.
//
// ── WHAT IS DRIVEN HERE, AND WHY IT IS THE REAL POSTER ──
// Every clause below goes through `postApprovedReport` — the function the owner's Post button
// reaches — rather than `createIssue` alone. The label list is built inside the poster
// (`issueLabelsFor(reportVersion(row))`), the body it sends is the one the owner approved, and the
// row transition is part of the property: "the report landed" is a claim about the DATABASE and
// the tracker, not about a return value.
//
// ── THE FOUR BRANCHES, EACH WITH ITS CONTROL ──
//   1. 201 first time              → ONE call, labels sent, nothing said about labels.
//   2. 403/422 with labels sent    → TWO calls, the second carrying no `labels` KEY, the issue
//                                    posted, and a sentence that names the labels, the status and
//                                    GitHub's own words.
//   3. 403 that a smaller request cannot survive → TWO calls, then an HONEST failure carrying
//                                    GitHub's sentence, the row NOT posted, and nothing anywhere
//                                    claiming a label was dropped.
//   4. no labels to drop, or a status that is not about a field → ONE call, honest failure.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import p from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('no test database');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => p.join(os.tmpdir(), 'dojo-t8-labels', 'dojo.db'),
}));

// The emitted log lines, captured so the leak sweep can read every one of them.
const logLines: string[] = [];
vi.mock('../../logger.js', () => ({
  createLogger: (component: string) => {
    const write = (level: string) => (message: string, meta?: unknown) => {
      logLines.push(`${level} ${component}: ${message} ${meta === undefined ? '' : JSON.stringify(meta)}`);
    };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
  },
}));

import { runMigrations } from '../../db/migrations.js';
import {
  createReport, attachDraft, submitForApproval, approveOnce, getReport, type ReportBrief,
} from '../../report/store.js';
import { saveGithubAccount, disconnectGithub, getGithubToken } from '../account.js';
import { githubStatus } from '../status.js';
import { postApprovedReport } from '../../report/post.js';
import { renderIssueBody } from '../../report/issue-body.js';
import { REPORT_ISSUE_LABELS } from '../../report/issue-body.js';
import { DOJO_REPORT_REPO_DEFAULT } from '../../report/repo.js';

/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';
const SIGNATURE = 'ds1-abcdef123456';
const BRIEF: ReportBrief = {
  title: 'work_open refused a task the engine had just demanded',
  whatHappened: 'The tool door refused the call and the turn ended.',
  whatShouldHaveHappened: 'The call should have opened a task.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Add the label to the creation default.',
};
const TELEMETRY = {
  report: { schema: 'dojo-telemetry-1', signature: SIGNATURE, lane: 'tool-error' },
  platform: { version: '3.1.28', os: 'darwin', node_major: 22 },
};

/** GitHub's real sentence for a permission it will not grant, as its docs spell it. */
const NOT_ACCESSIBLE = 'Resource not accessible by personal access token';
/** GitHub's 422 shape when it will not validate a field. */
const VALIDATION_FAILED = 'Validation Failed';

// ── the stubbed GitHub ───────────────────────────────────────────────────────────────────

interface RecordedCall { method: string; url: string; body: string; auth: string | null }
let calls: RecordedCall[] = [];
/** Answers handed out to successive POSTs on `/issues`, in order. The LAST one repeats. */
let createAnswers: (() => Response)[] = [];
const realFetch = globalThis.fetch;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const created = (n = 7): Response =>
  jsonRes(201, { number: n, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/${n}` });
const refused = (status: number, message: string): Response =>
  jsonRes(status, { message, documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue' });

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method, url,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.Authorization ?? headers.authorization ?? null,
    });
    if (url.includes('/search/issues')) return jsonRes(200, { items: [] });
    // ── THE READ-BACK OF A CREATED ISSUE (added with the silent-drop round, D-B) ──
    // THIS FILE'S PREMISE IS A REPORTER WHOSE LABELS SURVIVE, so the issue comes back carrying
    // exactly what the accepted request asked for. Modelling it matters: without this branch the
    // stub answers a create body to a GET, the read-back finds no `labels` array and correctly
    // logs that it could not tell — a fact about the STUB, not about GitHub, which would then be
    // read as noise on the clean arm below. The DROP is another file's property
    // (`a-label-github-silently-dropped-is-measured-and-said.test.ts`); here it must not happen.
    if (method === 'GET' && /\/repos\/.+\/issues\/\d+$/.test(url)) {
      const last = creates().at(-1);
      const asked = last ? ((JSON.parse(last.body) as { labels?: string[] }).labels ?? []) : [];
      return jsonRes(200, { number: 7, labels: asked.map((name, id) => ({ id, name })) });
    }
    const nth = creates().length - 1;
    const answer = createAnswers[Math.min(nth, createAnswers.length - 1)];
    return answer();
  }) as unknown as typeof fetch;
}

/** Every POST to the issue-creation endpoint, in order. The instrument the counts are read from. */
const creates = (): RecordedCall[] =>
  calls.filter(c => c.method === 'POST' && /\/repos\/.+\/issues$/.test(c.url));

/** The parsed payload of the nth create. */
const payload = (n: number): Record<string, unknown> =>
  JSON.parse(creates()[n].body) as Record<string, unknown>;

/** A report sitting exactly where the Post button finds it. */
function approvedReport(): string {
  const r = createReport('agent-1', 'tool-error', SIGNATURE);
  attachDraft(r.id, {
    lane: 'tool-error', signature: SIGNATURE, brief: BRIEF,
    telemetry: TELEMETRY, bundlePath: '/tmp/never-opened/bundle.json',
  });
  submitForApproval(r.id);
  approveOnce(r.id);
  return r.id;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  calls = [];
  logLines.length = 0;
  createAnswers = [() => created()];
  installFetch();
  disconnectGithub();
  saveGithubAccount('octocat', TOKEN, 'public_repo');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

// ── 1. THE LABELLED PATH IS UNTOUCHED (the control that stops this being a deletion) ─────

describe('a reporter GitHub accepts labels from is unaffected', () => {
  it('files once, with the labels, and says nothing about labels', async () => {
    const id = approvedReport();
    const outcome = await postApprovedReport(id);

    expect(outcome.kind, JSON.stringify(outcome)).toBe('created');
    expect(creates(), 'a second create was attempted on a call GitHub had already accepted')
      .toHaveLength(1);
    expect(payload(0).labels, 'the labelled request stopped carrying its labels')
      .toEqual([...REPORT_ISSUE_LABELS, 'v3.1.28']);
    expect(outcome.kind === 'created' && outcome.labelsDropped,
      'a delivery that kept its labels still reported dropping them').toBeNull();
    expect(getReport(id)?.status).toBe('posted');
    expect(getReport(id)?.issueNumber).toBe(7);
  });
});

// ── 2. THE 403/422 ON LABELS — THE REPORT GETS OUT ───────────────────────────────────────

describe('a refusal that is about the labels costs the labels, not the report', () => {
  for (const [label, first] of [
    ['403, GitHub\'s own permission sentence', () => refused(403, NOT_ACCESSIBLE)],
    ['422, the validation shape', () => refused(422, VALIDATION_FAILED)],
    ['403 with no readable body at all', () => new Response('', { status: 403 })],
  ] as [string, () => Response][]) {
    it(`${label}: posts UNLABELLED and says so`, async () => {
      createAnswers = [first, () => created(12)];
      const id = approvedReport();
      const outcome = await postApprovedReport(id);

      // THE REPORT LANDED. This is the whole point, and it is asserted on the row as well as
      // on the return value: an outcome nobody recorded is not a delivery.
      expect(outcome.kind, JSON.stringify(outcome)).toBe('created');
      expect(getReport(id)?.status).toBe('posted');
      expect(getReport(id)?.issueNumber).toBe(12);

      // EXACTLY TWO ATTEMPTS. One retry, never a loop (NO-DOOMED-DIALS P3: the next attempt
      // after this is a human pressing Post again).
      expect(creates(), 'the retry is not bounded at one').toHaveLength(2);

      // THE SECOND REQUEST ASKS FOR LESS, AND ASKS FOR NOTHING IT MAY NOT HAVE. `labels` is
      // ABSENT, not `[]` — an empty array is still an instruction to set this issue's labels.
      expect(payload(0)).toHaveProperty('labels');
      expect(Object.keys(payload(1)), 'the second attempt still named `labels`')
        .not.toContain('labels');
      // …and it is the SAME REPORT. A retry that re-rendered or trimmed the body would publish
      // something the owner never read (D4).
      expect(payload(1).title).toBe(payload(0).title);
      expect(payload(1).body).toBe(payload(0).body);
      expect(payload(1).body).toBe(renderIssueBody(getReport(id)!));
    });
  }

  it('the sentence names the labels, the status, and GitHub\'s own words', async () => {
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(12)];
    const outcome = await postApprovedReport(approvedReport());
    expect(outcome.kind).toBe('created');
    const note = outcome.kind === 'created' ? outcome.labelsDropped : null;
    expect(note, 'the labels vanished and the owner was told nothing').toBeTruthy();
    expect(note).toContain('dojo-report');
    expect(note).toContain('v3.1.28');
    expect(note).toContain('403');
    expect(note, 'GitHub explained itself and the sentence dropped it').toContain(NOT_ACCESSIBLE);
    // It reports the EXPERIMENT. Both halves have to be in the sentence or it is a guess.
    expect(note).toContain('refused the labelled version');
    expect(note).toContain('accepted the same issue with the labels removed');
  });

  it('...and the LOG carries GitHub\'s explanation of the first refusal, not only the second', async () => {
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(12)];
    await postApprovedReport(approvedReport());
    const retryLine = logLines.find(l => l.includes('asking again with no labels'));
    expect(retryLine, `no retry line in:\n${logLines.join('\n')}`).toBeTruthy();
    expect(retryLine, 'the refusal that caused the retry was logged without GitHub\'s words')
      .toContain(NOT_ACCESSIBLE);
    expect(retryLine, 'the log does not say which labels were dropped').toContain('dojo-report');
    // The delivery itself is logged too, with the issue number that proves it landed.
    const dropped = logLines.find(l => l.includes('filed without its labels'));
    expect(dropped, 'nothing recorded that a delivered report is missing its labels').toBeTruthy();
    expect(dropped).toContain('"issueNumber":12');
  });

  it('leaves the connection ledger CLEAN — a successful post is not a broken credential', async () => {
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(12)];
    await postApprovedReport(approvedReport());
    const status = githubStatus();
    expect(status.connected).toBe(true);
    expect(status.reauthRequired, 'a report that POSTED left the owner being told to reconnect')
      .toBe(false);
    expect(status.lastError, 'the refused first attempt was recorded as the connection\'s last '
      + 'outcome, although the second attempt succeeded').toBeNull();
    expect(status.lastOkAt).toBeTruthy();
  });

  it('an unlabelled issue is still triageable — the trailer is in the body GitHub accepted', async () => {
    // This is the clause that makes dropping the labels acceptable rather than merely possible.
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(12)];
    await postApprovedReport(approvedReport());
    const body = String(payload(1).body);
    // Everything triage keys on rides the BODY, which GitHub accepted in full: the digest the
    // duplicate check searches for, the lane, the report id and the version. The labels were
    // convenience; none of this was.
    expect(body).toContain(`dojo-sig: ${SIGNATURE}`);
    expect(body).toContain('lane: `tool-error`');
    expect(body).toContain('dojo-report-id: ');
    expect(body).toContain('dojo-version: 3.1.28');
    // …and the ISSUE TITLE still carries the tag a label-less tracker can filter on.
    expect(String(payload(1).title)).toContain('[dojo-report]');
  });
});

// ── 3. A REFUSAL THAT IS NOT ABOUT THE LABELS STILL FAILS HONESTLY ───────────────────────

describe('the retry cannot turn a real refusal into a success', () => {
  it('both attempts refused: the report is NOT posted and nothing claims a label was dropped', async () => {
    createAnswers = [() => refused(403, 'Repository was archived so is read-only.')];
    const id = approvedReport();
    const outcome = await postApprovedReport(id);

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error, 'the owner was not told what GitHub said')
      .toContain('Repository was archived');
    expect(creates(), 'the bounded retry became a loop').toHaveLength(2);
    // The row is left exactly where the poster found it. The route hands the approval back.
    expect(getReport(id)?.status).toBe('approved');
    expect(getReport(id)?.issueUrl).toBeNull();
    // No half-truth anywhere: nothing was filed, so nothing was filed without labels.
    for (const line of logLines) {
      expect(line, `a failed post logged a dropped label: ${line}`)
        .not.toContain('filed without its labels');
    }
    // …and the ledger records the failure, because this time there was one.
    expect(githubStatus().lastError).toBeTruthy();
  });

  it('the sentence is the answer to the SMALLEST request, so it cannot be blamed on labels', async () => {
    // First 403 mentions labels; the second names the real obstacle. The owner must be told the
    // second one — it is the refusal of a request that asked for nothing optional.
    createAnswers = [
      () => refused(403, 'You do not have permission to set labels here.'),
      () => refused(403, 'Issues are disabled for this repository.'),
    ];
    const outcome = await postApprovedReport(approvedReport());
    expect(outcome.kind).toBe('failed');
    const error = outcome.kind === 'failed' ? outcome.error : '';
    expect(error).toContain('Issues are disabled for this repository.');
    expect(error, 'the owner was pointed at the labels when the labels were not the problem')
      .not.toContain('permission to set labels here');
  });
});

// ── 4. THE NARROWING — WHAT NEVER RETRIES AT ALL ─────────────────────────────────────────

describe('the second attempt only exists when there is something to drop', () => {
  it('a report with NO version label to drop still retries, because `dojo-report` is always sent', async () => {
    // Non-vacuity for the clause below: the label list is never empty by construction, so
    // "labels.length === 0" is not reachable through the poster. Proven, not assumed.
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(12)];
    const r = createReport('agent-1', 'other', SIGNATURE);
    attachDraft(r.id, {
      lane: 'other', signature: SIGNATURE, brief: BRIEF,
      // No `platform.version` at all → `issueLabelsFor` drops the version label.
      telemetry: { report: { schema: 'dojo-telemetry-1' } },
      bundlePath: '/tmp/never-opened/bundle.json',
    });
    submitForApproval(r.id);
    approveOnce(r.id);
    await postApprovedReport(r.id);
    expect(payload(0).labels).toEqual([...REPORT_ISSUE_LABELS]);
    expect(creates()).toHaveLength(2);
  });

  it('a status that is not about a field performs ONE call and fails', async () => {
    for (const status of [500, 502, 404, 410, 429]) {
      calls = [];
      createAnswers = [() => refused(status, `GitHub answered ${status}.`)];
      const id = approvedReport();
      const outcome = await postApprovedReport(id);
      expect(outcome.kind, `HTTP ${status}`).toBe('failed');
      expect(creates(), `HTTP ${status} was retried without labels — only a refusal of a FIELD `
        + 'can be survived by dropping that field').toHaveLength(1);
      expect(getReport(id)?.status).toBe('approved');
    }
  });

  it('`createIssue` with an empty label list retries nothing (the direct control)', async () => {
    // Reached directly, because the poster cannot produce an empty list. This is the branch
    // that makes "labels were actually sent" a real condition rather than a comment.
    const { createIssue } = await import('../issues.js');
    createAnswers = [() => refused(403, NOT_ACCESSIBLE)];
    const result = await createIssue(DOJO_REPORT_REPO_DEFAULT, 't', 'b', []);
    expect(result.ok).toBe(false);
    expect(creates(), 'a call that sent no labels asked again anyway').toHaveLength(1);
    expect(Object.keys(payload(0)), 'an empty label list was still sent as a `labels` instruction')
      .not.toContain('labels');
  });
});

// ── 5. THE TOKEN, OVER EVERY NEW SURFACE ─────────────────────────────────────────────────

describe('nothing on the label path can print the credential', () => {
  it('no log line, no owner sentence and no ledger column carries the token', async () => {
    // ⚠ THE NON-VACUITY BOUND IS PER-ARM, and the third arm is why. A post GitHub accepts first
    // time emits NO log line at all — correctly; there is nothing to report — so a blanket
    // `logLines.length > 0` would have failed on the one arm whose silence is the design. The
    // arms that refuse MUST speak, and the clean arm must be seen to have nothing to sweep, which
    // is a property in its own right rather than a hole in this one.
    const scripts: [string, (() => Response)[], boolean][] = [
      ['labels dropped, then posted', [() => refused(403, NOT_ACCESSIBLE), () => created(12)], true],
      ['both attempts refused', [() => refused(403, 'Repository was archived so is read-only.')], true],
      ['accepted first time', [() => created()], false],
    ];
    for (const [label, answers, speaks] of scripts) {
      calls = [];
      logLines.length = 0;
      createAnswers = answers;
      // Non-vacuity, both halves: the token IS the sealed value, and lines WERE emitted on
      // every arm that has something to say.
      expect(getGithubToken(), `${label}: the fixture token is not the sealed one`).toBe(TOKEN);
      const outcome = await postApprovedReport(approvedReport());
      expect(logLines.length > 0, `${label}: expected ${speaks ? 'log lines' : 'silence'}, `
        + `got ${logLines.length} line(s)`).toBe(speaks);
      for (const line of logLines) {
        expect(line, `${label}: a log line carried the token`).not.toContain(TOKEN);
      }
      const owner = outcome.kind === 'failed'
        ? outcome.error
        : (outcome.kind === 'created' ? outcome.labelsDropped ?? '' : '');
      expect(owner, `${label}: the owner-facing sentence carried the token`).not.toContain(TOKEN);
      expect(githubStatus().lastError ?? '', `${label}: the ledger carried the token`)
        .not.toContain(TOKEN);
    }
  });
});
