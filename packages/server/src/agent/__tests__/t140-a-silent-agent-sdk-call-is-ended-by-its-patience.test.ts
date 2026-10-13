// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 6 (final review I3, ruling R-V333-15) — A SILENT AGENT-SDK CALL IS ENDED BY ITS OWN
// PATIENCE, AND A WORKING ONE IS NEVER CUT.
//
// Round 5 removed the background summary clocks on the premise that a writer which is not
// answering is ended by its own provider's patience in the transport. For the agent-sdk transport
// that was false when the provider declares no patience (the default): `agent/model.ts` passed
// `timeoutMs`/`idleTimeoutMs` = null, the transport armed no timer, and a wedged call held the
// background slot and the agent's compaction lock indefinitely.
//
// A hung call is a SAFETY case, not a behaviour limit. The bound is the transport's real signal —
// no first token within the provider's patience, or a gap after it — from the same patience
// machinery the other three transports use (the standing 90 s / 60 s when nothing is declared).
// For that signal to be real the transport must see TOKENS, not only the finished answer, so it
// now asks `query()` for token-level events; a long answer that keeps streaming is never cut.
//
// THE DOOR: the real `callModel` → the real agent-sdk transport; only `query()` is scripted
// (through the suite-wide mock in `vitest.setup.ts`), on a fake clock.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

type Script = 'silent' | 'streams-slowly';
const sdk = vi.hoisted(() => ({ script: 'silent' as Script, calls: [] as Array<{ options: Record<string, unknown> }> }));

(globalThis as { __scriptedAgentSdk?: unknown }).__scriptedAgentSdk = {
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    sdk.calls.push(args);
    const controller = args.options.abortController as AbortController | undefined;
    const waitOrAbort = (ms: number | null) => new Promise<void>((resolve, reject) => {
      const t = ms === null ? null : setTimeout(resolve, ms);
      const fail = () => { if (t) clearTimeout(t); reject(new Error('The operation was aborted.')); };
      if (controller?.signal.aborted) fail(); else controller?.signal.addEventListener('abort', fail, { once: true });
    });
    if (sdk.script === 'silent') {
      return (async function* silent() {
        yield { type: 'system', subtype: 'init' };
        await waitOrAbort(null);   // the far end never says another word
      })();
    }
    // A long answer that keeps streaming: one token every 50 s for five minutes, then the
    // finished message (which the real SDK sends too, with token events switched on).
    return (async function* streamsSlowly() {
      yield { type: 'system', subtype: 'init' };
      const words = ['The', 'crew', 'counted', 'the', 'north', 'dock'];
      for (const w of words) {
        await waitOrAbort(50_000);
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `${w} ` } } };
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: words.map((w) => `${w} `).join('') }], usage: { input_tokens: 9, output_tokens: 6 } } };
    })();
  },
};

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t140-sdk-patience');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';

function seed(firstChunkMs: number | null): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, is_validated, created_at, updated_at)
              VALUES ('p-sdk', 'Agent SDK', 'anthropic', 'agent-sdk', ?, 1, datetime('now'), datetime('now'))`).run(firstChunkMs);
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
              VALUES ('m-sdk', 'p-sdk', 'Claude (SDK)', 'sonnet', '["text","tools"]', 200000, 8192, 1, datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
              VALUES ('agent-sdk-writer', 'Depot Writer', 'm-sdk', 'idle', '{}', datetime('now'), datetime('now'))`).run();
}

/** A summary call, the way `memory/summarize.ts` makes one. */
const summaryCall = () => callModel({
  agentId: 'agent-sdk-writer', modelId: 'm-sdk', tools: false, purpose: 'memory_summarize',
  messages: [{ role: 'user', content: 'Summarise: the crew counted the north dock.' }], systemPrompt: 'Summarise.',
});

/** Drive the fake clock a second at a time, letting real work settle between ticks. */
async function onTheClock<T>(p: Promise<T>, maxMs: number): Promise<{ settled: boolean; value?: T; error?: unknown; atMs: number }> {
  let out: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then((value) => { out = { settled: true, value }; }, (error) => { out = { settled: true, error }; });
  const start = Date.now();
  for (let t = 0; t < maxMs && !out.settled; t += 1_000) {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return { ...out, atMs: Date.now() - start };
}

beforeEach(() => {
  clearSecretsCache();
  clearClientCache();
  mockDb.current = new Database(':memory:');
  runMigrations();
  sdk.calls = [];
  sdk.script = 'silent';
});
afterEach(() => {
  vi.useRealTimers();
  for (const c of sdk.calls) (c.options.abortController as AbortController | undefined)?.abort();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 6 — the agent-sdk transport is bounded by its provider\'s own patience', () => {
  it.fails('a provider that declares no patience: a call that never answers ends at the standing first-token patience, by name', async () => {
    seed(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = await onTheClock(summaryCall(), 30 * 60_000);
    expect(run.settled, 'the call was never ended: nothing bounded it').toBe(true);
    expect(String((run.error as Error | undefined)?.message ?? ''), 'ended by its patience, said so').toMatch(/patience|timeout|no data/i);
    expect(run.atMs, 'about the standing 90 s first-token patience, not the 300 s transport floor').toBeLessThan(200_000);
  });

  it.fails('the transport asks for token-level events, so "no first token" and "a gap" are real signals', async () => {
    seed(null);
    sdk.script = 'streams-slowly';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await onTheClock(summaryCall(), 30 * 60_000);
    expect(sdk.calls[0]?.options.includePartialMessages).toBe(true);
  });

  it.fails('a long answer that keeps streaming (a token every 50 s for five minutes) is never cut, and its text arrives once', async () => {
    seed(null);
    sdk.script = 'streams-slowly';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = await onTheClock(summaryCall(), 30 * 60_000);
    expect(run.error, 'a working writer was cut').toBeUndefined();
    expect((run.value as { content: string }).content.trim()).toBe('The crew counted the north dock');
  });
});
