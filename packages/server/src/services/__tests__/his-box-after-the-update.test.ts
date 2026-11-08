// FIELD FAILURE 2 OF 3.5, END TO END: THE OWNER'S OWN BOX, UPGRADED FROM 3.4.1.
//
// What he saw after the update (v35-field-failure-2-diagnosis.md): five cards (the "restart it yourself" card and four "You
// chose…" cards), "Downloading the decision model (…): installed" next to "missing", a note telling him to download Ollama
// from ollama.com, Ollama still on the old version, and a Repair that did nothing. Owner ruling OR-UPKEEP-AUTOMATIC: zero
// cards after a normal update, the right version running, both models pulled, and Repair does the whole job in one press.
//
// His box here: the v3.4.1 shape (the local provider row and the rows discovery made, no record of any serve), the Homebrew
// formula's old program serving, started by something nothing recorded (the 3.4.1 Dojo's `exec('ollama serve')`, a shell, an
// agent), not Homebrew's service; the embedder and the writer installed, the decision model missing. The Mac is
// `fake-mac.ts`: brew changes the disk only, the running version changes only when a serve is restarted. The whole screen is
// judged: every live card frame AND the standing owner-notices list the dashboard loads, and the Settings Ollama section.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-his-box');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../gateway/routes/update.js', () => ({ getCurrentVersion: () => '3.5.0' }));

import { runMigrations } from '../../db/migrations.js';
import { ensureStandardModelsAtBoot, retryStandardModelsIfMissing, standardInstallSettled, standardModelRowId, STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../local-standard.js';
import fs from 'node:fs';
import path from 'node:path';
import { ollamaRestartSettled } from '../ollama-model-limit.js';
import { overrideOllamaHost } from '../ollama-host.js';
import { ollamaAtLeast } from '../ollama-version.js';
import { onTheModel } from '../../agent/decision-policy.js';
import { getDecisionProvider } from '../../agent/decision-provider.js';
import { setupDepsRouter } from '../../gateway/routes/setup-deps.js';
import { configRouter } from '../../gateway/routes/config.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, appServe, LATEST, type Mac } from './fake-mac.js';

const EMBEDDER = 'nomic-embed-text:latest';
const DECISION = STANDARD_DECISION_MODEL.tag;
const WRITER = STANDARD_WRITER_MODEL.tag;
const NO_CHORES = /download|ollama\.com|quit|start it again|restart it|brew upgrade/i;
const db = (): Database.Database => mockDb.current!;
let mac: Mac;

/** The cards on his screen: every live card frame (an end, `info`, is not a card) and the standing list a reload shows. */
const liveCards = (): string[] => frames.list.filter((f) => f.type === 'chat:error' && f.severity !== 'info').map((f) => f.error ?? '');
async function standingCards(): Promise<string[]> {
  return ((await (await configRouter.request('/owner-notices')).json()) as { data: Array<{ words: string }> }).data.map((c) => c.words);
}
/** The Settings → Dojo → Ollama section, as the dashboard reads it. */
async function settings(): Promise<{ decision: string; writer: string; note: string; lines: string[] }> {
  return ((await (await setupDepsRouter.request('/ollama/standard')).json()) as { data: { decision: string; writer: string; note: string; lines: string[] } }).data;
}
/** Every "installed" the section says is true of Ollama, and it asks him for no chore. */
async function expectSettingsTellTheTruth(): Promise<void> {
  const s = await settings();
  for (const [which, tag] of [['decision', DECISION], ['writer', WRITER]] as const) {
    expect(s[which], which).toBe(ollama.installed.has(tag) ? 'installed' : 'missing');
    for (const line of s.lines.filter((l) => l.includes(tag))) if (/installed/.test(line)) expect(ollama.installed.has(tag), line).toBe(true);
  }
  const text = [...s.lines, s.note].join('\n');
  expect(text).not.toMatch(NO_CHORES);
  expect(text).not.toContain('—');
  const decisionRow = db().prepare("SELECT value FROM config WHERE key = 'decision_model_id'").get() as { value: string } | undefined;
  expect(!!decisionRow, 'decision_model_id is set only for a model Ollama lists').toBe(ollama.installed.has(DECISION));
  expect(!!getDecisionProvider()).toBe(ollama.installed.has(DECISION));
}

/** The update's first boot, as `index.ts` runs it: the start hook (Ollama upkeep + the install once per version). */
async function updateFirstBoot(): Promise<void> {
  await ensureStandardModelsAtBoot();
  await ollamaRestartSettled(); await standardInstallSettled();
}

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  // v3.4.1's shape: setup's auto-configure made the provider row and a row per model Ollama listed; nothing recorded a serve.
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama (Local)', 'ollama', ?, 'none', 1)").run(baseUrl);
  for (const name of [EMBEDDER, WRITER]) {
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES (?, 'ollama-local', ?, ?, '[]', 1)").run(`ollama-${name.replace(/[^a-z0-9]/gi, '-')}`, name, name);
  }
  db().prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  ollama.silent = new Set(); ollama.pulls = []; ollama.refuseAllBelow035 = false; ollama.failPulls = false;
  ollama.installed = new Set([EMBEDDER, WRITER]);
  mac = fakeMac({ running: formulaServe('0.30.10'), formula: '0.30.10' });   // the formula's program, started by nothing recorded
  overrideOllamaHost(mac);
  frames.list.length = 0;
});
afterEach(async () => {
  await standardInstallSettled(); await ollamaRestartSettled();
  overrideOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

describe('his box, upgraded from 3.4.1', () => {
  it('the premise holds: nothing records the serve, it is not Homebrew\'s service, and the decision model is missing', async () => {
    expect(db().prepare("SELECT 1 FROM config WHERE key LIKE 'ollama_own_serve%'").get()).toBeUndefined();
    expect(await mac.brewServicePid()).toBeNull();
    expect(ollama.serving?.version).toBe('0.30.10');
    expect(ollama.installed.has(DECISION)).toBe(false);
  });

  it('the update\'s first boot: ZERO cards, the right Ollama running, both models pulled, and Settings tells the truth', async () => {
    await updateFirstBoot();
    expect(liveCards()).toEqual([]);
    expect(await standingCards()).toEqual([]);
    expect(ollamaAtLeast(ollama.serving?.version ?? null, STANDARD_DECISION_MODEL.minOllama)).toBe(true);
    expect(ollama.serving?.version).toBe(LATEST);
    expect(mac.running?.by).toBe('brew-service');   // a kind that lasts: the next Dojo restart does not end it
    expect(ollama.installed.has(DECISION) && ollama.installed.has(WRITER)).toBe(true);
    expect(standardModelRowId('decision')).not.toBeNull();
    await expectSettingsTellTheTruth();
    expect((await settings()).note).toMatch(/^Both standard models are installed/);
    // The judgments the owner put on the model now answer on it, and none of them was told as his choice
    expect(onTheModel('inbound_routing/simple_chat')).toBe(true);
    expect(frames.list.map((f) => f.error ?? '').join('\n')).not.toMatch(/You chose/);
  });

  it('the same boot on the box preflight.2 left: Homebrew\'s program already new on disk, the old serve still running, a phantom decision row and its old cards', async () => {
    mac.disk.formula = LATEST;   // preflight.2 ran `brew upgrade ollama` and stopped there
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('ollama-tev1-4b-q4-K-M', 'ollama-local', ?, ?, '[\"decision\"]', 1)").run(DECISION, DECISION);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_id', 'ollama-tev1-4b-q4-K-M')").run();
    db().prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', 'ollama-restart-needed', 1), ('owner_told', 'ollama-limit-set', 1)").run();
    await updateFirstBoot();
    expect(liveCards()).toEqual([]);
    expect(await standingCards()).toEqual([]);
    expect(mac.terms).toEqual([500]);   // the old serve, which preflight.2 left running, is what had to go
    expect(ollama.serving?.version).toBe(LATEST);
    await expectSettingsTellTheTruth();
  });

  it('stuck (Homebrew could not fetch at boot): ONE plain card, a truthful Settings section; then ONE Repair fixes everything with no new card', async () => {
    mac.failBrew = true;
    await updateFirstBoot();
    expect(liveCards().length).toBe(1);   // the one card, never a stack
    expect(liveCards()[0]).toMatch(/^Dojo: /);
    expect(liveCards()[0]).not.toMatch(NO_CHORES);
    expect(ollama.serving?.version).toBe('0.30.10');
    await expectSettingsTellTheTruth();   // the decision model is "missing", never "installed"; no decision_model_id
    const told = liveCards().length;
    mac.failBrew = false;                 // the network is back; the owner presses Repair once
    await setupDepsRouter.request('/ollama/standard', { method: 'POST' });
    await standardInstallSettled(); await ollamaRestartSettled();
    expect(liveCards().length).toBe(told);   // zero new cards
    expect(await standingCards()).toEqual([]);   // and the one card ended
    expect(ollama.serving?.version).toBe(LATEST);
    expect(mac.running?.by).toBe('brew-service');
    expect(ollama.installed.has(DECISION) && ollama.installed.has(WRITER)).toBe(true);
    await expectSettingsTellTheTruth();
    // A second Repair is idempotent: no new card, no pull, nothing restarted
    const [pulls, restarts] = [ollama.pulls.length, mac.serviceRestarts];
    await setupDepsRouter.request('/ollama/standard', { method: 'POST' });
    await standardInstallSettled();
    expect([ollama.pulls.length, mac.serviceRestarts, liveCards().length]).toEqual([pulls, restarts, told]);
  });

  it('E1: a decision model that waits for Ollama is never "installed", never registered, and a phantom row from preflight.2 is retired', async () => {
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('ollama-tev1-4b-q4-K-M', 'ollama-local', ?, ?, '[\"decision\"]', 1)").run(DECISION, DECISION);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_id', 'ollama-tev1-4b-q4-K-M')").run();
    mac.running = formulaServe('0.30.10', { foreign: true });   // one the Dojo truly cannot stop
    await updateFirstBoot();
    expect(standardModelRowId('decision')).toBeNull();
    expect((await settings()).lines.join('\n')).not.toMatch(/decision model.*installed/i);
    await expectSettingsTellTheTruth();
    expect(liveCards().join('\n')).not.toMatch(/You chose/);   // no model: nothing switched, nothing told
    expect(liveCards().length).toBe(1);
  });

  it('while Repair works, the section reads "installing" (so the dashboard keeps polling) and never a false "installed"', async () => {
    const seen: string[] = [];
    await setupDepsRouter.request('/ollama/standard', { method: 'POST' });
    for (let i = 0; i < 3; i++) { seen.push((await settings()).decision); await new Promise((r) => setTimeout(r, 0)); }
    await standardInstallSettled(); await ollamaRestartSettled();
    expect(seen.every((s) => s === 'pulling' || s === 'installed')).toBe(true);
    expect(seen[0]).toBe('pulling');
    expect((await settings()).decision).toBe('installed');
  });
});

// FIELD FIX 2 ROUND 5 (the paid run on 9400b4dc, RED 0/5): on the dev box Ollama was current and listed the decision model, yet
// migration 209 had disabled its row and removed decision_model_id, and nothing re-enabled them because no install was needed.
// What is registered must follow what Ollama lists at every boot it answers and at every health answer, never an install.
describe('round 5: the pair\'s rows follow what Ollama lists, at every boot and health answer', () => {
  const MIGRATION_209 = (): string => fs.readFileSync(path.resolve(__dirname, '../../db/migrations/209_field_failure_2_retired_records.sql'), 'utf8');
  const DECISION_ROW = 'ollama-tev1-4b-q4-K-M';
  /** A v3.5 box: both models in Ollama and registered, the decision model assigned, the version already stamped (no install owed). */
  function v35Box(listed: boolean): void {
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES (?, 'ollama-local', ?, ?, '[\"decision\"]', 1)").run(DECISION_ROW, DECISION, DECISION);
    db().prepare("UPDATE models SET capabilities = '[\"chat\"]' WHERE api_model_id = ?").run(WRITER);
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_id', ?), ('standard_models_version', '3.5.0')").run(DECISION_ROW);
    if (listed) ollama.installed.add(DECISION);
    mac = fakeMac({ running: appServe(LATEST), app: LATEST }); overrideOllamaHost(mac);   // current, and the app: nothing to take over
  }
  const decisionRow = (): { is_enabled: number } | undefined => db().prepare('SELECT is_enabled FROM models WHERE id = ?').get(DECISION_ROW) as { is_enabled: number } | undefined;
  const decisionId = (): string | undefined => (db().prepare("SELECT value FROM config WHERE key = 'decision_model_id'").get() as { value: string } | undefined)?.value;

  it('(a) the dev box: Ollama current with the model listed, the row enabled before the update; migration 209 then the boot: enabled, assigned, zero cards', async () => {
    v35Box(true);
    db().exec(MIGRATION_209());   // the update's migration, as it ran on that box
    await updateFirstBoot();
    expect(mac.brews).toEqual([]);   // no install, no upgrade: the box needed nothing
    expect(decisionRow()?.is_enabled).toBe(1);
    expect(decisionId()).toBe(DECISION_ROW);
    expect(getDecisionProvider()).not.toBeNull();
    expect(liveCards()).toEqual([]);
    expect(await standingCards()).toEqual([]);
  });

  it('(b) the preflight.2 phantom: the row registered but the model not listed; the boot disables it and clears the id', async () => {
    v35Box(false);
    ollama.failPulls = true;   // it cannot arrive at this boot either
    db().exec(MIGRATION_209());
    await updateFirstBoot();
    expect(decisionRow()?.is_enabled).toBe(0);
    expect(decisionId()).toBeUndefined();
    expect(getDecisionProvider()).toBeNull();
  });

  it('(c) the model appears later: the next health answer enables its row and assigns it, with no install and no card', async () => {
    v35Box(false);
    ollama.failPulls = true;
    await updateFirstBoot();
    expect(decisionRow()?.is_enabled).toBe(0);
    ollama.installed.add(DECISION);   // pulled by hand, or the registry was back
    const pulls = ollama.pulls.length;
    const told = liveCards().length;   // the boot told the one missing-models card: the registry was unreachable
    retryStandardModelsIfMissing([...ollama.installed], ollama.serving ? (db().prepare("SELECT base_url FROM providers WHERE id = 'ollama-local'").get() as { base_url: string }).base_url : '');
    await standardInstallSettled();
    expect(decisionRow()?.is_enabled).toBe(1);
    expect(decisionId()).toBe(DECISION_ROW);
    expect(ollama.pulls.length).toBe(pulls);   // nothing was installed for it
    expect(liveCards().length).toBe(told);   // no new card
    expect(await standingCards()).toEqual([]);   // and the missing-models card ended
  });

  // Round 6 (re-review 2 LOW-D). These names state the dependency migration 209's decision lines rely on: its "not registered
  // until Ollama lists it" is healed ONLY because the reconcile runs on every health answer and at boot. Keep it there.
  it('(d) migration 209 healed with no dashboard: Ollama down at the boot\'s first look, then up as the start hook\'s own start comes up: the queued boot ask registers it', async () => {
    v35Box(true);
    mac = fakeMac({ running: null, app: LATEST }); overrideOllamaHost(mac);
    mac.relaunchGate = new Promise<void>((r) => setTimeout(r, 50));   // the app the start hook opens takes real time to come up
    db().exec(MIGRATION_209());
    await updateFirstBoot();   // no dashboard: nothing else ever asks Ollama
    expect(decisionRow()?.is_enabled).toBe(1);
    expect(decisionId()).toBe(DECISION_ROW);
    expect(liveCards()).toEqual([]);
  });

  it('(e) Ollama comes up long after the boot, still no dashboard: the next judgment asks once, and its answer registers the model', async () => {
    v35Box(true);
    mac = fakeMac({ running: null }); overrideOllamaHost(mac);   // nothing to start at boot
    db().exec(MIGRATION_209());
    await updateFirstBoot();
    expect(getDecisionProvider()).toBeNull();
    mac.running = appServe(LATEST);   // the owner opened Ollama himself, hours later
    expect(getDecisionProvider()).toBeNull();   // this judgment keeps its rule, and asks
    for (let i = 0; i < 50 && decisionRow()?.is_enabled !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(decisionRow()?.is_enabled).toBe(1);
    expect(getDecisionProvider()).not.toBeNull();
  });

  it('(f) no storm while Ollama stays down: twenty judgments in a row ask it once', async () => {
    v35Box(true);
    mac = fakeMac({ running: null }); overrideOllamaHost(mac);
    db().exec(MIGRATION_209());
    await updateFirstBoot();
    const before = ollama.requests;
    for (let i = 0; i < 20; i++) getDecisionProvider();
    await new Promise((r) => setTimeout(r, 100));
    expect(ollama.requests - before).toBe(1);
  });
});

