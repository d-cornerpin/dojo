// ════════════════════════════════════════════════════════════════════════════════════════
// THE INTEGRATIONS CARD SHOWS CONNECTION TRUTH, AND NEVER GOES AND ASKS.
//
// ── WHAT THIS FILE HOLDS, AND WHY IT IS HERE AND NOT BESIDE THE CARD ──
// T5 builds a React card; `packages/dashboard` has NO test runner. So the card is split at the
// only seam that can be argued with: the ROUTE that feeds it (`gateway/routes/github.ts` +
// `github/status.ts`), driven here for real, and the DECISIONS it renders
// (`dashboard/src/lib/github-card.ts`), imported here directly — the v3.1.27 arrangement
// `the-provider-editor-sends-only-what-changed.test.ts` uses for `lib/provider-edits.ts` and
// `the-panel-speaks-plainly.test.ts` uses for `lib/access-summary.ts`.
//
// Holding both in ONE file is the point: the wire shape and the card's reading of it are
// checked AGAINST EACH OTHER, which is the only place that agreement can be observed at all. A
// real `githubStatus()` result is passed through every card function below, so a field renamed
// on the server fails a test here rather than rendering a blank pill in a browser nobody is
// watching.
//
// ── THE CLAIM THAT MATTERS MOST: THE STATUS ENDPOINT NEVER PROBES GITHUB ──
// `memory/integration-status-lane.ts` states the doctrine the card serves — live truth outranks
// a remembered claim — and the SAME module states the discipline that keeps it honest: it is
// LEDGER-BACKED, never an invented freshness, because *"a status line that invents a freshness
// is the W84 defect one surface over."* The tempting way to look honest is to have the card
// probe `api.github.com` on render. That is refused, and the refusal is held as BEHAVIOUR: a
// `fetch` that throws is installed, and `GET /status` still answers — on a box with a sealed
// token, and on a box with a sign-in open, which is the render most tempting to "refresh".
//
// ── WHAT IS DELIBERATELY NOT HELD HERE, AND IS NAMED IN THE T5 REPORT ──
// The card's own `connectFailure` state — the text of the last `github:connect_failed` frame —
// is on the wire and in no ledger, so it has no door to drive. That, the four `subscribe()`
// wirings and the JSX are the card's unheld surface, listed honestly in the report rather than
// implied to be covered by this file's name.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t5-github-card', 'dojo.db'),
  };
});

vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { githubRouter } from '../github.js';
import {
  saveGithubAccount, disconnectGithub, noteGithubOk, noteGithubFailure,
} from '../../../github/account.js';
import { githubStatus, looksLikeAuthFailure } from '../../../github/status.js';
import {
  GITHUB_OAUTH_SCOPE, GITHUB_DEVICE_CODE_URL, cancelDeviceFlow, startDeviceFlow,
} from '../../../github/device-flow.js';
import {
  githubCardState, connectLabel, describeScope, connectedAs, scopeRequestSentence,
  problemText, CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK,
  GITHUB_EXPECTED_SCOPE, type GithubCardStatus,
} from '../../../../../dashboard/src/lib/github-card.js';

/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';
const CLIENT_ID = 'Ov23liFIXTURECLIENT';

const db = (): Database.Database => mockDb.current!;

const setClientId = (): void => {
  db().prepare("INSERT INTO config (key, value) VALUES ('github_client_id', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CLIENT_ID);
};

interface StatusBody { ok: boolean; data: Record<string, unknown>; error?: string }
const getStatus = async (): Promise<StatusBody> =>
  await (await githubRouter.request('/status')).json() as StatusBody;

const realFetch = globalThis.fetch;

/** A `fetch` that cannot be called without being noticed. Returns the spy. */
function forbidFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => {
    throw new Error('the status endpoint went and probed GitHub');
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/** Enough of a GitHub to get one device flow open. */
function stubDeviceCode(): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const payload = String(input) === GITHUB_DEVICE_CODE_URL
      ? {
        device_code: 'dc-fixture', user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
      }
      : { error: 'authorization_pending' };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  cancelDeviceFlow();
  globalThis.fetch = realFetch;
});

afterEach(() => {
  cancelDeviceFlow();
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('an unconfigured box says so plainly, and offers nothing that cannot work', () => {
  it('GET /status reports no client id and no connection', async () => {
    const body = await getStatus();
    expect(body.ok).toBe(true);
    expect(body.data.clientIdConfigured).toBe(false);
    expect(body.data.connected).toBe(false);
  });

  it('POST /connect answers 400 and a sentence a human can read', async () => {
    const res = await githubRouter.request('/connect', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    // A SENTENCE, not a code: the card renders this verbatim (T4 hand-off note 3).
    expect(body.error).toMatch(/not configured/i);
    expect(body.error!.trim()).toMatch(/\.$/);
  });

  it('...and the card draws the state with no button', async () => {
    const s = (await getStatus()).data as unknown as GithubCardStatus;
    expect(githubCardState(s)).toBe('unconfigured');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('a sealed token reads as connected, and the token itself never appears', () => {
  beforeEach(() => { setClientId(); saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE); });

  it('GET /status says connected, and names who', async () => {
    const body = await getStatus();
    expect(body.data.connected).toBe(true);
    expect(body.data.login).toBe('octocat');
    expect(body.data.scope).toBe(GITHUB_OAUTH_SCOPE);
    expect(body.data.reauthRequired).toBe(false);
  });

  it('no field of the answer carries the token', async () => {
    const body = await getStatus();
    // Over the WHOLE serialised body rather than field by field: a token added to a field
    // invented tomorrow is caught by this and by no enumeration.
    expect(JSON.stringify(body)).not.toContain('gho_');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('...and the card reads it as connected, with the name it was given', async () => {
    const data = (await getStatus()).data;
    expect(githubCardState(data as unknown as GithubCardStatus)).toBe('connected');
    expect(connectedAs(data.login as string | null)).toBe('Connected as octocat');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the last live outcome is the ledger, and an auth refusal is a reconnect', () => {
  beforeEach(() => { setClientId(); saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE); });

  it('a 401 comes back as that exact sentence, and asks for a reconnect', async () => {
    noteGithubFailure('401 Bad credentials');
    const body = await getStatus();
    expect(body.data.lastError).toBe('401 Bad credentials');
    // THE POINT OF THE CLAUSE. The sealed value still OPENS — nothing local broke — so the
    // pre-T5 derivation (`row exists && token will not open`) read this as fully connected
    // while every post GitHub received was refused. That is a remembered claim outranking the
    // live truth, which is the exact inversion of the doctrine this card exists to serve.
    expect(body.data.reauthRequired).toBe(true);
  });

  it('a later success clears it — the ledger moves forward, it does not accumulate', async () => {
    noteGithubFailure('401 Bad credentials');
    noteGithubOk();
    const body = await getStatus();
    expect(body.data.lastError).toBeNull();
    expect(body.data.reauthRequired).toBe(false);
    expect(body.data.lastOkAt).toBeTruthy();
  });

  it('a failure that is NOT about credentials leaves the connection alone', async () => {
    noteGithubFailure('404 Not Found');
    const body = await getStatus();
    expect(body.data.lastError).toBe('404 Not Found');
    expect(body.data.reauthRequired).toBe(false);
    expect(body.data.connected).toBe(true);
  });

  // ── DAY-ONE FIXTURE TABLE ──
  // `looksLikeAuthFailure` reads a platform-authored sentence, and a reader of free text is
  // only as good as the spellings it has actually been shown. Every row is a message the
  // platform can really write: GitHub's own bodies, and T7's wrappers around them.
  //
  // ⚠ THAT CLAIM WAS HALF FALSE FOR THREE TASKS, AND C1 IS WHERE IT STOPPED BEING. "GitHub's own
  // bodies" were rows in this table and nowhere else: no writer of `last_error` had ever put one
  // there, so six patterns passed a fixture in front of a column their input could not reach. The
  // C1 block below is the same six spellings in the sentences the column now really holds, and the
  // load-bearing clause under the table is what keeps a hand-written row from standing in for a
  // pattern doing work again.
  //
  // THE DIRECTION IT FAILS IN IS CHOSEN. A false NO costs the reconnect prompt and nothing
  // else — `lastError` is still rendered verbatim in a warning, so the owner still sees the
  // failure. A false YES tells someone their working connection is broken. So the predicate is
  // narrow on purpose, and the rows below pin both sides of that.
  const AUTH_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
    // ── The credential sentences. These carry the signal with no number at all. ──
    ['Bad credentials', true],
    ['Requires authentication', true],                              // GitHub's 401 on /issues
    ['GitHub refused: unauthorized', true],
    ['403 Forbidden — token has not been granted the required scopes', true],
    // ── SPLIT IN C1. This was ONE row carrying two spellings — `not accessible by personal
    //    access token` and `insufficient scope` — so either pattern could be deleted and the row
    //    still passed on the other. Two rows, one spelling each, is what makes both load-bearing;
    //    the clause below strikes each spelling out and requires the row to go quiet.
    ['Resource not accessible by personal access token', true],     // GitHub's literal 403 body
    ['The request had insufficient scope for this operation', true],
    // ── 401 PRESENTED AS A STATUS CODE: sentence-initial, bracketed, or introduced by a
    //    status word. These are the only shapes in which the bare number counts. ──
    ['401 Bad credentials', true],                                  // GitHub's literal body
    ['401 Unauthorized', true],                                     // the status line verbatim
    ['GitHub answered 401.', true],                                 // T4's own test fixture
    ['HTTP 401', true],
    ['Request failed with status code 401', true],
    ['GitHub returned 401', true],
    ['Received 401 from api.github.com', true],
    ['(401)', true],
    // ── 🔴 THE FIX-ROUND-1 ROWS (review F1). A NUMERAL 401 IN PROSE IS NOT A STATUS CODE. ──
    // Every one of these read as AUTH-FAILURE before the fix — the reviewer drove them through
    // `\b401\b`, which matches the number in ANY context. That is the false YES this module's
    // header says it chose against: it tells an owner whose connection works perfectly that it
    // "stopped working" and invites them to Disconnect.
    //
    // NOT HYPOTHETICAL — ISSUE NUMBERS ARE T7's WHOLE DOMAIN. T7 builds `findIssueBySignature`,
    // `createIssue` and `commentOnIssue`, and a failure sentence naming the issue it could not
    // comment on is the obvious thing to write into the very column T5 taught to be read as a
    // verdict. The fixture table was one row short on exactly the axis it was built for: it
    // pinned the SUFFIX case (`401k-planner`) and had no row for 401 standing alone as a number.
    ['Could not comment on issue 401', false],
    ['Failed to update issue #401 on d-cornerpin/dojo', false],
    ['Search returned issue 401 but the comment was refused (500)', false],
    ['Could not open an issue (HTTP 500) after 401 ms', false],
    ['Timed out after 401 ms', false],
    ['Rate limited; retry after 401 seconds', false],
    ['Commented on issue 401 but could not label it', false],
    // ADVERSARIAL: `401` inside a longer token must not match. A naive `includes('401')`
    // passes every credential row above and fails this one.
    ['Could not open an issue on 401k-planner', false],
    // ── 🔴 THE C1 ROWS: THE LINES THE LEDGER ACTUALLY HOLDS NOW ──
    // Everything above this marker is a spelling, tested in isolation. These are the WHOLE
    // SENTENCES `github/refusal.ts` writes into `last_error`, prefix and all, because until C1 the
    // column carried ONLY `GitHub refused to <verb> (HTTP <status>).` — and the six prose patterns
    // in this predicate match text GITHUB writes, which had no route into it. They were
    // unreachable code: a fixture table proving a reader works, in front of a column the reader's
    // input never reached.
    //
    // The 401 rows hid it. `(HTTP 401)` matches the status-word anchor, so the shape everyone
    // tested passed. THE ROW THAT MATTERED IS THE NEXT ONE: GitHub refuses a revoked or missing
    // scope with a 403, no numeral in this predicate can help, and before C1 the card told an
    // owner whose token could no longer file anything that the connection was working.
    ['GitHub refused to file the issue (HTTP 403). GitHub said: Resource not accessible by '
      + 'personal access token (https://docs.github.com/rest/issues/issues#create-an-issue)', true],
    ['GitHub refused to add the comment (HTTP 403). GitHub said: Your token has not been granted '
      + "the required scopes to execute this operation. The 'createIssue' field requires one of "
      + "the following scopes: ['public_repo'], but your token has only been granted the: [] "
      + 'scopes.', true],
    // Verbatim from `curl https://api.github.com/user` with a bogus bearer, September 2026 —
    // message, help link and all. These two are the bodies GitHub really sends on 401.
    ['GitHub refused to file the issue (HTTP 401). GitHub said: Bad credentials '
      + '(https://docs.github.com/rest)', true],
    ['GitHub refused to file the issue (HTTP 401). GitHub said: Requires authentication '
      + '(https://docs.github.com/rest)', true],
    // ── ...AND THE OTHER DIRECTION, WHICH IS THE ONE C1 HAD TO NOT BREAK ──
    // Provider prose reaching a predicate is how a false YES gets made: one wrong word in a
    // rate-limit body and an owner is told to tear down a connection that works. Every row below
    // is a real GitHub refusal body on a real transient, wearing the same new prefix.
    ['GitHub refused to file the issue (HTTP 403). GitHub said: API rate limit exceeded for user '
      + 'ID 12345. (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)',
      false],
    // ADVERSARIAL, AND NOT HYPOTHETICAL: GitHub's rate-limit body names a numeric USER ID, so the
    // T7 hand-off ("this column carries a verdict, never an identifier") now has a second party
    // writing to it. An owner whose GitHub user id is 401 must not be told to reconnect.
    ['GitHub refused to file the issue (HTTP 403). GitHub said: API rate limit exceeded for user '
      + 'ID 401. (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)',
      false],
    ['GitHub refused to file the issue (HTTP 403). GitHub said: You have exceeded a secondary '
      + 'rate limit and have been temporarily blocked from content creation. Please retry your '
      + 'request again later.', false],
    ['GitHub refused to file the issue (HTTP 429). GitHub said: Too Many Requests', false],
    ['GitHub refused to file the issue (HTTP 500). GitHub said: Server Error', false],
    // A 502 from a gateway is an HTML page, so the honest-absence phrase is what lands here.
    ['GitHub refused to file the issue (HTTP 502). GitHub sent no readable explanation.', false],
    ['GitHub refused to file the issue (HTTP 503). GitHub sent no readable explanation.', false],
    ['GitHub refused to file the issue (HTTP 404). GitHub said: Not Found '
      + '(https://docs.github.com/rest/issues/issues#create-an-issue)', false],
    ['GitHub refused to file the issue (HTTP 410). GitHub said: Issues are disabled for this repo',
      false],
    ['GitHub refused to file the issue (HTTP 403). GitHub said: Repository was archived so is '
      + 'read-only.', false],
    ['GitHub refused to file the issue (HTTP 422). GitHub said: Validation Failed', false],
    // ADVERSARIAL: GitHub's IP-allow-list 403 contains the word "authorization" — and
    // `unauthoriz(ed|ation)` does NOT match it, which is the difference between a pattern and a
    // substring search. Reconnecting fixes nothing here, so a reconnect prompt would be a lie.
    ['GitHub refused to file the issue (HTTP 403). GitHub said: Although you appear to have the '
      + 'correct authorization credentials, the acme organization has an IP allow list enabled, '
      + 'and 203.0.113.4 is not permitted to access this resource.', false],
    ['GitHub refused to file the issue (HTTP 403). GitHub said: Resource protected by organization '
      + 'SAML enforcement. You must grant your OAuth token access to an organization within this '
      + 'enterprise.', false],
    // `issues.ts`'s `unreachable()` writes this column too, and it never goes through
    // `refusal.ts` — so the socket failures keep their own shape, and must stay quiet in it.
    ['Could not reach GitHub to file the issue: The operation was aborted due to timeout', false],
    ['Could not reach GitHub to add the comment: connect ETIMEDOUT 140.82.114.6:443', false],
    ['Could not reach GitHub to file the issue: fetch failed', false],
    // ── The transient blips. A connection that is fine must never read as broken. ──
    ['403 API rate limit exceeded for user', false],                // a 403 that is NOT auth
    ['404 Not Found', false],
    ['422 Validation Failed: issues are disabled for this repository', false],
    ['Could not reach GitHub (socket hang up).', false],
    ['500 Internal Server Error', false],
    ['GitHub answered 502.', false],
    ['AbortError: The operation was aborted due to timeout', false],
    ['The repository is archived and cannot accept issues.', false],
    ['', false],
  ];

  it('the auth-failure reader answers every spelling the platform can write', () => {
    for (const [message, expected] of AUTH_FIXTURES) {
      expect(looksLikeAuthFailure(message), `"${message}"`).toBe(expected);
    }
    // Non-vacuity on BOTH sides: a reader stuck on one answer passes half a table silently.
    expect(AUTH_FIXTURES.some(([, v]) => v)).toBe(true);
    expect(AUTH_FIXTURES.some(([, v]) => !v)).toBe(true);
  });

  // ── ADDED IN C1: THE SIX PATTERNS THAT PASSED THIS TABLE WHILE BEING DEAD ──
  // A green fixture table is not evidence that a pattern does any work. Six of the nine patterns
  // in `looksLikeAuthFailure` match text only GITHUB writes, the column they read carried none of
  // it until C1, and this table said TRUE for all six anyway — because the rows testing them were
  // hand-written spellings, and hand-written spellings are reachable by definition.
  //
  // So each spelling is struck out of a row the table asserts TRUE, and the row must GO QUIET.
  // That is what makes the pattern load-bearing rather than decorative: if anything else in the
  // row carried the verdict (a `401`, a second spelling — which is exactly what the split row
  // above was doing), the strike leaves the answer TRUE and this fails. It is the self-mutating
  // half of the property; the production half — that the ledger really receives these sentences —
  // is driven through the real poster in
  // `github/__tests__/a-refusal-carries-githubs-own-explanation.test.ts`.
  const PROVIDER_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ['bad credentials', 'Bad credentials'],
    ['unauthorized', 'GitHub refused: unauthorized'],
    ['requires authentication', 'Requires authentication'],
    ['required scopes', '403 Forbidden — token has not been granted the required scopes'],
    ['insufficient scope', 'The request had insufficient scope for this operation'],
    ['not accessible by personal access token',
      'Resource not accessible by personal access token'],
  ];

  it('each of the six provider-text patterns is LOAD-BEARING on a row of this table', () => {
    for (const [spelling, row] of PROVIDER_SPELLINGS) {
      expect(
        AUTH_FIXTURES.some(([m, v]) => v && m === row),
        `the table no longer carries the TRUE row that holds "${spelling}" up`,
      ).toBe(true);
      expect(looksLikeAuthFailure(row), `"${row}"`).toBe(true);
      const struck = row.replace(new RegExp(spelling, 'i'), 'xxx');
      expect(struck, `the strike-out did not change "${row}" — this clause is broken`)
        .not.toBe(row);
      expect(
        looksLikeAuthFailure(struck),
        `"${spelling}" is not what makes this row an auth failure — something else in it is, so `
        + `deleting the pattern would leave the table green. Row: "${row}"`,
      ).toBe(false);
    }
    expect(PROVIDER_SPELLINGS.length, 'a provider-text pattern lost its row').toBe(6);
  });

  // ── ADDED IN C1: THE MARK MUST CLEAR, OR A FIXED CONNECTION NAGS FOREVER ──
  // Making `reauthRequired` reachable for real auth failures is the point of C1, and it buys a
  // second obligation with it: the three places that end a failure must end THIS one. Before C1
  // the only sentence that could raise the mark was a `(HTTP 401)` line; a provider-text 403 now
  // raises it too, so each clear-point is re-driven from that starting state rather than from the
  // one shape that already worked.
  const SCOPE_REFUSAL = 'GitHub refused to file the issue (HTTP 403). GitHub said: Resource not '
    + 'accessible by personal access token';

  it('noteGithubOk clears a provider-text auth refusal', async () => {
    noteGithubFailure(SCOPE_REFUSAL);
    expect((await getStatus()).data.reauthRequired, 'setup: the mark was never raised').toBe(true);
    noteGithubOk();
    const body = await getStatus();
    expect(body.data.lastError).toBeNull();
    expect(body.data.reauthRequired, 'a working connection is still being told to reconnect')
      .toBe(false);
  });

  it('saveGithubAccount clears it on BOTH arms — the fresh insert and the reconnect upsert', async () => {
    // THE UPSERT ARM IS THE ONE THAT MATTERS and it had no clause. The row already exists (the
    // owner is RE-connecting, which is what the card just told them to do), so this goes through
    // `ON CONFLICT(id) DO UPDATE`, a separate `last_error = NULL` written in a separate place from
    // the INSERT's. A reconnect that left the old refusal behind would re-raise the mark the
    // moment the card reloaded, and the owner would be told to reconnect a connection they had
    // just reconnected.
    noteGithubFailure(SCOPE_REFUSAL);
    expect((await getStatus()).data.reauthRequired, 'setup: the mark was never raised').toBe(true);
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);   // upsert over the existing row
    let body = await getStatus();
    expect(body.data.lastError, 'the reconnect upsert kept the refusal it was curing').toBeNull();
    expect(body.data.reauthRequired).toBe(false);

    // ...and the INSERT arm, reached by deleting the row first.
    noteGithubFailure(SCOPE_REFUSAL);
    disconnectGithub();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    body = await getStatus();
    expect(body.data.lastError).toBeNull();
    expect(body.data.reauthRequired).toBe(false);
  });

  it('disconnectGithub clears it — with no row there is nothing left to nag about', async () => {
    noteGithubFailure(SCOPE_REFUSAL);
    expect((await getStatus()).data.reauthRequired, 'setup: the mark was never raised').toBe(true);
    disconnectGithub();
    const body = await getStatus();
    expect(body.data.lastError).toBeNull();
    expect(body.data.reauthRequired).toBe(false);
    expect(githubCardState(body.data as unknown as GithubCardStatus)).toBe('disconnected');
  });

  it('reauth also covers the half-state a rotated master key leaves behind', async () => {
    const sealed = (db().prepare('SELECT access_token FROM github_account WHERE id = 1')
      .get() as { access_token: string }).access_token;
    db().prepare('UPDATE github_account SET access_token = ? WHERE id = 1')
      .run(sealed.slice(0, -4) + 'AAAA');
    const body = await getStatus();
    expect(body.data.connected).toBe(false);
    expect(body.data.reauthRequired).toBe(true);
    expect(body.data.login).toBe('octocat');
    // The card says RECONNECT rather than CONNECT — the difference between "set this up" and
    // "the thing you set up stopped working".
    expect(connectLabel(body.data as unknown as GithubCardStatus)).toBe('Reconnect GitHub');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('disconnect leaves no trace of whose account it was', () => {
  it('status goes back to not-connected with no login', async () => {
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    disconnectGithub();
    const body = await getStatus();
    expect(body.data.connected).toBe(false);
    expect(body.data.login).toBeNull();
    expect(body.data.reauthRequired).toBe(false);
    expect(body.data.lastError).toBeNull();
    expect(githubCardState(body.data as unknown as GithubCardStatus)).toBe('disconnected');
    expect(connectLabel(body.data as unknown as GithubCardStatus)).toBe('Connect GitHub');
  });

  it('POST /disconnect answers it, through the real route', async () => {
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    const res = await githubRouter.request('/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await getStatus()).data.connected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('GET /status performs no outbound fetch — the ledger is the whole answer', () => {
  it('answers on an unconfigured box without touching the network', async () => {
    const spy = forbidFetch();
    const body = await getStatus();
    expect(spy).not.toHaveBeenCalled();
    expect(body.ok).toBe(true);
  });

  it('answers on a CONNECTED box without touching the network', async () => {
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    noteGithubOk();
    const spy = forbidFetch();
    const res = await githubRouter.request('/status');
    expect(spy, 'the status endpoint probed GitHub to look fresher than its ledger')
      .not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json() as StatusBody;
    expect(body.data.connected).toBe(true);
    // The freshness it reports is the one the LEDGER holds, written by `noteGithubOk` and by
    // nothing else. There is no timer here and no staleness heuristic to re-derive it from.
    expect(body.data.lastOkAt).toBeTruthy();
  });

  it('answers MID SIGN-IN without touching the network — the render most tempting to refresh', async () => {
    setClientId();
    stubDeviceCode();
    const started = await startDeviceFlow();
    expect(started.ok, 'setup: the device flow must be open for this clause to mean anything')
      .toBe(true);

    const spy = forbidFetch();
    const res = await githubRouter.request('/status');
    expect(spy, 'the status endpoint re-asked GitHub whether the code had been entered yet')
      .not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json() as StatusBody;
    // The code comes from the live flow held in memory, not from a second round trip.
    expect(body.data.loginInProgress).toBe(true);
    expect(body.data.userCode).toBe('WDJB-MJHT');
    expect(body.data.verificationUri).toBe('https://github.com/login/device');
    expect(githubCardState(body.data as unknown as GithubCardStatus)).toBe('connecting');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the card reads the served shape, and re-derives nothing', () => {
  it('every field the card decides on is present on a real status answer', async () => {
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    const data = (await getStatus()).data;
    // The card's input type, named field by field against the live wire answer. A rename on
    // the server lands here as a failure instead of as a blank pill in a browser.
    for (const field of [
      'connected', 'scope', 'reauthRequired', 'clientIdConfigured',
      'loginInProgress', 'userCode', 'verificationUri',
    ]) {
      expect(Object.keys(data), `the card reads \`${field}\`, which the route stopped serving`)
        .toContain(field);
    }
  });

  it('the four render states are exhaustive and mutually exclusive over every shape', () => {
    // 2^5 flag combinations, both code shapes — 64 statuses, each of which must land on
    // exactly one state. This is what "mutually exclusive" means when it is measured rather
    // than asserted by the way the JSX happens to be nested.
    const seen = new Set<string>();
    for (const connected of [true, false]) {
      for (const clientIdConfigured of [true, false]) {
        for (const loginInProgress of [true, false]) {
          for (const reauthRequired of [true, false]) {
            for (const withCode of [true, false]) {
              for (const scope of [GITHUB_OAUTH_SCOPE, null]) {
                const s: GithubCardStatus = {
                  connected, clientIdConfigured, loginInProgress, reauthRequired, scope,
                  userCode: withCode ? 'WDJB-MJHT' : null,
                  verificationUri: withCode ? 'https://github.com/login/device' : null,
                };
                const state = githubCardState(s);
                expect(['connecting', 'connected', 'unconfigured', 'disconnected'])
                  .toContain(state);
                seen.add(state);
              }
            }
          }
        }
      }
    }
    expect([...seen].sort(), 'a render state is unreachable — the card has dead JSX')
      .toEqual(['connected', 'connecting', 'disconnected', 'unconfigured']);
  });

  it('a stored connection outranks a cleared client id — the .24 rule, sharpest case', () => {
    // The owner clears `github_client_id` after connecting. The token is still sealed here and
    // T7 can still post with it, so "GitHub isn't set up on this box yet" would be the card
    // inventing a disconnection.
    const s: GithubCardStatus = {
      connected: true, clientIdConfigured: false, loginInProgress: false,
      reauthRequired: false, scope: GITHUB_OAUTH_SCOPE,
      userCode: null, verificationUri: null,
    };
    expect(githubCardState(s)).toBe('connected');
  });

  it('a reconnect started while still connected shows the CODE, not the connected pill', async () => {
    // ── ADDED BECAUSE A MUTANT SURVIVED (T5 mutation round, M4) ──
    // Swapping the first two lines of `githubCardState` — `connected` tested before
    // `loginInProgress` — rode 27/27 GREEN. Every other clause here reaches only cases where
    // at most one of the two flags is set, so the PRECEDENCE, which the module header spends a
    // paragraph arguing, was held by nothing at all.
    //
    // The overlap is ordinary, not exotic: a revoked token leaves the row and the seal intact,
    // so `connected` is true and `reauthRequired` is true at the same time, and the user
    // pressing Reconnect opens a flow on top of both.
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    stubDeviceCode();
    expect((await startDeviceFlow()).ok).toBe(true);
    const data = (await getStatus()).data;
    expect(data.connected, 'setup: BOTH must be true or this clause proves nothing').toBe(true);
    expect(data.loginInProgress, 'setup: BOTH must be true or this clause proves nothing')
      .toBe(true);
    // A card that drew "Connected" here would swallow the one thing the user is waiting for.
    expect(
      githubCardState(data as unknown as GithubCardStatus),
      'a sign-in is open and the card hid the code behind a connected pill',
    ).toBe('connecting');
  });

  it('an open sign-in outranks a cleared client id too — the fourth precedence leg', () => {
    // ── ADDED IN FIX ROUND 1 (review F2), and it is the M4 shape one leg over ──
    // The header says "CONNECTING WINS OVER EVERYTHING." Three legs were held by clauses; this
    // one was held by the sentence. The reviewer's probe — requiring `clientIdConfigured` for
    // `'connecting'` — rode 28/28, because no case reached `loginInProgress` with the client id
    // cleared. T4 pins that combination as a real loop ending: the owner clears
    // `github_client_id` while a device flow is open.
    //
    // Cheaper consequence than M4's (a flicker in a transient window, not a lie about a
    // connection), and closed for the same reason M4 was: a leg of a precedence argument held
    // by prose is a leg nothing holds.
    const s: GithubCardStatus = {
      connected: false, clientIdConfigured: false, loginInProgress: true,
      reauthRequired: false, scope: null,
      userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device',
    };
    expect(githubCardState(s), 'a code is on screen and the card called the box unconfigured')
      .toBe('connecting');
  });

  it('a sign-in with no code to type is NOT the connecting state', () => {
    // T4 hand-off note 5: the flow is one module variable in one process, so a restart
    // mid-sign-in can leave the flag without the code. A code panel with nothing in it is a
    // card waiting forever; falling through gives the user a button instead.
    const s: GithubCardStatus = {
      connected: false, clientIdConfigured: true, loginInProgress: true,
      reauthRequired: false, scope: null, userCode: null, verificationUri: null,
    };
    expect(githubCardState(s)).toBe('disconnected');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the permission is described from what GitHub granted, never from what we asked', () => {
  it('the card and the engine name the SAME scope string', () => {
    // The cross-check that makes every sentence below honest. `packages/dashboard` cannot
    // import from `packages/server`, so the scope is restated there — and if T4's constant
    // ever widens, this fails before the card can keep printing the narrow reassurance.
    expect(GITHUB_EXPECTED_SCOPE).toBe(GITHUB_OAUTH_SCOPE);
  });

  it('the expected scope gets the reassurance, in plain words', () => {
    const words = describeScope(GITHUB_OAUTH_SCOPE);
    expect(words).toContain('public repositories');
    expect(words).toMatch(/cannot read your private repositories/i);
  });

  // ── DAY-ONE FIXTURE TABLE ──
  // Every scope string GitHub can really hand back. The reassurance about private repositories
  // is TRUE of `public_repo` and FALSE of every one of these, so it must appear on none.
  const WIDER_SCOPES = [
    'repo', 'repo,public_repo', 'public_repo,gist', 'admin:org', 'workflow',
    'repo:status', 'delete_repo', '', '   ', null,
  ];

  it('every other scope is described without a promise about private code', () => {
    for (const scope of WIDER_SCOPES) {
      const words = describeScope(scope);
      expect(words, `describeScope(${JSON.stringify(scope)})`)
        .not.toMatch(/cannot read your private repositories/i);
      expect(words.length, `describeScope(${JSON.stringify(scope)}) said nothing`)
        .toBeGreaterThan(0);
    }
    // Non-vacuity: the reassurance must be reachable at all, or the clause above is trivial.
    expect(describeScope(GITHUB_OAUTH_SCOPE)).toMatch(/cannot read your private repositories/i);
  });

  it('a wider scope is NAMED, so the owner can see what they granted', () => {
    expect(describeScope('repo')).toContain('"repo"');
    expect(describeScope('repo')).toMatch(/disconnect and connect again/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('a connection with no name is a connection, not a null', () => {
  it('renders a nameless grant without printing null', () => {
    // T4 hand-off note 6: `GET /user` is not retried, so a hiccup costs the NAME, never the
    // grant. `Connected as null` is the bug this refuses.
    for (const login of [null, '', '   ']) {
      const line = connectedAs(login);
      expect(line, `connectedAs(${JSON.stringify(login)})`).toBe('Connected');
      expect(line).not.toContain('null');
      expect(line).not.toContain('undefined');
    }
    expect(connectedAs('octocat')).toBe('Connected as octocat');
  });

  it('the engine really can store a nameless grant — this is not a hypothetical', async () => {
    setClientId();
    saveGithubAccount(null, TOKEN, GITHUB_OAUTH_SCOPE);
    const body = await getStatus();
    expect(body.data.connected).toBe(true);
    expect(body.data.login).toBeNull();
    expect(connectedAs(body.data.login as string | null)).toBe('Connected');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('a sign-in that failed says why, and the sentence is not invented at the call site', () => {
  // ── ADDED IN FIX ROUND 1: the reviewer's cheap extraction ──
  // §2b listed the `problem` state as unheld because it is an EVENT with no door to drive.
  // That is true of the WIRING and false of the DECISION: "what text do I show when the frame
  // or the 400 carried no error?" is a pure function of an optional string, and by the module's
  // own test — would being wrong be a lie about a connection? — a failed sign-in showing no
  // reason at all is nearer a connection claim than a cosmetic slip.
  it('passes a real sentence through untouched', () => {
    expect(problemText('That sign-in code expired. Press Connect to get a new one.', CONNECT_FAILED_FALLBACK))
      .toBe('That sign-in code expired. Press Connect to get a new one.');
  });

  it('never renders an empty box, a null or an undefined', () => {
    for (const absent of [null, undefined, '', '   ']) {
      for (const fallback of [CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK]) {
        const text = problemText(absent, fallback);
        expect(text, `problemText(${JSON.stringify(absent)})`).toBe(fallback);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toContain('null');
        expect(text).not.toContain('undefined');
      }
    }
  });

  it('the two fallbacks are different sentences — they answer different questions', () => {
    // One is "your sign-in stopped", the other is "it never started". A user who sees the
    // wrong one looks in the wrong place.
    expect(CONNECT_FAILED_FALLBACK).not.toBe(CONNECT_REFUSED_FALLBACK);
    for (const s of [CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK]) {
      expect(s.trim()).toMatch(/\.$/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the card holds no copy of a rule the lib is guarding', () => {
  // ── ADDED IN FIX ROUND 1 (review F3 + the refetch-on-event extraction) ──
  // `packages/dashboard` has no test runner, so a rule that gets RE-TYPED into the .tsx escapes
  // every guard the lib carries. These two clauses are source censuses over the component —
  // this plan's own instrument, used five times in T4 — and each catches one specific edit.
  const cardSource = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../dashboard/src/components/GitHubSettings.tsx'), 'utf8');

  it('the reassurance about private repositories exists in ONE place, behind the guarded constant', () => {
    // F3. The card carried a second, differently-worded copy of the sentence `describeScope`
    // exists to make honest ("private repos" vs "private repositories"), so no grep over the
    // tested string found it. That copy is a CONSTANT claim about the user's private code
    // sitting in the one file nothing tests — precisely what §2 calls "the rule with teeth".
    expect(cardSource.length, 'the census read an empty file — it is broken')
      .toBeGreaterThan(0);
    expect(
      cardSource,
      'the card hardcodes a claim about private repositories again. That sentence belongs in '
      + '`lib/github-card.ts` behind GITHUB_EXPECTED_SCOPE, where a test holds it and where the '
      + 'scope cross-check reaches it.',
    ).not.toMatch(/private repo/i);
    // ...and the sentence really does exist, in the place that IS guarded.
    expect(scopeRequestSentence()).toMatch(/private repositories/i);
  });

  it('state is replaced from the door, never merged from a frame', () => {
    // THE REFETCH-ON-EVENT IDIOM, held statically. §2b named this the gap most worth a DOM
    // runner: an "optimisation" that merged a frame's fields into card state would reintroduce
    // the invented-freshness defect this whole card is written against, and nothing would
    // notice. A runner is still the full answer — but the feared edit has one visible shape,
    // a second `setStatus(`, and that is cheap to refuse.
    const calls = [...cardSource.matchAll(/setStatus\(/g)];
    expect(calls.length, 'the card stopped setting its status at all — this census is broken')
      .toBeGreaterThan(0);
    expect(
      calls.length,
      'a second `setStatus(` appeared. If it merges fields from a WebSocket frame into the '
      + 'card\'s state, that is the invented-freshness defect: the card would show a freshness '
      + 'no door served. Refetch from `GET /status` instead.',
    ).toBe(1);
    // ...and the one call is inside `loadStatus`, not inside a subscribe handler.
    //
    // THE FIRST READER HERE WAS WRONG AND THE SUITE SAID SO, which is the reason to write the
    // reader rather than assume it: "the nearest preceding `const <name> =`" answered `result`,
    // because `const result = await api.getGithubStatus()` sits between the declaration and the
    // call. A census is only as good as its reader — the lesson this task already banked twice
    // — so this walks `loadStatus`'s actual body instead of guessing at its name.
    const declStart = cardSource.indexOf('const loadStatus');
    expect(declStart, 'the card no longer declares `loadStatus` — this census is broken')
      .toBeGreaterThan(-1);
    let bodyEnd = cardSource.indexOf('{', declStart);
    for (let depth = 0, i = bodyEnd; i < cardSource.length; i++) {
      if (cardSource[i] === '{') depth++;
      else if (cardSource[i] === '}' && --depth === 0) { bodyEnd = i; break; }
    }
    const body = cardSource.slice(declStart, bodyEnd);
    // Non-vacuity: a walk that returned an empty or runaway body would pass the range check
    // below for the wrong reason.
    expect(body, 'the extracted `loadStatus` body is not the one that calls the door')
      .toContain('api.getGithubStatus');
    expect(
      calls[0].index! > declStart && calls[0].index! < bodyEnd,
      'the single `setStatus(` moved out of `loadStatus` — state is no longer replaced by what '
      + 'the door served',
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the status shape the card was built against is the one the route serves', () => {
  it('is exactly the eleven fields, and T4 pinned the same set', async () => {
    // The DUPLICATE-TYPE note in the plan: `GithubStatus` is declared server-side and again in
    // `dashboard/src/lib/api.ts`, because the dashboard cannot import from the server. This is
    // the clause that keeps the restatement honest from this side; T4's own file pins it from
    // the other. Two files failing is the intended cost of changing the shape.
    setClientId();
    saveGithubAccount('octocat', TOKEN, GITHUB_OAUTH_SCOPE);
    const body = await getStatus();
    expect(Object.keys(body.data).sort()).toEqual([
      'clientIdConfigured', 'connected', 'connectedAt', 'lastError', 'lastOkAt', 'login',
      'loginInProgress', 'reauthRequired', 'scope', 'userCode', 'verificationUri',
    ]);
    expect(Object.keys(githubStatus()).sort()).toEqual(Object.keys(body.data).sort());
  });
});
