// ════════════════════════════════════════════════════════════════════════════════════════
// GITHUB DROPS THE LABELS WITHOUT SAYING SO, AND THE PLATFORM MEASURES IT (T8 LIVE, D-B).
//
// ── WHAT WAS MEASURED, AND WHAT IT OVERTURNS ──
// On 2026-09-26 the platform posted report `9489b6ff-…` to the scratch tracker. It sent
// `{title, body, labels:["dojo-report","v0.0.0"]}`. GitHub answered **201**. The created issue
// has **NO LABELS**. `labelsDropped` was `null`, no warn line was written, and the card showed a
// clean delivery. GitHub's REST reference for *Create an issue* says why, in its own words:
//
//   "Only users with push access can set labels for new issues. Labels are silently dropped
//    otherwise."
//
// Three things follow, and all three were wrong in the tree before this file:
//
//   1. **THE BEST-EFFORT RETRY HAS NEVER FIRED.** It triggers on 403/422, and the case it was
//      written for does not refuse — it succeeds and discards. `grep` over the whole live log
//      and its rotation for either of its sentences returns 0, including for the owner's own
//      issue #3, whose empty labels an earlier hand-off attributed to the retry firing. **That
//      claim is WITHDRAWN.** It did not fire; GitHub took the labelled request and dropped the
//      labels, exactly as it did for #4.
//   2. **THE OWNER WAS TOLD NOTHING.** `labelsDropped` was the only channel for "your issue is
//      missing its labels" and it was null on the one path that actually loses them.
//   3. **LABEL-BASED TRIAGE SILENTLY MISSES EVERY OUTSIDE REPORT.** Every report filed by a
//      non-collaborator — i.e. every ordinary user filing against `d-cornerpin/dojo` — arrives
//      unlabelled. A `dojo-report` label sweep finds none of them. SEARCHING THE `dojo-sig:`
//      TRAILER DOES, because the trailer is in the body GitHub accepted in full.
//
// ── WHY A READ-BACK AND NOT THE CREATE ANSWER'S OWN `labels` FIELD ──
// GitHub's 201 body is the created issue and very probably carries the drop already. NOBODY
// CAPTURED IT. Building the branch on an uncaptured response body is precisely the mistake that
// produced the withdrawn claim above — a mechanism inferred from a status code with the body
// thrown away — so this asks the question out loud instead: one authenticated GET of the issue
// that was just created, whose answer for the live issue #4 is `"labels": []`, re-read
// unauthenticated on 2026-09-25 to confirm the field and its shape.
//
// ── AND THE RETRY SURVIVES, DEMOTED ──
// Its trigger is not a case proven impossible; it is a case whose CAUSE is unknown. The owner
// met a real 403 on a labelled create at 00:24:13Z and its body was never read. Deleting the
// one branch that turns that 403 into a delivered report, on the evidence that it has not fired
// since, would be confusing "has not happened lately" with "cannot happen". What the
// measurement DOES buy is that the retry is no longer the platform's account of a missing
// label: this file is. Held below — the retry arm performs no read-back, because the request it
// succeeded with sent no labels to read back.
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
  getDbPath: () => p.join(os.tmpdir(), 'dojo-t8-dropped-labels', 'dojo.db'),
}));

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
import { DOJO_REPORT_REPO_DEFAULT } from '../../report/repo.js';

/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';
const SIGNATURE = 'ds1-abcdef123456';
const BRIEF: ReportBrief = {
  title: 'A staged sub-agent was granted a task it had no tool group to perform',
  whatHappened: 'The tool door refused the call and the turn ended.',
  whatShouldHaveHappened: 'The capability should have been checked at assignment time.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Check the grant when the task is assigned, not when the tool is called.',
};
const TELEMETRY = {
  report: { schema: 'dojo-telemetry-1', signature: SIGNATURE, lane: 'permission' },
  platform: { version: '3.1.28', os: 'darwin', node_major: 22 },
};
/** What `issueLabelsFor(reportVersion(row))` builds for the row above. Both labels. */
const SENT = ['dojo-report', 'v3.1.28'];
const NOT_ACCESSIBLE = 'Resource not accessible by personal access token';
const ISSUE = 12;

// ── the stubbed GitHub ───────────────────────────────────────────────────────────────────

interface RecordedCall { method: string; url: string; body: string; auth: string | null }
let calls: RecordedCall[] = [];
/** Answers handed to successive POSTs on `/issues`, in order. The LAST one repeats. */
let createAnswers: (() => Response)[] = [];
/** The answer to the READ-BACK of the created issue. */
let readBack: () => Response;
const realFetch = globalThis.fetch;

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const created = (n = ISSUE): Response =>
  jsonRes(201, { number: n, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/${n}` });
const refused = (status: number, message: string): Response => jsonRes(status, { message });
/** GitHub's Issue representation, labels as the objects the REST API really returns. */
const issueWithLabels = (names: string[]): Response =>
  jsonRes(200, { number: ISSUE, labels: names.map((name, id) => ({ id, name, color: 'ededed' })) });

/** Every POST to the creation endpoint, in order. */
const creates = (): RecordedCall[] =>
  calls.filter(c => c.method === 'POST' && /\/repos\/.+\/issues$/.test(c.url));
/** Every GET of one issue — the read-back. */
const reads = (): RecordedCall[] =>
  calls.filter(c => c.method === 'GET' && /\/repos\/.+\/issues\/\d+$/.test(c.url));
const payload = (n: number): Record<string, unknown> =>
  JSON.parse(creates()[n].body) as Record<string, unknown>;

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
    if (method === 'GET' && /\/repos\/.+\/issues\/\d+$/.test(url)) return readBack();
    const nth = creates().length - 1;
    return createAnswers[Math.min(nth, createAnswers.length - 1)]();
  }) as unknown as typeof fetch;
}

/** A report sitting exactly where the Post button finds it. */
function approvedReport(): string {
  const r = createReport('agent-1', 'permission', SIGNATURE);
  attachDraft(r.id, {
    lane: 'permission', signature: SIGNATURE, brief: BRIEF,
    telemetry: TELEMETRY, bundlePath: '/tmp/never-opened/bundle.json',
  });
  submitForApproval(r.id);
  approveOnce(r.id);
  return r.id;
}

/** The note the owner is shown, or null. Reading it off the real outcome, never off a stub. */
async function postAndNote(id: string): Promise<{ note: string | null; kind: string }> {
  const outcome = await postApprovedReport(id);
  return {
    kind: outcome.kind,
    note: outcome.kind === 'created' ? outcome.labelsDropped : null,
  };
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  calls = [];
  logLines.length = 0;
  createAnswers = [() => created()];
  readBack = () => issueWithLabels(SENT);   // the collaborator's case is the default
  installFetch();
  disconnectGithub();
  saveGithubAccount('octocat', TOKEN, 'public_repo');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

// ── 1. THE MEASURED DROP — the live case, on the wire shape it really had ─────────────────

describe('GitHub answers 201 and keeps none of the labels', () => {
  it('the report lands, and the owner is told WHICH labels did not survive', async () => {
    readBack = () => issueWithLabels([]);          // exactly what issue #4 answers
    const id = approvedReport();
    const { kind, note } = await postAndNote(id);

    // THE DELIVERY IS UNAFFECTED. Whatever is said about labels, the report posted.
    expect(kind, JSON.stringify(logLines)).toBe('created');
    expect(getReport(id)?.status).toBe('posted');
    expect(getReport(id)?.issueNumber).toBe(ISSUE);
    expect(creates(), 'a 201 was retried').toHaveLength(1);

    // AND THE SILENCE IS OVER. This is the assertion the defect was: `null` here.
    expect(note, 'GitHub kept no labels and the platform said nothing').toBeTruthy();
    for (const label of SENT) {
      expect(note, `the note does not name the dropped label ${label}`).toContain(label);
    }
    expect(note, 'the note does not say the report posted').toMatch(/posted/i);
    expect(note, 'the note does not name write access as GitHub\'s documented reason')
      .toMatch(/write access/i);
    expect(note, 'the note does not point triage at the trailer').toContain('dojo-sig');
  });

  it('...and the LOG carries the measurement: what was sent, what came back, what is missing', async () => {
    readBack = () => issueWithLabels([]);
    await postApprovedReport(approvedReport());
    const line = logLines.find(l => l.includes('silently dropped'));
    expect(line, `no measurement line in:\n${logLines.join('\n')}`).toBeTruthy();
    expect(line, 'the log does not record what was SENT').toContain('"sent":["dojo-report","v3.1.28"]');
    expect(line, 'the log does not record what GitHub KEPT').toContain('"kept":[]');
    expect(line, 'the log does not record the DIFFERENCE').toContain('"dropped":["dojo-report","v3.1.28"]');
    expect(line, 'the log does not name the issue the measurement is about').toContain(`"issueNumber":${ISSUE}`);
  });

  it('the read-back is ONE authenticated GET of the issue that was just created', async () => {
    readBack = () => issueWithLabels([]);
    await postApprovedReport(approvedReport());
    expect(reads(), 'the created issue was not read back exactly once').toHaveLength(1);
    expect(reads()[0].url).toBe(`https://api.github.com/repos/${DOJO_REPORT_REPO_DEFAULT}/issues/${ISSUE}`);
    expect(reads()[0].auth, 'the read-back went out without the credential').toBe(`Bearer ${TOKEN}`);
    // ORDER MATTERS: it reads an issue that exists, so it cannot precede the create.
    const order = calls.filter(c => /\/repos\/.+\/issues(\/\d+)?$/.test(c.url)).map(c => c.method);
    expect(order, 'the read-back did not follow the create').toEqual(['POST', 'GET']);
  });

  it('a PARTIAL drop names only what is actually missing', async () => {
    // The property is a DIFFERENCE, not a boolean. A version-filtered triage view loses this
    // report while a `dojo-report` sweep still finds it, and the sentence must say which.
    readBack = () => issueWithLabels(['dojo-report']);
    const { note } = await postAndNote(approvedReport());
    expect(note, 'a surviving label was reported as dropped').toBeTruthy();
    expect(note).toContain('v3.1.28');
    expect(note, 'the note claims `dojo-report` was dropped when GitHub kept it')
      .not.toMatch(/dropped[^.]*\bdojo-report\b/);
  });
});

// ── 2. THE CONTROL — labels that survive are not talked about ────────────────────────────

describe('a reporter GitHub accepts labels from is told nothing', () => {
  it('both labels come back, so there is no note and no log line', async () => {
    readBack = () => issueWithLabels(SENT);
    const id = approvedReport();
    const { kind, note } = await postAndNote(id);
    expect(kind).toBe('created');
    expect(getReport(id)?.status).toBe('posted');
    expect(note, 'a delivery that kept its labels reported dropping them').toBeNull();
    for (const line of logLines) {
      expect(line, `a clean delivery logged a dropped label: ${line}`).not.toContain('silently dropped');
    }
  });

  it('...even when GitHub answers labels as bare strings instead of objects', async () => {
    // GitHub's own schemas spell `labels` both ways depending on the endpoint. Reading only one
    // shape would report a full drop on every collaborator's issue — a false alarm on the
    // majority case, which is worse than the silence being fixed.
    readBack = () => jsonRes(200, { number: ISSUE, labels: SENT });
    expect((await postAndNote(approvedReport())).note).toBeNull();
  });
});

// ── 3. NO FABRICATION — a check that could not run claims nothing ────────────────────────

describe('a read-back that cannot be believed says nothing about labels', () => {
  for (const [label, answer] of [
    ['the issue read 404s', () => refused(404, 'Not Found')],
    ['GitHub 500s', () => refused(500, 'Server Error')],
    ['the body will not parse', () => new Response('<html>502</html>', { status: 200 })],
    ['`labels` is absent from the answer', () => jsonRes(200, { number: ISSUE })],
    ['`labels` is not an array', () => jsonRes(200, { number: ISSUE, labels: 'dojo-report' })],
  ] as [string, () => Response][]) {
    it(`${label}: the report still posted, and nothing is claimed`, async () => {
      readBack = answer;
      const id = approvedReport();
      const { kind, note } = await postAndNote(id);

      // THE DELIVERY MUST NOT DEPEND ON THE CHECK. A failed read-back turning a posted report
      // into a failure would be a strictly worse defect than the silence this replaces.
      expect(kind, `${label}: a failed read-back broke the delivery`).toBe('created');
      expect(getReport(id)?.status).toBe('posted');
      expect(getReport(id)?.issueUrl).toBeTruthy();

      // AND NOTHING IS INVENTED: no measurement means no claim, in either direction.
      expect(note, `${label}: a label drop was reported without being measured`).toBeNull();
      for (const line of logLines) {
        expect(line, `${label}: an unmeasured drop was logged as measured: ${line}`)
          .not.toContain('silently dropped');
      }
      // …but the fact that it could not be checked IS recorded. Silence about the silence is
      // how this defect existed in the first place.
      expect(logLines.some(l => l.includes('could not read the labels back')),
        `${label}: the unusable read-back left no trace:\n${logLines.join('\n')}`).toBe(true);
    });

    it(`${label}: and the owner's connection is NOT flagged broken`, async () => {
      // The WRITE succeeded, so the credential works. `looksLikeAuthFailure` reads the ledger to
      // decide whether to tell the owner to reconnect, and a read of our own issue failing after
      // a successful post is the false YES the T5 fix round was spent on.
      readBack = answer;
      await postApprovedReport(approvedReport());
      const status = githubStatus();
      expect(status.connected).toBe(true);
      expect(status.reauthRequired, `${label}: a posted report left the owner told to reconnect`)
        .toBe(false);
      expect(status.lastError, `${label}: a read-back failure was recorded as the connection's `
        + 'last outcome, although the post succeeded').toBeNull();
      expect(status.lastOkAt).toBeTruthy();
    });
  }
});

// ── 4. NOTHING IS READ BACK WHEN NOTHING WAS SENT ────────────────────────────────────────

describe('the read-back exists only where labels were actually asked for', () => {
  it('the retry arm reads nothing back — its successful request carried no labels', async () => {
    // The retry's own sentence is a controlled experiment and stays exactly as it was. What it
    // must NOT do is pick up a second, contradictory account of the same labels from a
    // read-back of an issue that was deliberately filed without them.
    createAnswers = [() => refused(403, NOT_ACCESSIBLE), () => created(ISSUE)];
    readBack = () => issueWithLabels([]);
    const { kind, note } = await postAndNote(approvedReport());
    expect(kind).toBe('created');
    expect(creates(), 'the bounded retry moved').toHaveLength(2);
    expect(reads(), 'an issue filed with no labels was read back for its labels').toHaveLength(0);
    expect(note, 'the retry stopped explaining itself').toContain('refused the labelled version');
    expect(note, 'the retry\'s sentence was overwritten by the read-back\'s')
      .not.toMatch(/write access/i);
  });

  it('`createIssue` with an empty label list reads nothing back (the direct control)', async () => {
    const { createIssue } = await import('../issues.js');
    readBack = () => issueWithLabels([]);
    const result = await createIssue(DOJO_REPORT_REPO_DEFAULT, 't', 'b', []);
    expect(result.ok).toBe(true);
    expect(reads(), 'a call that sent no labels asked GitHub which labels it kept').toHaveLength(0);
    expect(result.ok && result.labelsDropped).toBeNull();
  });

  it('a create GitHub REFUSES outright reads nothing back', async () => {
    createAnswers = [() => refused(410, 'Issues are disabled for this repository.')];
    readBack = () => issueWithLabels([]);
    const id = approvedReport();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    expect(reads(), 'an issue that was never created was read back').toHaveLength(0);
    expect(getReport(id)?.status).toBe('approved');
  });
});

// ── 5. TRIAGE DOES NOT DEPEND ON THE LABELS ──────────────────────────────────────────────

describe('an unlabelled issue is still findable, by the trailer in its body', () => {
  it('the body GitHub accepted carries the digest a search finds it by', async () => {
    readBack = () => issueWithLabels([]);
    const id = approvedReport();
    await postApprovedReport(id);
    const body = String(payload(0).body);
    // The label sweep found nothing; this is what does. Same digest `findIssueBySignature`
    // searches for, so the dedupe and the triage habit read the same key.
    expect(body).toContain(`dojo-sig: ${SIGNATURE}`);
    expect(body).toContain('dojo-report-id: ');
    expect(String(payload(0).title)).toContain('[dojo-report]');
    expect(getReport(id)?.signature, 'the row and the published trailer disagree').toBe(SIGNATURE);
  });
});

// ── 6. THE CREDENTIAL, OVER THE NEW SURFACE ──────────────────────────────────────────────

describe('nothing on the read-back path can print the credential', () => {
  it('no log line and no owner sentence carries the token', async () => {
    const scripts: [string, () => Response][] = [
      ['all labels dropped', () => issueWithLabels([])],
      ['labels kept', () => issueWithLabels(SENT)],
      ['read-back refused', () => refused(403, NOT_ACCESSIBLE)],
    ];
    for (const [label, answer] of scripts) {
      calls = [];
      logLines.length = 0;
      readBack = answer;
      // Non-vacuity: the token really is the sealed value, and the read-back really happened.
      expect(getGithubToken(), `${label}: the fixture token is not the sealed one`).toBe(TOKEN);
      const { note } = await postAndNote(approvedReport());
      expect(reads().length, `${label}: no read-back was performed, so nothing was swept`).toBe(1);
      for (const line of logLines) {
        expect(line, `${label}: a log line carried the token`).not.toContain(TOKEN);
      }
      expect(note ?? '', `${label}: the owner-facing sentence carried the token`).not.toContain(TOKEN);
      expect(githubStatus().lastError ?? '', `${label}: the ledger carried the token`)
        .not.toContain(TOKEN);
    }
  });
});
