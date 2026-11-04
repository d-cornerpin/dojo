// FIELD FIX 2, REVIEW ROUND (`overhaul-plans/field-fix-2-REVIEW.md`). The takeover of "whatever Ollama runs" must:
//   H1 stop only an Ollama program (never Docker Desktop or an ssh tunnel that forwards one);
//   H2 never leave Ollama down while a program that runs is on disk (the fallback serve), which also starts a plain binary (M4);
//   H3 settle: a supervisor of the owner's, or another user's Ollama, is not stopped again at the next start or health retry,
//      and the limit is in launchd before the TERM, so a respawn has it;
//   H4/M5/L4 records of earlier 3.5 builds are gone before anything reads them (migration 209), and an unknown key is no card;
//   M1 the download runs outside the hold; M2 a slow start is not a card; M3 the cask's limits fall back to the formula.
// `fake-mac.ts` plays the Mac, now with time, slow starts, delayed respawns and listeners that are not Ollama. Nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { ensureStandardModels, retryStandardModelsIfMissing, standardInstallSettled, STANDARD_DECISION_MODEL } from '../local-standard.js';
import { releasePairHold } from '../ollama-pair-gate.js';
import { overrideOllamaHost } from '../ollama-host.js';
import { ensureOllamaModelLimit, ollamaRestartSettled } from '../ollama-model-limit.js';
import { healerOwnerCards, OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS, HEALER_BROKEN_WORDS } from '../../healer/owner-notices.js';
import { setupDepsRouter } from '../../gateway/routes/setup-deps.js';
import { getDecisionProvider } from '../../agent/decision-provider.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, appServe, dockerServe, LATEST, type Mac } from './fake-mac.js';

const SRC = path.resolve(__dirname, '../..');
const db = (): Database.Database => mockDb.current!;
const cards = (): string[] => frames.list.filter((f) => f.type === 'chat:error' && f.severity !== 'info').map((f) => f.error ?? '');
const use = (m: Mac): Mac => { overrideOllamaHost(m); return m; };
/** A Dojo start: the start hook's upkeep, then the update's install. */
const boot = async (m: Mac): Promise<void> => { await ensureOllamaModelLimit(m, 'darwin'); await ollamaRestartSettled(); await ensureStandardModels(); await standardInstallSettled(); };
let baseUrl = '';

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  baseUrl = await startFakeOllama();
  ollama.serving = null; ollama.silent = new Set(); ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = [];
  ollama.refuseAllBelow035 = false; ollama.failPulls = false;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  frames.list.length = 0;
  releasePairHold();
});
afterEach(async () => {
  await standardInstallSettled(); await ollamaRestartSettled();
  overrideOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

describe('H1: only an Ollama program is ever stopped', () => {
  it('Docker Desktop forwarding a current Ollama: never TERMed, nothing installed over it, no card', async () => {
    const mac = use(fakeMac({ running: dockerServe('0.41.0') }));
    await boot(mac);
    expect(mac.terms).toEqual([]); expect(mac.brews).toEqual([]); expect(mac.serviceRestarts).toBe(0);
    expect(ollama.installed.has(STANDARD_DECISION_MODEL.tag)).toBe(true);   // it serves, so the models are pulled through it
    expect(cards()).toEqual([]);
  });

  it('a tunnel or Docker forwarding an OLD Ollama: still never TERMed; the ONE card says why', async () => {
    const mac = use(fakeMac({ running: { pid: 650, path: '/usr/bin/ssh', version: '0.30.1', by: 'unsupervised' }, formula: '0.41.0' }));
    await boot(mac);
    expect(mac.terms).toEqual([]); expect(mac.serviceRestarts).toBe(0);
    expect(cards()).toEqual([OLLAMA_TOO_OLD_WORDS]);
  });
});

describe('H2 / M4: Ollama is never left down while a program that runs is on disk', () => {
  it('a plain `ollama` binary and nothing serving (setup\'s start step for the CLI tarball): it is started as the detached serve', async () => {
    const mac = use(fakeMac({ running: null })); mac.cli = { path: '/usr/local/bin/ollama', version: LATEST };
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('set'); await ollamaRestartSettled();
    expect(mac.serves).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '4' }]);
    expect(ollama.serving?.version).toBe(LATEST);
    expect(cards()).toEqual([]);
  });
});

describe('H3: no restart storm', () => {
  it('a LaunchAgent of the owner\'s respawns the formula after the TERM: kept, the limit was in launchd FIRST, and two more boots and a health-retry loop stop it never again', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    mac.respawn = { program: null };   // `/opt/homebrew/bin/ollama serve` under KeepAlive: the program on disk, now new
    await boot(mac);
    expect(mac.terms).toEqual([500]);
    expect(mac.log.indexOf('setenv')).toBeLessThan(mac.log.indexOf('term'));   // the respawn inherits the limit
    expect(ollama.serving?.version).toBe(LATEST);
    ollama.failPulls = true; ollama.installed.delete(STANDARD_DECISION_MODEL.tag);   // a model that stays missing: retries keep coming
    await boot(mac); await boot(mac);
    for (let i = 0; i < 5; i++) { retryStandardModelsIfMissing([...ollama.installed], baseUrl); await standardInstallSettled(); }
    expect(mac.terms).toEqual([500]);
    expect(mac.serviceRestarts).toBe(0);
    expect(cards()).not.toContain(OLLAMA_TOO_OLD_WORDS);
  });

  it('another user\'s current Ollama (the TERM is refused): settled once, never signalled again, no card', async () => {
    const mac = use(fakeMac({ running: formulaServe(LATEST, { foreign: true }), formula: LATEST }));
    await boot(mac); await boot(mac);
    for (let i = 0; i < 3; i++) { retryStandardModelsIfMissing([...ollama.installed], baseUrl); await standardInstallSettled(); }
    expect(mac.terms).toEqual([500]);
    expect(cards()).toEqual([]);
  });

  it('a supervisor that respawns only after a while finds the port taken by Homebrew\'s service; the next boot stops nothing', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    mac.respawn = { program: null, delayMs: 10_000 };
    await boot(mac);
    mac.wait(20_000);   // the supervisor's respawn comes, and dies on the taken port
    expect(mac.running?.by).toBe('brew-service');
    await boot(mac);
    expect(mac.terms).toEqual([500]);
  });
});

describe('M1 / M2 / M3: the download, a slow start, and the cask\'s limits', () => {
  it('M1: the formula\'s download runs before the hold; only the stop and the start hold local calls', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.heldDuringBrew).toEqual([false]);
  });

  it('M2: an updated app that takes longer than the poll to answer is a slow start: no card; the next look finds it current and pulls', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' })); mac.appStartMs = 8_000;
    await ensureStandardModels();
    expect(cards()).toEqual([]);
    expect(mac.launches).toBe(1);   // opened once, and not quit again for being slow
    mac.wait(10_000);   // it answers now
    releasePairHold();
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(cards()).toEqual([]);
  });

  it('M3: below Sonoma, an app from ollama.com is replaced by the formula and Homebrew\'s service (the cask cannot install there)', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1', appCask: null })); mac.macos = 13;
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(mac.brews.some((a) => a.includes('--cask'))).toBe(false);
    expect(mac.running?.by).toBe('brew-service');
    expect(cards()).toEqual([]);
  });

  it('M3: the cask does not install, or its new app never answers (a first-launch prompt nobody sees): the formula and the service instead', async () => {
    const failing = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1', appCask: null })); failing.failCask = true;
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(failing.running?.by).toBe('brew-service');
    ollama.installed = new Set(['nomic-embed-text:latest']); releasePairHold(); frames.list.length = 0;
    const silent = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1', appCask: null })); silent.appStartMs = Infinity;
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(silent.running?.by).toBe('brew-service');
    expect(silent.terms.length).toBeGreaterThanOrEqual(2);   // the old app, then the new one that did not answer
    expect(cards()).toEqual([]);
  });

  it('M3 guard: no Ollama upkeep code ever zaps, uninstalls, strips quarantine, or touches ~/.ollama (the owner\'s models)', () => {
    const files = fs.readdirSync(path.join(SRC, 'services')).filter((f) => /^ollama-.*\.ts$/.test(f)).map((f) => path.join(SRC, 'services', f));
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // code, not the comments that name the rule
      expect(code, f).not.toMatch(/--zap|'uninstall'|"uninstall"|xattr|com\.apple\.quarantine|--no-quarantine|\/\.ollama\b|'\.ollama'/);
    }
  });
});

describe('re-review LOW-1 / LOW-3: no contending supervisor, and no start that stays "starting" for ever', () => {
  it('LOW-1: Homebrew\'s job is unloaded before the fallback serve starts, so it never crash-loops against it for the port', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' })); mac.serviceWorks = false;
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(mac.log.indexOf('service-stop')).toBeGreaterThan(-1);
    expect(mac.log.indexOf('service-stop')).toBeLessThan(mac.log.indexOf('serve'));
    expect(mac.serviceLoaded).toBe(false);
    expect(mac.running?.by).toBe('unsupervised');
  });

  it('LOW-3: an upgraded app alive behind a prompt nobody sees is "starting" once; the next look (Repair) ends it and the formula\'s service takes over', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' })); mac.appStartMs = Infinity;
    await ensureStandardModels();
    expect(cards()).toEqual([]);
    const settingsSay = async (): Promise<string> => (await setupDepsRouter.request('/ollama/standard').then((r) => r.json()) as { data: { lines: string[]; note: string } }).data.lines.join(' ');
    expect(await settingsSay()).toMatch(/starting/);
    mac.wait(60_000);   // still not answering, however long
    releasePairHold();   // what Repair does
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(mac.running?.by).toBe('brew-service');
    expect(mac.brews).toContainEqual(['install', 'ollama']);
    expect(await settingsSay()).not.toMatch(/starting/);
    expect(cards()).toEqual([]);
  });

  it('LOW-3: a plain binary\'s serve that never answers: the next look ends it, and with nothing else to start, the ONE "down" card; never "starting" again', async () => {
    const mac = use(fakeMac({ running: null })); mac.cli = { path: '/usr/local/bin/ollama', version: LATEST }; mac.startMs = Infinity; mac.hasBrewInstalled = false;
    await ensureStandardModels();
    expect(cards()).toEqual([]);
    releasePairHold();
    await ensureStandardModels();
    expect(cards()).toEqual([OLLAMA_DOWN_WORDS]);
    expect(db().prepare("SELECT 1 FROM config WHERE key = 'ollama_start_pending'").get()).toBeUndefined();
  });
});

describe('H4 / M5 / L4: what earlier 3.5 builds left is gone before anything reads it', () => {
  const migrate = (): void => { db().exec(fs.readFileSync(path.join(SRC, 'db', 'migrations', '209_field_failure_2_retired_records.sql'), 'utf8')); };

  it('the earliest read (the owner-notices list, before any boot hook) never shows a retired card, in the Healer\'s words or any other', () => {
    db().prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', 'ollama-restart-needed', 1), ('owner_told', 'ollama-limit-set', 1), ('owner_told', 'some-card-a-later-build-retires', 1)").run();
    expect(healerOwnerCards().map((c) => c.words)).not.toContain(HEALER_BROKEN_WORDS);
    expect(healerOwnerCards()).toEqual([]);
    migrate();   // and the update's migration, which runs before the port is bound, removes the two it knows
    expect(db().prepare("SELECT key FROM healer_state WHERE key IN ('ollama-restart-needed', 'ollama-limit-set')").all()).toEqual([]);
  });

  it('M5: migration 209 retires a phantom decision row even while Ollama does not answer (the boot reconcile re-enables a real one), and drops orphaned keys', () => {
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('ollama-tev1-4b-q4-K-M', 'ollama-local', ?, ?, '[\"decision\"]', 1), ('ollama-qwen3-5-4b', 'ollama-local', 'qwen3.5:4b', 'qwen3.5:4b', '[\"chat\"]', 1)").run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_id', 'ollama-tev1-4b-q4-K-M'), ('ollama_own_serve', '{}'), ('ollama_limit_told', '4')").run();
    migrate();
    expect(getDecisionProvider()).toBeNull();   // until Ollama lists it (his-box round 5 (a): the next answer)
    expect(db().prepare("SELECT is_enabled FROM models WHERE id = 'ollama-qwen3-5-4b'").get()).toEqual({ is_enabled: 1 });
    expect(db().prepare("SELECT key FROM config WHERE key IN ('decision_model_id', 'ollama_own_serve', 'ollama_limit_told')").all()).toEqual([]);
  });

  it('M5: a failed download of the writer never disables the writer\'s row (an agent may use it)', async () => {
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('ollama-qwen3-5-4b', 'ollama-local', 'qwen3.5:4b', 'qwen3.5:4b', '[\"chat\"]', 1)").run();
    use(fakeMac({ running: appServe(LATEST), app: LATEST })); ollama.failPulls = true;
    await ensureStandardModels();
    expect(db().prepare("SELECT is_enabled FROM models WHERE id = 'ollama-qwen3-5-4b'").get()).toEqual({ is_enabled: 1 });
  });
});
