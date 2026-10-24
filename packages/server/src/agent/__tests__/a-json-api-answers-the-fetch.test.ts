// web_fetch CAN READ A JSON API.
//
// ── THE DEFECT THIS PINS ──
// `webFetch` sent one hardcoded, HTML-ONLY offer:
//
//   Accept: text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8
//
// Nothing in that list is a media type a JSON API serves, and nothing in it is a
// catch-all. A strict origin performing real content negotiation therefore reads it as
// "this client does not accept what I have" and answers **415 Unsupported Media Type**
// — so `web_fetch` could not read ANY JSON API at all. Measured against api.github.com
// (every endpoint tried, same answer): bare `text/html` → 415, `*/*` → 200,
// `application/json` → 200, `text/html,*/*;q=0.1` → 200.
//
// The fix appends `,*/*;q=0.1`. That is the MINIMAL measured form, and the low q is the
// whole point: HTML still wins the negotiation for ordinary web pages (a
// content-negotiating site keeps serving its human page, and `stripHtmlTags` keeps
// receiving the HTML it was written for), while a JSON-only origin finally has something
// it is permitted to answer with.
//
// ── WHAT THE ORIGIN STUB IS ──
// Not a canned 200. The stub below is a real (if small) content negotiator: it parses the
// Accept header the tool actually sent and refuses with 415 when that header cannot be
// satisfied by `application/json` — exactly the behaviour measured on GitHub's API. So
// this suite fails for the REASON the live API failed, not because a string stopped
// matching. Restore the bare header and every clause here goes red.
//
// TEST HYGIENE: DNS is mocked and `fetch` is replaced. Nothing here touches the network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: { lookup },
  lookup,
}));

vi.mock('../permissions.js', () => ({
  checkPermission: () => ({ allowed: true }),
}));
vi.mock('../../config/loader.js', () => ({
  getSearchApiKey: () => null,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import { webFetch } from '../web-tools.js';

// ── HTTP content negotiation, as much of RFC 9110 §12.5.1 as this needs ──

/**
 * The quality the given Accept header assigns to `mediaType`, or -1 when the header
 * cannot be satisfied by it at all (which is what makes an origin answer 415).
 * Matches all three shapes a media range can take: an exact `type/sub`, a subtype
 * wildcard `type/` + star, and the full catch-all star-slash-star.
 */
function acceptQuality(accept: string, mediaType: string): number {
  const [type, sub] = mediaType.split('/');
  let best = -1;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.trim().split(';').map((s) => s.trim());
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9.]+)$/.exec(p);
      if (m) q = Number(m[1]);
    }
    const [rangeType, rangeSub] = range.split('/');
    const matches =
      (rangeType === '*' && rangeSub === '*') ||
      (rangeType === type && rangeSub === '*') ||
      (rangeType === type && rangeSub === sub);
    if (matches) best = Math.max(best, q);
  }
  return best;
}

/** One issue, in the shape `GET /repos/:o/:r/issues?per_page=1` really returns. */
const ISSUES_PAYLOAD = [
  {
    number: 41,
    title: 'web_fetch cannot read a JSON API',
    state: 'open',
    labels: [{ name: 'bug' }],
  },
];

const JSON_API_URL = 'https://api.github.com/repos/d-cornerpin/dojo/issues?per_page=1';

describe('web_fetch against a JSON API', () => {
  const realFetch = globalThis.fetch;
  /** The Accept header of every request the tool made, in order. */
  let sentAccept: string[] = [];

  beforeEach(() => {
    sentAccept = [];
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '140.82.121.6', family: 4 }]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * A JSON-only origin that negotiates for real: it serves `application/json` and
   * NOTHING else, so a client whose Accept header excludes JSON gets 415 — the exact
   * behaviour measured on api.github.com.
   */
  function stubJsonOnlyOrigin(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get('accept') ?? '';
      sentAccept.push(accept);
      if (acceptQuality(accept, 'application/json') < 0) {
        return Promise.resolve(new Response('', { status: 415, statusText: 'Unsupported Media Type' }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(ISSUES_PAYLOAD), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    }) as typeof globalThis.fetch;
  }

  it('gets a 200 and hands the agent JSON it can still parse', async () => {
    stubJsonOnlyOrigin();

    const out = await webFetch('agent-under-test', { url: JSON_API_URL });

    // Not the tool's non-2xx guidance line. This is the clause the bare header broke.
    expect(out).not.toMatch(/returned HTTP 415/);
    expect(out).not.toMatch(/HTTP \d\d\d/);
    expect(out).toContain(`Fetched from ${JSON_API_URL}`);

    // The SHAPE survives: a JSON content-type is not run through the HTML stripper, so
    // what reaches the agent is still valid JSON with its fields intact.
    const body = out.slice(out.indexOf('\n\n') + 2);
    const parsed = JSON.parse(body) as typeof ISSUES_PAYLOAD;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].number).toBe(41);
    expect(parsed[0].labels[0].name).toBe('bug');
  });

  it('sends an Accept header a JSON origin can satisfy — while still preferring HTML', async () => {
    // Read the header the tool actually SHIPS, by driving it, rather than asserting
    // against a copy of the string: a test that keeps its own copy proves the copy.
    stubJsonOnlyOrigin();
    await webFetch('agent-under-test', { url: JSON_API_URL });
    expect(sentAccept).toHaveLength(1);
    const header = sentAccept[0];

    // (a) JSON is acceptable AT ALL. Below zero is the 415 that started this.
    expect(acceptQuality(header, 'application/json')).toBeGreaterThan(0);
    // (b) So is anything else an origin might hand back — a catch-all, not a JSON
    //     special case, because the next API to refuse us will serve something else.
    expect(acceptQuality(header, 'application/vnd.api+json')).toBeGreaterThan(0);
    expect(acceptQuality(header, 'text/csv')).toBeGreaterThan(0);
    // (c) HTML STILL WINS. This is what keeps `,*/*;q=0.1` from being rewritten as a
    //     bare `*/*`: an ordinary page must still negotiate to HTML.
    expect(acceptQuality(header, 'text/html')).toBe(1);
    expect(acceptQuality(header, 'text/html')).toBeGreaterThan(
      acceptQuality(header, 'application/json'),
    );
  });

  it('still reads an ordinary HTML page, tags stripped', async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      sentAccept.push(new Headers(init?.headers).get('accept') ?? '');
      return Promise.resolve(
        new Response('<html><body><p>hello world</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
    }) as typeof globalThis.fetch;

    const out = await webFetch('agent-under-test', { url: 'https://example.com/page' });

    expect(out).toMatch(/hello world/);
    expect(out).not.toMatch(/<p>/);
  });
});
