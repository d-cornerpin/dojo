// v3.5 A2 — SETUP INSTALLS THE DOJO'S TWO STANDARD MODELS BY ITSELF, AND AN UPDATING BOX GETS THEM
// ONCE PER VERSION. Every Ollama call is a scripted fetch: nothing here pulls a real model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';
import {
  ensureStandardModelsOncePerVersion, standardInstallSettled, standardModelRowId,
  STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL,
} from '../../../services/local-standard.js';

const ollama = { installed: new Set<string>(), pulls: [] as string[], calls: [] as string[] };

function pullStream(): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`${JSON.stringify({ status: 'pulling', digest: 'sha256:a', total: 100, completed: 100 })}\n`));
      ctrl.enqueue(enc.encode(`${JSON.stringify({ status: 'success' })}\n`));
      ctrl.close();
    },
  }), { status: 200 });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  ollama.installed = new Set(['nomic-embed-text:latest']);
  ollama.pulls = [];
  ollama.calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname;
    ollama.calls.push(path);
    if (path === '/api/tags') return Response.json({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) });
    if (path === '/api/ps') return Response.json({ models: [] });
    if (path === '/api/show') return new Response('not found', { status: 404 });
    if (path === '/api/pull') {
      const model = (JSON.parse(init?.body ?? '{}') as { model: string }).model;
      ollama.pulls.push(model);
      ollama.installed.add(model);
      return pullStream();
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

/** The install runs in the background; wait for it the way a poller would, starting nothing. */
const settled = (): Promise<void> => standardInstallSettled();

describe('setup installs the pair once Ollama is up and the embedder is present', () => {
  it('auto-configure starts the install with no choice asked, and GET /ollama/standard reports it', async () => {
    const res = await setupDepsRouter.request('/ollama/auto-configure', { method: 'POST' });
    expect(res.status).toBe(200);
    await settled();
    expect(ollama.pulls.sort()).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag].sort());

    const state = await (await setupDepsRouter.request('/ollama/standard')).json() as {
      ok: boolean; data: { decision: string; writer: string; tags: { decision: string; writer: string }; lines: string[] };
    };
    expect(state.ok).toBe(true);
    expect(state.data.decision).toBe('installed');
    expect(state.data.writer).toBe('installed');
    expect(state.data.tags).toEqual({ decision: STANDARD_DECISION_MODEL.tag, writer: STANDARD_WRITER_MODEL.tag });
    expect(state.data.lines).toHaveLength(2);
    expect(standardModelRowId('writer')).toBeTruthy();
  });

  it('without the embedder, auto-configure pulls nothing yet', async () => {
    ollama.installed = new Set();
    await setupDepsRouter.request('/ollama/auto-configure', { method: 'POST' });
    await settled().catch(() => undefined);
    expect(ollama.pulls).toEqual([]);
  });

  it('POST /ollama/standard (the Repair button) installs what is missing', async () => {
    const res = await setupDepsRouter.request('/ollama/standard', { method: 'POST' });
    expect(res.status).toBe(200);
    await settled();
    expect(ollama.pulls.sort()).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag].sort());
  });
});

describe('an updating box gets the pair once per version', () => {
  const seedLocalProvider = (): void => {
    mockDb.current!.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated)
      VALUES ('ollama-local', 'Ollama (Local)', 'ollama', 'http://localhost:11434', 'none', 1)`).run();
  };

  it('runs on the first boot of a version, not on the second, and again on the next version', async () => {
    seedLocalProvider();
    expect(await ensureStandardModelsOncePerVersion('3.5.0')).toBe(true);
    expect(ollama.pulls).toHaveLength(2);

    ollama.calls = [];
    expect(await ensureStandardModelsOncePerVersion('3.5.0')).toBe(false);
    expect(ollama.calls).toEqual([]);

    expect(await ensureStandardModelsOncePerVersion('3.5.1')).toBe(true);
    expect(ollama.calls).toContain('/api/tags');
    expect(ollama.pulls).toHaveLength(2);   // already installed: nothing pulled again
  });

  it('a box that never set up Ollama is left to setup (nothing created, nothing stamped)', async () => {
    expect(await ensureStandardModelsOncePerVersion('3.5.0')).toBe(false);
    expect(ollama.calls).toEqual([]);
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM providers WHERE type = 'ollama'").get()).toEqual({ n: 0 });
  });

  it('an install that could not finish is tried again at the next boot of the same version', async () => {
    seedLocalProvider();
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    expect(await ensureStandardModelsOncePerVersion('3.5.0')).toBe(true);
    vi.stubGlobal('fetch', realFetch);
    expect(await ensureStandardModelsOncePerVersion('3.5.0')).toBe(true);
    expect(ollama.pulls).toHaveLength(2);
  });
});
