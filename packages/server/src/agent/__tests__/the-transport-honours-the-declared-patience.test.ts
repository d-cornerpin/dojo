// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T73b — THE TRANSPORT HONOURS WHAT THE ROW DECLARES.
//
// T64b gave a provider two columns to declare how long it is worth waiting for, and T72b made
// the watchdog arm from them honestly. Underneath both sat an HTTP client nobody had told
// anything: Node's built-in `fetch` is undici, and an unconfigured undici dispatcher dies at
// `headersTimeout`/`bodyTimeout` = 300,000 ms. `STREAM_PATIENCE_MAX_MS` is thirty minutes. So
// the door would store, the reader would honour and the watchdog would arm any bound up to
// 1,800,000 ms while the socket underneath was cut at 300,000 — a value storable and
// unhonourable at the same time, which is the one defect `stream-patience.ts` says it exists
// to prevent.
//
// THE OWNER'S STAKES, since the numbers are what make this urgent rather than tidy: cold
// prefill on his DS4 box runs about 200 tok/s, so a 300-second ceiling caps his prompt at
// roughly 55K tokens. His conversations run 42–52K.
//
// ── HOW THIS FILE PROVES IT, AND WHAT IT DOES NOT TRY TO PROVE ──
// The ceiling is 300 seconds. A test that waits it out costs five minutes of wall clock in a
// suite of 5,000, so the proof is split the same way `the-patience-carries-a-real-call.test.ts`
// splits its own:
//
//   §1  THE ARITHMETIC, exactly — at full scale, with the real 300,000 and the real thirty
//       minutes. No scaling anywhere; these are the numbers the field uses.
//   §2  THE MECHANISM, driven, scaled — a real SSE server, the real `openai` SDK, real
//       sockets, and two real undici Agents. One stands in for the unconfigured default and
//       kills the call; the other is the one `resolveTransportTimeouts` builds, and the same
//       call survives. Only the size of the numbers is scaled; nothing in the path is faked.
//   §3  THE WIRING, through the real `callModel` against a real provider row — with the
//       `undici` Agent constructor wrapped so the test can state which clock was built and
//       whether the request actually went out on it. The wrapper is a SUBCLASS of the real
//       Agent that counts its own `connect` events: nothing is faked, and "this call was
//       carried by the Agent derived from this row" is a fact the dispatcher itself reports.
//
//   OUT OF SUITE: the full-scale run — a stub silent for 310 s against a row declaring 400 s —
//   at HEAD and on this branch, recorded with its timings in the task report.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { Agent } from 'undici';
import type { AddressInfo } from 'node:net';

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t73b-transport');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

// ── The Agent wrapper §3 reads ──
//
// A SUBCLASS of the real `undici.Agent`, so every Agent in this file — including the two §2
// builds by hand — is a real dispatcher doing real work. It records the options it was
// constructed with and counts the connections it actually carried, which is what turns "the
// client was wired to this clock" from a claim about a constructor into an observation.
interface AgentBuild { options: { headersTimeout?: number; bodyTimeout?: number }; connects: () => number }
const built = vi.hoisted(() => ({ agents: [] as AgentBuild[] }));

vi.mock('undici', async (orig) => {
  const real = await orig<typeof import('undici')>();
  class RecordingAgent extends real.Agent {
    constructor(options: ConstructorParameters<typeof real.Agent>[0]) {
      super(options);
      let connects = 0;
      this.on('connect', () => { connects += 1; });
      built.agents.push({ options: (options ?? {}) as AgentBuild['options'], connects: () => connects });
    }
  }
  return { ...real, Agent: RecordingAgent };
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t73b-transport', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import {
  callModel, clearClientCache,
  STREAM_IDLE_TIMEOUT_ERROR, STREAM_FIRST_CHUNK_TIMEOUT_ERROR,
  type ModelCallResult,
} from '../model.js';
import {
  resolveStreamPatience, resolveTransportTimeouts,
  STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, STREAM_PATIENCE_MAX_MS,
  TRANSPORT_DEFAULT_TIMEOUT_MS, TRANSPORT_MARGIN_MS, TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS,
} from '../stream-patience.js';
import { AgentError } from '../errors.js';
import { configRouter } from '../../gateway/routes/config.js';

// Real sockets and two cases that deliberately wait out a bound.
vi.setConfig({ testTimeout: 30_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t73b-transport', '.dojo');

// ── The stub: headers out at once, then the machine reads the prompt ──
//
// The same shape `the-patience-carries-a-real-call.test.ts` uses, plus one thing this file
// needs: the headers are FLUSHED explicitly. Without that, Node's http server holds them until
// the first body write, which turns every body-gap case into a headers-gap case and hides the
// bound under test.
const behaviour = { preFirstChunkMs: 0, midStreamStallMs: 0 };

let server: http.Server;
let stubUrl = '';

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({
    id: 'chatcmpl-t73b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-ds4', object: 'model' }] }));
      return;
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // the bytes are on the wire NOW: what follows is a BODY gap
      const finish = (): void => {
        res.write(chunk({ content: behaviour.midStreamStallMs > 0 ? 'is done.' : 'It is done.' }));
        res.write(chunk({}, 'stop'));
        res.write(sse({
          id: 'chatcmpl-t73b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
          choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }));
        res.end('data: [DONE]\n\n');
      };
      const afterFirst = (): void => {
        if (behaviour.midStreamStallMs > 0) {
          res.write(chunk({ content: 'It ' }));
          setTimeout(finish, behaviour.midStreamStallMs);
        } else finish();
      };
      if (behaviour.preFirstChunkMs > 0) setTimeout(afterFirst, behaviour.preFirstChunkMs);
      else afterFirst();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const seedProvider = (firstChunkMs: number | null, idleMs: number | null): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms, stream_idle_timeout_ms, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
  `).run(stubUrl, firstChunkMs, idleMs);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
};

const call = (): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-local',
  messages: [{ role: 'user', content: 'Is it done?' }],
  systemPrompt: 'You are a local model.',
  tools: false,
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  behaviour.preFirstChunkMs = 0;
  behaviour.midStreamStallMs = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════
// §1 — THE ARITHMETIC, AT FULL SCALE
// ════════════════════════════════════════════════════════════════════════════════════
describe('T73b §1 — the transport clock derived from the declared patience', () => {
  it('RED at HEAD: the owner\'s 400 s declaration outruns the transport\'s 300 s ceiling', () => {
    // The row he can legally write today. Before T73b nothing derived anything from it: the
    // watchdog was armed with 400,000 and the socket underneath was cut at 300,000, so his
    // declared patience was unreachable by 100 seconds — and the abort was undici's, not ours.
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: 400_000, streamIdleTimeoutMs: null });
    expect(patience.firstChunkMs).toBe(400_000);
    expect(patience.firstChunkMs).toBeGreaterThan(TRANSPORT_DEFAULT_TIMEOUT_MS); // the defect, stated

    const t = resolveTransportTimeouts(patience);
    expect(t).not.toBeNull();
    expect(t!.headersTimeoutMs).toBe(430_000);
    expect(t!.bodyTimeoutMs).toBe(430_000);
    // Whether the prefill is spent before the headers or after them is the server's choice, so
    // BOTH bounds have to carry the first-chunk grant.
    expect(t!.headersTimeoutMs).toBeGreaterThan(patience.firstChunkMs);
    expect(t!.bodyTimeoutMs).toBeGreaterThan(patience.firstChunkMs);
  });

  it('the watchdog is the binding bound: every derived number clears its bound by the margin', () => {
    // The reason there is a margin at all. Two clocks that expire together produce a race whose
    // loser decides what the owner reads: a watchdog cut names its bound, grants or withholds
    // the retry, and is distinguishable from the stop button; a transport cut is none of those.
    const patience = resolveStreamPatience({ firstChunkTimeoutMs: 400_000, streamIdleTimeoutMs: 500_000 });
    const t = resolveTransportTimeouts(patience)!;
    expect(t.headersTimeoutMs - patience.firstChunkMs).toBe(TRANSPORT_MARGIN_MS);
    expect(t.bodyTimeoutMs - Math.max(patience.firstChunkMs, patience.idleMs)).toBe(TRANSPORT_MARGIN_MS);
  });

  it('CONTROL: a provider that declares nothing configures nothing', () => {
    // The NULL row every provider has today. `null` means no dispatcher is built, no client
    // option is set, and the call goes out on the shared global pool exactly as it did before
    // this task existed.
    const standing = resolveStreamPatience(null);
    expect(standing.firstChunkMs).toBe(STREAM_FIRST_CHUNK_TIMEOUT_MS);
    expect(standing.idleMs).toBe(STREAM_IDLE_TIMEOUT_MS);
    expect(resolveTransportTimeouts(standing)).toBeNull();
  });

  it('CONTROL: a declaration the standing transport clock already covers configures nothing', () => {
    // 200 s of prompt-processing patience — the owner's own T72b row — needs 230 s of transport
    // and today's is 300 s. Nothing to lift, so nothing is touched: the set of providers whose
    // HTTP client changes is exactly the set that could not be served before.
    const fits = resolveStreamPatience({ firstChunkTimeoutMs: 200_000, streamIdleTimeoutMs: 120_000 });
    expect(resolveTransportTimeouts(fits)).toBeNull();
  });

  it('CONTROL: an impatient declaration never TIGHTENS the transport', () => {
    // A 300 ms row is coherent and the reader honours it (see `stream-patience.ts` on why the
    // reader's rule is not the door's). It must not drag the socket down with it: this function
    // only ever lifts.
    expect(resolveTransportTimeouts(resolveStreamPatience({ firstChunkTimeoutMs: 300, streamIdleTimeoutMs: 300 })))
      .toBeNull();
  });

  it('the idle bound lifts on its own, and lifts only what it owns', () => {
    // Ten minutes of tolerance for a mid-answer gap, nothing said about prompt processing.
    // `bodyTimeout` is where inter-chunk gaps live, so it moves; `headersTimeout` answers to the
    // first-chunk bound only, which is still the standing 90 s and still fits inside 300 s.
    const t = resolveTransportTimeouts(resolveStreamPatience({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: 600_000 }))!;
    expect(t.bodyTimeoutMs).toBe(630_000);
    expect(t.headersTimeoutMs).toBe(TRANSPORT_DEFAULT_TIMEOUT_MS);
  });

  it('the SDK\'s own ten-minute timer is lifted too, and only when it would bind', () => {
    // `fetchWithTimeout` clears this timer once the headers land, so it bounds time-to-headers
    // and nothing else — but a provider allowed thirty minutes to think would hit it on a server
    // that withholds its headers until the first token.
    const modest = resolveTransportTimeouts(resolveStreamPatience({ firstChunkTimeoutMs: 400_000, streamIdleTimeoutMs: null }))!;
    expect(modest.requestTimeoutMs).toBe(TRANSPORT_REQUEST_TIMEOUT_DEFAULT_MS); // 430 s fits in 600 s

    const wide = resolveTransportTimeouts(resolveStreamPatience({ firstChunkTimeoutMs: 1_200_000, streamIdleTimeoutMs: null }))!;
    expect(wide.requestTimeoutMs).toBe(1_230_000);
  });

  it('the door\'s own ceiling is reachable end to end', () => {
    // The largest bound the write door can store. If this did not derive a transport that
    // carries it, the door would still be able to store something the engine cannot honour —
    // which is the whole defect, moved rather than fixed.
    const max = resolveStreamPatience({ firstChunkTimeoutMs: STREAM_PATIENCE_MAX_MS, streamIdleTimeoutMs: STREAM_PATIENCE_MAX_MS });
    const t = resolveTransportTimeouts(max)!;
    expect(t.headersTimeoutMs).toBe(STREAM_PATIENCE_MAX_MS + TRANSPORT_MARGIN_MS);
    expect(t.bodyTimeoutMs).toBe(STREAM_PATIENCE_MAX_MS + TRANSPORT_MARGIN_MS);
    expect(t.requestTimeoutMs).toBe(STREAM_PATIENCE_MAX_MS + TRANSPORT_MARGIN_MS);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §2 — THE MECHANISM, DRIVEN
//
// Scaled in one respect only: the stand-in for undici's unconfigured 300 s is an Agent built
// with 500 ms, so the case costs two seconds instead of five minutes. Everything else is the
// field's — the real `openai` SDK, a real socket, a real SSE stream, and for the GREEN arm the
// real Agent `resolveTransportTimeouts` produces for a 400-second declaration.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T73b §2 — the dispatcher is what decides whether the stream lives', () => {
  const SILENCE_MS = 2_500;

  const streamThrough = async (dispatcher: Agent): Promise<string> => {
    const client = new OpenAI({
      apiKey: 'dojo-provider-declares-no-auth',
      baseURL: stubUrl,
      fetchOptions: { dispatcher },
    });
    const stream = await client.chat.completions.create({
      model: 'local-ds4',
      messages: [{ role: 'user', content: 'Is it done?' }],
      stream: true,
    });
    let text = '';
    for await (const c of stream) text += c.choices[0]?.delta?.content ?? '';
    return text;
  };

  it('RED: the transport\'s own timer kills a stream the row said to wait for', async () => {
    behaviour.preFirstChunkMs = SILENCE_MS;
    const err = await streamThrough(new Agent({ headersTimeout: 500, bodyTimeout: 500 }))
      .then(() => null, (e: unknown) => e as Error & { code?: string; cause?: { code?: string } });

    expect(err).not.toBeNull();
    const code = err!.code ?? err!.cause?.code;
    expect(code).toBe('UND_ERR_BODY_TIMEOUT');

    // AND THE SECOND HALF OF THE DAMAGE, asserted rather than described: this is not our
    // abort. The watchdog never fired, so the error carries NEITHER phrase the v2 loop reads,
    // and T65b's single same-model retry is not withheld by T72b's rule — it is lost.
    const message = `${err!.message} ${err!.cause?.code ?? ''}`;
    expect(message).not.toContain(STREAM_IDLE_TIMEOUT_ERROR);
    expect(message).not.toContain(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
  });

  it('GREEN: the SAME wait, the SAME server, carried by the derived Agent', async () => {
    behaviour.preFirstChunkMs = SILENCE_MS;
    const t = resolveTransportTimeouts(resolveStreamPatience({ firstChunkTimeoutMs: 400_000, streamIdleTimeoutMs: null }))!;
    const text = await streamThrough(new Agent({ headersTimeout: t.headersTimeoutMs, bodyTimeout: t.bodyTimeoutMs }));
    expect(text).toBe('It is done.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
// §3 — THE WIRING, THROUGH THE REAL CALL PATH
//
// Each case declares a DIFFERENT patience, because `model.ts` caches its Agents by their
// timeouts (one connection pool per distinct clock, deliberately) and two cases sharing a
// clock would have the second answered out of that cache. Distinct rows keep every assertion
// about a construction this case caused.
// ════════════════════════════════════════════════════════════════════════════════════
describe('T73b §3 — the client the engine builds for a real provider row', () => {
  it('a declaration past the ceiling is carried to a real answer, ON the clock it declared', async () => {
    behaviour.preFirstChunkMs = 400;
    const before = built.agents.length;
    seedProvider(1_200_000, null); // 20 minutes: past 300 s AND past the SDK's own 600 s
    const result = await call();
    expect(result.content).toBe('It is done.');

    expect(built.agents.length).toBe(before + 1);
    const agent = built.agents[before];
    // 1,200,000 + the 30,000 margin, on both bounds: the server chooses whether a prefill is
    // spent before the headers or after them, so neither bound may be the short one.
    expect(agent.options).toEqual({ headersTimeout: 1_230_000, bodyTimeout: 1_230_000 });
    // And the request actually went out on it — the dispatcher's own connect event, not an
    // inference from the constructor having run.
    expect(agent.connects()).toBeGreaterThanOrEqual(1);
  });

  it('CONTROL: a NULL row builds no dispatcher at all', async () => {
    const before = built.agents.length;
    seedProvider(null, null);
    const result = await call();
    expect(result.content).toBe('It is done.');
    // Nothing constructed means no `fetchOptions` and no `timeout` were passed either — the
    // client is built from exactly the arguments it was built from before T73b, and the call
    // goes out on the shared global pool exactly as it did.
    expect(built.agents.length).toBe(before);
  });

  it('the watchdog still wins: a lifted transport does not loosen the declared bound', async () => {
    // The point of the margin, end to end. The socket may now stay open for eighteen minutes;
    // the row also says a mid-answer gap of 300 ms is a stall, and it is OUR bound that cuts —
    // with OUR phrase, which is what keeps the retry decision in the code that reasons about it.
    behaviour.midStreamStallMs = 1_200;
    seedProvider(1_100_000, 300);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain(STREAM_IDLE_TIMEOUT_ERROR);
  });

  it('the REAL patience door moves the clock of the very next call', async () => {
    // Through `PATCH /providers/:id/response-patience`, not a hand-written UPDATE. Until T73b
    // that door had nothing to invalidate — the columns were read fresh on every call — so it
    // did not clear the client cache, and adding the derivation without adding that line would
    // have meant the owner raises the number on the Providers page and sees no change until a
    // restart. Both client caches are keyed by the derived clock as well as the provider id,
    // and `clearClientCache` deletes by prefix; this asserts the door and the keys together.
    seedProvider(900_000, null);
    await call();
    const afterFirst = built.agents.length;
    expect(built.agents[afterFirst - 1].options).toEqual({ headersTimeout: 930_000, bodyTimeout: 930_000 });

    const res = await configRouter.request('/providers/local/response-patience', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstChunkTimeoutMs: 1_000_000 }),
    });
    expect(res.status).toBe(200);

    await call();
    expect(built.agents.length).toBe(afterFirst + 1);
    const edited = built.agents[afterFirst];
    expect(edited.options).toEqual({ headersTimeout: 1_030_000, bodyTimeout: 1_030_000 });
    expect(edited.connects()).toBeGreaterThanOrEqual(1);
  });
});
