// ════════════════════════════════════════════════════════════════════════════════════════
// A-6 — THE WEB AND WORKSPACE TRANSPORTS ANSWER TO THE STOP BUTTON TOO.
//
// A-5 made the four media dials abortable and left a ledger line saying the rest of the
// family still had the old blindness: *"web_fetch/site-snapshot and the Microsoft/Google
// transport calls have the same old stop-blindness the media dials had; the fix machinery
// (openAgentCall) is built and waiting"*. Four more `fetch` sites, each carrying nothing but
// its own flat clock, so a stop pressed while a page, a Graph read or a Drive upload was on
// the wire found an empty registry for that work and cut nothing.
//
// THE THREE THINGS EVERY CLAUSE HERE PROVES, the same three A-5's suite proves, because a
// receipt for one of them is what the defect wore while it survived:
//
//   1. THE HTTP CALL IS CUT — the signal handed to `fetch` is aborted, which is the only
//      thing that stops bytes moving and money being spent. Every clause reads the signal
//      the stub was actually handed, never the promise's fate.
//
//   2. THE IDENTITY IS HONEST. A stop is not a provider failure, and in THIS family the risk
//      was measured, not feared: `web-tools.ts` owns a friendly-error ladder that turns an
//      `AbortError` into *"Couldn't reach <url> — request timed out. The server is slow or
//      unresponsive."* — the user's own button wearing a provider's failure, with a retry
//      implied. §2 pins the words on both sides of that ladder.
//
//   3. THE CALLER'S OWN CLOCK STILL WORKS AND IS NOT A STOP. Every one of these sites had a
//      deadline before this change and keeps it, COMPOSED rather than replaced — so §6
//      measures a real deadline firing through the composition and `cutByStop()` refusing to
//      claim it.
//
// ── AND §7, THE CENSUS, WHICH IS THE POINT OF THE WHOLE FILE ──
// Wiring four files fixes four files. The census is what makes the NEXT tool unable to be
// born stop-blind: every production module that calls `fetch(` either registers through
// `openAgentCall` or is named in `EXEMPT` with a written reason, and a file that is neither
// fails this test on the day it is added. The exemption table is exact in both directions —
// a stale row fails too — so it cannot rot into a list nobody re-reads.
//
// No real provider is contacted: `globalThis.fetch` is stubbed in every clause.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AGENT = 'kevin-a6';

// ── the two transports' surroundings, stubbed so the TRANSPORT is what runs ──────────────
vi.mock('../../google/auth.js', () => ({ getValidAccessTokenForAccount: async () => 'ya29.fake-token' }));
vi.mock('../../microsoft/auth.js', () => ({ getValidAccessTokenForAccount: async () => 'eyJ.fake-token' }));
vi.mock('../../google/accounts.js', () => ({ getGoogleAccount: () => ({ kind: 'agent', email: 'a@b.test' }) }));
vi.mock('../../microsoft/accounts.js', () => ({ getMicrosoftAccount: () => ({ kind: 'agent', email: 'a@b.test' }) }));
vi.mock('../../google/activity-log.js', () => ({ logGoogleActivity: () => {} }));
vi.mock('../../microsoft/activity-log.js', () => ({ logMicrosoftActivity: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/outbound.js', () => ({
  recordAtDoor: () => null, inOutboundScope: () => false, recordedId: () => null,
}));
vi.mock('../../config/loader.js', () => ({ getSearchApiKey: () => 'brave-fake-key' }));
// The embedder reads its provider row before it dials (L2-3's path); nothing else here needs a db.
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }),
  closeDb: () => {},
  getDbPath: () => '/tmp/dojo-a6-census.db',
}));
vi.mock('../permissions.js', () => ({ checkPermission: () => ({ allowed: true }) }));
vi.mock('../net-guard.js', () => ({
  assertPublicHttpTarget: async () => {},
  NetGuardError: class NetGuardError extends Error { address = '1.2.3.4'; },
}));

// ── the fetch stub, the A-5 suite's own shape ───────────────────────────────────────────

interface Dial { url: string; signal: AbortSignal | undefined }
let dials: Dial[] = [];
const realFetch = globalThis.fetch;

/** Every request hangs until its signal aborts, then rejects the way undici does. */
function hangUntilAborted(): void {
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    dials.push({ url: String(input), signal });
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('This operation was aborted', 'AbortError')); return; }
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('This operation was aborted', 'AbortError')),
        { once: true },
      );
    });
  }) as unknown as typeof globalThis.fetch;
}

/** A redirect chain that hangs from `hangAt` onward, so a stop can land between hops. */
function redirectThenHang(hangAt: number): void {
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const n = dials.length;
    dials.push({ url: String(input), signal });
    if (n < hangAt) {
      return Promise.resolve(new Response(null, {
        status: 302, headers: { location: `https://example.test/hop${n + 1}` },
      }));
    }
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('This operation was aborted', 'AbortError')),
        { once: true },
      );
    });
  }) as unknown as typeof globalThis.fetch;
}

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function untilDialled(n = 1): Promise<void> {
  for (let i = 0; i < 200 && dials.length < n; i += 1) await tick(5);
}

/** The USER'S STOP, spelled exactly as `runtime.ts`'s `stopAgent` spells it. */
async function stopNow(): Promise<number> {
  const { abortInFlight } = await import('../shared-state.js');
  return abortInFlight(AGENT, 'user-stop', { scope: 'all' });
}

beforeEach(() => {
  vi.resetModules();
  dials = [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const s = await import('../shared-state.js');
  s.stoppedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
});

// ── §1 — web_search ──────────────────────────────────────────────────────────────────────

describe('§1 a stop cuts web_search on the wire', () => {
  it('aborts the signal the search was dialled with, and says who did it', async () => {
    hangUntilAborted();
    const { webSearch } = await import('../web-tools.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');

    const inFlight = webSearch(AGENT, { query: 'anything' });
    await untilDialled();
    expect(dials.length, 'the search never reached the wire — nothing to stop').toBe(1);

    const cut = await stopNow();
    expect(cut, 'the stop found no registration for the search').toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the search request was not cut').toBe(true);
    await expect(inFlight).resolves.toBe(STOPPED_BY_USER);
  });

  it('refuses at the door while a stop is already standing — no dial at all', async () => {
    hangUntilAborted();
    const { webSearch } = await import('../web-tools.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');
    const { stoppedAgents } = await import('../shared-state.js');
    stoppedAgents.add(AGENT);

    await expect(webSearch(AGENT, { query: 'anything' })).resolves.toBe(STOPPED_BY_USER);
    expect(dials.length, 'a stopped agent still put a search on the wire').toBe(0);
  });
});

// ── §2 — web_fetch, and the friendly ladder that used to swallow the identity ───────────

describe('§2 a stop cuts web_fetch, and is not renamed a provider failure', () => {
  it('cuts the request and returns the stop sentence, NOT the timeout wording', async () => {
    hangUntilAborted();
    const { webFetch } = await import('../web-tools.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');

    const inFlight = webFetch(AGENT, { url: 'https://example.test/page', prompt: 'x' });
    await untilDialled();
    const cut = await stopNow();

    expect(cut).toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the page request was not cut').toBe(true);
    const out = await inFlight;
    expect(out).toBe(STOPPED_BY_USER);
    // ⚠ THE DEFECT'S OWN WORDS. This is the sentence the ladder produces for an AbortError.
    expect(out, 'the user\'s stop was reported as the server being slow').not.toContain('timed out');
    expect(out).not.toContain("Couldn't reach");
  });

  it('a stop between redirect hops is not survived by the next hop', async () => {
    redirectThenHang(2);
    const { webFetch } = await import('../web-tools.js');

    const inFlight = webFetch(AGENT, { url: 'https://example.test/hop0', prompt: 'x' });
    await untilDialled(3);
    await stopNow();
    await inFlight;

    // One slot covers the whole loop, so the cut lands on the hop in flight and the loop
    // cannot walk on. Without that, hop 4 and hop 5 would still be dialled after the stop.
    expect(dials.length, 'the redirect loop kept walking after the stop').toBe(3);
    expect(dials[2].signal?.aborted).toBe(true);
  });
});

// ── §3/§4 — the two workspace transports ────────────────────────────────────────────────

describe('§3 a stop cuts the Google transport', () => {
  it('cuts the request and answers with the stop sentence, not a transport error', async () => {
    hangUntilAborted();
    const { googleRead } = await import('../../google/client.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');

    const inFlight = googleRead('https://www.googleapis.com/drive/v3/files', AGENT, 'Kevin', 'drive_list', {});
    await untilDialled();
    const cut = await stopNow();

    expect(cut, 'the Google call registered nothing for the stop to find').toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the Graph/Drive request was not cut').toBe(true);
    const res = await inFlight;
    expect(res.ok).toBe(false);
    expect(res.error, 'a stop was reported as a transport failure').toBe(STOPPED_BY_USER);
  });

  it('a call with no agentId still dials — platform plumbing has no owner to be stopped by', async () => {
    hangUntilAborted();
    const { googleSilentFetch } = await import('../../google/client.js');
    void googleSilentFetch('GET', 'https://www.googleapis.com/oauth2/v1/tokeninfo');
    await untilDialled();
    expect(dials.length, 'an ownerless plumbing call was refused a dial').toBe(1);
    const cut = await stopNow();
    expect(cut, 'an ownerless call was registered against this agent anyway').toBe(0);
  });
});

describe('§4 a stop cuts the Microsoft transport', () => {
  it('cuts the request and answers with the stop sentence', async () => {
    hangUntilAborted();
    const { msGraphRead } = await import('../../microsoft/client.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');

    const inFlight = msGraphRead('me/messages', AGENT, 'Kevin', 'outlook_list', {});
    await untilDialled();
    const cut = await stopNow();

    expect(cut).toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the Graph request was not cut').toBe(true);
    const res = await inFlight;
    expect(res.ok).toBe(false);
    expect(res.error).toBe(STOPPED_BY_USER);
  });
});

// ── §5 — the site snapshot's embeddability probe ────────────────────────────────────────

describe('§5 a stop cuts the canvas\'s embeddability probe', () => {
  it('cuts the probe, and a stop standing at the door skips it entirely', async () => {
    hangUntilAborted();
    const { isEmbeddable } = await import('../site-snapshot.js');

    const inFlight = isEmbeddable('https://example.test/site', AGENT);
    await untilDialled();
    await stopNow();
    expect(dials[0].signal?.aborted, 'the probe was not cut').toBe(true);
    // The probe fails SAFE: "let the iframe try" rather than sending a just-stopped agent on
    // to the heavier screenshot path.
    await expect(inFlight).resolves.toBe(true);

    dials = [];
    const { stoppedAgents } = await import('../shared-state.js');
    stoppedAgents.add(AGENT);
    await expect(isEmbeddable('https://example.test/site', AGENT)).resolves.toBe(true);
    expect(dials.length, 'a stopped agent still probed').toBe(0);
  });
});

// ── §6 — the composed clock still fires, and is not a stop ──────────────────────────────

describe('§6 composing the stop onto a deadline leaves the deadline working', () => {
  it('the caller\'s own deadline reaches fetch and does NOT read as the user\'s stop', async () => {
    const { openAgentCall } = await import('../abortable-call.js');
    const slot = openAgentCall(AGENT, 'turn', AbortSignal.timeout(20));
    try {
      expect(slot.signal.aborted).toBe(false);
      await new Promise<void>((r) => { slot.signal.addEventListener('abort', () => r(), { once: true }); });
      expect(slot.signal.aborted, 'the composed deadline never fired').toBe(true);
      expect(slot.cutByStop(), 'a deadline is not the user pressing stop').toBe(false);
      expect(slot.cutBy(), 'a deadline must not be attributed to anybody').toBeNull();
    } finally {
      slot.release();
    }
  });

  it('every wired transport releases its slot — the registry is empty after a clean call', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      dials.push({ url: String(input), signal: init?.signal ?? undefined });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const { googleRead } = await import('../../google/client.js');
    const { msGraphRead } = await import('../../microsoft/client.js');
    const { countAbortable } = await import('../shared-state.js');

    await googleRead('https://www.googleapis.com/drive/v3/files', AGENT, 'Kevin', 'drive_list', {});
    await msGraphRead('me/messages', AGENT, 'Kevin', 'outlook_list', {});
    // A leaked slot is worse than a missing one once A-5b makes this count something a USER
    // reads: it would show a Stop button for work that finished minutes ago.
    expect(countAbortable(AGENT, 'all'), 'a transport leaked its registration').toBe(0);
  });
});

// ── §6b — THE GRAPH BYTE DOOR (fix round, review L2-1) ──────────────────────────────────

describe('§6b a stop cuts the Graph calls that do NOT go through the wrapped door', () => {
  it('cuts the call, names the stop, and gives a clockless site a clock', async () => {
    hangUntilAborted();
    const { graphFetch, GRAPH_TIMEOUT_MS } = await import('../../microsoft/graph-fetch.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');

    // The shape the reviewer measured eleven of in `tools-office.ts`: no `signal` at all.
    const inFlight = graphFetch(AGENT, 'https://graph.microsoft.com/v1.0/me/drive/items/x/content');
    await untilDialled();
    expect(dials.length, 'the Graph call never reached the wire').toBe(1);
    expect(dials[0].signal, 'a site that brought no clock was dialled without one').toBeTruthy();

    const cut = await stopNow();
    expect(cut, 'the stop found no registration for the Graph call').toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the Graph call was not cut').toBe(true);
    await expect(inFlight).rejects.toThrow(STOPPED_BY_USER);
    expect(GRAPH_TIMEOUT_MS, 'the default deadline must be finite').toBeGreaterThan(0);
  });

  it('refuses at the door under a standing stop, and releases on every exit', async () => {
    hangUntilAborted();
    const { graphFetch } = await import('../../microsoft/graph-fetch.js');
    const { STOPPED_BY_USER } = await import('../abortable-call.js');
    const { stoppedAgents, countAbortable } = await import('../shared-state.js');

    stoppedAgents.add(AGENT);
    await expect(graphFetch(AGENT, 'https://graph.microsoft.com/v1.0/me')).rejects.toThrow(STOPPED_BY_USER);
    expect(dials.length, 'a stopped agent still dialled Graph').toBe(0);
    expect(countAbortable(AGENT, 'all'), 'the refused slot was never released').toBe(0);

    stoppedAgents.clear();
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      dials.push({ url: String(input), signal: init?.signal ?? undefined });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    await graphFetch(AGENT, 'https://graph.microsoft.com/v1.0/me');
    expect(countAbortable(AGENT, 'all'), 'a clean Graph call leaked its registration').toBe(0);
  });

  it('an ownerless Graph call still dials, and registers against nobody', async () => {
    hangUntilAborted();
    const { graphFetch } = await import('../../microsoft/graph-fetch.js');
    void graphFetch(undefined, 'https://graph.microsoft.com/v1.0/me').catch(() => {});
    await untilDialled();
    expect(dials.length).toBe(1);
    expect(await stopNow(), 'an ownerless call was registered against this agent').toBe(0);
  });

  it('the three files the reviewer measured now reach Graph ONLY through the door', () => {
    // The L2-1 finding in one clause: no bare `fetch(` may remain in any of them, and each
    // must name the door. `codeOf` strips comments, so the prose above cannot satisfy it.
    for (const rel of ['microsoft/tools-office.ts', 'microsoft/tools-read.ts', 'microsoft/tools-write.ts']) {
      const src = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/\bgraphFetch\(/.test(src), `${rel} does not reach the Graph door`).toBe(true);
      const bare = src.split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /(?<!graph)(?<![A-Za-z])fetch\s*\(/.test(l) && !/graphFetch\(/.test(l));
      expect(
        bare.map(({ l, i }) => `${rel}:${i + 1} — ${l.trim()}`),
        'a bare Graph fetch is back — that is the L2-1 defect, which was ELEVEN clockless, '
        + 'unstoppable calls on an agent\'s tool path inside a file the census called handled',
      ).toEqual([]);
    }
  });
});

// ── §6c — THE EMBEDDER, ON THE PATH AN AGENT WAITS ON (review L2-3) ────────────────────

describe('§6c a stop cuts an embedding the agent is waiting on', () => {
  it('cuts the dial, and releases — a leaked slot is a Stop button for work that finished', async () => {
    hangUntilAborted();
    const { generateEmbedding } = await import('../../memory/embeddings.js');
    const { countAbortable } = await import('../shared-state.js');

    const inFlight = generateEmbedding('a query the agent is waiting on', { agentId: AGENT }).catch(() => null);
    await untilDialled();
    expect(dials.length, 'the embedder never dialled').toBe(1);
    expect(countAbortable(AGENT, 'all'), 'the embedding registered nothing').toBe(1);

    const cut = await stopNow();
    expect(cut, 'the stop found no registration for the embedding').toBeGreaterThan(0);
    expect(dials[0].signal?.aborted, 'the embedding request was not cut').toBe(true);
    await inFlight;
  });

  it('releases on a CLEAN embedding — the leak a stop would have hidden', async () => {
    // ⚠ WHY THIS IS A SEPARATE CLAUSE, measured: `abortInFlight` DELETES each controller from
    // the registry as it aborts it, so after a stop the count is 0 whether the caller released
    // or not. A planted leak therefore survives the clause above and dies here. The stake is
    // A-5b: a registration that outlives its work renders as a Stop button for work that is over.
    const { generateEmbedding } = await import('../../memory/embeddings.js');
    const { countAbortable } = await import('../shared-state.js');
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      dials.push({ url: String(input), signal: init?.signal ?? undefined });
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    await generateEmbedding('a query that succeeds', { agentId: AGENT });
    expect(dials.length, 'nothing was dialled — the clause would be vacuous').toBe(1);
    expect(countAbortable(AGENT, 'all'), 'the embedder leaked its registration').toBe(0);
  });

  it('the corpus sweep still dials with no owner — "not a turn\'s work" is true of THAT path', async () => {
    hangUntilAborted();
    const { generateEmbedding } = await import('../../memory/embeddings.js');
    void generateEmbedding('a background summary').catch(() => null);
    await untilDialled();
    expect(dials.length).toBe(1);
    expect(await stopNow(), 'a background embedding was registered against this agent').toBe(0);
  });
});

// ── §7 — THE CENSUS ─────────────────────────────────────────────────────────────────────

describe('§7 the census: no fetch-bearing module is stop-blind by accident', () => {
  /** Every production .ts under the server's src, tests excluded. */
  function walkSources(dir = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(SRC_ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        out.push(...walkSources(rel));
      } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
        out.push(rel);
      }
    }
    return out;
  }

  const textOf = (rel: string) => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
  /** Comments stripped: a `fetch(` inside a prose paragraph is not a call. */
  const codeOf = (rel: string) =>
    textOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /**
   * THE EXEMPTIONS, EACH ONE A SENTENCE SOMEBODY HAD TO WRITE.
   *
   * Three kinds, and the KIND is the argument — not the file name:
   *
   *  · NO AGENT EXISTS. Platform plumbing: a boot probe, a price index refresh, an OAuth
   *    token exchange, an update download. There is no agent whose stop could apply, and
   *    inventing one would make `countAbortable` — which A-5b turns into something a user
   *    READS — report work no agent is doing.
   *  · THE CALL IS THE STOP, or the delivery of one. Registering it would let a stop abort
   *    the request that enacts it, which is the one shape that cannot be allowed.
   *  · THE AGENT IS NOT WAITING. A watcher's poll and an inbound webhook's reply are the
   *    platform's own clock, not a turn's work; cutting them on a stop would silence the box.
   */
  const EXEMPT: Record<string, string> = {
    'agent/model.ts': 'the model transport — T83 registered it directly through the registry, before this door existed; it is the one caller that already had the property this census checks for',
    'gateway/routes/config.ts': 'NO AGENT: an operator in Settings validating a provider key from the dashboard',
    'gateway/routes/setup-deps.ts': 'NO AGENT: first-run dependency install, driven by the installer',
    'gateway/routes/system.ts': 'NO AGENT: the health page probing the box itself',
    'gateway/routes/update.ts': 'NO AGENT: the updater fetching a release; an agent stop must not corrupt a half-downloaded artifact',
    'github/device-flow.ts': 'NO AGENT: the owner authorising a device code in a browser',
    'github/issues.ts': 'THE CALL IS THE DELIVERY: all four sites are inside the post flow behind the owner\'s own Post button — including the dedupe GET, whose only caller is `report/post.ts` (the reviewer attacked this one specifically and it held)',
    'google/auth.ts': 'NO AGENT: the OAuth token exchange that PRECEDES any agent call — cutting it would make the stop look like an auth failure',
    'microsoft/auth.ts': 'NO AGENT: same as the Google token exchange',
    'google/tools-slides.ts': 'RIDES THE DOOR ALREADY, and this one was MEASURED as true: nine wrapped calls through `googleWrite`/`googleSilentFetch`, and the single bare `fetch` is the `thumbData.contentUrl` byte-read off a URL Slides just handed back',
    'services/capabilities.ts': 'NO AGENT: an operator refreshing what a model can do, from Settings',
    'services/litellm-pricing-sync.ts': 'NO AGENT: the price index refresh, on a timer',
    'services/pricing-sync.ts': 'NO AGENT: the provider price refresh, on the platform\'s own timer, shared by every agent on the box',
    'services/num-ctx-calculator.ts': 'NO AGENT: a local sizing probe against Ollama, run at model registration',
    'services/ollama.ts': 'NO AGENT: local model management (list/pull/delete) from Settings',
    'twilio/client.ts': 'TWO KINDS IN ONE FILE (review L2-4). `sendSms` is THE CALL IS THE DELIVERY — an SMS already committed to, where half-sending is worse than finishing; its callers are the channel push and the turn-closure sweep. The second site, `testTwilioCredentials`, is NO AGENT — an operator in Settings pressing Test. `endCall` is neither a delivery nor an agent\'s wait. The file needs both sentences, so here are both',
    'twilio/sms-inbound.ts': 'THE AGENT IS NOT WAITING: the webhook ack owed to Twilio, not work an agent asked for',
    'update/artifact-integrity.ts': 'NO AGENT: the updater verifying what it downloaded',
    'voice/model-manager.ts': 'NO AGENT: voice model download/management',
    'voice/smart-turn.ts': 'NOT A TURN\'S WORK: the live-voice turn detector, on the audio clock; cutting it would freeze the mic rather than stop an agent',
    'voice/stt-service.ts': 'NOT A TURN\'S WORK: the live-voice transcriber, same clock',
    'agent/tools/definitions.ts': 'NOT A CALL: the string `fetch(` appears in a tool DESCRIPTION the model reads',
  };

  /**
   * ⚠ EVERY FETCH SITE IN THE TREE, COUNTED — THE HOLE THE REVIEWER WALKED THROUGH (L2-2).
   *
   * The first cut of this census made an exemption into PERMANENT, FILE-WIDE IMMUNITY. The
   * reviewer proved it: a clockless, unregistered `fetch` to `${GRAPH_BASE}` added to an exempt
   * file rode **27/27 GREEN**. MA6 proved a new FILE cannot be born stop-blind; nothing stopped
   * stop-blindness being ADDED to any of the exempt ones, because the shape clauses only walked
   * the wired list.
   *
   * An exemption is an argument about the sites that EXIST, so the sites that exist are pinned.
   * A new `fetch(` anywhere — wired file or exempt file — changes a number here and fails, and
   * the author has to do one of three things: wire it, widen the exemption's argument to cover
   * it honestly, or move the number and say why in the commit. That is the whole mechanism.
   */
  const FETCH_SITES: Record<string, number> = {
    'agent/model.ts': 1,
    'agent/site-snapshot.ts': 1,
    'agent/tools/definitions.ts': 1,
    'agent/web-tools.ts': 2,
    'gateway/routes/config.ts': 9,
    'gateway/routes/setup-deps.ts': 7,
    'gateway/routes/system.ts': 1,
    'gateway/routes/update.ts': 4,
    'github/device-flow.ts': 2,
    'github/issues.ts': 4,
    'google/auth.ts': 5,
    'google/client.ts': 1,
    'google/tools-slides.ts': 1,
    'memory/embeddings.ts': 2,
    'microsoft/auth.ts': 4,
    'microsoft/client.ts': 1,
    'microsoft/graph-fetch.ts': 1,
    'services/audio-generation.ts': 1,
    'services/capabilities.ts': 2,
    'services/image-generation.ts': 1,
    'services/litellm-pricing-sync.ts': 1,
    'services/num-ctx-calculator.ts': 2,
    'services/ollama.ts': 3,
    'services/pricing-sync.ts': 1,
    'services/transcription.ts': 2,
    'services/video-generation.ts': 4,
    'twilio/client.ts': 2,
    'twilio/sms-inbound.ts': 1,
    'update/artifact-integrity.ts': 1,
    'voice/model-manager.ts': 3,
    'voice/smart-turn.ts': 1,
    'voice/stt-service.ts': 2,
  };

  const fetchSites = (rel: string): number => (codeOf(rel).match(/\bfetch\s*\(/g) ?? []).length;

  const fetchBearing = (): string[] =>
    walkSources().filter((rel) => /\bfetch\s*\(/.test(codeOf(rel)));

  it('every fetch-bearing module either rides `openAgentCall` or carries a written exemption', () => {
    const files = fetchBearing();
    // Non-vacuity: a walk that found nothing would pass every clause below for free.
    expect(files.length, 'the source walk found no fetch at all').toBeGreaterThan(20);

    const blind = files.filter(
      (rel) => !/openAgentCall\(/.test(codeOf(rel)) && EXEMPT[rel] === undefined,
    );
    expect(
      blind,
      'a module calls `fetch` with no registration and no written exemption. If an agent waits '
      + 'on it, wire it through `openAgentCall` like the media dials and the four A-6 transports; '
      + 'if no agent can, add it to EXEMPT with the sentence that says why.',
    ).toEqual([]);
  });

  it('the four A-6 transports are wired, by name — the census cannot pass by exempting them', () => {
    const WIRED = [
      'agent/web-tools.ts', 'agent/site-snapshot.ts', 'google/client.ts', 'microsoft/client.ts',
      // ── ADDED BY THE FIX ROUND (review L2-1) ──
      // These three were EXEMPT with the sentence "RIDES THE DOOR ALREADY", and the reviewer
      // measured it false of all three: `tools-office.ts` called neither wrapper anywhere, with
      // eleven of its thirteen fetches carrying no signal at all. They are wired now — every
      // Graph call goes through `graph-fetch.ts`, which registers — so the exemption is gone
      // rather than reworded, and `memory/embeddings.ts` joins them for the same reason (L2-3).
      'microsoft/graph-fetch.ts', 'microsoft/tools-office.ts', 'microsoft/tools-read.ts',
      'microsoft/tools-write.ts', 'memory/embeddings.ts',
    ];
    for (const rel of WIRED) {
      // Either the file opens the slot itself, or every one of its calls goes through the
      // shared Graph door that does — `graphFetch` is `openAgentCall` with a Graph-shaped
      // preamble, and three of these files reach it that way.
      const src = codeOf(rel);
      expect(/openAgentCall\(|graphFetch\(/.test(src), `${rel} lost its registration`).toBe(true);
      expect(EXEMPT[rel], `${rel} is BOTH wired and exempt — the exemption is a lie`).toBeUndefined();
    }
  });

  // ⚠ THE CLAUSE THE FIRST CUT DID NOT HAVE, AND THE ONE THE REVIEWER'S RV1 WALKED PAST (L2-2).
  it('every fetch site in the tree is counted, exempt files included', () => {
    const files = fetchBearing();
    expect(files.length, 'the walk found nothing').toBeGreaterThan(20);

    const unpinned = files.filter(rel => FETCH_SITES[rel] === undefined);
    expect(
      unpinned,
      'a module gained its FIRST `fetch` and is in no table. Wire it through `openAgentCall`, or '
      + 'exempt it with a sentence that is true of it, and pin its site count either way.',
    ).toEqual([]);

    const moved = files
      .map(rel => ({ rel, now: fetchSites(rel), pinned: FETCH_SITES[rel] }))
      .filter(r => r.now !== r.pinned);
    expect(
      moved.map(r => `${r.rel}: pinned ${r.pinned}, now ${r.now}`),
      'the number of `fetch` sites in a file changed. An exemption argues about the calls that '
      + 'EXIST — it is not immunity for the next one. A NEW site must be wired through '
      + '`openAgentCall` (or the Graph door), or the exemption must be widened to cover it '
      + 'honestly; then move the number here in the same commit.',
    ).toEqual([]);

    const stalePins = Object.keys(FETCH_SITES).filter(rel => !files.includes(rel));
    expect(stalePins, 'a pinned file no longer calls `fetch` — drop its row').toEqual([]);
  });

  it('no wired transport hands `fetch` a BARE clock — that is the defect\'s own shape', () => {
    // `signal: AbortSignal.timeout(…)` with nothing else on it is what stop-blindness looks
    // like. The composed form reads `slot.signal` / `slot?.signal ?? …`, so the fallback is
    // allowed only on the ownerless branch, where there is no agent to compose with.
    const offenders: string[] = [];
    for (const rel of ['agent/web-tools.ts', 'agent/site-snapshot.ts', 'google/client.ts', 'microsoft/client.ts']) {
      codeOf(rel).split('\n').forEach((line, i) => {
        if (/signal:\s*AbortSignal\.timeout\(/.test(line) && !/slot\?\.signal\s*\?\?/.test(line)) {
          offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(offenders, 'a bare clock on a wired transport is a call the stop cannot reach').toEqual([]);
  });

  it('the exemption table is exact in both directions — a stale row fails too', () => {
    const files = new Set(fetchBearing());
    const stale = Object.keys(EXEMPT).filter((rel) => !files.has(rel));
    expect(
      stale,
      'EXEMPT names a module that no longer calls `fetch`. An exemption list nobody re-reads is '
      + 'how the last blindness survived four reviews — delete the row.',
    ).toEqual([]);
  });

  it('an exemption that covers two KINDS of call says both (review L2-4)', () => {
    // `twilio/client.ts` carried one sentence — THE CALL IS THE DELIVERY — for two different
    // things: `sendSms` (a message already committed to) and `testTwilioCredentials` (an
    // operator in Settings pressing Test). No stop-blindness gap, but a reader inheriting the
    // single-kind story would extend the wrong argument to the next call added to the file.
    const twilio = EXEMPT['twilio/client.ts'];
    expect(twilio, 'the twilio exemption vanished').toBeTruthy();
    expect(twilio, 'the delivery kind is not named').toContain('THE CALL IS THE DELIVERY');
    expect(twilio, 'the operator-in-Settings kind is not named').toContain('NO AGENT');
    expect(twilio, 'the second site is not identified').toContain('testTwilioCredentials');
    // And the file really does have two sites, so the clause is about something.
    expect(FETCH_SITES['twilio/client.ts']).toBe(2);
  });

  it('every exemption says WHY, in words, and not just "ok"', () => {
    const thin = Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 40);
    expect(thin.map(([rel]) => rel), 'an exemption with no argument in it is not an exemption').toEqual([]);
  });
});
