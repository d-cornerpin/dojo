// v3.5 fix round 2 — OWNER DECISION 2026-10-24 ("Dojo raises the limit"): during setup and update the Dojo
// sets Ollama's loaded-model limit on the Mac (OLLAMA_MAX_LOADED_MODELS via `launchctl setenv`) to the
// embedder + the Dojo's pair + the Ollama lock's agent slots, restarts the Ollama app ONCE when the value
// changed (never when it is already right), and tells the owner on a card. A failure never fails anything.
// Every command is a stub here: the real launchctl, osascript and Ollama app are NEVER touched by a test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));
const spawned = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const refuse = (): never => { spawned.n++; throw new Error('a test tried to run a real command'); };
  return { ...real, execFile: refuse, exec: refuse, spawn: refuse, execFileSync: refuse, execSync: refuse };
});

import { runMigrations } from '../../db/migrations.js';
import { ensureOllamaModelLimit, desiredOllamaMaxLoaded, OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS, type OllamaLimitDeps } from '../ollama-model-limit.js';
import { healerOwnerCards } from '../../healer/owner-notices.js';

function fakeDeps(env: Record<string, string>, running = true, failSet = false): OllamaLimitDeps & { restarts: number; sets: string[] } {
  const d = {
    restarts: 0, sets: [] as string[],
    getenv: async (k: string) => env[k] ?? null,
    setenv: async (k: string, v: string) => { if (failSet) throw new Error('launchctl: permission denied'); env[k] = v; d.sets.push(`${k}=${v}`); },
    appRunning: async () => running,
    restartApp: async () => { d.restarts++; },
  };
  return d;
}

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); frames.list.length = 0; spawned.n = 0; });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the Dojo raises Ollama\'s model limit', () => {
  it('the value: the embedder + the pair + the lock\'s agent slots (default 1 → 4; the owner\'s 2 → 5)', () => {
    expect(desiredOllamaMaxLoaded()).toBe(4);
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    expect(desiredOllamaMaxLoaded()).toBe(5);
    mockDb.current!.prepare("UPDATE config SET value = '1' WHERE key = 'ollama_max_concurrent_models'").run();
    expect(desiredOllamaMaxLoaded()).toBe(4);   // the lock is one per process; put it back for the next clauses
  });

  it('unset: it is set, the running app is restarted ONCE, and the owner is told on a lasting card', async () => {
    const deps = fakeDeps({});
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.restarts).toBe(1);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_SET_WORDS]);
    expect(healerOwnerCards().map((c) => c.words)).toContain(OLLAMA_LIMIT_SET_WORDS);
  });

  it('already right: nothing set, NO restart, nothing told — idempotent', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('already');
    expect(deps.sets).toEqual([]);
    expect(deps.restarts).toBe(0);
    expect(frames.list).toEqual([]);
  });

  it('the app not running: set, not restarted (it reads the value when it next starts)', async () => {
    const deps = fakeDeps({}, false);
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    expect(deps.restarts).toBe(0);
  });

  it('a failure never throws; it says so on the card', async () => {
    const deps = fakeDeps({}, true, true);
    await expect(ensureOllamaModelLimit(deps, 'darwin')).resolves.toBe('failed');
    expect(deps.restarts).toBe(0);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_FAILED_WORDS]);
  });

  it('fix round 3: EVERY boot re-applies it — after a reboot (unset) it is set and the app restarted once, but the owner is told only the first time', async () => {
    const env: Record<string, string> = {};
    const first = fakeDeps(env);
    expect(await ensureOllamaModelLimit(first, 'darwin')).toBe('set');
    expect(first.restarts).toBe(1);
    delete env.OLLAMA_MAX_LOADED_MODELS;   // the Mac rebooted: launchctl's variable is gone
    const afterReboot = fakeDeps(env);
    expect(await ensureOllamaModelLimit(afterReboot, 'darwin')).toBe('set');
    expect(afterReboot.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(afterReboot.restarts).toBe(1);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_SET_WORDS]);   // once, not at every boot
  });

  it('fix round 3: a boot with it already right does nothing at all', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('already');
    expect(deps.sets).toEqual([]);
    expect(deps.restarts).toBe(0);
    expect(frames.list).toEqual([]);
  });

  it('not a Mac: nothing is done', async () => {
    const deps = fakeDeps({});
    expect(await ensureOllamaModelLimit(deps, 'linux')).toBe('skipped');
    expect(deps.sets).toEqual([]);
  });

  it('in a test run the REAL commands are never reached', async () => {
    expect(await ensureOllamaModelLimit()).toBe('skipped');
    expect(spawned.n).toBe(0);
  });
});
