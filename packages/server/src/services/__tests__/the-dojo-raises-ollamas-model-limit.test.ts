// v3.5 — OWNER DECISION 2026-10-24 ("Dojo raises the limit"): the Dojo sets Ollama's loaded-model limit on the
// Mac (OLLAMA_MAX_LOADED_MODELS via `launchctl setenv`) to the embedder + the Dojo's pair + the Ollama lock's
// agent slots, at setup and at every start.
// Fix round 4 rulings:
//   NB-1 the Ollama app is restarted only when no local Ollama call and no pull is in flight; calls that
//        arrive during the restart wait for it; a running turn or a download is never cut.
//   NB-2 it acts only where it is true: the Ollama app serving the local Ollama → set + restart + card;
//        Fix W: Homebrew's service → set + the service restarted; a `serve` the Dojo started → restarted with the
//        variable in its own environment; any other server → nothing changed and NO card (the owner is never asked
//        to set a variable); no local Ollama → nothing at all.
//   NB-3 an owner's value is never lowered.
//   NB-5 no AppleScript (a TERM to the app's processes, then `open`); a failed restart is retried at the next
//        start; an unset `launchctl getenv` reads as unset.
// Every command is a stub here: the real launchctl, the real Ollama and the Ollama app are NEVER touched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { LogEntry } from '@dojo/shared';

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
import {
  ensureOllamaModelLimit, ollamaRestartSettled, desiredOllamaMaxLoaded, makeRealDeps, raisedLoadedLimit,
  OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS, type OllamaLimitDeps,
} from '../ollama-model-limit.js';
import { getOllamaLock } from '../ollama-lock.js';
import { localWorkBegins } from '../ollama-quiet.js';
import { pullOllamaModel } from '../ollama-pull.js';
import { healerOwnerCards } from '../../healer/owner-notices.js';
import { holdWhenQuiet } from '../ollama-quiet.js';
import type { WatchableChild } from '../../child-idle-bound.js';

const LOCAL = 'ollama-local';
const APP_SERVER = '/Applications/Ollama.app/Contents/Resources/ollama';
const BREW_SERVER = '/opt/homebrew/Cellar/ollama/0.40.6/bin/ollama';

type Fake = OllamaLimitDeps & { sets: string[]; terms: number[]; launches: number; log: string[]; serves: Array<Record<string, string>>; serviceRestarts: number };
function fakeDeps(env: Record<string, string>, o: {
  server?: string | null; appPids?: number[]; installed?: boolean; failSet?: boolean; neverQuits?: boolean; launchGate?: Promise<void>; neverAnswers?: boolean; failLaunch?: unknown; brewService?: boolean;
} = {}): Fake {
  const server = o.server === undefined ? APP_SERVER : o.server;
  const living = new Set<number>([...(o.appPids ?? (server === APP_SERVER ? [501] : [])), ...(server ? [502] : [])]);
  const d: Fake = {
    sets: [], terms: [], launches: 0, log: [], serves: [], serviceRestarts: 0,
    getenv: async (k) => env[k] ?? null,
    setenv: async (k, v) => { if (o.failSet) throw new Error('launchctl: permission denied'); env[k] = v; d.sets.push(`${k}=${v}`); },
    listener: async () => (server && living.has(502) ? { pid: 502, path: server } : null),
    appPids: async () => [...(o.appPids ?? (server === APP_SERVER ? [501] : []))].filter((p) => living.has(p)),
    appInstalled: async () => o.installed ?? server === APP_SERVER,
    terminate: (pid) => { d.terms.push(pid); d.log.push('term'); if (!o.neverQuits) living.delete(pid); },
    alive: (pid) => living.has(pid),
    launchApp: async () => { d.log.push('launch'); if (o.failLaunch !== undefined) throw o.failLaunch; await o.launchGate; d.launches++; living.add(501); living.add(502); },
    answers: async () => !o.neverAnswers && living.has(502),
    sleep: async () => { /* the tick, instant in a test */ },
    brewServicePid: async () => (o.brewService && living.has(502) ? 502 : null),
    hasBrew: async () => true,
    brew: async () => undefined,
    restartBrewService: async () => { d.serviceRestarts++; living.add(502); },
    startServe: (e) => { d.serves.push(e); d.log.push('serve'); living.add(502); },
  };
  return d;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
/** A child process stand-in: exits cleanly at once, or (`hang`) never. */
function quickChild(hang = false): WatchableChild & { killed: boolean } {
  const closers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const c = {
    killed: false, stdout: null, stderr: null,
    on: (ev: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void) => { if (ev === 'close') closers.push(cb); return c; },
    kill: () => { c.killed = true; for (const cb of closers) cb(null, 'SIGTERM'); return true; },
  };
  if (!hang) setTimeout(() => { for (const cb of closers) cb(0, null); }, 0);
  return c as unknown as WatchableChild & { killed: boolean };
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES (?, 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run(LOCAL);
  frames.list.length = 0; spawned.n = 0;
});
afterEach(async () => { await ollamaRestartSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the Dojo raises Ollama\'s model limit', () => {
  it('the value: the embedder + the pair + the lock\'s agent slots (default 1 → 4; the owner\'s 2 → 5)', () => {
    expect(desiredOllamaMaxLoaded()).toBe(4);
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    expect(desiredOllamaMaxLoaded()).toBe(5);
    mockDb.current!.prepare("UPDATE config SET value = '1' WHERE key = 'ollama_max_concurrent_models'").run();
    expect(desiredOllamaMaxLoaded()).toBe(4);   // the lock is one per process; put it back for the next clauses
  });

  it('the Ollama app serves it, unset: set, the app restarted ONCE (TERM, then launch), and a lasting card that claims no restart it did not do', async () => {
    const deps = fakeDeps({});
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.terms.sort()).toEqual([501, 502]);
    expect(deps.launches).toBe(1);
    expect(deps.log).toEqual(['term', 'term', 'launch']);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_SET_WORDS]);
    expect(OLLAMA_LIMIT_SET_WORDS).not.toMatch(/was restarted/);
    expect(healerOwnerCards().map((c) => c.words)).toContain(OLLAMA_LIMIT_SET_WORDS);
  });

  it('already right: nothing set, NO restart, nothing told — idempotent', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('already');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual([]);
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('the app installed but not running: set, not restarted (it reads the value when it next starts)', async () => {
    const deps = fakeDeps({}, { server: null, installed: true });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.terms).toEqual([]);
    expect(deps.launches).toBe(0);
  });

  it('a failure to set never throws; it says so on the card, and the card says the next START, not the next update', async () => {
    const deps = fakeDeps({}, { failSet: true });
    await expect(ensureOllamaModelLimit(deps, 'darwin')).resolves.toBe('failed');
    expect(deps.terms).toEqual([]);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_FAILED_WORDS]);
    expect(OLLAMA_LIMIT_FAILED_WORDS).toContain('next start');
    expect(OLLAMA_LIMIT_FAILED_WORDS).not.toContain('next update');
  });

  it('EVERY boot re-applies it — after a reboot (unset) it is set and the app restarted once, but the owner is told only the first time', async () => {
    const env: Record<string, string> = {};
    const first = fakeDeps(env);
    expect(await ensureOllamaModelLimit(first, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(first.launches).toBe(1);
    delete env.OLLAMA_MAX_LOADED_MODELS;   // the Mac rebooted: launchctl's variable is gone
    const afterReboot = fakeDeps(env);
    expect(await ensureOllamaModelLimit(afterReboot, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(afterReboot.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(afterReboot.launches).toBe(1);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_SET_WORDS]);   // once, not at every boot
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

describe('NB-1: the restart never cuts a running call or a download', () => {
  it('a restart requested while a local agent call is held happens only after it is released', async () => {
    const lock = getOllamaLock();
    await lock.acquire(LOCAL, 'agent-model:7b');
    const deps = fakeDeps({});
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    await settle();
    expect(deps.terms).toEqual([]);   // deferred: the turn's call is still answering
    lock.release(LOCAL, 'agent-model:7b');
    await ollamaRestartSettled();
    expect(deps.launches).toBe(1);
  });

  it('the Dojo\'s own resident calls (pinned, decide(), the embedder) hold it off the same way', async () => {
    const lock = getOllamaLock();
    await lock.acquire(LOCAL, 'qwen3.5:4b', undefined, true);
    const end = await localWorkBegins();
    const deps = fakeDeps({});
    await ensureOllamaModelLimit(deps, 'darwin');
    await settle();
    lock.release(LOCAL, 'qwen3.5:4b', true);
    await settle();
    expect(deps.terms).toEqual([]);   // the decision call is still open
    end();
    await ollamaRestartSettled();
    expect(deps.launches).toBe(1);
  });

  it('during a model pull: the restart waits until the pull has finished', async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"pulling manifest"}\n'));
        finish = () => { c.enqueue(new TextEncoder().encode('{"status":"success"}\n')); c.close(); };
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const pull = pullOllamaModel('qwen3.5:4b', { baseUrl: 'http://localhost:11434' });
    await settle();
    const deps = fakeDeps({});
    await ensureOllamaModelLimit(deps, 'darwin');
    await settle();
    expect(deps.terms).toEqual([]);   // never during a download
    finish();
    expect(await pull).toEqual({ ok: true, status: 'success' });
    await ollamaRestartSettled();
    expect(deps.launches).toBe(1);
  });

  it('a local call that arrives DURING the restart waits for it, then proceeds', async () => {
    let open!: () => void;
    const deps = fakeDeps({}, { launchGate: new Promise<void>((r) => { open = r; }) });
    await ensureOllamaModelLimit(deps, 'darwin');
    await settle();
    expect(deps.log).toEqual(['term', 'term', 'launch']);   // the app is being relaunched now
    let got = false;
    const call = getOllamaLock().acquire(LOCAL, 'agent-model:7b').then(() => { got = true; });
    await settle();
    expect(got).toBe(false);
    open();
    await ollamaRestartSettled();
    await call;
    expect(got).toBe(true);
    getOllamaLock().release(LOCAL, 'agent-model:7b');
  });
});

describe('NB-2: act only where it is true', () => {
  it('a server the Dojo cannot restart (a plain binary): nothing set, nothing restarted, and NO card at all', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: false });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('unmanaged');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual([]);
    expect(deps.terms).toEqual([]);
    expect(deps.launches).toBe(0);
    expect(deps.serves).toEqual([]);
    expect(frames.list).toEqual([]);
    expect(healerOwnerCards()).toEqual([]);
  });

  it('the Ollama app is installed but another server is the one answering: still no restart and no card', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: true, appPids: [] });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('unmanaged');
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('Homebrew\'s service serves it: the variable goes into launchd, the service is restarted once, and the owner is asked for nothing', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: false, brewService: true });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.serviceRestarts).toBe(1);
    expect(deps.terms).toEqual([]);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_SET_WORDS]);
    const again = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' }, { server: BREW_SERVER, installed: false, brewService: true });
    expect(await ensureOllamaModelLimit(again, 'darwin')).toBe('already');   // done: the next start restarts nothing
    expect(again.serviceRestarts).toBe(0);
  });

  it('a serve the Dojo started (through the app\'s own link, or Homebrew\'s binary) is restarted with the variable in its OWN environment', async () => {
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_own_serve_exe', ?)").run(BREW_SERVER);
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: false });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(deps.terms).toEqual([502]);
    expect(deps.serves).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '4' }]);
    expect(deps.sets).toEqual([]);   // launchd is not involved
    expect(frames.list).toEqual([]);
    expect(healerOwnerCards()).toEqual([]);
    // Started with the limit: a later Dojo start leaves it alone.
    const next = fakeDeps({}, { server: BREW_SERVER, installed: false });
    expect(await ensureOllamaModelLimit(next, 'darwin')).toBe('already');
    expect(next.terms).toEqual([]);
  });

  it('the real program decides, not the path it was started by: a serve started through the CLI link into the app is the app', async () => {
    const argv: string[][] = [];
    const run = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      argv.push([cmd, ...args]);
      if (cmd === 'lsof' && args.includes('-t')) return { stdout: '777\n' };
      if (cmd === 'lsof') return { stdout: 'p777\nfcwd\nn/\nftxt\nn/Applications/Ollama.app/Contents/Resources/ollama\n' };   // what the process really runs
      if (cmd === 'ps') return { stdout: '/usr/local/bin/ollama\n' };   // what it was started by: the link
      return { stdout: '' };
    };
    const real = makeRealDeps(run, () => true, () => quickChild());
    expect(await real.listener(11434)).toEqual({ pid: 777, path: '/Applications/Ollama.app/Contents/Resources/ollama' });
    expect(argv.some(([c]) => c === 'ps')).toBe(false);
    // …and the Dojo treats that listener as the app: the variable is already in place, so nothing is asked or restarted
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' }, { server: '/Applications/Ollama.app/Contents/Resources/ollama' });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('already');
    expect(frames.list).toEqual([]);
  });

  it('no local Ollama at all: nothing, and no card', async () => {
    mockDb.current!.prepare('DELETE FROM providers').run();
    const deps = fakeDeps({});
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('skipped');
    expect(deps.sets).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('nothing serving and no Ollama app on the box: nothing, and no card', async () => {
    const deps = fakeDeps({}, { server: null, installed: false });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('skipped');
    expect(deps.sets).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('the app\'s process is found by its case-sensitive name (`pgrep -x Ollama`), never Homebrew\'s lowercase `ollama`', async () => {
    const argv: string[][] = [];
    const real = makeRealDeps(async (cmd, args) => { argv.push([cmd, ...args]); return { stdout: '501\n' }; }, () => true, () => quickChild());
    expect(await real.appPids()).toEqual([501]);
    // fix round 5 (NB4-4): this user's processes only — another user's Ollama app is never signalled
    expect(argv).toEqual([['pgrep', '-x', '-u', String(process.getuid!()), 'Ollama']]);
  });
});

describe('NB-3: an owner\'s value is never lowered', () => {
  it('a higher value is left alone: no set, no restart, no card', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '8' });
    expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('already');
    await ollamaRestartSettled();
    expect(deps.sets).toEqual([]);
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('a lower value or one that is not a number is raised', async () => {
    expect(raisedLoadedLimit('3', 4)).toBe('4');
    expect(raisedLoadedLimit('lots', 4)).toBe('4');
    expect(raisedLoadedLimit(null, 4)).toBe('4');
    expect(raisedLoadedLimit('4', 4)).toBeNull();
    expect(raisedLoadedLimit('8', 4)).toBeNull();
    expect(raisedLoadedLimit(' 12 ', 4)).toBeNull();
  });
});

describe('NB-5: no AppleScript; a failed restart is tried again at the next start', () => {
  it('the real commands: no osascript; `launchctl getenv` failing for an unset variable reads as unset', async () => {
    const argv: string[][] = [];
    const kills: Array<[number, string | number]> = [];
    const real = makeRealDeps(async (cmd, args) => {
      argv.push([cmd, ...args]);
      if (cmd === 'launchctl' && args[0] === 'getenv') throw Object.assign(new Error('exit 1'), { code: 1 });
      return { stdout: '' };
    }, (pid, sig) => { kills.push([pid, sig]); return true; }, (cmd, args) => { argv.push([cmd, ...args]); return quickChild(); });
    expect(await real.getenv('OLLAMA_MAX_LOADED_MODELS')).toBeNull();
    real.terminate(501);
    await real.launchApp();
    expect(kills).toEqual([[501, 'SIGTERM']]);
    expect(argv.some(([c]) => c === 'osascript')).toBe(false);
    expect(argv).toContainEqual(['/usr/bin/open', '-j', '-a', 'Ollama', '--args', '--fast-startup']);
  });

  it('the app does not quit: the failed card, and the next start (variable already set) tries the restart again', async () => {
    const env: Record<string, string> = {};
    const stuck = fakeDeps(env, { neverQuits: true });
    expect(await ensureOllamaModelLimit(stuck, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(frames.list.map((f) => f.error)).toContain(OLLAMA_LIMIT_FAILED_WORDS);
    expect(env.OLLAMA_MAX_LOADED_MODELS).toBe('4');
    const next = fakeDeps(env);
    expect(await ensureOllamaModelLimit(next, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(next.sets).toEqual([]);   // already set: only the restart was owed
    expect(next.launches).toBe(1);
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(OLLAMA_LIMIT_FAILED_WORDS);
    // …and once it worked, a later start does nothing.
    const after = fakeDeps(env);
    expect(await ensureOllamaModelLimit(after, 'darwin')).toBe('already');
    await ollamaRestartSettled();
    expect(after.terms).toEqual([]);
  });
});

describe('fix round 5', () => {
  it('NB4-1: a relaunched app that does not ANSWER is a failed restart — owed kept, failed card, the hold released, retried next start', async () => {
    const env: Record<string, string> = {};
    const silent = fakeDeps(env, { neverAnswers: true });
    expect(await ensureOllamaModelLimit(silent, 'darwin')).toBe('set');
    await settle();
    const call = getOllamaLock().acquire(LOCAL, 'agent-model:7b');   // waits on the hold, then proceeds into Ollama-down
    await ollamaRestartSettled();
    await call;
    getOllamaLock().release(LOCAL, 'agent-model:7b');
    expect(frames.list.map((f) => f.error)).toContain(OLLAMA_LIMIT_FAILED_WORDS);
    expect(healerOwnerCards().map((c) => c.words)).toContain(OLLAMA_LIMIT_FAILED_WORDS);
    const next = fakeDeps(env);
    expect(await ensureOllamaModelLimit(next, 'darwin')).toBe('set');   // still owed
    await ollamaRestartSettled();
    expect(next.launches).toBe(1);
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(OLLAMA_LIMIT_FAILED_WORDS);
  });

  it('NB4-2: `/usr/bin/open` runs under the platform\'s child-process bound: one that never returns is ended', async () => {
    vi.useFakeTimers();
    try {
      const child = quickChild(true);
      const real = makeRealDeps(async () => ({ stdout: '' }), () => true, () => child);
      const launched = real.launchApp().then(() => 'returned', () => 'ended');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await launched).toBe('ended');
      expect(child.killed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('NB4-3: a call waiting on the hold stops when its agent is stopped, and its turn shows it is waiting for the local model', async () => {
    const release = await holdWhenQuiet(LOCAL);
    const stop = new AbortController();
    const waiting = getOllamaLock().acquire(LOCAL, 'agent-model:7b', undefined, false, { signal: stop.signal, agentId: 'agent-w' })
      .then(() => 'proceeded', () => 'stopped');
    await settle();
    const activity = frames.list.filter((f) => (f as { type?: string }).type === 'engine:activity') as unknown as Array<{ data: { agentId: string; label: string; phase: string } }>;
    expect(activity.map((f) => [f.data.agentId, f.data.phase])).toEqual([['agent-w', 'start']]);
    expect(activity[0].data.label).toBe('Waiting for the local model to restart');
    stop.abort();
    expect(await waiting).toBe('stopped');
    expect((frames.list.filter((f) => (f as { type?: string }).type === 'engine:activity') as unknown as Array<{ data: { phase: string } }>).map((f) => f.data.phase)).toEqual(['start', 'end']);
    release();
  });

  it('the manual card of 3.5.0-preflight.1 is retired: its record on an upgraded box is removed at the start, and nothing names the variable to the owner', async () => {
    mockDb.current!.prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', 'ollama-limit-manual:4', 1)").run();
    expect(await ensureOllamaModelLimit(fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '8' }), 'darwin')).toBe('already');
    expect(mockDb.current!.prepare("SELECT 1 FROM healer_state WHERE key LIKE 'ollama-limit-manual:%'").get()).toBeUndefined();
    for (const w of [OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS]) expect(w).not.toMatch(/OLLAMA_|environment variable/);
  });
});

describe('a failed `open` logs the real reason, never `[object Object]`', () => {
  it('a failed relaunch (non-zero exit) logs the reason from its stderr', async () => {
    const env: Record<string, string> = {};
    const logged: LogEntry[] = [];
    const { setLogBroadcast } = await import('../../logger.js');
    setLogBroadcast((entry) => { logged.push(entry); });
    try {
      // The real `open` runs under `child-idle-bound.ts`, which rejects with a plain object
      // (`{ code, stderr }`), not an Error — exactly the shape a failed relaunch takes.
      const deps = fakeDeps(env, { failLaunch: { stdout: '', stderr: 'The application Ollama could not be found', code: 1 } });
      expect(await ensureOllamaModelLimit(deps, 'darwin')).toBe('set');
      await ollamaRestartSettled();
      const errorTexts = logged.filter((e) => e.level === 'warn').map((e) => String(e.meta?.error ?? ''));
      expect(errorTexts).toContain('The application Ollama could not be found');
      expect(errorTexts.join(' | ')).not.toContain('[object Object]');
    } finally {
      setLogBroadcast(() => undefined);
    }
  });
});
