// ════════════════════════════════════════════════════════════════════════════════════════
// THE REFUSAL READERS, READ DIRECTLY (DOJO-REPORT T8 fix round).
//
// ── THE GAP THIS FILE CLOSES ──
// `refusal.ts` holds the rule that GitHub's own words are EVIDENCE, never a diagnosis: it reads
// a refused response, it never invents a cause, it never shows an unparsed body to the owner, and
// it never throws while reading. But every test that reaches that module has reached it through
// the ISSUE DOORS — `a-label-github-silently-dropped-…` and `the-github-card-reports-connection-
// truth` drive the real poster, and `a-refusal-carries-githubs-own-explanation` drives the whole
// graph. None calls the five readers themselves. So a regression in, say, the trimming, the raw
// bound, or the "an absence is reported as an absence" half could slip through while every door
// still read green, because the doors feed the readers shapes they happen to build and not the
// shapes the contract promises.
//
// ── WHAT THIS FILE MEASURES ──
// Each reader's contract, pinned at the reader and not at a door that assembles its input:
//   • readRefusal      — trims and reads `message` / `documentation_url` verbatim, bounds `raw`
//                        to REFUSAL_RAW_MAX, and absorbs EVERY way of failing to read (an empty
//                        body, an unparseable one, a JSON body with no `message`, a body stream
//                        that rejects) into `message: null` rather than throwing.
//   • githubsWords     — the OWNER sentence: plain English, GitHub's own `message`, its help link
//                        when one came, and the honest absence phrase otherwise — never the raw.
//   • refusalDetail    — the LOG line: status, message, link, and a bounded, LABELLED verbatim
//                        slice when the body would not parse; an empty body distinguished from it.
//   • reportRefusal    — logs in full, records the one owner sentence on the ledger, hands the
//                        caller that same sentence.
//   • reportUnreadableAnswer — a 201 is NOT a refusal: the ledger gets the short "could not be
//                        read" sentence, the card gets the long one that admits the outcome is
//                        unknown.
//
// ── THE LEDGER, MOCKED ──
// `noteGithubFailure` is the only thing here that would reach the database, so the ledger is the
// only module mocked: the readers are driven for real and the ledger call is what is asserted on.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The one destination that touches the ledger; nothing else here reads the database.
vi.mock('../account.js', () => ({ noteGithubFailure: vi.fn() }));

import { noteGithubFailure } from '../account.js';
import {
  readRefusal, githubsWords, refusalDetail, reportRefusal, reportUnreadableAnswer,
  type GithubRefusal,
} from '../refusal.js';

beforeEach(() => { vi.clearAllMocks(); });

// ── 1. READ: GITHUB'S OWN FIELDS, VERBATIM AND TRIMMED ─────────────────────────────────────

describe('readRefusal reads GitHub\'s own fields, trimmed, and the raw verbatim', () => {
  it('a 401 with a padded message and a help link', async () => {
    const body = '{"message":"  Bad credentials  ","documentation_url":"https://docs.github.com/rest"}';
    const got = await readRefusal(new Response(body, { status: 401 }));

    expect(got).toEqual({
      status: 401,
      message: 'Bad credentials',
      documentationUrl: 'https://docs.github.com/rest',
      raw: body,
    });
  });
});

// ── 2. READ: AN UNREADABLE BODY IS REPORTED, NEVER THROWN ──────────────────────────────────
// Every way of failing to read is absorbed into `message: null` so the refusal is still REPORTED
// rather than replaced by this box's own parse error. The raw survives intact where a raw arrived.

const UNREADABLE: ReadonlyArray<{ name: string; make: () => Response; expect: GithubRefusal }> = [
  {
    name: 'an HTML error page', make: () => new Response('<html>oops</html>', { status: 502 }),
    expect: { status: 502, message: null, documentationUrl: null, raw: '<html>oops</html>' },
  },
  {
    name: 'an empty body', make: () => new Response('', { status: 502 }),
    expect: { status: 502, message: null, documentationUrl: null, raw: '' },
  },
  {
    name: 'whitespace only', make: () => new Response('   ', { status: 502 }),
    expect: { status: 502, message: null, documentationUrl: null, raw: '   ' },
  },
  {
    name: 'a JSON array (no message field)', make: () => new Response('[1,2]', { status: 502 }),
    expect: { status: 502, message: null, documentationUrl: null, raw: '[1,2]' },
  },
  {
    // A JSON body that parses but whose `message` is not a string and whose link is blank: both
    // fields are "stated", and "stated" means a non-blank string — so both read as absent.
    name: 'JSON with a non-string message and a blank link',
    make: () => new Response('{"message":42,"documentation_url":"  "}', { status: 502 }),
    expect: {
      status: 502, message: null, documentationUrl: null, raw: '{"message":42,"documentation_url":"  "}',
    },
  },
  {
    // A body stream that REJECTS is the hardest way to fail: the read must not surface it as our
    // own error. It is absorbed into an empty raw, so the refusal is still reportable.
    name: 'a response whose body stream rejects',
    make: () => ({ status: 500, text: async () => { throw new Error('x'); } } as unknown as Response),
    expect: { status: 500, message: null, documentationUrl: null, raw: '' },
  },
];

describe('readRefusal reports an unreadable body as an absence, never throws', () => {
  for (const { name, make, expect: want } of UNREADABLE) {
    it(`${name}: null message, no documentation link, the raw preserved`, async () => {
      const got = await readRefusal(make());
      expect(got).toEqual(want);
    });
  }
});

// ── 3. READ: THE RAW IS BOUNDED ────────────────────────────────────────────────────────────

describe('readRefusal bounds the raw slice to REFUSAL_RAW_MAX', () => {
  it('a 400-character body is cut to 300', async () => {
    const got = await readRefusal(new Response('a'.repeat(400), { status: 502 }));
    expect(got.raw.length).toBe(300);
  });
});

// ── 4. githubsWords: THE OWNER'S PLAIN ENGLISH, NEVER THE RAW ───────────────────────────────

describe('githubsWords gives the owner plain English and nothing of the raw body', () => {
  it('says GitHub\'s own message when it came', () => {
    expect(githubsWords({
      status: 403, message: 'Resource not accessible by personal access token',
      documentationUrl: null, raw: '',
    })).toBe('GitHub said: Resource not accessible by personal access token');
  });

  it('appends the help link when GitHub sent one', () => {
    expect(githubsWords({
      status: 403, message: 'Resource not accessible by personal access token',
      documentationUrl: 'https://d.example/x', raw: '',
    })).toBe('GitHub said: Resource not accessible by personal access token (https://d.example/x)');
  });

  it('says the honest absence when GitHub named no cause, and never shows the raw', () => {
    // The raw is LOG ONLY: even an HTML error page in `raw` must not reach the owner's sentence.
    const words = githubsWords({
      status: 502, message: null, documentationUrl: null, raw: '<html>secret</html>',
    });
    expect(words).toBe('GitHub sent no readable explanation.');
    expect(words, 'the raw body reached the owner-facing sentence').not.toContain('<html>secret</html>');
  });
});

// ── 5. refusalDetail: EVERYTHING, FOR THE LOG ───────────────────────────────────────────────

describe('refusalDetail logs the status, the words, the link, and a labelled raw slice', () => {
  it('the status and the message, with no link', () => {
    expect(refusalDetail({
      status: 403, message: 'Nope', documentationUrl: null, raw: '',
    })).toBe('HTTP 403; GitHub said: Nope');
  });

  it('the status, the message and its documentation_url, with a link', () => {
    expect(refusalDetail({
      status: 403, message: 'Nope', documentationUrl: 'https://d.example/x', raw: '',
    })).toBe('HTTP 403; GitHub said: Nope documentation_url=https://d.example/x');
  });

  it('an empty body is distinguished from one that would not parse', () => {
    expect(refusalDetail({
      status: 502, message: null, documentationUrl: null, raw: '',
    })).toBe('HTTP 502; GitHub sent no readable explanation (the body was empty).');
    // A raw of only spaces reads as empty too — the slice is the trimmed body.
    expect(refusalDetail({
      status: 502, message: null, documentationUrl: null, raw: '   ',
    })).toBe('HTTP 502; GitHub sent no readable explanation (the body was empty).');
  });

  it('an unparseable body reaches the log verbatim, LABELLED as not parsed', () => {
    // The slice is the evidence for a failure nobody can reproduce on demand; the label keeps no
    // reader mistaking it for a diagnosis of the failure.
    const detail = refusalDetail({
      status: 502, message: null, documentationUrl: null, raw: '<html>oops</html>',
    });
    expect(detail).toBe(
      'HTTP 502; GitHub sent no readable explanation (the body would not parse). '
      + 'Body verbatim, first 300 bytes: <html>oops</html>',
    );
  });
});

// ── 6. reportRefusal: LOG IN FULL, LEDGER ONE SENTENCE, CALLER THE SAME ────────────────────

describe('reportRefusal logs in full, records one sentence on the ledger, hands the caller it', () => {
  it('a 403 with a message', async () => {
    const out = await reportRefusal('file the issue', new Response('{"message":"Nope"}', { status: 403 }));

    expect(out).toEqual({
      ok: false,
      error: 'GitHub refused to file the issue (HTTP 403). GitHub said: Nope',
    });
    expect(noteGithubFailure).toHaveBeenCalledTimes(1);
    expect(noteGithubFailure).toHaveBeenCalledWith('GitHub refused to file the issue (HTTP 403). GitHub said: Nope');
  });
});

// ── 7. reportUnreadableAnswer: A 201 IS NOT A REFUSAL ───────────────────────────────────────

describe('reportUnreadableAnswer reports an unread answer as unknown, not as a refusal', () => {
  it('a 201 the box could not read', () => {
    const out = reportUnreadableAnswer('file the issue', 201);
    const prefix = "GitHub's answer could not be read (HTTP 201).";

    expect(out.ok).toBe(false);
    // The card sentence admits the outcome is unknown and tells the owner what to do.
    expect(out.error.startsWith(prefix), 'the card no longer admits the answer was unread').toBe(true);
    expect(out.error).toContain('check it before sending again');

    // The LEDGER keeps the short form only — the "may or may not have reached" second sentence is
    // card text, not a sentence the connection predicate should ever have to read.
    expect(noteGithubFailure).toHaveBeenCalledTimes(1);
    expect(noteGithubFailure).toHaveBeenCalledWith(prefix);
  });
});
