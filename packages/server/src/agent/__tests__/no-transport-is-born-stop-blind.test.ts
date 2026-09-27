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
    'github/issues.ts': 'THE CALL IS THE DELIVERY: the owner pressed Post on a report card; their stop of an agent must not tear the issue in half',
    'google/auth.ts': 'NO AGENT: the OAuth token exchange that PRECEDES any agent call — cutting it would make the stop look like an auth failure',
    'microsoft/auth.ts': 'NO AGENT: same as the Google token exchange',
    'google/tools-slides.ts': 'RIDES THE DOOR ALREADY: its media uploads go through `googleWrite`/`googleSilentFetch`, which register; the bare `fetch` left here is the image byte-read it feeds them',
    'microsoft/tools-office.ts': 'RIDES THE DOOR ALREADY: Graph traffic goes through `msGraphRead`/`msGraphWrite`',
    'microsoft/tools-read.ts': 'RIDES THE DOOR ALREADY: every Graph read goes through `msGraphRead`, which registers; the bare `fetch` here is an attachment byte-read off a signed URL Graph handed back',
    'microsoft/tools-write.ts': 'RIDES THE DOOR ALREADY: every Graph write goes through `msGraphWrite`, which registers; the bare `fetch` here is an upload-session PUT to the URL Graph just issued',
    'memory/embeddings.ts': 'NOT A TURN\'S WORK: the embedder runs on the platform\'s own clock over the whole corpus; a stop pressed in one chat must not derail another agent\'s recall',
    'services/capabilities.ts': 'NO AGENT: an operator refreshing what a model can do, from Settings',
    'services/litellm-pricing-sync.ts': 'NO AGENT: the price index refresh, on a timer',
    'services/pricing-sync.ts': 'NO AGENT: the provider price refresh, on the platform\'s own timer, shared by every agent on the box',
    'services/num-ctx-calculator.ts': 'NO AGENT: a local sizing probe against Ollama, run at model registration',
    'services/ollama.ts': 'NO AGENT: local model management (list/pull/delete) from Settings',
    'twilio/client.ts': 'THE CALL IS THE DELIVERY: an SMS already committed to. A stop that half-sent a message would be worse than one that let it finish',
    'twilio/sms-inbound.ts': 'THE AGENT IS NOT WAITING: the webhook ack owed to Twilio, not work an agent asked for',
    'update/artifact-integrity.ts': 'NO AGENT: the updater verifying what it downloaded',
    'voice/model-manager.ts': 'NO AGENT: voice model download/management',
    'voice/smart-turn.ts': 'NOT A TURN\'S WORK: the live-voice turn detector, on the audio clock; cutting it would freeze the mic rather than stop an agent',
    'voice/stt-service.ts': 'NOT A TURN\'S WORK: the live-voice transcriber, same clock',
    'agent/tools/definitions.ts': 'NOT A CALL: the string `fetch(` appears in a tool DESCRIPTION the model reads',
  };

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
    ];
    for (const rel of WIRED) {
      expect(/openAgentCall\(/.test(codeOf(rel)), `${rel} lost its registration`).toBe(true);
      expect(EXEMPT[rel], `${rel} is BOTH wired and exempt — the exemption is a lie`).toBeUndefined();
    }
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

  it('every exemption says WHY, in words, and not just "ok"', () => {
    const thin = Object.entries(EXEMPT).filter(([, why]) => why.trim().length < 40);
    expect(thin.map(([rel]) => rel), 'an exemption with no argument in it is not an exemption').toEqual([]);
  });
});
