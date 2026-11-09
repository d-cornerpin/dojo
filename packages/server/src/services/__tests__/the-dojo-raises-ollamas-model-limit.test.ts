// THE DOJO RAISES OLLAMA'S LOADED-MODEL LIMIT ON THE MAC (OLLAMA_MAX_LOADED_MODELS via `launchctl setenv`) to the embedder +
// the Dojo's pair + the Ollama lock's agent slots, at every start, through the one upkeep. It acts only where it is true: the
// app or Homebrew's service gets the variable and one restart; a serve nothing supervises is taken over; no local Ollama,
// nothing. An owner's higher value is never lowered; there is no AppleScript; a failed restart is tried again at the next
// start. Every command is a stub here: the real launchctl, the real Ollama and the Ollama app are NEVER touched.
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
import { makeRealDeps, type OllamaHost } from '../ollama-host.js';
import { useOllamaHost } from './fake-mac.js';
import { desiredLoaded, raisedLoadedLimit } from '../ollama-restart.js';
import { upkeep } from '../ollama-upkeep.js';
import { STANDARD_DECISION_MODEL, STANDARD_TAGS, STANDARD_WRITER_MODEL } from '../local-standard.js';
import { OLLAMA_LIMIT_FAILED_WORDS } from '../../healer/owner-notices.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';
import type { WatchableChild } from '../../child-idle-bound.js';

const LOCAL = 'ollama-local';
const APP_SERVER = '/Applications/Ollama.app/Contents/Resources/ollama';
const BREW_SERVER = '/opt/homebrew/Cellar/ollama/0.40.6/bin/ollama';

type Fake = OllamaHost & { sets: string[]; terms: number[]; launches: number; log: string[]; serviceRestarts: number };
function fakeDeps(env: Record<string, string>, o: {
  server?: string | null; appPids?: number[]; installed?: boolean; failSet?: boolean; neverQuits?: boolean; launchGate?: Promise<void>; neverAnswers?: boolean; failLaunch?: unknown; brewService?: boolean; formula?: boolean;
} = {}): Fake {
  let service = !!o.brewService;
  const server = o.server === undefined ? APP_SERVER : o.server;
  const living = new Set<number>([...(o.appPids ?? (server === APP_SERVER ? [501] : [])), ...(server ? [502] : [])]);
  const d: Fake = {
    sets: [], terms: [], launches: 0, log: [], serviceRestarts: 0,
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
    brewServicePid: async () => (service && living.has(502) ? 502 : null),
    hasBrew: async () => true,
    brewCaskToken: async () => 'ollama-app',
    cliRuns: async () => true,
    brew: async (args) => { d.log.push(`brew ${args.join(' ')}`); },
    restartBrewService: async () => { d.serviceRestarts++; d.log.push('service'); service = true; living.add(502); },
    brewFormulaInstalled: async () => o.formula ?? false,
    stopBrewService: async () => { service = false; },
    macosMajor: async () => 15,
    startServe: () => null,
  };
  return d;
}

/** One Dojo start on `deps`. */
const boot = async (deps: Fake): Promise<void> => { useOllamaHost(deps); await upkeep('boot'); };
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

// The running Ollama answers over HTTP: current, with the pair listed, so these clauses are about the limit (never the real Ollama).
const LISTED = [STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.windowTag, STANDARD_WRITER_MODEL.tag].map((name) => ({ name }));
const currentOllama = (): void => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return path === '/api/version' ? Response.json({ version: '0.41.0' }) : path === '/api/tags' ? Response.json({ models: LISTED }) : new Response('nf', { status: 404 });
  }));
};
beforeEach(() => {
  currentOllama();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES (?, 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run(LOCAL);
  frames.list.length = 0; spawned.n = 0;
});
afterEach(async () => { useOllamaHost(null); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the Dojo raises Ollama\'s model limit', () => {
  it('the value: the embedder + the pair + the lock\'s agent slots (default 1 → 4; the owner\'s 2 → 5)', () => {
    expect(desiredLoaded(STANDARD_TAGS.length)).toBe(4);
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    expect(desiredLoaded(STANDARD_TAGS.length)).toBe(5);
    mockDb.current!.prepare("UPDATE config SET value = '1' WHERE key = 'ollama_max_concurrent_models'").run();
    expect(desiredLoaded(STANDARD_TAGS.length)).toBe(4);   // the lock is one per process; put it back for the next clauses
  });

  it('the Ollama app serves it, unset: set, the app restarted ONCE (TERM, then launch), and NO card (field failure 2: zero cards after an update)', async () => {
    const deps = fakeDeps({});
    await boot(deps);
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.terms.sort()).toEqual([501, 502]);
    expect(deps.launches).toBe(1);
    expect(deps.log).toEqual(['term', 'term', 'launch']);
    expect(frames.list).toEqual([]);
    expect(standingOwnerNotices()).toEqual([]);
  });

  it('an upgraded box still holding the "limit raised" card of an earlier 3.5 build: it is never shown, in any card\'s words', async () => {
    mockDb.current!.prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', 'ollama-limit-set', 1), ('owner_told', 'ollama-restart-needed', 1)").run();
    await boot(fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' }));
    expect(standingOwnerNotices()).toEqual([]);   // never read back as another card's words
  });

  it('already right: nothing set, NO restart, nothing told — idempotent', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' });
    await boot(deps);
    expect(deps.sets).toEqual([]);
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('the app installed but not running: set, and the app is opened with it (the Dojo\'s own models need Ollama running)', async () => {
    const deps = fakeDeps({}, { server: null, installed: true });
    await boot(deps);
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.terms).toEqual([]);
    expect(deps.log).toEqual(['launch']);
    expect(frames.list).toEqual([]);
  });

  it('a failure to set never throws; it says so on the card, and the card says the next START, not the next update', async () => {
    const deps = fakeDeps({}, { failSet: true });
    await boot(deps);
    expect(deps.terms).toEqual([]);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_LIMIT_FAILED_WORDS]);
    expect(OLLAMA_LIMIT_FAILED_WORDS).toContain('next start');
    expect(OLLAMA_LIMIT_FAILED_WORDS).not.toContain('next update');
  });

  it('EVERY boot re-applies it — after a reboot (unset) it is set and the app restarted once, and the owner is never told', async () => {
    const env: Record<string, string> = {};
    const first = fakeDeps(env);
    await boot(first);
    expect(first.launches).toBe(1);
    delete env.OLLAMA_MAX_LOADED_MODELS;   // the Mac rebooted: launchctl's variable is gone
    const afterReboot = fakeDeps(env);
    await boot(afterReboot);
    expect(afterReboot.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(afterReboot.launches).toBe(1);
    expect(frames.list).toEqual([]);
  });

  it('in a test run the REAL commands are never reached', async () => {
    await upkeep('boot');
    expect(spawned.n).toBe(0);
  });
});

describe('it acts only where it is true', () => {
  it('field failure 2: a serve nothing supervises is taken over, Homebrew\'s service in its place, the limit in launchd, and NO card', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: false, formula: true });
    await boot(deps);
    expect(deps.log).toEqual(['term', 'service']);   // stopped and confirmed gone before the service starts on its port
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.launches).toBe(0);
    expect(frames.list).toEqual([]);
    expect(standingOwnerNotices()).toEqual([]);
  });

  it('the Ollama app is installed but an unsupervised formula serve answers: that serve is replaced by Homebrew\'s service, no card', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: true, appPids: [], formula: true });
    await boot(deps);
    expect(deps.terms).toEqual([502]);
    expect(deps.serviceRestarts).toBe(1);
    expect(frames.list).toEqual([]);
  });

  it('a plain binary on a box without Homebrew, current: it is left serving, and NO card (nothing the owner must do)', async () => {
    const deps = fakeDeps({}, { server: '/opt/custom/bin/ollama', installed: false });
    deps.hasBrew = async () => false;
    await boot(deps);
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
    expect(standingOwnerNotices()).toEqual([]);
  });

  it('Homebrew\'s service serves it: the variable goes into launchd, the service is restarted once, and the owner is asked for nothing', async () => {
    const deps = fakeDeps({}, { server: BREW_SERVER, installed: false, brewService: true });
    await boot(deps);
    expect(deps.sets).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(deps.serviceRestarts).toBe(1);
    expect(deps.terms).toEqual([]);
    expect(frames.list).toEqual([]);
    const again = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '4' }, { server: BREW_SERVER, installed: false, brewService: true });
    await boot(again);   // done: the next start restarts nothing
    expect(again.serviceRestarts).toBe(0);
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
    await boot(deps);
    expect(frames.list).toEqual([]);
  });

  it('no local Ollama at all: nothing, and no card', async () => {
    mockDb.current!.prepare('DELETE FROM providers').run();
    const deps = fakeDeps({});
    await boot(deps);
    expect(deps.sets).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('nothing serving and no Ollama installed at all: nothing, and no card', async () => {
    const deps = fakeDeps({}, { server: null, installed: false });
    deps.cliRuns = async () => false;
    await boot(deps);
    expect(deps.sets).toEqual([]);
    expect(frames.list).toEqual([]);
  });

  it('the app\'s process is found by its case-sensitive name (`pgrep -x Ollama`), never Homebrew\'s lowercase `ollama`', async () => {
    const argv: string[][] = [];
    const real = makeRealDeps(async (cmd, args) => { argv.push([cmd, ...args]); return { stdout: '501\n' }; }, () => true, () => quickChild());
    expect(await real.appPids()).toEqual([501]);
    // this user's processes only: another user's Ollama app is never signalled
    expect(argv).toEqual([['pgrep', '-x', '-u', String(process.getuid!()), 'Ollama']]);
  });
});

describe('an owner\'s value is never lowered', () => {
  it('a higher value is left alone: no set, no restart, no card', async () => {
    const deps = fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '8' });
    await boot(deps);
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

describe('no AppleScript; a failed restart is tried again at the next start', () => {
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
    await boot(stuck);
    expect(frames.list.map((f) => f.error)).toContain(OLLAMA_LIMIT_FAILED_WORDS);
    expect(env.OLLAMA_MAX_LOADED_MODELS).toBe('4');
    const next = fakeDeps(env);
    await boot(next);
    expect(next.sets).toEqual([]);   // already set: only the restart was owed
    expect(next.launches).toBe(1);
    expect(standingOwnerNotices().map((c) => c.words)).not.toContain(OLLAMA_LIMIT_FAILED_WORDS);
    // …and once it worked, a later start does nothing.
    const after = fakeDeps(env);
    await boot(after);
    expect(after.terms).toEqual([]);
  });
});

describe('a slow or failed relaunch', () => {
  it('a relaunched app that is alive but not answering yet is a slow start, not a failure: no card', async () => {
    const env: Record<string, string> = {};
    const slow = fakeDeps(env, { neverAnswers: true });
    await boot(slow);
    expect(frames.list.filter((f) => f.error !== undefined)).toEqual([]);
    expect(standingOwnerNotices()).toEqual([]);
  });

  it('a relaunched app that is GONE is a failed restart: owed kept, the failed card, retried next start', async () => {
    const env: Record<string, string> = {};
    const dead = fakeDeps(env, { neverAnswers: true });
    dead.launchApp = async () => { dead.log.push('launch'); };   // opened, but nothing of it is running
    await boot(dead);
    expect(frames.list.map((f) => f.error)).toContain(OLLAMA_LIMIT_FAILED_WORDS);
    const next = fakeDeps(env);
    await boot(next);   // still owed
    expect(next.launches).toBe(1);
    expect(standingOwnerNotices().map((c) => c.words)).not.toContain(OLLAMA_LIMIT_FAILED_WORDS);
  });

  it('`/usr/bin/open` runs under the platform\'s child-process bound: one that never returns is ended', async () => {
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

  it('a retired card\'s record left on a box is never shown, and nothing names the variable', async () => {
    mockDb.current!.prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', 'ollama-limit-manual:4', 1)").run();
    await boot(fakeDeps({ OLLAMA_MAX_LOADED_MODELS: '8' }));
    expect(standingOwnerNotices()).toEqual([]);
    expect(OLLAMA_LIMIT_FAILED_WORDS).not.toMatch(/OLLAMA_|environment variable/);
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
      await boot(deps);
        const errorTexts = logged.filter((e) => e.level === 'warn').map((e) => String(e.meta?.error ?? ''));
      expect(errorTexts).toContain('The application Ollama could not be found');
      expect(errorTexts.join(' | ')).not.toContain('[object Object]');
    } finally {
      setLogBroadcast(() => undefined);
    }
  });
});
