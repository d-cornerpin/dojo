// ════════════════════════════════════════════════════════════════════════════════════════
// A MATCHING ISSUE GETS A COMMENT, NOT A DUPLICATE (DOJO-REPORT T7).
//
// ── WHAT THIS FILE HOLDS, AND WHY EACH PART IS SEPARABLE ──
//
//   1. NOTHING LEAVES WITHOUT A CONSUMED APPROVAL. `postApprovedReport` refuses every status
//      but `approved`, and the refusal is measured as ZERO NETWORK CALLS — not as a returned
//      error. An error that arrives after the issue is filed is not a refusal.
//
//   2. THE SEARCH IS A GATE, NOT A COURTESY. A search that fails is never a reason to post
//      anyway: on a 500, a rate limit or a dead socket the answer is `failed`, the row keeps
//      its approval, and NO POST HAPPENS. The reverse — "we could not check, so we filed a
//      second copy" — is how one defect becomes nine issues on a public tracker.
//
//   3. A MATCH IS AN OFFER, NEVER AN ACTION. Finding an existing issue returns
//      `duplicate-found` and posts nothing at all: the owner chooses between adding to it and
//      filing separately, and both choices come back through the one door behind the Post
//      button. A platform that silently commented on someone else's issue would be publishing
//      the owner's words somewhere they never agreed to.
//
//   4. THE LEDGER TELLS THE TRUTH ABOUT THE CONNECTION (T4/T5's hand-off). A 401 writes a
//      failure the Settings card reads as "reconnect"; a comment that failed on issue #401
//      does NOT, because T5's predicate reads this column and an issue number is not a status
//      code. That is the one place this feature can make the Settings card lie.
//
//   5. THE BOX THAT MAY NOT SEND. `DOJO_DEV_BOX=1` refuses the real tracker at the wire, not
//      in the caller — so no amount of env manipulation between the check and the send can
//      file an issue on `d-cornerpin/dojo` from a development machine.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t7-poster', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  createReport, attachDraft, submitForApproval, approveOnce, cancelReport, getReport, markPosted,
  type ReportBrief,
} from '../../report/store.js';
import { saveGithubAccount, disconnectGithub, getGithubAccount } from '../account.js';
import { githubStatus } from '../status.js';
import { postApprovedReport } from '../../report/post.js';
import { renderIssueBody, renderIssueTitle } from '../../report/issue-body.js';
import { exportReport } from '../../report/export.js';
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

// ── the stubbed GitHub ───────────────────────────────────────────────────────────────────

interface RecordedCall { method: string; url: string; body: string; auth: string | null }
let calls: RecordedCall[] = [];
/** What the SEARCH endpoint answers. Replaced per clause. */
let searchAnswer: () => Response = () => jsonRes(200, { items: [] });
/** What a WRITE endpoint (issue create / issue comment) answers. */
let writeAnswer: () => Response = () => jsonRes(201, { number: 7, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/7` });

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.Authorization ?? headers.authorization ?? null,
    });
    return url.includes('/search/issues') ? searchAnswer() : writeAnswer();
  }) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
const writes = (): RecordedCall[] => calls.filter(c => c.method === 'POST');
const searches = (): RecordedCall[] => calls.filter(c => c.url.includes('/search/issues'));

const openIssue = (n: number, body: string): unknown => ({
  number: n, title: 'work_open refuses a granted category', state: 'open',
  html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/${n}`, body,
});

/** A report sitting exactly where the poster is allowed to find it. */
function approved(signature = SIGNATURE, brief: ReportBrief = BRIEF): string {
  const r = createReport('agent-1', 'tool-error', signature);
  attachDraft(r.id, brief, TELEMETRY, '/tmp/never-opened/bundle.json');
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
  searchAnswer = () => jsonRes(200, { items: [] });
  writeAnswer = () => jsonRes(201, {
    number: 7, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/7`,
  });
  installFetch();
  disconnectGithub();
  saveGithubAccount('octocat', TOKEN, 'public_repo');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
  delete process.env.DOJO_REPORT_REPO;
  delete process.env.DOJO_DEV_BOX;
});

// ── 1. NOTHING LEAVES WITHOUT A CONSUMED APPROVAL ───────────────────────────────────────

describe('the poster refuses everything that is not an approved report', () => {
  it('a report still awaiting its owner performs NO NETWORK CALL AT ALL', async () => {
    const r = createReport('agent-1', 'tool-error', SIGNATURE);
    attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    submitForApproval(r.id);

    const outcome = await postApprovedReport(r.id);
    expect(outcome.kind).toBe('failed');
    expect(calls, 'a report nobody approved reached the network').toEqual([]);
    expect(getReport(r.id)?.status).toBe('awaiting_approval');
  });

  it('a drafting, a cancelled, a posted and an unknown report all reach nothing', async () => {
    const drafting = createReport('agent-1', 'other', 'ds1-111111111111');
    attachDraft(drafting.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');

    const cancelled = createReport('agent-1', 'other', 'ds1-222222222222');
    attachDraft(cancelled.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    submitForApproval(cancelled.id);
    cancelReport(cancelled.id);

    const posted = approved('ds1-333333333333');
    markPosted(posted, 'https://example.invalid/1', 1);

    for (const id of [drafting.id, cancelled.id, posted, '00000000-0000-4000-8000-000000000000']) {
      const outcome = await postApprovedReport(id);
      expect(outcome.kind, `${id} was posted from a status the door does not serve`).toBe('failed');
    }
    expect(calls, 'a report the door does not serve reached the network').toEqual([]);
  });

  it('an unconnected box never reaches a write door, even on an approved report', async () => {
    disconnectGithub();
    const id = approved();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    expect(writes(), 'a box with no token tried to write to GitHub').toEqual([]);
    expect(getReport(id)?.status, 'the approval was spent with nothing delivered').toBe('approved');
  });
});

// ── 2. THE SEARCH IS A GATE ─────────────────────────────────────────────────────────────

describe('a search that fails stops the post — it never falls through', () => {
  it('a 500 from the search posts NOTHING and leaves the approval unspent', async () => {
    searchAnswer = () => jsonRes(500, { message: 'server error' });
    const id = approved();

    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    expect(writes(), 'the duplicate check failed and the report was filed anyway').toEqual([]);
    expect(getReport(id)?.status).toBe('approved');
    expect(getReport(id)?.issueUrl).toBeNull();
  });

  it('a dead socket on the search posts NOTHING', async () => {
    searchAnswer = () => { throw new Error('socket hang up'); };
    const id = approved();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    expect(writes()).toEqual([]);
  });

  it('a rate-limited search says so in the sentence the card shows', async () => {
    searchAnswer = () => jsonRes(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    const id = approved();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('rate-limiting');
      expect(outcome.error, 'a rate limit read as a broken connection').not.toContain('reconnect');
    }
    expect(writes()).toEqual([]);
    // A rate limit is not a credential problem, and the Settings card must not claim it is.
    expect(githubStatus().reauthRequired, 'a rate limit told the owner to reconnect').toBe(false);
  });

  it('searches for the bare signature, unauthenticated, oldest first', async () => {
    const id = approved();
    await postApprovedReport(id);
    expect(searches()).toHaveLength(1);
    const url = new URL(searches()[0].url);
    expect(url.origin + url.pathname).toBe('https://api.github.com/search/issues');
    expect(url.searchParams.get('q')).toBe(`repo:${DOJO_REPORT_REPO_DEFAULT} is:issue "${SIGNATURE}"`);
    expect(url.searchParams.get('order')).toBe('asc');
    expect(searches()[0].method).toBe('GET');
    expect(searches()[0].auth, 'the duplicate check is an UNAUTHENTICATED read (spec)').toBeNull();
  });
});

// ── 3. A MATCH IS AN OFFER, NEVER AN ACTION ─────────────────────────────────────────────

describe('a match is offered to the owner, and nothing is posted until they answer', () => {
  it('a match with no answer yields duplicate-found and performs NO POST', async () => {
    searchAnswer = () => jsonRes(200, { items: [openIssue(42, `dojo-sig: ${SIGNATURE}`)] });
    const id = approved();

    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('duplicate-found');
    if (outcome.kind === 'duplicate-found') {
      expect(outcome.match.number).toBe(42);
      expect(outcome.match.url).toContain('/issues/42');
      expect(outcome.match.title.length).toBeGreaterThan(0);
    }
    expect(writes(), 'a duplicate was filed while the owner was being asked').toEqual([]);
    expect(getReport(id)?.status, 'the approval was spent on a question').toBe('approved');
  });

  it('“add to it” comments on that issue and records the delivery against it', async () => {
    searchAnswer = () => jsonRes(200, { items: [openIssue(42, `dojo-sig: ${SIGNATURE}`)] });
    writeAnswer = () => jsonRes(201, { html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/42#issuecomment-9` });
    const id = approved();

    const outcome = await postApprovedReport(id, { addToExisting: 42 });
    expect(outcome.kind).toBe('commented');
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url).toBe(`https://api.github.com/repos/${DOJO_REPORT_REPO_DEFAULT}/issues/42/comments`);
    expect(writes()[0].auth, 'the comment went out unauthenticated').toContain(TOKEN);

    const row = getReport(id)!;
    expect(row.status).toBe('posted');
    expect(row.issueNumber).toBe(42);
    expect(row.issueUrl).toContain('/issues/42');
    // The comment carries the same body the issue would have carried — one renderer, one text.
    expect(JSON.parse(writes()[0].body).body).toBe(renderIssueBody(row));
  });

  it('“add to it” does not search at all — the owner already chose the issue', async () => {
    searchAnswer = () => { throw new Error('the poster searched when it had been told where to go'); };
    const id = approved();
    const outcome = await postApprovedReport(id, { addToExisting: 42 });
    expect(outcome.kind).toBe('commented');
    expect(searches()).toEqual([]);
  });

  it('“post separately” files its own issue even though a match exists', async () => {
    searchAnswer = () => jsonRes(200, { items: [openIssue(42, `dojo-sig: ${SIGNATURE}`)] });
    const id = approved();
    const outcome = await postApprovedReport(id, { postSeparately: true });
    expect(outcome.kind).toBe('created');
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url).toBe(`https://api.github.com/repos/${DOJO_REPORT_REPO_DEFAULT}/issues`);
    expect(getReport(id)?.issueNumber).toBe(7);
  });

  it('a CLOSED issue carrying the signature is not a match — the fix already shipped', async () => {
    searchAnswer = () => jsonRes(200, {
      items: [{ ...(openIssue(42, `dojo-sig: ${SIGNATURE}`) as object), state: 'closed' }],
    });
    const id = approved();
    expect((await postApprovedReport(id)).kind).toBe('created');
  });

  it('a hit whose body does NOT carry the signature is not a match', async () => {
    // GitHub's search tokenizer is fuzzy and the consequence of trusting it is the owner's
    // words appended to a stranger's issue. The body is re-read before anything is offered.
    searchAnswer = () => jsonRes(200, { items: [openIssue(42, 'a completely unrelated issue')] });
    const id = approved();
    expect((await postApprovedReport(id)).kind).toBe('created');
  });

  it('the OLDEST matching open issue wins, so every box converges on one thread', async () => {
    searchAnswer = () => jsonRes(200, {
      items: [
        { ...(openIssue(11, 'nothing here') as object) },
        openIssue(42, `dojo-sig: ${SIGNATURE}`),
        openIssue(99, `dojo-sig: ${SIGNATURE}`),
      ],
    });
    const id = approved();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('duplicate-found');
    if (outcome.kind === 'duplicate-found') expect(outcome.match.number).toBe(42);
  });
});

// ── the ordinary path ───────────────────────────────────────────────────────────────────

describe('no match files one issue, with the title, the labels and the body', () => {
  it('creates the issue, records it, and tells the card where it went', async () => {
    const id = approved();
    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('created');
    if (outcome.kind === 'created') {
      expect(outcome.issueNumber).toBe(7);
      expect(outcome.issueUrl).toContain('/issues/7');
    }

    expect(writes()).toHaveLength(1);
    const sent = JSON.parse(writes()[0].body) as { title: string; body: string; labels: string[] };
    const row = getReport(id)!;
    expect(sent.title).toBe(renderIssueTitle(BRIEF));
    expect(sent.labels).toEqual(['dojo-report', 'v3.1.28']);
    expect(sent.body).toBe(renderIssueBody(row));
    expect(row.status).toBe('posted');
    expect(row.issueNumber).toBe(7);
    expect(row.postedAt).toBeTruthy();
  });

  // ⚠ THE LABELS ARE PART OF "THE SAME DELIVERY", AND THEY HAD DRIFTED (final review, FR-6).
  //
  // D2's load-bearing word is SAME: the export is the identical report handed over by hand
  // instead of by token. The bytes were held from both ends and the labels were held from
  // neither — the poster sent `issueLabelsFor(reportVersion(row))` while the prefilled link
  // carried the literal `labels=dojo-report`, so every hand-pasted report arrived WITHOUT the
  // version label and vanished from version-filtered triage. The only clause over that line
  // was `toContain('labels=dojo-report')`, which is true of both spellings.
  //
  // This clause is the diff itself, driven through both doors for ONE row, so neither door can
  // be changed alone. It is deliberately not a comparison against a literal list: a literal
  // would be a third source of truth, and three copies drift faster than two.
  it('the labels on the prefilled link are the labels the poster sends, for the same row', async () => {
    const id = approved();
    const linked = new URL(exportReport(id)!.newIssueUrl).searchParams.get('labels');
    await postApprovedReport(id);
    const posted = (JSON.parse(writes()[0].body) as { labels: string[] }).labels;

    // Non-vacuity on both sides before they are compared: two empty label sets also match, and
    // the version label is the whole point — a report with no version label is the defect.
    expect(posted, 'the poster sent no labels at all — this comparison would prove nothing')
      .toContain('dojo-report');
    expect(posted.some(l => /^v\d/.test(l)), 'the fixture row carries no version label').toBe(true);
    expect(linked, 'the prefilled link carries no labels at all').not.toBeNull();
    expect(
      (linked ?? '').split(','),
      'the prefilled link and the posted issue no longer carry the same labels — a hand-pasted '
      + 'report will not show up in the triage filters a posted one does (D2: the SAME report)',
    ).toEqual(posted);
  });

  it('the bytes posted to GitHub are the bytes of the file an unconnected box writes', async () => {
    // D4 spans BOTH doors: the report an owner pastes by hand and the one the platform sends
    // are the same text, or the consent gate only covers one of them.
    const id = approved();
    await postApprovedReport(id);
    const posted = (JSON.parse(writes()[0].body) as { body: string }).body;
    const written = fs.readFileSync(exportReport(id)!.filePath, 'utf8');
    expect(written, 'the exported file and the posted issue have drifted').toBe(posted);
  });

  it('a second post on a delivered row is refused before the network', async () => {
    const id = approved();
    await postApprovedReport(id);
    calls = [];
    const again = await postApprovedReport(id);
    expect(again.kind).toBe('failed');
    expect(calls, 'a delivered report was posted a second time').toEqual([]);
    expect(getReport(id)?.issueNumber).toBe(7);
  });
});

// ── 4. THE LEDGER TELLS THE TRUTH ABOUT THE CONNECTION ──────────────────────────────────

describe('every real GitHub call is recorded as the connection\'s last live outcome', () => {
  it('a 401 on the create writes a failure the Settings card reads as “reconnect”', async () => {
    writeAnswer = () => jsonRes(401, { message: 'Bad credentials' });
    const id = approved();

    const outcome = await postApprovedReport(id);
    expect(outcome.kind).toBe('failed');
    expect(getGithubAccount()?.lastError, 'the failure was never recorded').toBeTruthy();
    expect(githubStatus().reauthRequired,
      'GitHub refused the credential and the card still shows a working connection').toBe(true);
    expect(getReport(id)?.status, 'the approval was spent on a refused call').toBe('approved');
  });

  it('a success clears the error and stamps the last-ok moment', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    mockDb.current!.prepare("UPDATE github_account SET last_error = 'Bad credentials', last_ok_at = NULL WHERE id = 1").run();
    expect(githubStatus().reauthRequired).toBe(true);

    await postApprovedReport(approved());
    expect(getGithubAccount()?.lastError).toBeNull();
    expect(getGithubAccount()?.lastOkAt).toBeTruthy();
    expect(githubStatus().reauthRequired).toBe(false);
  });

  it('a comment that fails on issue #401 does NOT read as a revoked credential', async () => {
    // T5's `looksLikeAuthFailure` reads this column, and issue numbers are this task's whole
    // domain. A failure sentence carrying an issue number would tell an owner whose connection
    // works perfectly to tear it down.
    writeAnswer = () => jsonRes(422, { message: 'Validation failed' });
    const id = approved();
    await postApprovedReport(id, { addToExisting: 401 });

    const recorded = getGithubAccount()?.lastError ?? '';
    expect(recorded.length, 'the failure was never recorded').toBeGreaterThan(0);
    expect(recorded, 'the ledger line carries an issue number').not.toContain('401');
    expect(githubStatus().reauthRequired,
      'a failed comment on issue #401 was read as a revoked credential').toBe(false);
  });
});

// ── 5. THE BOX THAT MAY NOT SEND ────────────────────────────────────────────────────────

describe('a development box cannot file an issue on the real tracker', () => {
  it('refuses at the wire, posts nothing, and keeps the report deliverable', async () => {
    process.env.DOJO_DEV_BOX = '1';
    vi.resetModules();
    const post = await import('../../report/post.js');
    const store = await import('../../report/store.js');

    const r = store.createReport('agent-1', 'tool-error', SIGNATURE);
    store.attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    store.submitForApproval(r.id);
    store.approveOnce(r.id);

    const outcome = await post.postApprovedReport(r.id);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.error).toContain('DOJO_DEV_BOX');
    expect(writes(), 'a dev box filed an issue on the real tracker').toEqual([]);
    expect(store.getReport(r.id)?.status).toBe('approved');
  });

  it('...and cannot be unlocked by clearing the flag between the check and the send', async () => {
    process.env.DOJO_DEV_BOX = '1';
    vi.resetModules();
    const post = await import('../../report/post.js');
    const store = await import('../../report/store.js');
    const r = store.createReport('agent-1', 'tool-error', SIGNATURE);
    store.attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    store.submitForApproval(r.id);
    store.approveOnce(r.id);

    // The search answers, and the answer handler clears the flag — the widest window there is
    // between the decision to post and the post itself.
    searchAnswer = () => { delete process.env.DOJO_DEV_BOX; return jsonRes(200, { items: [] }); };

    const outcome = await post.postApprovedReport(r.id);
    expect(outcome.kind).toBe('failed');
    expect(writes(), 'clearing DOJO_DEV_BOX mid-flight unlocked the real tracker').toEqual([]);
  });

  it('a dev box pointed at its own scratch repository posts normally', async () => {
    process.env.DOJO_DEV_BOX = '1';
    process.env.DOJO_REPORT_REPO = 'd-cornerpin/dojo-scratch';
    vi.resetModules();
    const post = await import('../../report/post.js');
    const store = await import('../../report/store.js');
    const r = store.createReport('agent-1', 'tool-error', SIGNATURE);
    store.attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/x/bundle.json');
    store.submitForApproval(r.id);
    store.approveOnce(r.id);

    const outcome = await post.postApprovedReport(r.id);
    expect(outcome.kind).toBe('created');
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url).toContain('d-cornerpin/dojo-scratch');
  });
});
