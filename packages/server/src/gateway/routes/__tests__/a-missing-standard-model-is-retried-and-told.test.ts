// v3.5 fix round 1 (A2, I-2) — A MISSING STANDARD MODEL IS RETRIED WHENEVER OLLAMA IS ANSWERING, NOT
// ONLY AT A RESTART, AND THE OWNER IS TOLD ONCE THROUGH THE EXISTING NOTIFICATION SYSTEM. No timer:
// the existing Ollama health check is the signal. Every Ollama call is a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; agentId?: string; error?: string; severity?: string; cardClass?: string }> }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { standardModelRowId } from '../../../services/local-standard.js';
import { upkeep, upkeepSettled } from '../../../services/ollama-upkeep.js';
import { noteUpkeep } from '../../../services/ollama-version.js';
/** The health door's retry window after a failed attempt has passed. */
const windowPassed = (): void => noteUpkeep({ triedAt: Date.now() - 11 * 60_000 });
import { checkOllamaHealth } from '../../../services/ollama.js';
import { healerOwnerCards, STANDARD_MODELS_MISSING_WORDS } from '../../../healer/owner-notices.js';
// Load the lazily-imported decision window (its chain loads playwright, which writes globalThis.fetch
// once at load) at COLLECTION, so that write can never land inside a test's stubbed fetch.
import '../../../services/decision-window.js';

const ollama = { installed: new Set<string>(), registryDown: true };
function pullStream(): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`${JSON.stringify({ status: 'success' })}\n`)); c.close(); } }), { status: 200 });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama (Local)', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  ollama.installed = new Set(['nomic-embed-text:latest']);
  ollama.registryDown = true;
  frames.list.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname;
    if (path === '/api/tags') return Response.json({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) });
    if (path === '/api/ps') return Response.json({ models: [] });
    if (path === '/api/show') return new Response('nf', { status: 404 });
    if (path === '/api/pull') {
      if (ollama.registryDown) return Response.json({ error: 'pull model manifest: registry unreachable' }, { status: 500 });
      ollama.installed.add((JSON.parse(init?.body ?? '{}') as { model: string }).model);
      return pullStream();
    }
    return new Response('nf', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const cards = (): string[] => frames.list.filter((f) => f.type === 'chat:error' && f.agentId === 'platform' && f.severity === 'warning').map((f) => f.error ?? '');

describe('a pair that failed to install', () => {
  it('is installed without a reboot once Ollama answers again (the health check is the signal)', async () => {
    await upkeep('boot');
    expect(standardModelRowId('writer')).toBeNull();
    ollama.registryDown = false; windowPassed();
    expect(await checkOllamaHealth('http://localhost:11434')).toBe(true);
    await upkeepSettled();
    expect(standardModelRowId('writer')).toBeTruthy();
    expect(standardModelRowId('decision')).toBeTruthy();
  });

  it('the owner is told ONCE through the dashboard card system, and the card ends when the pair is in', async () => {
    await upkeep('boot');
    await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(cards()).toEqual([STANDARD_MODELS_MISSING_WORDS]);
    // The Dojo keeps trying by itself, so it is an INFORMATIONAL card: a toast that leaves by itself, never re-derived on a reload.
    expect(frames.list.filter((f) => f.error === STANDARD_MODELS_MISSING_WORDS && f.severity === 'warning').map((f) => f.cardClass)).toEqual(['informational']);
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(STANDARD_MODELS_MISSING_WORDS);
    ollama.registryDown = false; windowPassed();
    await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(frames.list.some((f) => f.severity === 'info' && (f as { cardKey?: string }).cardKey === 'ollama')).toBe(true);
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(STANDARD_MODELS_MISSING_WORDS);
  });

  it('A5: an updated box whose Ollama does not answer is told too (the writer never installs otherwise)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    await upkeep('boot');
    expect(cards()).toEqual([STANDARD_MODELS_MISSING_WORDS]);
  });

  it('N4: Ollama slow at boot, then answering with both models already there → registered, and the card ends', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    await upkeep('boot');
    expect(cards()).toEqual([STANDARD_MODELS_MISSING_WORDS]);
    vi.stubGlobal('fetch', real);
    ollama.installed.add('tev1:4b-q4_K_M');
    ollama.installed.add('qwen3.5:4b');
    await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(standardModelRowId('writer')).toBeTruthy();
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(STANDARD_MODELS_MISSING_WORDS);
  });

  it('a health check of a box with both models installed starts nothing', async () => {
    ollama.registryDown = false;
    await upkeep('boot');
    const pullsBefore = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/api/pull')).length;
    await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/api/pull')).length).toBe(pullsBefore);
  });
});

describe('the health door after a failed attempt', () => {
  it('tries again at most once per window: health answers inside it pull nothing and rewrite no row', async () => {
    await upkeep('boot');
    const pulls = (): number => vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/api/pull')).length;
    const before = pulls();
    const tier = mockDb.current!.prepare("SELECT updated_at FROM config WHERE key = 'ollama_upkeep'").get();
    for (let i = 0; i < 5; i++) await checkOllamaHealth('http://localhost:11434');
    await upkeepSettled();
    expect(pulls()).toBe(before);
    expect(mockDb.current!.prepare("SELECT updated_at FROM config WHERE key = 'ollama_upkeep'").get()).toEqual(tier);
    windowPassed();
    await checkOllamaHealth('http://localhost:11434'); await upkeepSettled();
    expect(pulls()).toBeGreaterThan(before);
  });
});
