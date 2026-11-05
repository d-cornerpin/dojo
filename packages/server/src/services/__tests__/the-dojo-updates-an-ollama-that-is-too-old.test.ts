// FIX W (field failures 1 and 2 of 3.5) — THE DOJO'S OWN MODELS NEED A MINIMUM OLLAMA; THE DOJO MAKES THE ONE RUNNING CURRENT.
//
// Field failure 1: the registry refused the decision model ("412 … requires a newer version of Ollama") and Repair pulled
// again. Field failure 2: the Dojo upgraded Homebrew's program on disk, left the old serve running because the Dojo had not
// started it (review M4/M5), and told the owner to restart it himself. Owner ruling OR-UPKEEP-AUTOMATIC overrules M4/M5: the
// Dojo takes over WHATEVER Ollama runs. A real HTTP server plays Ollama and `fake-mac.ts` plays the Mac, where `brew` changes
// the disk only and the running version changes only when a serve is restarted. Nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { overrideOllamaHost } from '../ollama-host.js';
import { parseOllamaVersion, ollamaAtLeast, requiredOllamaVersion, isVersionRefusal } from '../ollama-version.js';
import { healerOwnerCards, OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS, OLLAMA_LIMIT_FAILED_WORDS, STANDARD_MODELS_MISSING_WORDS, uncheckedFitWords } from '../../healer/owner-notices.js';
import { ensureOllamaModelLimit, ollamaRestartSettled } from '../ollama-model-limit.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, appServe, serviceServe, REFUSAL, APP_PROGRAM, LATEST, type Mac } from './fake-mac.js';

const db = (): Database.Database => mockDb.current!;
const SLASH_PULLS = (): string[] => ollama.pulls.filter((p) => p === STANDARD_DECISION_MODEL.tag);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const owner = (): Array<string | undefined> => frames.list.filter((f) => f.severity !== 'info' && (f as { type?: string }).type !== 'engine:activity').map((f) => f.error);
/** No owner text may tell him to fetch, quit or restart anything (owner ruling OR-UPKEEP-AUTOMATIC). */
const NO_CHORES = /download|ollama\.com|quit|restart it|start it again|brew upgrade/i;
let baseUrl = '';
const use = (m: Mac): Mac => { overrideOllamaHost(m); return m; };

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  baseUrl = await startFakeOllama();
  ollama.serving = null; ollama.silent = new Set(); ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = []; ollama.refuseAllBelow035 = false;
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

describe('the fake Mac is a Mac: brew changes the disk, only a restart changes what runs', () => {
  it('brew upgrade alone leaves the old serve answering the old version', async () => {
    const mac = fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' });
    await mac.brew(['upgrade', 'ollama']);
    expect(mac.disk.formula).toBe(LATEST);
    expect(ollama.serving?.version).toBe('0.30.1');
    mac.terminate(500); await mac.restartBrewService();
    expect(ollama.serving?.version).toBe(LATEST);
  });
});

describe('an Ollama that is too old is updated AND restarted BEFORE the pull, by how it is installed', () => {
  it('the Ollama app (Homebrew\'s): quit, `brew upgrade --cask`, opened again with the limit in launchd; then the pull works', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' }));
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['fetch', '--cask', 'ollama-app'], ['upgrade', '--cask', 'ollama-app']]);
    expect(mac.heldDuringBrew).toEqual([false, true]);   // review M1: the download runs while local calls go on
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(mac.launches).toBe(1);
    expect(ollama.serving?.version).toBe(LATEST);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);   // pulled ONCE, after the upgrade: never refused
    expect(state.decision).toBe('installed'); expect(state.writer).toBe('installed');
    expect(standardProgressLines().join(' | ')).toContain('Updated the Ollama app from 0.30.1 to 0.41.0 and restarted it.');
    expect(owner()).toEqual([]);
  });

  it('Homebrew\'s service: the formula is upgraded and the service restarted (the limit in launchd first)', async () => {
    const mac = use(fakeMac({ running: serviceServe('0.30.1'), formula: '0.30.1' }));
    await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(mac.serviceRestarts).toBe(1);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect(standardProgressLines().join(' | ')).toContain('Updated Ollama (installed with Homebrew) from 0.30.1 to 0.41.0');
    expect(owner()).toEqual([]);
  });

  it('M5 OVERRULED: a formula serve nothing supervises (the 3.4.1 Dojo\'s, a shell\'s, an agent\'s) is upgraded, STOPPED, and replaced by Homebrew\'s service', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.terms).toEqual([500]);
    expect(mac.serviceRestarts).toBe(1);
    expect(mac.running?.by).toBe('brew-service');   // a kind that lasts: launchd keeps it, a Dojo restart does not end it
    expect(ollama.serving?.version).toBe(LATEST);
    expect(state.decision).toBe('installed');
    expect(owner()).toEqual([]);
  });

  it('an Ollama new enough and lasting is left alone: no brew, no restart, both pulled', async () => {
    const mac = use(fakeMac({ running: appServe('0.40.13'), app: '0.40.13' }));
    await ensureStandardModels();
    expect(mac.brews).toEqual([]); expect(mac.launches).toBe(0); expect(mac.terms).toEqual([]);
    expect(ollama.pulls).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag]);
  });

  it('the update path (first boot of a new version) and Repair run the same upkeep-then-pull', async () => {
    const boot = use(fakeMac({ running: serviceServe('0.30.1'), formula: '0.30.1' }));
    expect(await ensureStandardModelsOncePerVersion('3.5.1')).toBe(true);
    expect(boot.brews).toEqual([['upgrade', 'ollama']]);
    expect((await standardState()).decision).toBe('installed');
    // Repair on another box in the same state
    ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = [];
    const repair = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' }));
    startStandardInstall(); await standardInstallSettled();
    expect(repair.brews).toEqual([['fetch', '--cask', 'ollama-app'], ['upgrade', '--cask', 'ollama-app']]);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
  });

  it('nothing is running but Ollama is installed (the 3.4.1 Dojo\'s serve died with the update): it is started, updated, and the pull works', async () => {
    const mac = use(fakeMac({ running: null, formula: '0.30.1' }));
    const state = await ensureStandardModels();
    expect(mac.running?.by).toBe('brew-service');
    expect(ollama.serving?.version).toBe(LATEST);
    expect(state.decision).toBe('installed'); expect(state.writer).toBe('installed');
    expect(owner()).toEqual([]);
  });
});

describe('an app Homebrew did not install (downloaded from ollama.com) is taken over by Homebrew\'s cask', () => {
  it('"the proper version is installed, period": quit, `brew install --cask --force ollama-app`, opened again, then pulled; Homebrew owns it from then on', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1', appCask: null }));
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['fetch', '--cask', 'ollama-app'], ['install', '--cask', '--force', 'ollama-app']]);
    expect(mac.heldDuringBrew).toEqual([false, true]); expect(mac.downAtBrew).toEqual([false, true]);   // fetched first; quit, then installed from the cache
    expect(mac.launches).toBe(1);
    expect(ollama.serving?.version).toBe(LATEST);
    expect(state.decision).toBe('installed');
    expect(mac.disk.appCask).toBe('ollama-app');
    expect(owner()).toEqual([]);
  });
});

describe('what the Dojo truly cannot fix: ONE plain card, and no endless pulling', () => {
  it('another user\'s (or the system\'s) Ollama: the signal is refused, nothing is pulled, ONE card that asks him for no chore', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' }));
    const state = await ensureStandardModels();
    expect(mac.terms).toEqual([500]);
    expect(ollama.serving?.version).toBe('0.30.1');
    expect(mac.serviceRestarts).toBe(0);   // never started over a port another serve holds
    expect(SLASH_PULLS()).toEqual([]);   // never sent a pull the registry refuses
    expect(state.decision).toBe('missing');
    expect(owner()).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(healerOwnerCards().map((c) => c.words)).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(OLLAMA_TOO_OLD_WORDS).toMatch(/^Dojo: /);
    expect(OLLAMA_TOO_OLD_WORDS).toContain('Settings → Dojo → Ollama (Local Models)');
    const shown = [...standardProgressLines(), state.note, OLLAMA_TOO_OLD_WORDS].join('\n');
    expect(shown).toContain('it runs as another user or as the system');
    expect(shown).not.toMatch(NO_CHORES);
    expect(shown).not.toMatch(/412|manifest|OLLAMA_MAX|newer version of Ollama\./);
    expect(db().prepare("SELECT value FROM config WHERE key = 'decision_model_id'").get()).toBeUndefined();
  });

  it('no Homebrew, or brew failing: the same card, the raw failure only in the log', async () => {
    const noBrew = use(fakeMac({ running: { pid: 500, path: '/opt/custom/bin/ollama', version: '0.30.1', by: 'unsupervised' } }));
    noBrew.hasBrewInstalled = false;
    await ensureStandardModels();
    expect(noBrew.brews).toEqual([]); expect(noBrew.terms).toEqual([]);
    expect(owner()).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(standardProgressLines().join(' ')).toContain('Homebrew is not installed');
    releasePairHold(); frames.list.length = 0;
    const broken = use(fakeMac({ running: serviceServe('0.30.1'), formula: '0.30.1' })); broken.failBrew = true;
    const state = await ensureStandardModels();
    expect(broken.serviceRestarts).toBe(0);
    expect([...standardProgressLines(), state.note].join('\n')).not.toMatch(/exploded|412|manifest/);
    expect(standardProgressLines().join(' ')).toContain('Homebrew could not install the newer Ollama.');
  });

  it('a supervisor starts the OLD program again after the TERM: one card; one that starts the NEW program is simply kept', async () => {
    const stuck = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    stuck.respawn = { program: '/opt/custom/bin/ollama', version: '0.30.1' };
    await ensureStandardModels();
    expect(owner()).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(standardProgressLines().join(' ')).toContain('starts the old Ollama again');
    releasePairHold(); frames.list.length = 0; ollama.pulls = [];
    const fine = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }));
    fine.respawn = { program: null };   // the owner's own job runs the formula's link: the program on disk, now new
    expect((await ensureStandardModels()).decision).toBe('installed');
    expect(fine.serviceRestarts).toBe(0);   // its supervisor serves; the Dojo does not start a second one over it
    expect(owner()).toEqual([]);
  });

  it('a version refusal is NOT pulled again at every health check; it is released when Ollama\'s version changes', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' }));
    await ensureStandardModels();
    const names = [...ollama.installed];
    for (let i = 0; i < 6; i++) retryStandardModelsIfMissing(names, baseUrl);   // six health checks
    // Field fix 3: an AWAITED signal, never a sleep. A held health check asks Ollama its version in the
    // background (`ollama-pair-gate.ts retryMayStart`); `standardInstallSettled` now waits for that ask
    // and for the install it may start. The 30 ms `settle()` that stood here lost that race under load.
    await standardInstallSettled();
    expect(SLASH_PULLS()).toEqual([]);
    expect(owner().length).toBe(1);   // the card was told once
    // The other user's Ollama is restarted at the new version: the next health check sees it, and the install goes on
    mac.running = formulaServe(LATEST, { foreign: true });
    retryStandardModelsIfMissing(names, baseUrl);
    await standardInstallSettled();
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect((await standardState()).decision).toBe('installed');
    expect(healerOwnerCards()).toEqual([]);   // the card ended with the condition
  });

  it('Repair looks again (the hold is released) and says the same thing in plain words once, not a second card', async () => {
    use(fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' }));
    await ensureStandardModels();
    releasePairHold();   // what POST /ollama/standard does
    startStandardInstall(); await standardInstallSettled();
    expect(owner().length).toBe(1);
    expect(standardProgressLines().join(' ')).toContain('older than the Dojo\'s models need (0.35)');
    expect(SLASH_PULLS()).toEqual([]);
  });

  it('M3: the updated program is not known to run, so the running serve is NOT stopped (and the card says it was not updated)', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' })); mac.cliOk = false;
    await ensureStandardModels();
    expect(mac.terms).toEqual([]);
    expect(ollama.serving?.version).toBe('0.30.1');
    expect(owner()).toEqual([OLLAMA_TOO_OLD_WORDS]);
  });

  it('review H2: Homebrew\'s service cannot start after the TERM ("Bootstrap failed"): the program on disk runs as a detached serve, never down', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' })); mac.serviceWorks = false;
    const state = await ensureStandardModels();
    expect(mac.terms).toEqual([500]);
    expect(mac.serves).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '4' }]);   // the limit in its own environment
    expect(ollama.serving?.version).toBe(LATEST);
    expect(state.decision).toBe('installed');
    expect(owner()).toEqual([]);
    // the next start finds it serving and current: it is settled, not stopped again
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('set'); await ollamaRestartSettled();
    expect(mac.terms).toEqual([500]);
  });

  it('M3: the Ollama it stopped did not come back and nothing on disk runs — ONE "Dojo:" card that it is down (not a second "too old" one)', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' })); mac.serviceWorks = false; mac.serveWorks = false;
    await ensureStandardModels();
    expect(mac.terms).toEqual([500]);
    expect(owner()).toEqual([OLLAMA_DOWN_WORDS]);
    expect(OLLAMA_DOWN_WORDS).toMatch(/^Dojo: /);
    expect(OLLAMA_DOWN_WORDS).not.toMatch(NO_CHORES);
    // The next start finds nothing serving and starts what is installed: the card ends
    mac.serviceWorks = true; releasePairHold();
    await ensureStandardModels();
    expect(ollama.serving?.version).toBe(LATEST);
    expect(healerOwnerCards()).toEqual([]);
  });
});

describe('round 3: one sequenced Ollama upkeep, and no wrong advice', () => {
  it('H1: the update boot — the start hook\'s upkeep has the app down while the install looks, and the install waits for it', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' }));
    let open!: () => void;
    mac.relaunchGate = new Promise<void>((r) => { open = r; });   // the app takes a long time to come back
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('set');   // too old: the start hook runs the upkeep
    const boot = ensureStandardModelsOncePerVersion('3.5.1');            // the same boot goes on to the decision model
    await settle(); await settle();
    expect(mac.running).toBeNull();
    expect(SLASH_PULLS()).toEqual([]);   // not yet: it waits for the upkeep under way, it does not judge a listener that is down
    open();
    await boot; await ollamaRestartSettled();
    expect(mac.brews).toEqual([['fetch', '--cask', 'ollama-app'], ['upgrade', '--cask', 'ollama-app']]);   // once: the install found it current
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag]);
    expect((await standardState()).decision).toBe('installed');
    expect(owner()).toEqual([]);
  });

  it('H1: nothing listening and nothing installed is never "can\'t update": nothing is held, nothing is told', async () => {
    const mac = use(fakeMac({ running: null }));
    await ensureStandardModels();
    expect(mac.brews).toEqual([]);
    expect(owner()).not.toContain(OLLAMA_TOO_OLD_WORDS);
  });

  it('M1: the registry refuses though the version could not be read — Homebrew\'s service is UPGRADED, then the pull works', async () => {
    ollama.silent.add('0.30.1');               // a very old Ollama: /api/version does not say
    const mac = use(fakeMac({ running: serviceServe('0.30.1'), formula: '0.30.1' }));
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama']]);
    expect(mac.serviceRestarts).toBe(1);
    expect(SLASH_PULLS()).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag]);   // refused once, then pulled after the upgrade
    expect(state.decision).toBe('installed');
    expect(owner()).toEqual([]);
  });

  it('M2: the cask upgrade runs INSIDE the quiet hold after the Dojo quit the app, under the token Homebrew holds, never reinstall', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1', appCask: 'ollama' }));   // before the cask was renamed
    await ensureStandardModels();
    expect(mac.brews).toEqual([['fetch', '--cask', 'ollama'], ['upgrade', '--cask', 'ollama']]);
    expect(mac.heldDuringBrew).toEqual([false, true]);
    expect(mac.downAtBrew).toEqual([false, true]);
    expect(mac.brews.flat()).not.toContain('reinstall');
  });

  it('N1: Homebrew has nothing newer (exit 0, version unchanged) — no false "updated", the card tells the truth, the app is open again', async () => {
    const mac = use(fakeMac({ running: appServe('0.30.1'), app: '0.30.1' })); mac.latest = '0.30.1';
    await ensureStandardModels();
    expect(mac.brews).toEqual([['fetch', '--cask', 'ollama-app'], ['upgrade', '--cask', 'ollama-app']]);
    expect(mac.launches).toBe(1);
    expect(standardProgressLines().join(' ')).toContain('Homebrew has no newer Ollama to install.');
    expect(standardProgressLines().join(' ')).not.toMatch(/Updated/);
    expect(owner()).toEqual([OLLAMA_TOO_OLD_WORDS]);
    expect(SLASH_PULLS()).toEqual([]);
  });

  it('N3: a refusal-driven upgrade that works installs the decision model in the SAME pass (the first try had failed)', async () => {
    ollama.refuseAllBelow035 = true;
    const mac = use(fakeMac({ running: serviceServe('0.30.1'), formula: '0.30.1' })); mac.failBrewOnce = true;
    const state = await ensureStandardModels();
    expect(mac.brews).toEqual([['upgrade', 'ollama'], ['upgrade', 'ollama']]);
    expect(state.decision).toBe('installed'); expect(state.writer).toBe('installed');
    expect(owner()).not.toContain(STANDARD_MODELS_MISSING_WORDS);
    expect(healerOwnerCards()).toEqual([]);
  });

  it('M4 OVERRULED: a current serve the owner started himself is taken over at the start, so the limit applies and it lasts', async () => {
    const mac = use(fakeMac({ running: formulaServe('0.40.13'), formula: '0.40.13' }));
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(mac.brews).toEqual([]);   // current: nothing to fetch
    expect(mac.terms).toEqual([500]);
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    expect(mac.running?.by).toBe('brew-service');
    expect(owner()).toEqual([]);
  });

  it('L1: a source build (0.0.0) is unknown — the pull decides, nothing is blocked; a pre-release ranks below its release', async () => {
    const mac = use(fakeMac({ running: { pid: 500, path: '/opt/src/ollama', version: '0.0.0', by: 'unsupervised' } }));
    await ensureStandardModels();
    expect(mac.brews).toEqual([]); expect(mac.terms).toEqual([]);
    expect(ollamaAtLeast('0.35.0-rc1', '0.35')).toBe(false);
    expect(ollamaAtLeast('0.35.1-rc1', '0.35')).toBe(true);
    expect(ollamaAtLeast('0.35.0', '0.35.0-rc1')).toBe(true);
  });

  it('L5: every Ollama card starts "Dojo:", names the real Settings path, and asks for no chore', () => {
    for (const w of [STANDARD_MODELS_MISSING_WORDS, OLLAMA_LIMIT_FAILED_WORDS, OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS, uncheckedFitWords('A model')]) expect(w).toMatch(/^Dojo: /);
    for (const w of [OLLAMA_TOO_OLD_WORDS, OLLAMA_DOWN_WORDS, STANDARD_MODELS_MISSING_WORDS]) { expect(w).not.toMatch(NO_CHORES); expect(w).not.toContain('—'); }
    expect(STANDARD_MODELS_MISSING_WORDS).toContain('Settings → Dojo → Ollama');
    expect(STANDARD_MODELS_MISSING_WORDS).not.toContain('Platform');
  });

  it('L7 / BACKLOG "the Dojo\'s own serve dies on a Dojo restart": nothing serves at a start, so Homebrew\'s service is started, which outlives the Dojo', async () => {
    const mac = use(fakeMac({ running: null, formula: LATEST }));
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('set');
    await ollamaRestartSettled();
    expect(mac.running?.by).toBe('brew-service');
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
    // A later Dojo start finds it serving and current: nothing is restarted
    const restarts = mac.serviceRestarts;
    expect(await ensureOllamaModelLimit(mac, 'darwin')).toBe('already');
    expect(mac.serviceRestarts).toBe(restarts);
    expect(APP_PROGRAM).toContain('Ollama.app');
  });
});
