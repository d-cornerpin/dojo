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
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; agentId?: string; error?: string; severity?: string }> }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { ensureStandardModelsOncePerVersion, standardInstallSettled, standardModelRowId, STANDARD_MODELS_MISSING_WORDS } from '../../../services/local-standard.js';
import { checkOllamaHealth } from '../../../services/ollama.js';
import { healerOwnerCards } from '../../../healer/owner-notices.js';

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
    await ensureStandardModelsOncePerVersion('3.5.0');
    expect(standardModelRowId('writer')).toBeNull();
    ollama.registryDown = false;
    expect(await checkOllamaHealth('http://localhost:11434')).toBe(true);
    await standardInstallSettled();
    expect(standardModelRowId('writer')).toBeTruthy();
    expect(standardModelRowId('decision')).toBeTruthy();
  });

  it('the owner is told ONCE through the dashboard card system, and the card ends when the pair is in', async () => {
    await ensureStandardModelsOncePerVersion('3.5.0');
    await checkOllamaHealth('http://localhost:11434');
    await standardInstallSettled();
    expect(cards()).toEqual([STANDARD_MODELS_MISSING_WORDS]);
    expect(healerOwnerCards().map((c) => c.words)).toContain(STANDARD_MODELS_MISSING_WORDS);
    ollama.registryDown = false;
    await checkOllamaHealth('http://localhost:11434');
    await standardInstallSettled();
    expect(frames.list.some((f) => f.severity === 'info' && f.error === STANDARD_MODELS_MISSING_WORDS)).toBe(true);
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(STANDARD_MODELS_MISSING_WORDS);
  });

  it('A5: an updated box whose Ollama does not answer is told too (the writer never installs otherwise)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    await ensureStandardModelsOncePerVersion('3.5.0');
    expect(cards()).toEqual([STANDARD_MODELS_MISSING_WORDS]);
  });

  it('a health check of a box with both models installed starts nothing', async () => {
    ollama.registryDown = false;
    await ensureStandardModelsOncePerVersion('3.5.0');
    const pullsBefore = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/api/pull')).length;
    await checkOllamaHealth('http://localhost:11434');
    await standardInstallSettled();
    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/api/pull')).length).toBe(pullsBefore);
  });
});
