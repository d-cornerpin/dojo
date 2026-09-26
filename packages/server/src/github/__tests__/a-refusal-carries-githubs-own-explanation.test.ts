// ════════════════════════════════════════════════════════════════════════════════════════
// A REFUSAL CARRIES GITHUB'S OWN EXPLANATION (DOJO-REPORT T8 fix round).
//
// ── THE DEFECT THIS FILE HOLDS SHUT ──
// A live run, the owner at his browser: Post pressed, and the card said *"GitHub refused to file
// the issue (HTTP 403)"*. That sentence was the only thing the box kept. GitHub had explained
// itself in the response body — it always does — and the poster read the status line and dropped
// the body on the floor. Every innocent party (public repo, issues open, not archived, an account
// that could file by hand, neither side an org) then had to be eliminated one at a time to
// re-derive what the discarded witness had already said.
//
// ── THE THREE PROPERTIES, AND WHY EACH IS SEPARABLE ──
//
//   1. THE PROVIDER'S WORDS SURVIVE. On a non-OK answer from any of the three calls — issue
//      create, issue comment, duplicate search — GitHub's `message` and `documentation_url`
//      reach the LOG verbatim and the owner's sentence carries the `message`. Driven through the
//      real poster, so the path a Post press takes is the path measured.
//
//   2. AN ABSENCE IS REPORTED AS AN ABSENCE. An unparseable body, an empty body and a JSON body
//      with no `message` all produce "GitHub sent no readable explanation" — never a cause. This
//      is the honesty half and it is the direction that is easy to get wrong: a status code
//      invites a plausible story, and a plausible story sends the next reader somewhere the
//      evidence never pointed. The unparseable body ALSO reaches the log verbatim, labelled as
//      unparsed, because a bounded slice of an HTML error page is evidence and a guess is not.
//
//   3. THE TOKEN IS IN NONE OF IT. T4's positive-proof rule: containment is proven by a sweep
//      over every emitted line, on every door, in every body shape, with the sweep's own
//      non-vacuity asserted (a real token is in scope, and lines were actually emitted).
//
// ── WHAT THIS GUARD CAN AND CANNOT SEE ──
//
// | Property | Seen how | Blind to |
// |---|---|---|
// | the provider's words in the log | behaviourally — every `createLogger` in the import graph records into one array, and the assertion is over the WHOLE array, per door and per body shape. It requires the PARSED statement (`GitHub said: …`, `documentation_url=…`) rather than the bare message text: a bare `toContain(message)` is also satisfied by the unparsed-body fallback, which quotes the whole JSON, so a poster that dropped the parsed body would have ridden it | a write to stdout/stderr that does not go through `createLogger` |
// | the provider's words on the card | behaviourally — the real `postApprovedReport` is driven and its `failed` sentence is read | a second surface that composes its own sentence from the status code instead of using this one |
// | an absence reported honestly | behaviourally, plus a NEGATIVE list: no emitted line may contain `scope`, `permission`, `rate limit` or `archived` when GitHub named no cause | a fabricated cause worded outside that list — which is why the POSITIVE clause (the honest phrase must be present) runs beside it rather than instead of it |
// | the token in any emitted line | behaviourally — the unfiltered log array, the card sentence and the ledger column, on 3 doors × 4 body shapes | a line emitted by a module this file does not import; a leak on a branch no row here drives (the blind spot that bit T4 at 31/31) |
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ logLines: [] as string[] }));

// Every logger in the import graph records into one array, so "the token never reaches a log
// line" is measured over the WHOLE graph rather than over the modules I happened to think of.
vi.mock('../../logger.js', () => {
  const rec = (level: string) => (msg: string, meta?: unknown): void => {
    h.logLines.push(`${level} ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`);
  };
  return {
    createLogger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }),
    setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t8-refusal', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  createReport, attachDraft, submitForApproval, approveOnce, type ReportBrief,
} from '../../report/store.js';
import { saveGithubAccount, disconnectGithub, getGithubAccount, getGithubToken } from '../account.js';
import { githubStatus } from '../status.js';
import { postApprovedReport } from '../../report/post.js';
import { NO_EXPLANATION } from '../refusal.js';
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

let searchAnswer: () => Response = () => jsonRes(200, { items: [] });
let writeAnswer: () => Response = () => jsonRes(201, { number: 7, html_url: 'https://x.invalid/7' });

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown) =>
    String(input).includes('/search/issues') ? searchAnswer() : writeAnswer()) as unknown as typeof fetch;
}
const realFetch = globalThis.fetch;

/** A report sitting exactly where the poster is allowed to find it. */
function approved(): string {
  const r = createReport('agent-1', 'tool-error', SIGNATURE);
  attachDraft(r.id, BRIEF, TELEMETRY, '/tmp/never-opened/bundle.json');
  submitForApproval(r.id);
  approveOnce(r.id);
  return r.id;
}

// ── the three doors, driven through the real poster ──────────────────────────────────────

interface Door {
  name: string;
  /** Point the stub at THIS door so it is the call that refuses. */
  arrange: (answer: () => Response) => void;
  /** Drive a Post press and return the sentence the card would show. */
  drive: (id: string) => Promise<string>;
}

const sentence = async (p: Promise<{ kind: string; error?: string }>): Promise<string> => {
  const outcome = await p;
  expect(outcome.kind, 'this door did not fail at all — every assertion below proves nothing')
    .toBe('failed');
  return outcome.error ?? '';
};

const DOORS: Door[] = [
  {
    name: 'issue create',
    arrange: a => { writeAnswer = a; },
    drive: id => sentence(postApprovedReport(id)),
  },
  {
    name: 'issue comment',
    arrange: a => { writeAnswer = a; },
    drive: id => sentence(postApprovedReport(id, { addToExisting: 42 })),
  },
  {
    name: 'duplicate search',
    arrange: a => { searchAnswer = a; },
    drive: id => sentence(postApprovedReport(id)),
  },
];

// GitHub's real 403 shape, field for field.
const REFUSAL_BODY = {
  message: 'Resource not accessible by personal access token',
  documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
  status: '403',
};
const HTML_BODY = '<html><head><title>403 Forbidden</title></head><body>request blocked</body></html>';

/** Body shapes a refusal can arrive in. `says` is null when GitHub named no cause at all. */
interface BodyShape { name: string; answer: () => Response; says: string | null; logCarries?: string }
const SHAPES: BodyShape[] = [
  { name: "GitHub's own 403 body", answer: () => jsonRes(403, REFUSAL_BODY), says: REFUSAL_BODY.message },
  {
    name: 'a body that will not parse', says: null, logCarries: 'request blocked',
    answer: () => new Response(HTML_BODY, { status: 403, headers: { 'content-type': 'text/html' } }),
  },
  { name: 'an empty body', says: null, answer: () => new Response('', { status: 403 }) },
  { name: 'JSON with no message at all', says: null, answer: () => jsonRes(403, { documentation_url: 'https://x.invalid' }) },
];

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  h.logLines = [];
  searchAnswer = () => jsonRes(200, { items: [] });
  writeAnswer = () => jsonRes(201, { number: 7, html_url: `https://github.com/${DOJO_REPORT_REPO_DEFAULT}/issues/7` });
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

// ── 1. THE PROVIDER'S WORDS SURVIVE ─────────────────────────────────────────────────────

describe("a refusal reaches the log in GitHub's own words", () => {
  for (const door of DOORS) {
    it(`${door.name}: a 403 puts GitHub's message and its help link in the log`, async () => {
      door.arrange(() => jsonRes(403, REFUSAL_BODY));
      const card = await door.drive(approved());

      const logged = h.logLines.join('\n');
      expect(logged.length, 'nothing was logged at all — the refusal left no trace').toBeGreaterThan(0);
      // ⚠ THE PARSED STATEMENT, not merely the bytes. `toContain(message)` alone is satisfied by
      // the unparsed-body fallback, which quotes the whole JSON verbatim — so a poster that threw
      // the PARSED body away would still ride this clause on the raw slice. Requiring
      // `GitHub said: …` means the field was read, which is the property T8 is about.
      expect(logged, "GitHub's own explanation of the refusal was discarded before logging")
        .toContain(`GitHub said: ${REFUSAL_BODY.message}`);
      expect(logged, "GitHub's documentation_url was discarded before logging")
        .toContain(`documentation_url=${REFUSAL_BODY.documentation_url}`);
      expect(logged, 'the log line does not say which status GitHub answered with').toContain('403');

      // The owner's sentence is plain English AND carries GitHub's words: they are the only
      // person who can re-grant a scope, and they cannot fix what nobody tells them.
      expect(card, "the card sentence still hides GitHub's reason").toContain(REFUSAL_BODY.message);
      expect(card, 'the card sentence is a raw JSON body, not plain English').not.toContain('{');
    });
  }

  it('a 401 still reads as a revoked credential on the Settings card (T5 contract)', async () => {
    writeAnswer = () => jsonRes(401, { message: 'Bad credentials' });
    await DOORS[0].drive(approved());
    expect(getGithubAccount()?.lastError, 'the failure was never recorded').toBeTruthy();
    expect(githubStatus().reauthRequired,
      'GitHub refused the credential and the card still shows a working connection').toBe(true);
  });

  for (const door of DOORS.filter(d => d.name !== 'duplicate search')) {
    it(`${door.name}: GitHub's own message reaches the LEDGER, not just the log`, async () => {
      // ── THE C1 PROPERTY, AND THE HALF A FIXTURE TABLE CANNOT SEE ──
      // `github/status.ts` holds nine auth patterns and SIX of them match text only GITHUB writes
      // — `bad credentials`, `unauthorized`, `requires authentication`, `required scopes`,
      // `insufficient scope`, `not accessible by personal access token`. T5 put a 34-row fixture
      // table in front of that reader and every row was green, because every row was hand-written
      // INTO the reader. Nothing checked whether the column it reads had ever carried such a
      // sentence, and it had not: the first cut of `refusal.ts` recorded `(HTTP 403).` and stopped.
      // So this clause reads the COLUMN, after a real Post press, and requires the provider's own
      // words to be in it.
      door.arrange(() => jsonRes(403, REFUSAL_BODY));
      const card = await door.drive(approved());
      const ledger = getGithubAccount()?.lastError ?? '';
      expect(ledger, "the ledger column dropped GitHub's explanation on the floor")
        .toContain(REFUSAL_BODY.message);
      expect(ledger, 'the ledger no longer says which status GitHub answered with')
        .toContain('403');
      // ONE sentence for both audiences: the card shows what the ledger holds, so the owner and
      // the predicate are reading the same evidence and cannot disagree about it.
      expect(card, 'the card and the ledger tell two different stories about one refusal')
        .toBe(ledger);
      expect(ledger, 'a raw body reached a column the card renders verbatim').not.toContain('{');
    });
  }

  it('a 403 SCOPE refusal now reads as a reconnect — the defect C1 closes', async () => {
    // THE LIVE SHAPE THE MASKED PATTERNS WERE FOR. A revoked or missing scope is GitHub's 403
    // `Resource not accessible by personal access token`, and 403 carries no numeral this
    // predicate can use — so before C1 no pattern matched, `reauthRequired` stayed false, and the
    // Settings card told an owner whose token could no longer file anything that the connection
    // was working. The 401 case hid it: `(HTTP 401)` matches the status-word anchor on its own.
    writeAnswer = () => jsonRes(403, REFUSAL_BODY);
    await DOORS[0].drive(approved());
    expect(getGithubAccount()?.lastError ?? '', 'setup: the refusal was never recorded')
      .toContain(REFUSAL_BODY.message);
    expect(
      githubStatus().reauthRequired,
      'GitHub will not let this token file anything and the card still claims a working connection',
    ).toBe(true);
  });

  // ── AND THE DIRECTION C1 HAD TO NOT BREAK ──
  // Provider prose reaching a predicate is how a false YES is made, and a false YES tells an owner
  // their working connection is broken. Every row is a real GitHub body on a real transient,
  // driven through the real poster so the sentence measured is the sentence written.
  const TRANSIENTS: ReadonlyArray<readonly [string, () => Response]> = [
    ['a primary rate limit', () => jsonRes(403, {
      message: 'API rate limit exceeded for user ID 12345.',
      documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    })],
    ['a secondary rate limit', () => jsonRes(403, {
      message: 'You have exceeded a secondary rate limit and have been temporarily blocked from '
        + 'content creation. Please retry your request again later.',
    })],
    ['a 429', () => jsonRes(429, { message: 'Too Many Requests' })],
    ['a 500', () => jsonRes(500, { message: 'Server Error' })],
    ['a 502 behind an HTML error page', () =>
      new Response('<html><body>Bad gateway</body></html>', { status: 502 })],
    ['a 422 validation failure', () => jsonRes(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }],
    })],
  ];

  for (const [name, answer] of TRANSIENTS) {
    it(`${name} does NOT ask the owner to reconnect a connection that works`, async () => {
      writeAnswer = answer;
      await DOORS[0].drive(approved());
      expect(getGithubAccount()?.lastError, `setup: ${name} recorded nothing, so this proves nothing`)
        .toBeTruthy();
      expect(
        githubStatus().reauthRequired,
        `${name} was read as a revoked credential. That is the false YES the predicate is narrow `
        + 'against: it tells someone their working connection is broken and invites them to tear '
        + 'it down.',
      ).toBe(false);
      // ...and the connection is still reported as what it is.
      expect(githubStatus().connected, `${name} also lost the connection itself`).toBe(true);
    });
  }

  it('a dead socket is not a revoked credential either — the path that skips `refusal.ts`', async () => {
    // `issues.ts`'s `unreachable()` writes this column WITHOUT going through `refusal.ts`, so it
    // keeps its own sentence shape and has to be checked in it. A timeout is the most common
    // failure this box will ever record, and the most expensive one to misread.
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes('/search/issues')) return jsonRes(200, { items: [] });
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;
    await DOORS[0].drive(approved());
    expect(getGithubAccount()?.lastError ?? '', 'setup: the timeout recorded nothing')
      .toContain('timeout');
    expect(githubStatus().reauthRequired, 'a timeout was read as a revoked credential').toBe(false);
  });

  it('the mark CLEARS at every clear-point, so a fixed connection stops nagging', async () => {
    // Reachability bought an obligation: a mark that can now be raised by a 403 must be cleared by
    // the three things that end a failure. The upsert arm of `saveGithubAccount` is the one the
    // owner actually walks — the card said Reconnect, so the row already exists — and it clears
    // `last_error` in a different statement from the insert's.
    const raise = async (): Promise<void> => {
      writeAnswer = () => jsonRes(403, REFUSAL_BODY);
      await DOORS[0].drive(approved());
      expect(githubStatus().reauthRequired, 'setup: the mark was never raised').toBe(true);
    };

    await raise();
    writeAnswer = () => jsonRes(201, { number: 8, html_url: 'https://x.invalid/8' });
    const ok = await postApprovedReport(approved());
    expect(ok.kind, 'setup: the second post had to succeed to clear anything').toBe('created');
    expect(githubStatus().reauthRequired, 'a successful post left the reconnect prompt up')
      .toBe(false);

    await raise();
    saveGithubAccount('octocat', TOKEN, 'public_repo');       // the reconnect the card asked for
    expect(githubStatus().reauthRequired, 'reconnecting did not clear the prompt to reconnect')
      .toBe(false);

    await raise();
    disconnectGithub();
    expect(githubStatus().reauthRequired, 'a disconnected box still asks for a reconnect')
      .toBe(false);
  });

  it('an OK answer with an unreadable shape is NOT reported as a refusal', async () => {
    // `GitHub refused to file the issue (HTTP 201)` was the old sentence: a cause invented from
    // a status code that said the opposite. The honest answer is that the outcome is unknown.
    writeAnswer = () => jsonRes(201, { nothing: 'we can use' });
    const card = await DOORS[0].drive(approved());
    expect(card, 'a 201 was reported as a refusal').not.toContain('refused');
    expect(card, 'the sentence does not admit the outcome is unknown').toMatch(/may or may not/);
    expect(getGithubAccount()?.lastError ?? '', 'the ledger claims GitHub refused a 201')
      .not.toContain('refused');
  });
});

// ── 2. AN ABSENCE IS REPORTED AS AN ABSENCE ─────────────────────────────────────────────

describe('a refusal GitHub did not explain is reported as unexplained, never as a cause', () => {
  /** Causes a status code invites, none of which the platform may assert on its own. */
  const FABRICATIONS = ['scope', 'permission', 'rate limit', 'archived', 'not a collaborator'];

  for (const shape of SHAPES.filter(s => s.says === null)) {
    it(`${shape.name}: the log and the card say so honestly and name no cause`, async () => {
      DOORS[0].arrange(shape.answer);
      const card = await DOORS[0].drive(approved());

      const logged = h.logLines.join('\n');
      expect(logged, 'the log invented an explanation, or logged nothing').toContain(NO_EXPLANATION);
      expect(card, 'the card invented an explanation').toContain(NO_EXPLANATION);
      for (const guess of FABRICATIONS) {
        expect(logged.toLowerCase(), `the log asserted a cause GitHub never stated: "${guess}"`)
          .not.toContain(guess);
        expect(card.toLowerCase(), `the card asserted a cause GitHub never stated: "${guess}"`)
          .not.toContain(guess);
      }
    });
  }

  it('an unparseable body still reaches the log verbatim, labelled as unparsed', async () => {
    // The bounded slice IS the evidence for a failure nobody can reproduce on demand. It is
    // log-only: an HTML error page on a dashboard card is not plain English.
    DOORS[0].arrange(() => new Response(HTML_BODY, { status: 403 }));
    const card = await DOORS[0].drive(approved());
    const logged = h.logLines.join('\n');
    expect(logged, 'the unreadable body was thrown away instead of being quoted')
      .toContain('request blocked');
    expect(logged, 'the quoted body is not labelled as unparsed').toContain('would not parse');
    expect(card, 'raw HTML was put in front of the owner').not.toContain('<html>');
  });

  it('an empty body is distinguished from one that would not parse', async () => {
    DOORS[0].arrange(() => new Response('', { status: 403 }));
    await DOORS[0].drive(approved());
    expect(h.logLines.join('\n'), 'an empty body was reported as an unparseable one')
      .toContain('the body was empty');
  });
});

// ── 3. THE TOKEN IS IN NONE OF IT ───────────────────────────────────────────────────────

describe('no refusal path puts the credential in anything it emits', () => {
  it('sweeps every emitted line on every door, in every body shape', async () => {
    for (const door of DOORS) {
      for (const shape of SHAPES) {
        h.logLines = [];
        searchAnswer = () => jsonRes(200, { items: [] });
        writeAnswer = () => jsonRes(201, { number: 7, html_url: 'https://x.invalid/7' });
        door.arrange(shape.answer);
        const where = `${door.name} / ${shape.name}`;

        // Non-vacuity, both halves: a real token must be in play, or there is nothing to leak.
        expect(getGithubToken(), `${where}: setup — no token was in scope`).toBe(TOKEN);
        const card = await door.drive(approved());
        expect(h.logLines.length, `${where}: nothing was emitted — this sweep proves nothing`)
          .toBeGreaterThan(0);

        for (const line of h.logLines) {
          expect(line, `${where}: a log line carried the token`).not.toContain(TOKEN);
        }
        expect(card, `${where}: the owner's sentence carried the token`).not.toContain(TOKEN);
        expect(getGithubAccount()?.lastError ?? '', `${where}: the ledger column carried the token`)
          .not.toContain(TOKEN);
      }
    }
  });
});
