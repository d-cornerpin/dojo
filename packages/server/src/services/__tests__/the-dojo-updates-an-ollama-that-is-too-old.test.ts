// FIX W (field failure 1, 3.5.0-preflight.1) — THE DOJO'S OWN MODELS NEED A MINIMUM OLLAMA; THE DOJO UPGRADES AN OLDER ONE.
//
// What the owner saw after 3.4.1 → 3.5: the decision model failed with "pull model manifest: 412 … requires a newer
// version of Ollama", Repair ran the same pull again, and every health check pulled again. Here a real HTTP server
// plays Ollama (`/api/version`, `/api/tags`, `/api/pull` with the registry's exact 412 for a version below 0.35) and
// the commands the Dojo would run on the Mac (brew, launchctl, the app, a serve) are a fake host: nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import {
  ensureStandardModels, retryStandardModelsIfMissing, standardState, standardProgressLines, startStandardInstall, standardInstallSettled,
  STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL, ensureStandardModelsOncePerVersion,
} from '../local-standard.js';
import { releasePairHold } from '../ollama-pair-gate.js';
import { overrideOllamaHost, type OllamaHost } from '../ollama-host.js';
import { parseOllamaVersion, ollamaAtLeast, requiredOllamaVersion, isVersionRefusal } from '../ollama-version.js';
import { healerOwnerCards, OLLAMA_TOO_OLD_WORDS } from '../../healer/owner-notices.js';

const REFUSAL = '{"error":"pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama. Please download the latest version at https://ollama.com/download"}';
const APP_PROGRAM = '/Applications/Ollama.app/Contents/Resources/ollama';
const FORMULA = '/opt/homebrew/Cellar/ollama/0.30.1/bin/ollama';

/** A fake Ollama over real HTTP: its version, what is installed, and every pull it was asked for. */
const ollama = { version: '0.30.1' as string | null, installed: new Set<string>(), pulls: [] as string[], versionReads: 0 };
let server: http.Server;
let baseUrl = '';

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/version') {
      ollama.versionReads++;
      if (ollama.version === null) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: ollama.version }));
    } else if (url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) }));
    } else if (url.pathname === '/api/pull') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const model = (JSON.parse(body) as { model: string }).model;
        ollama.pulls.push(model);
        const tooOld = model === STANDARD_DECISION_MODEL.tag && !ollamaAtLeast(ollama.version, '0.35');
        if (tooOld) { res.writeHead(412, { 'content-type': 'application/json' }).end(REFUSAL); return; }
        ollama.installed.add(model);
        res.writeHead(200).end(`${JSON.stringify({ status: 'pulling', digest: 'sha256:a', total: 100, completed: 50 })}\n${JSON.stringify({ status: 'success' })}\n`);
      });
    } else res.writeHead(404).end('no route');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }));
}

/** The Mac's commands, faked. `kind` says what runs the Ollama: the app, Homebrew's service, a Dojo serve, or something else. */
type Mac = OllamaHost & { brews: string[][]; setenvs: string[]; terms: number[]; launches: number; serviceRestarts: number; serves: Array<Record<string, string>>; failBrew?: boolean; hasBrewInstalled: boolean; brewApp: boolean };
function fakeMac(kind: 'app' | 'brew-service' | 'own-serve' | 'plain'): Mac {
  const program = kind === 'app' ? APP_PROGRAM : FORMULA;
  const m: Mac = {
    brews: [], setenvs: [], terms: [], launches: 0, serviceRestarts: 0, serves: [], hasBrewInstalled: true, brewApp: true,
    getenv: async () => null, setenv: async (k, v) => { m.setenvs.push(`${k}=${v}`); },
    listener: async () => ({ pid: 500, path: program }),
    appPids: async () => (kind === 'app' ? [499] : []), appInstalled: async () => kind === 'app',
    terminate: (pid) => { m.terms.push(pid); }, alive: () => false,
    launchApp: async () => { m.launches++; }, answers: async () => true, sleep: async () => undefined,
    brewServicePid: async () => (kind === 'brew-service' ? 500 : null),
    hasBrew: async () => m.hasBrewInstalled,
    brewOwnsApp: async () => m.brewApp,
    brew: async (args) => { m.brews.push(args); if (m.failBrew) throw new Error('Error: brew exploded (raw)'); ollama.version = '0.41.0'; },
    restartBrewService: async () => { m.serviceRestarts++; },
    startServe: (env) => { m.serves.push(env); },
  };
  return m;
}

const db = (): Database.Database => mockDb.current!;
const SLASH_PULLS = (): string[] => ollama.pulls.filter((p) => p === STANDARD_DECISION_MODEL.tag);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  await startServer();
  ollama.version = '0.30.1'; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = []; ollama.versionReads = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  frames.list.length = 0;
  releasePairHold();
});
afterEach(async () => {
  await standardInstallSettled();
  overrideOllamaHost(null);
  await new Promise((r) => server.close(r));
  mockDb.current?.close(); mockDb.current = null;
});

describe('the minimum Ollama is declared once, next to the model\'s tag', () => {
  it('the decision model declares 0.35 (its library page: "Tev1 requires Ollama 0.35 or later"); versions compare as numbers', () => {
    expect(STANDARD_DECISION_MODEL.minOllama).toBe('0.35');
    expect(requiredOllamaVersion([STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL])).toBe('0.35');
    expect(parseOllamaVersion('v0.40.13')).toEqual([0, 40, 13]);
    expect(ollamaAtLeast('0.40.13', '0.35')).toBe(true);   // not the string order: "0.4" < "0.35" as text
    expect(ollamaAtLeast('0.9.6', '0.35')).toBe(false);
    expect(ollamaAtLeast('0.35.0', '0.35')).toBe(true);
    expect(ollamaAtLeast(null, '0.35')).toBe(false);
    expect(isVersionRefusal(REFUSAL)).toBe(true);
    expect(isVersionRefusal('connection reset')).toBe(false);
  });
});

describe('an Ollama that is too old is upgraded BEFORE the pull, by how it is installed', () => {
  it('the Ollama app: the current app is installed, the app is restarted with the limit in launchd, and then the pull works', async () => {
    const mac = fakeMac('app'); overrideOllamaHost(mac);
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['reinstall', '--cask', 'ollama']]);
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(mac.terms).toContain(499); expect(mac.launches).toBe(1);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);   // pulled ONCE, after the upgrade: never refused
    expect(state.decision).toBe('installed'); expect(state.writer).toBe('installed');
    expect(standardProgressLines().join(' | ')).toContain('Updated the Ollama app from 0.30.1 to 0.41.0 and restarted it.');
    expect(frames.list).toEqual([]);   // nothing to tell: it was fixed
  });

  it('a serve started through the CLI link into the app is the app (the real program decides), not a card', async () => {
    const mac = fakeMac('app'); mac.listener = async () => ({ pid: 500, path: APP_PROGRAM });
    overrideOllamaHost(mac);
    await ensureStandardModels();
    expect(mac.brews).toEqual([['reinstall', '--cask', 'ollama']]);
    expect(frames.list).toEqual([]);
  });

  it('Homebrew\'s service: the formula is upgraded and the service it runs under is restarted (the limit in launchd first)', async () => {
    const mac = fakeMac('brew-service'); overrideOllamaHost(mac);
    await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(mac.serviceRestarts).toBe(1);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect(standardProgressLines().join(' | ')).toContain('Updated Ollama (installed with Homebrew) from 0.30.1 to 0.41.0');
    expect(frames.list).toEqual([]);
  });

  it('a serve the Dojo started: upgraded the way setup installed it (the formula) and started again with the limit in its own environment', async () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('ollama_own_serve_exe', ?)").run(FORMULA);
    const mac = fakeMac('own-serve'); overrideOllamaHost(mac);
    await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.terms).toEqual([500]);
    expect(mac.serves).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '4' }]);
    expect(mac.setenvs).toEqual([]);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect(frames.list).toEqual([]);
  });

  it('an Ollama new enough is left alone: no brew, no restart, one pull', async () => {
    ollama.version = '0.40.13';
    const mac = fakeMac('app'); overrideOllamaHost(mac);
    await ensureStandardModels();
    expect(mac.brews).toEqual([]); expect(mac.launches).toBe(0);
    expect(ollama.pulls).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag]);
  });

  it('the update path (first boot of a new version) and Repair run the same upgrade-then-pull', async () => {
    const boot = fakeMac('brew-service'); overrideOllamaHost(boot);
    expect(await ensureStandardModelsOncePerVersion('3.5.1')).toBe(true);
    expect(boot.brews).toEqual([['upgrade', 'ollama']]);
    expect((await standardState()).decision).toBe('installed');
    // Repair on another box in the same state
    ollama.version = '0.30.1'; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = [];
    const repair = fakeMac('app'); overrideOllamaHost(repair);
    startStandardInstall(); await standardInstallSettled();
    expect(repair.brews).toEqual([['reinstall', '--cask', 'ollama']]);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
  });
});

describe('an app Homebrew did not install is never replaced', () => {
  it('the app was downloaded from ollama.com: nothing is run over it, one plain card, no --force anywhere', async () => {
    const mac = fakeMac('app'); mac.brewApp = false; overrideOllamaHost(mac);
    await ensureStandardModels();
    expect(mac.brews).toEqual([]); expect(mac.launches).toBe(0); expect(mac.terms).toEqual([]);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(SLASH_PULLS()).toEqual([]);
  });
});

describe('an Ollama the Dojo cannot upgrade: one plain card, and no endless pulling', () => {
  it('installed in a way the Dojo cannot update: nothing is run, the decision model is not pulled, ONE card in owner words, plain Settings text', async () => {
    const mac = fakeMac('plain'); overrideOllamaHost(mac);
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([]); expect(mac.terms).toEqual([]); expect(mac.launches).toBe(0); expect(mac.serves).toEqual([]);
    expect(SLASH_PULLS()).toEqual([]);   // never sent a pull the registry refuses
    expect(state.decision).toBe('missing');
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(healerOwnerCards().map((c) => c.words)).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(OLLAMA_TOO_OLD_WORDS).toMatch(/^Dojo: /);
    expect(OLLAMA_TOO_OLD_WORDS).toContain('Settings → Dojo → Ollama (Local Models)');
    expect(OLLAMA_TOO_OLD_WORDS).toContain('ollama.com');
    const shown = [...standardProgressLines(), state.note, OLLAMA_TOO_OLD_WORDS].join('\n');
    expect(shown).toContain("It was installed in a way the Dojo can't update.");
    expect(shown).not.toMatch(/412|manifest|OLLAMA_MAX|newer version of Ollama\./);
  });

  it('no Homebrew to update with, or brew failing: the same card, the raw failure only in the log', async () => {
    const noBrew = fakeMac('app'); noBrew.hasBrewInstalled = false; overrideOllamaHost(noBrew);
    await ensureStandardModels();
    expect(noBrew.brews).toEqual([]);
    expect(frames.list.map((f) => f.error)).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(standardProgressLines().join(' ')).toContain('Homebrew is not installed');
    releasePairHold(); frames.list.length = 0;
    const broken = fakeMac('brew-service'); broken.failBrew = true; overrideOllamaHost(broken);
    const state = await ensureStandardModels();
    expect(broken.serviceRestarts).toBe(0);
    expect([...standardProgressLines(), state.note].join('\n')).not.toMatch(/exploded|412|manifest/);
    expect(standardProgressLines().join(' ')).toContain('tried to update it, but that did not work');
  });

  it('a version refusal is NOT pulled again at every health check; it is released when Ollama\'s version changes', async () => {
    const mac = fakeMac('plain'); overrideOllamaHost(mac);
    await ensureStandardModels();
    ollama.versionReads = 0;
    const names = [...ollama.installed];
    for (let i = 0; i < 6; i++) retryStandardModelsIfMissing(names, baseUrl);   // six health checks
    await settle();
    expect(SLASH_PULLS()).toEqual([]);
    expect(frames.list.length).toBe(1);   // the card was told once
    // The owner downloads the latest Ollama himself: the next health check sees a newer version and the install goes on
    ollama.version = '0.41.0';
    retryStandardModelsIfMissing(names, baseUrl);
    await settle(); await standardInstallSettled();
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect((await standardState()).decision).toBe('installed');
    expect(healerOwnerCards()).toEqual([]);   // the card ended with the condition
  });

  it('Repair looks again (the hold is released) and says the same thing in plain words once, not a second card', async () => {
    const mac = fakeMac('plain'); overrideOllamaHost(mac);
    await ensureStandardModels();
    releasePairHold();   // what POST /ollama/standard does
    startStandardInstall(); await standardInstallSettled();
    expect(frames.list.length).toBe(1);
    expect(standardProgressLines().join(' ')).toContain('older than the Dojo\'s models need (0.35)');
    expect(SLASH_PULLS()).toEqual([]);
  });

  it('the registry refuses though the version could not be read: held after that one pull, one card, the raw 412 only in the log', async () => {
    // /api/version does not answer, so the version check cannot see it; the registry still refuses the old Ollama
    ollama.version = null;
    const mac = fakeMac('plain'); overrideOllamaHost(mac);
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/api/tags') res.writeHead(200).end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
      else if (p === '/api/pull') { ollama.pulls.push('pull'); res.writeHead(412).end(REFUSAL); }
      else res.writeHead(404).end('no');
    });
    const state = await ensureStandardModels();
    expect(ollama.pulls.length).toBeGreaterThanOrEqual(1);
    const pullsAfterInstall = ollama.pulls.length;
    expect(frames.list.map((f) => f.error)).toContain(OLLAMA_TOO_OLD_WORDS);
    for (let i = 0; i < 5; i++) retryStandardModelsIfMissing(['nomic-embed-text:latest'], baseUrl);
    await settle();
    expect(ollama.pulls.length).toBe(pullsAfterInstall);   // not pulled again at every health check
    expect([...standardProgressLines(), state.note].join('\n')).not.toMatch(/412|manifest/);
    expect(frames.list.filter((f) => f.error === OLLAMA_TOO_OLD_WORDS).length).toBe(1);
  });
});
