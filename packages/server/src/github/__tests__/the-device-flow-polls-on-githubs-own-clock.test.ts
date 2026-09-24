// ════════════════════════════════════════════════════════════════════════════════════════
// THE DEVICE FLOW POLLS ON GITHUB'S OWN CLOCK (DOJO-REPORT T4).
//
// Owner decision D3 — "GitHub integration built via device flow, public client ID only, no
// secret in the build" — is three separate promises wearing one sentence, and this file is
// the proof of each:
//
//   1. THE SCOPE IS THE MINIMUM AND IT IS ONE STRING. `public_repo`, never `repo`. The
//      narrowest thing a GitHub OAuth App can ask for that can still open an issue on a
//      public repository. The GitHub-App permission that would be narrower (`Issues: write`
//      on one repo) was measured and REFUSED: its user-to-server token expires and refreshing
//      it needs the client SECRET, which D3 forbids shipping.
//
//   2. EVERY WAIT IS GITHUB'S OWN DECLARED NUMBER. The `/login/device/code` response carries
//      `interval` and `expires_in`; the `slow_down` error carries a NEW `interval`. Our two
//      constants are a FLOOR and a CEILING that refuse an absurd server answer, and nothing
//      else. That is the NO-DOOMED-DIALS P2 test (census row 39) satisfied by DECLARATION,
//      not by a flat local constant.
//
//   3. WHEN IT STOPS, IT SAYS SO AND STAYS STOPPED. Expiry, denial, an unknown refusal or an
//      unreachable endpoint all END the loop with a sentence a person can act on. Nothing
//      re-dials, nothing auto-restarts, nothing retries in the background — P3. A user
//      pressing Connect again is a new human act, and it is the only restart there is.
//
// And the privacy half, which is RULING P5-R13 rather than D3: the token is sealed into
// `github_account` and is reachable from nowhere else. It never lands in `agent_credentials`
// (`credential_get` would hand it to any granted agent by name), never reaches a log line,
// never rides a broadcast frame, and never appears in an HTTP response body.
//
// ── WHAT THIS GUARD CAN AND CANNOT SEE (the day-one fixture table, T3's banked lesson) ──
//
// | Property | Seen how | Blind to |
// |---|---|---|
// | the scope we SEND | behaviourally — the stubbed `fetch` records the real form body | a scope added by a future second request built somewhere other than `startDeviceFlow` |
// | the scope we NAME | a source scan for wide-scope literals in `device-flow.ts` | a scope assembled from fragments (`'pub' + 'lic_repo'`), which is why the behavioural clause above is the primary and this one is the companion |
// | what the loop WAITS | behaviourally — fake timers, counting real token-endpoint calls between advances | a wait implemented with something other than a timer (a busy loop, `Atomics.wait`) |
// | when the loop STOPS | behaviourally — call counts stop growing, the flow goes null, a frame is broadcast | a second loop started by a module this file never imports |
// | the token at rest | behaviourally — the RAW column is read, bypassing the decode point | a second writer of the column in a module outside this test's imports (that is `secret-at-rest.test.ts` clause 4's census, which now names this column) |
// | the token in logs | behaviourally — every `createLogger` call in the whole import graph is captured, on every ending in the `endings` table **including the two arms of `fetchLogin`** (answers-without-a-login, and throws) | a write to stdout/stderr that does not go through `createLogger`; **and, the blind spot that actually bit: A BRANCH NO ROW DRIVES.** The capture is total over the graph and worth nothing on code never executed — a `tok:` leak on `fetchLogin`'s catch arm survived at 31/31 because no test made that call throw |
// | the token in a broadcast frame | behaviourally — every `broadcast()` call is captured and the WHOLE array is serialised, on all TEN endings in the `endings` table, each of which DECLARES the terminal frame it must emit so the ending's own frame is asserted to have fired (not merely that some frame did) | an ending added to the loop and not added to the `endings` table — though it would have to be added without a frame declaration to hide, since a declared frame that never fires is a failure; a frame emitted by a module this file does not import. **This row was MISSING in the first cut and the gap was real** — the only frame clause ran on the happy path, where `userAnswer` always named a user, so a `login ?? token` leak short-circuited and survived at 29/29 |
// | the token in a response body | behaviourally — the real Hono router is driven and its JSON is read as text, and the enumerated path list is asserted EQUAL to `githubRouter.routes` minus middleware (`ALL /*`, and the absence of any middleware today is itself pinned), so a new route on this router fails this file before it can go unchecked — **including one registered with `.all()`** | a route mounted on a DIFFERENT router, or onto this one through a computed/dynamic mount that never appears in `githubRouter.routes`; a response assembled outside these handlers. **The earlier version of this row claimed the only escape was a different router, and that was the THIRD overclaim this table has had to correct**: the filter discarded every `ALL`-method entry, so a real `.all('/leak', h)` handler returning the token hid on this very router at 33/33 |
// | the frame types the feature can emit | a SOURCE census of `broadcast({ type: 'github:…' })` over the whole server source, asserted equal to a declared four, each cross-checked against the `WsEvent` union and `EVENT_BATCHABLE` | a type built by concatenation or held in a variable; a frame broadcast by a package this scan does not cover. It answers "what CAN be emitted", which is why it is a source census and not a behavioural sweep — a sweep only ever proves what DID fire |
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({
  logLines: [] as string[],
  frames: [] as Array<Record<string, unknown>>,
}));

// Every logger in the import graph records into one array, so "the token never reaches a log
// line" is measured over the WHOLE graph and not over the two modules I happened to think of.
vi.mock('../../logger.js', () => {
  const rec = (level: string) => (msg: string, meta?: unknown): void => {
    h.logLines.push(`${level} ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`);
  };
  return {
    createLogger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }),
    setLogLevel: () => {},
    setLogBroadcast: () => {},
    readLogEntries: () => [],
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t4-github-device-flow', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { h.frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import {
  GITHUB_OAUTH_SCOPE, GITHUB_DEVICE_CODE_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL,
  DEVICE_POLL_MIN_INTERVAL_MS, DEVICE_POLL_MAX_LIFETIME_MS, DEVICE_HTTP_TIMEOUT_MS,
  verdictFor, startDeviceFlow, cancelDeviceFlow, deviceFlowInProgress,
} from '../device-flow.js';
import {
  saveGithubAccount, getGithubToken, getGithubAccount, disconnectGithub,
  noteGithubOk, noteGithubFailure, githubClientId,
} from '../account.js';
import { githubStatus } from '../status.js';
import { githubRouter } from '../../gateway/routes/github.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_ID = 'Ov23liFIXTURECLIENT';
/** An invented literal. No real token appears in this file. */
const TOKEN = 'gho_fixture-token-value-never-real';

const db = (): Database.Database => mockDb.current!;

/** Read the RAW column, bypassing the module's one decode point entirely. */
const rawToken = (): string | null =>
  (db().prepare('SELECT access_token FROM github_account WHERE id = 1').get() as
    { access_token: string | null } | undefined)?.access_token ?? null;

const setClientId = (value: string = CLIENT_ID): void => {
  db().prepare("INSERT INTO config (key, value) VALUES ('github_client_id', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(value);
};

// ── The stubbed GitHub ──

interface RecordedCall { url: string; body: string }
let calls: RecordedCall[] = [];
/** Token-endpoint answers, consumed in order; the last one repeats forever. */
let tokenAnswers: Array<Record<string, unknown>> = [];
let deviceCodeAnswer: Record<string, unknown> = {};
let userAnswer: Record<string, unknown> = { login: 'octocat' };

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    let payload: unknown;
    if (url === GITHUB_DEVICE_CODE_URL) payload = deviceCodeAnswer;
    else if (url === GITHUB_TOKEN_URL) payload = tokenAnswers.length > 1 ? tokenAnswers.shift() : tokenAnswers[0];
    else payload = userAnswer;
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const tokenCalls = (): number => calls.filter(c => c.url === GITHUB_TOKEN_URL).length;

/** Every route the response-body clause drives. Checked against `githubRouter.routes`. */
const ROUTE_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/status'], ['POST', '/connect'], ['POST', '/cancel-connect'], ['POST', '/disconnect'],
];

/** Wrap the installed fetch so ONE url throws, leaving every other answer intact. */
function throwOn(url: string, message: string): void {
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === url) {
      calls.push({ url: String(input), body: '' });
      throw new Error(message);
    }
    return (inner as typeof fetch)(input as never, init);
  }) as unknown as typeof fetch;
}

/** `GET /user` throws — a network error, a timeout, or a 5xx HTML page hitting `res.json()`. */
const throwOnUserCall = (): void => throwOn(GITHUB_USER_URL, 'socket hang up');
/** The token endpoint is unreachable. */
const throwOnTokenCall = (): void => throwOn(GITHUB_TOKEN_URL, 'connect ECONNREFUSED');

/** The owner clears the client id DURING the device-code round trip, between the two reads. */
function clearClientIdOnDeviceCode(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const res = await (inner as typeof fetch)(input as never, init);
    if (String(input) === GITHUB_DEVICE_CODE_URL) {
      db().prepare("DELETE FROM config WHERE key = 'github_client_id'").run();
    }
    return res;
  }) as unknown as typeof fetch;
}

/**
 * Every string literal in a source file, with comments removed first.
 *
 * A naive `/'([^']*)'/g` is WRONG here and quietly so: this module's header is full of prose
 * apostrophes ("GitHub's", "GitHub App's"), and the naive reader pairs one of those with the
 * next one and reads nonsense — it found no `public_repo` at all on its first run, i.e. the
 * whole refusal list was passing over an empty set. That is the exact shape of a census that
 * is green because it is blind, so the reader is a real (small) scanner and the clause that
 * uses it asserts non-vacuity before asserting anything else.
 */
function literalsIn(src: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let lit = '';
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === '\\') i++;
        lit += src[i];
      }
      i++; out.add(lit); continue;
    }
    i++;
  }
  return out;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  h.logLines = [];
  h.frames = [];
  calls = [];
  tokenAnswers = [{ error: 'authorization_pending' }];
  deviceCodeAnswer = {
    device_code: 'dc-fixture', user_code: 'WDJB-MJHT',
    verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  };
  userAnswer = { login: 'octocat' };
  installFetch();
  cancelDeviceFlow();
});

afterEach(() => {
  cancelDeviceFlow();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the scope is the minimum, and it is one string', () => {
  it('is exactly public_repo', () => {
    expect(GITHUB_OAUTH_SCOPE).toBe('public_repo');
  });

  it('never asks for anything wider', () => {
    for (const wide of ['repo', 'admin:org', 'admin:repo_hook', 'workflow', 'delete_repo',
      'write:packages', 'gist', 'user']) {
      expect(GITHUB_OAUTH_SCOPE.split(/[ ,]/)).not.toContain(wide);
    }
  });

  it('is the only scope string the module SENDS — measured on the real request body', async () => {
    // The primary clause, and it is behavioural rather than textual: whatever the module
    // believes about itself, this is the form body GitHub would receive.
    vi.useFakeTimers();
    setClientId();
    const started = await startDeviceFlow();
    expect(started.ok, 'the flow must start before its request can be inspected').toBe(true);

    const deviceCall = calls.find(c => c.url === GITHUB_DEVICE_CODE_URL);
    expect(deviceCall, 'the device-code endpoint must have been called').toBeDefined();
    const sent = new URLSearchParams(deviceCall!.body);
    expect(sent.getAll('scope')).toEqual(['public_repo']);
    expect(sent.get('client_id')).toBe(CLIENT_ID);
    // No secret is sent, because there is none to send. That is D3, measured.
    expect(sent.get('client_secret')).toBeNull();
    expect([...sent.keys()].sort()).toEqual(['client_id', 'scope']);
  });

  it('names no wider scope anywhere in its own source', () => {
    // The companion clause. It cannot see a scope assembled from fragments — which is why
    // the behavioural clause above is the one that decides, and this one only refuses the
    // careless edit that types `'repo'` where `'public_repo'` belongs.
    const src = fs.readFileSync(path.join(SRC, 'github/device-flow.ts'), 'utf8');
    const quoted = literalsIn(src);
    for (const wide of ['repo', 'admin:org', 'admin:repo_hook', 'workflow', 'delete_repo',
      'write:packages', 'gist', 'user']) {
      expect(quoted.has(wide), `device-flow.ts names the wider scope '${wide}' as a literal`).toBe(false);
    }
    // The non-vacuity control: if the reader cannot even find the scope we DO ask for, the
    // eight clauses above are passing over an empty set.
    expect(quoted.has('public_repo'), 'the literal reader found nothing — the refusals above prove nothing').toBe(true);
    // And no client secret, by any of its spellings, is anywhere in the build.
    expect(src).not.toMatch(/client_secret|clientSecret/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe("the poll waits on GitHub's clock, and stops honestly", () => {
  it('waits at the current interval while authorization is pending', () => {
    expect(verdictFor({ error: 'authorization_pending' }, 5000)).toEqual({ kind: 'wait', intervalMs: 5000 });
  });

  it("obeys GitHub's own slow_down interval, floored", () => {
    expect(verdictFor({ error: 'slow_down', interval: 12 }, 5000)).toEqual({ kind: 'wait', intervalMs: 12000 });
    expect(verdictFor({ error: 'slow_down', interval: 1 }, 5000))
      .toEqual({ kind: 'wait', intervalMs: DEVICE_POLL_MIN_INTERVAL_MS });
  });

  it('STOPS on an expired code and says so in plain words — it never re-dials', () => {
    const v = verdictFor({ error: 'expired_token' }, 5000);
    expect(v.kind).toBe('stop');
    expect(v.kind === 'stop' && v.reason).toBe('expired');
    expect(v.kind === 'stop' && v.message).toContain('Press Connect');
  });

  it('STOPS on access_denied and on an error it has never seen', () => {
    expect(verdictFor({ error: 'access_denied' }, 5000).kind).toBe('stop');
    expect(verdictFor({ error: 'the_moon_is_wrong' }, 5000).kind).toBe('stop');
  });

  it('takes the token when GitHub grants it', () => {
    expect(verdictFor({ access_token: TOKEN, scope: 'public_repo' }, 5000))
      .toEqual({ kind: 'granted', accessToken: TOKEN, scope: 'public_repo' });
  });

  it('bounds its own lifetime at fifteen minutes', () => {
    expect(DEVICE_POLL_MAX_LIFETIME_MS).toBe(900_000);
    expect(DEVICE_POLL_MIN_INTERVAL_MS).toBe(5_000);
    expect(DEVICE_HTTP_TIMEOUT_MS).toBe(10_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the LOOP runs on the numbers GitHub declared, not on numbers of ours', () => {
  it("waits GitHub's declared interval between polls, not a constant of ours", async () => {
    vi.useFakeTimers();
    setClientId();
    deviceCodeAnswer = { ...deviceCodeAnswer, interval: 9 }; // GitHub says nine seconds
    await startDeviceFlow();

    await vi.advanceTimersByTimeAsync(8_500);
    expect(tokenCalls(), 'a poll before GitHub said it was allowed').toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(tokenCalls()).toBe(1);
  });

  it('CARRIES a slow_down interval into the NEXT wait — the server moved our clock', async () => {
    // The wiring half of `verdictFor`'s slow_down clause. A loop that computed the new
    // interval and then kept sleeping the old one would pass every pure clause above.
    vi.useFakeTimers();
    setClientId();
    tokenAnswers = [{ error: 'slow_down', interval: 12 }, { error: 'authorization_pending' }];
    await startDeviceFlow();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls()).toBe(1);            // the first wait was GitHub's declared 5s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(), 'the loop ignored the slow_down and polled on the old interval').toBe(1);
    await vi.advanceTimersByTimeAsync(7_000); // 12s total since the slow_down
    expect(tokenCalls()).toBe(2);
  });

  it('FLOORS an absurd interval and CEILINGS an absurd lifetime — our two constants, doing their only job', async () => {
    vi.useFakeTimers();
    setClientId();
    deviceCodeAnswer = { ...deviceCodeAnswer, interval: 0, expires_in: 99_999 };
    const started = await startDeviceFlow();
    expect(started.ok).toBe(true);
    const state = started.ok ? started.state : null;
    expect(state!.intervalMs).toBe(DEVICE_POLL_MIN_INTERVAL_MS);
    expect(state!.expiresAt - Date.now()).toBe(DEVICE_POLL_MAX_LIFETIME_MS);
  });

  it('STOPS at the expiry GitHub declared, says so, and never dials again', async () => {
    vi.useFakeTimers();
    setClientId();
    deviceCodeAnswer = { ...deviceCodeAnswer, expires_in: 30, interval: 5 };
    await startDeviceFlow();

    await vi.advanceTimersByTimeAsync(30_000);
    const atExpiry = tokenCalls();
    expect(atExpiry, 'it must have polled while the code was alive').toBeGreaterThan(0);
    expect(deviceFlowInProgress(), 'an expired flow is not in progress').toBeNull();

    const failed = h.frames.filter(f => f.type === 'github:connect_failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0].error)).toMatch(/expired/i);
    expect(String(failed[0].error)).toContain('Press Connect');

    // P3: nothing re-dials. Five more minutes of wall clock, zero further calls.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(tokenCalls(), 'the loop re-dialled after it had failed honestly').toBe(atExpiry);
    expect(h.frames.filter(f => f.type === 'github:connect_failed')).toHaveLength(1);
  });

  it("STOPS when GitHub itself says the code expired, with GitHub's own verdict", async () => {
    vi.useFakeTimers();
    setClientId();
    tokenAnswers = [{ error: 'expired_token' }];
    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls()).toBe(1);
    expect(deviceFlowInProgress()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls()).toBe(1);
  });

  it('STOPS when the endpoint cannot be reached — a dead network is not a reason to re-dial', async () => {
    vi.useFakeTimers();
    setClientId();
    let first = true;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      if (url === GITHUB_DEVICE_CODE_URL && first) {
        first = false;
        return new Response(JSON.stringify(deviceCodeAnswer), { status: 200 });
      }
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls()).toBe(1);
    expect(deviceFlowInProgress()).toBeNull();
    expect(h.frames.filter(f => f.type === 'github:connect_failed')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tokenCalls(), 'it re-dialled a request that had already failed').toBe(1);
  });

  it('Cancel ends the loop, and the card stops claiming a sign-in is in progress', async () => {
    vi.useFakeTimers();
    setClientId();
    await startDeviceFlow();
    expect(deviceFlowInProgress()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    const before = tokenCalls();
    cancelDeviceFlow();
    expect(deviceFlowInProgress()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls()).toBe(before);
  });

  it('a GRANT saves the account, names the user, and announces it once', async () => {
    vi.useFakeTimers();
    setClientId();
    tokenAnswers = [{ error: 'authorization_pending' }, { access_token: TOKEN, scope: 'public_repo' }];
    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getGithubToken()).toBe(TOKEN);
    expect(getGithubAccount()?.login).toBe('octocat');
    expect(getGithubAccount()?.scope).toBe('public_repo');
    expect(deviceFlowInProgress()).toBeNull();
    expect(h.frames.filter(f => f.type === 'github:connected')).toEqual([
      { type: 'github:connected', login: 'octocat' },
    ]);
  });

  it('refuses to start at all when the box has no client id, and dials nothing', async () => {
    const started = await startDeviceFlow();
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toMatch(/not configured/i);
    expect(calls).toHaveLength(0);
    expect(githubClientId()).toBeNull();
    expect(githubStatus().clientIdConfigured).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the token is sealed at rest and reachable by nobody else', () => {
  it('what reaches the disk is ciphertext', () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    expect(rawToken()).not.toContain(TOKEN);
    expect(rawToken()!.startsWith('dojo.v1.')).toBe(true);
    expect(getGithubToken()).toBe(TOKEN);
  });

  it('an UPDATE seals too — reconnecting is not a plaintext back door', () => {
    saveGithubAccount('octocat', 'gho_fixture-first', 'public_repo');
    saveGithubAccount('octocat', 'gho_fixture-second', 'public_repo');
    expect(rawToken()).not.toContain('gho_fixture-second');
    expect(getGithubToken()).toBe('gho_fixture-second');
    expect(db().prepare('SELECT COUNT(*) AS n FROM github_account').get()).toEqual({ n: 1 });
  });

  it('never lands in the agent-reachable credential store', () => {
    // RULING P5-R13, the whole reason this table exists: `credential_get` hands any
    // `agent_credentials` row to any granted agent BY NAME.
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    expect(db().prepare('SELECT * FROM agent_credentials').all()).toHaveLength(0);
  });

  it('disconnect clears the token and the status tells the truth', () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    expect(githubStatus().connected).toBe(true);
    disconnectGithub();
    expect(getGithubToken()).toBeNull();
    expect(githubStatus().connected).toBe(false);
    expect(githubStatus().login).toBeNull();
  });

  it('a stored row whose token will not open reads as REAUTH REQUIRED, not as connected', () => {
    // What a rotated master key looks like. `openSecretColumn` degrades to null rather than
    // crashing the boot, so the honest surface is "reconnect", never "connected".
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    const sealed = rawToken()!;
    db().prepare('UPDATE github_account SET access_token = ? WHERE id = 1')
      .run(sealed.slice(0, -4) + 'AAAA');
    expect(getGithubToken()).toBeNull();
    expect(githubStatus().connected).toBe(false);
    expect(githubStatus().reauthRequired).toBe(true);
    expect(githubStatus().login).toBe('octocat');
  });

  it('the last outcome is a LEDGER, not an invented freshness', () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    noteGithubFailure('GitHub answered 401.');
    expect(githubStatus().lastError).toBe('GitHub answered 401.');
    noteGithubOk();
    expect(githubStatus().lastError).toBeNull();
    expect(githubStatus().lastOkAt).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the token reaches no log line, no broadcast frame, and no response body', () => {
  it('a whole successful connect leaves the token in none of the three', async () => {
    vi.useFakeTimers();
    setClientId();
    tokenAnswers = [{ access_token: TOKEN, scope: 'public_repo' }];
    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getGithubToken(), 'setup: the connect must have succeeded for this to assert anything').toBe(TOKEN);

    expect(h.logLines.length, 'setup: the flow must have logged SOMETHING, or this proves nothing')
      .toBeGreaterThan(0);
    for (const line of h.logLines) expect(line).not.toContain(TOKEN);
    expect(JSON.stringify(h.frames)).not.toContain(TOKEN);
  });

  // ── THE LOGIN-NULL BRANCH, AND WHY IT GETS ITS OWN CLAUSE ──
  // FIX ROUND 1 / B1. Review planted a TYPE-LEGAL leak — `login: login ?? verdict.accessToken`,
  // which compiles because `login` is `string | null` — and rode 29/29 GREEN. The clause above
  // could not see it: it stages `userAnswer = { login: 'octocat' }`, so `??` short-circuits and
  // the leak never fires. `userAnswer` was assigned to that same object in every test in the
  // file, so the `GET /user` FAILURE path was never driven at all — which also left three
  // things unproven that depend on it: `saveGithubAccount(null, …)` (the branch that motivates
  // the nullable signature), `GithubConnectedEvent.login: null` (the branch `ws.ts`'s own doc
  // comment exists to describe), and the T5 hand-off telling the card to render the null case.
  //
  // The lesson, which is the same one this file already learned once about its literal scanner:
  // A LEAK ASSERTION IS ONLY AS GOOD AS THE PATHS IT IS DRIVEN DOWN. One happy path is one path.
  it('a grant whose /user call fails connects anyway, names nobody, and still leaks nothing', async () => {
    vi.useFakeTimers();
    setClientId();
    userAnswer = {};                                   // GitHub grants, but will not name the user
    tokenAnswers = [{ access_token: TOKEN, scope: 'public_repo' }];
    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);

    // A missing NAME, never a missing connection — the reason `saveGithubAccount` takes
    // `login: string | null` rather than the brief's `login: string`.
    expect(getGithubToken(), 'setup: the grant must have landed for this to assert anything').toBe(TOKEN);
    expect(getGithubAccount()?.login).toBeNull();
    expect(getGithubAccount()?.scope).toBe('public_repo');
    expect(githubStatus().connected).toBe(true);
    expect(githubStatus().login).toBeNull();
    expect(githubStatus().reauthRequired).toBe(false);

    // The frame is asserted WHOLE, not probed field by field: an extra field carrying the
    // token would pass `login === null` and fail this.
    expect(h.frames.filter(f => f.type === 'github:connected'))
      .toEqual([{ type: 'github:connected', login: null }]);
    expect(JSON.stringify(h.frames)).not.toContain(TOKEN);
    for (const line of h.logLines) expect(line).not.toContain(TOKEN);
  });

  // ── THE `/user` CALL THAT THROWS, WHICH IS A DIFFERENT BRANCH FROM THE ONE ABOVE ──
  // FIX ROUND 2 / R1. The clause above drives `GET /user` ANSWERING WITHOUT A LOGIN. It never
  // drives `GET /user` THROWING — and those are two different arms of `fetchLogin`. The catch
  // arm has the token in scope as its own parameter and writes a `logger.warn`, so review
  // planted `tok: token` on that line and rode 31/31 GREEN: the arm was entered by no test in
  // the file. (`installFetch` answers 200 for every non-device, non-token URL, and the one test
  // that installs a throwing fetch makes the TOKEN endpoint throw first, so the loop ends before
  // any grant and `fetchLogin` is never reached at all.)
  //
  // IT IS AN ORDINARY PRODUCTION PATH, not an exotic one: `fetch` throws on a network error or
  // on `AbortSignal.timeout`, and `res.json()` throws on a non-JSON body — which is exactly what
  // `api.github.com` sends when it serves a 5xx HTML error page. A 502 immediately after a
  // successful grant enters this arm holding a live token.
  //
  // This is the SECOND time the same lesson has been collected in this file, one branch over:
  // A LEAK ASSERTION IS ONLY AS GOOD AS THE PATHS IT IS DRIVEN DOWN. The `endings` table below
  // now carries this branch as a row so it cannot come uncovered again.
  it('a grant whose /user call THROWS still connects, names nobody, and leaks nothing', async () => {
    vi.useFakeTimers();
    setClientId();
    tokenAnswers = [{ access_token: TOKEN, scope: 'public_repo' }];
    throwOnUserCall();

    await startDeviceFlow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getGithubToken(), 'setup: the grant must have landed for this to assert anything').toBe(TOKEN);
    expect(getGithubAccount()?.login).toBeNull();
    expect(githubStatus().connected).toBe(true);
    expect(h.frames.filter(f => f.type === 'github:connected'))
      .toEqual([{ type: 'github:connected', login: null }]);

    // The catch arm MUST have run, or every assertion below passes over a branch nothing took.
    expect(
      h.logLines.some(l => l.includes('would not name the user')),
      'setup: the /user catch arm never ran — the token-in-the-log assertion proves nothing',
    ).toBe(true);
    for (const line of h.logLines) expect(line).not.toContain(TOKEN);
    expect(JSON.stringify(h.frames)).not.toContain(TOKEN);
  });

  it('NO frame carries the token, on any ending the loop has', async () => {
    // The generalisation of B1, so the next ending added to the loop is covered by construction
    // rather than by someone remembering.
    //
    // ── FIX ROUND 2 / R2 + R3, and they are the same defect in two places ──
    // R2: the first cut called itself "all SIX endings" and `pollUntilAnswered` has more than
    // six. The unreachable endpoint — an ending T4 ADDED ON PURPOSE for P3 — was missing, as
    // were the client-id race and cancellation.
    // R3: the non-vacuity guard was `frames.length > 0`, which `startDeviceFlow`'s own
    // `github:device_code` frame satisfies on EVERY row. Review deleted `fail()`'s broadcast
    // entirely and this clause stayed green — its message promised more than its line checked.
    //
    // Both are fixed the same way: every row DECLARES the terminal frame it must emit, so the
    // guard asserts THIS ENDING'S OWN frame fired rather than that some frame did, and a new
    // ending cannot be added to the loop without a row here saying what it broadcasts.
    // `terminal: null` means FRAMELESS BY DESIGN and is asserted as such — cancellation is a
    // silent `return`, which is correct (the user who pressed Cancel already knows) and is now
    // pinned as a decision rather than left as an absence.
    interface Ending {
      name: string;
      /** Runs before `startDeviceFlow()`. */
      stage: () => void;
      /** Runs after `startDeviceFlow()` resolves, before the clock advances. */
      afterStart?: () => void;
      /** The frame this ending MUST emit — or null when it is frameless BY DESIGN. */
      terminal: 'github:connected' | 'github:connect_failed' | null;
      /** True when a real token exists on this path, i.e. there is something to leak. */
      grants: boolean;
    }
    const GRANT = { access_token: TOKEN, scope: 'public_repo' };
    const endings: Ending[] = [
      { name: 'granted, user named', terminal: 'github:connected', grants: true,
        stage: () => { tokenAnswers = [GRANT]; } },
      { name: 'granted, user NOT named', terminal: 'github:connected', grants: true,
        stage: () => { userAnswer = {}; tokenAnswers = [GRANT]; } },
      { name: 'granted, /user THROWS', terminal: 'github:connected', grants: true,
        stage: () => { tokenAnswers = [GRANT]; throwOnUserCall(); } },
      { name: "expired on GitHub's word", terminal: 'github:connect_failed', grants: false,
        stage: () => { tokenAnswers = [{ error: 'expired_token' }]; } },
      { name: 'denied on GitHub', terminal: 'github:connect_failed', grants: false,
        stage: () => { tokenAnswers = [{ error: 'access_denied' }]; } },
      { name: 'an error we have never seen', terminal: 'github:connect_failed', grants: false,
        stage: () => { tokenAnswers = [{ error: 'the_moon_is_wrong' }]; } },
      { name: 'lifetime reached', terminal: 'github:connect_failed', grants: false,
        stage: () => { deviceCodeAnswer = { ...deviceCodeAnswer, expires_in: 10 }; } },
      { name: 'the endpoint cannot be reached', terminal: 'github:connect_failed', grants: false,
        stage: () => { throwOnTokenCall(); } },
      // The one narrow way `pollUntilAnswered`'s own NOT_CONFIGURED arm is reachable: the owner
      // clears the client id DURING the device-code round trip, between the two reads.
      { name: 'the client id vanishes mid-handshake', terminal: 'github:connect_failed', grants: false,
        stage: () => { clearClientIdOnDeviceCode(); } },
      // Frameless BY DESIGN: the human who pressed Cancel does not need to be told.
      { name: 'cancelled by the user', terminal: null, grants: false,
        stage: () => {}, afterStart: () => { cancelDeviceFlow(); } },
    ];

    for (const e of endings) {
      // Each ending gets a clean slate; `beforeEach` runs per `it`, not per iteration.
      db().prepare('DELETE FROM github_account').run();
      h.frames = []; h.logLines = []; calls = [];
      tokenAnswers = [{ error: 'authorization_pending' }];
      userAnswer = { login: 'octocat' };
      deviceCodeAnswer = {
        device_code: 'dc-fixture', user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
      };
      installFetch();
      vi.useFakeTimers();
      setClientId();
      e.stage();
      await startDeviceFlow();
      e.afterStart?.();
      await vi.advanceTimersByTimeAsync(20_000);

      // FIX ROUND 3 / E2. This filter named the two terminal types, so "frameless by design"
      // was pinned against two of the four frames rather than against A FRAME: review added
      // `broadcast({ type: 'github:disconnected' })` to `cancelDeviceFlow()` and rode 33/33.
      // No token could ride it — the leak sweep below runs over the UNFILTERED frame array —
      // but the correctness claim was wrong, and it is one T5 cares about: a spurious
      // `github:disconnected` tells the card the account was disconnected when the user merely
      // cancelled a sign-in, on a box that still holds a working token.
      //
      // It now filters by EXCLUSION: every `github:` frame except `device_code`, which is
      // excluded for the stated reason that `startDeviceFlow` emits it on every path before any
      // ending is reached. A frame type invented tomorrow is therefore covered by default.
      const terminals = h.frames.filter(
        f => String(f.type).startsWith('github:') && f.type !== 'github:device_code');
      if (e.terminal === null) {
        expect(terminals, `${e.name}: expected NO frame after the device code, by design`).toEqual([]);
      } else {
        // R3: THIS ending's own frame, not "some frame" — `github:device_code` always fires.
        expect(
          terminals.map(f => f.type),
          `${e.name}: the ending's own frame never fired — every assertion below proves nothing`,
        ).toEqual([e.terminal]);
      }
      if (e.grants) {
        expect(getGithubToken(), `${e.name}: setup — the token must have landed`).toBe(TOKEN);
      }
      expect(JSON.stringify(h.frames), `${e.name}: a broadcast frame carried the token`)
        .not.toContain(TOKEN);
      for (const line of h.logLines) {
        expect(line, `${e.name}: a log line carried the token`).not.toContain(TOKEN);
      }
      cancelDeviceFlow();
      vi.useRealTimers();
    }
  });

  it('the frame types this feature can emit are exactly the four declared — T5 inherits this', () => {
    // FIX ROUND 3 / E2, the half that outlives this task. The clause above pins what each
    // ENDING emits; this pins what the FEATURE can emit at all, so a fifth frame type cannot
    // appear on the wire without a human editing this list. T5 owns the card that reads these
    // frames, and an undeclared frame type reaching it is a surprise rather than a contract.
    //
    // A SOURCE CENSUS rather than a behavioural sweep, deliberately: a behavioural sweep proves
    // what DID fire, and the claim here is about what CAN. Scanned over the whole server source,
    // not the four T4 modules, so a github frame emitted from a module this feature does not own
    // still has to be declared.
    const DECLARED_FRAME_TYPES = [
      'github:connect_failed',  // device-flow.ts `fail()` — the P3 honest ending
      'github:connected',       // device-flow.ts, after a grant is sealed
      'github:device_code',     // device-flow.ts `startDeviceFlow`, on every path
      'github:disconnected',    // routes/github.ts `POST /disconnect`
    ];
    const emitted = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(p);
        } else if (entry.name.endsWith('.ts')) {
          const code = fs.readFileSync(p, 'utf8')
            .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
          for (const m of code.matchAll(/broadcast\(\s*\{\s*type:\s*'(github:[^']+)'/g)) {
            emitted.add(m[1]);
          }
        }
      }
    };
    walk(SRC);
    // Non-vacuity first: a reader that finds nothing would pass the equality below trivially.
    expect(emitted.size, 'the frame reader found no github frames at all — it is broken')
      .toBeGreaterThan(0);
    expect(
      [...emitted].sort(),
      'the set of github frame types this server can broadcast changed. Declare it here, add '
      + 'it to `WsEvent` + `EVENT_BATCHABLE` in packages/shared/src/ws.ts, and tell T5 what '
      + 'the card should do with it.',
    ).toEqual(DECLARED_FRAME_TYPES);
    // ...and each declared type is a real member of the closed union, not a typo that would
    // broadcast a frame no dashboard has a case for.
    const wsSource = fs.readFileSync(
      path.resolve(SRC, '../../shared/src/ws.ts'), 'utf8');
    for (const t of DECLARED_FRAME_TYPES) {
      expect(wsSource, `${t} is broadcast but not declared in the WsEvent union`)
        .toContain(`type: '${t}'`);
      expect(wsSource, `${t} has no EVENT_BATCHABLE row`).toContain(`'${t}':`);
    }
  });

  it('every /api/github route answers without the token in its body', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    for (const [method, p] of ROUTE_PATHS) {
      const res = await githubRouter.request(p, { method });
      const text = await res.text();
      expect(text.length, `${method} ${p} answered with an empty body`).toBeGreaterThan(0);
      expect(text, `${method} ${p} put the token in its response body`).not.toContain(TOKEN);
      expect(text).not.toContain('access_token');
    }
  });

  it('...and that list IS every route the router has — it cannot go stale', () => {
    // FIX ROUND 2. The clause above enumerates four literal paths, which was a DECLARED blind
    // spot: a fifth route returning the token would not be seen. The disposition was "T5's
    // problem", but an unowned blind spot is a blind spot that stays — and Hono publishes
    // `githubRouter.routes`, so the enumeration can simply be checked against reality.
    //
    // What this buys: when T5 (or anyone) adds a route, THIS clause fails first and names it,
    // so the author is told to extend the response-body check rather than inheriting a note
    // nobody reads. The blind spot is now a failing test instead of a paragraph.
    //
    // ── FIX ROUND 3 / E1: THE FILTER WAS DISCARDING REAL HANDLERS ──
    // The first cut filtered `r.method !== 'ALL'`. The INTENT was to drop middleware, which Hono
    // records as `ALL /*`. But `githubRouter.all('/leak', h)` — a real, reachable handler — is
    // recorded as `ALL /leak`, and the same filter threw it away: review registered exactly that,
    // returning the live token in its body, and rode 33/33 GREEN. A one-word difference in how a
    // route is registered was enough to leave it undiscoverable.
    //
    // So the filter now excludes ONLY middleware — method AND path — and the clause below pins
    // the fact that makes that safe, measured rather than assumed: this router registers no
    // middleware today, so the exclusion currently removes NOTHING. If that ever stops being
    // true the pin fails and somebody re-reads this comment, which is the point.
    const middleware = githubRouter.routes.filter(r => r.method === 'ALL' && r.path === '/*');
    expect(
      middleware,
      'this router grew middleware. The exclusion below now removes something real — re-check '
      + 'that it still only removes middleware, and that no `.all()` handler hides behind it.',
    ).toEqual([]);

    const real = [...new Set(
      githubRouter.routes
        // Middleware only. A real `.all('/path', h)` handler is NOT middleware and must be
        // enumerated — discarding it by METHOD ALONE is how a leaking route hid at 33/33.
        .filter(r => !(r.method === 'ALL' && r.path === '/*'))
        .map(r => `${r.method} ${r.path}`),
    )].sort();
    const declared = ROUTE_PATHS.map(([m, p]) => `${m} ${p}`).sort();
    expect(real.length, 'the router exposes no routes — this clause would pass over nothing')
      .toBeGreaterThan(0);
    expect(
      real,
      'a route exists that the token-in-the-body clause above does not drive. Add it to '
      + 'ROUTE_PATHS — and if it can reach a token, say why it is safe.',
    ).toEqual(declared);
  });

  it('GET /status is the card\'s whole truth — connected, who, and the live flow', async () => {
    saveGithubAccount('octocat', TOKEN, 'public_repo');
    setClientId();
    const res = await githubRouter.request('/status');
    const body = await res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.connected).toBe(true);
    expect(body.data.login).toBe('octocat');
    expect(body.data.scope).toBe('public_repo');
    expect(body.data.clientIdConfigured).toBe(true);
    expect(body.data.loginInProgress).toBe(false);
    expect(Object.keys(body.data).sort()).toEqual([
      'clientIdConfigured', 'connected', 'connectedAt', 'lastError', 'lastOkAt', 'login',
      'loginInProgress', 'reauthRequired', 'scope', 'userCode', 'verificationUri',
    ]);
  });

  it('POST /connect on an unconfigured box answers a sentence, never a broken button', async () => {
    const res = await githubRouter.request('/connect', { method: 'POST' });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });
});
