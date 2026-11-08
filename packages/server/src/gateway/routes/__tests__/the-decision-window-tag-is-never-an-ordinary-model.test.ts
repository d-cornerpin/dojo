// t268 fix round 1 (I-1) — THE DECISION MODEL'S WINDOW TAG IS PART OF THE DOJO'S PAIR, NEVER AN ORDINARY MODEL.
// It is `tev1:4b-q4_K_M` at the window the Dojo reserves (`services/decision-window.ts`). So: no door registers it
// as a pickable chat model, setup does not list it with Remove, a migrated box is never asked to download it, and
// when it is missing the Dojo makes it again locally from the base tag — never a pull. Every outside call is scripted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t268-window-tag');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import { setupDepsRouter } from '../setup-deps.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL, withoutDojoInternalTags } from '../../../services/local-standard.js';
import { standardState, upkeep, upkeepSettled, upkeepWhenIncomplete } from '../../../services/ollama-upkeep.js';

/** The upkeep as Repair runs it, then the Settings state. */
const repair = async (): Promise<Awaited<ReturnType<typeof standardState>>> => { await upkeep('repair'); return standardState(); };
import { decisionTagWindow } from '../../../services/dojo-working-memory.js';
import { refuseUnfitLocalModel } from '../../../agent/local-model-fit.js';

const BASE = 'http://localhost:11434';
const WINDOW_TAG = STANDARD_DECISION_MODEL.windowTag;
const ollama = { names: [] as string[], createOk: true, creates: 0, pulls: 0, tagWindow: null as number | null };
const realFetch = globalThis.fetch;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  Object.assign(ollama, { names: [STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag, WINDOW_TAG, 'nomic-embed-text:latest'], createOk: true, creates: 0, pulls: 0, tagWindow: 27_648 });
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    if (url.pathname === '/api/tags') return json({ models: ollama.names.map((name) => ({ name, size: 1 })) });
    if (url.pathname === '/api/ps') return json({ models: [] });
    if (url.pathname === '/api/show') {
      if ((body.model ?? body.name) === WINDOW_TAG) return ollama.names.includes(WINDOW_TAG) && ollama.tagWindow ? json({ parameters: `num_ctx ${ollama.tagWindow}` }) : json({}, 404);
      return json({}, 404);
    }
    if (url.pathname === '/api/create') {
      ollama.creates++;
      if (!ollama.createOk) return json({ error: 'no' }, 500);
      ollama.tagWindow = (body.parameters as { num_ctx: number }).num_ctx;
      if (!ollama.names.includes(WINDOW_TAG)) ollama.names.push(WINDOW_TAG);
      return json({ status: 'success' });
    }
    if (url.pathname === '/api/pull') { ollama.pulls++; return json({ status: 'success' }); }
    throw new Error(`unexpected outside call: ${url}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; mockDb.current?.close(); mockDb.current = null; });

const rowFor = (api: string): unknown => db().prepare('SELECT id FROM models WHERE api_model_id = ?').get(api);

describe('no door makes it a model anyone can pick', () => {
  it('provider validation registers the pair\'s base tags and other models, never the window tag', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none')").run(BASE);
    expect((await configRouter.request('/providers/ollama-local/validate', { method: 'POST' })).status).toBe(200);
    expect(rowFor('nomic-embed-text:latest')).toBeTruthy();
    expect(rowFor(WINDOW_TAG)).toBeUndefined();
  });

  it('setup\'s discovery does not register it either, and setup\'s model list (with its Remove button) does not show it', async () => {
    await setupDepsRouter.request('/ollama/auto-configure', { method: 'POST' });
    await upkeepSettled();
    expect(rowFor(WINDOW_TAG)).toBeUndefined();
    const listed = (await (await setupDepsRouter.request('/ollama/models')).json()) as { data: Array<{ name: string }> };
    expect(listed.data.map((m) => m.name)).not.toContain(WINDOW_TAG);
    expect(listed.data.map((m) => m.name)).toContain(STANDARD_WRITER_MODEL.tag);
  });

  it('a box that already holds a row for it (from before this fix) cannot pick it: the decision-model refusal', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none')").run(BASE);
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-wt', 'ollama-local', ?, ?, '["chat"]', 1)`).run(WINDOW_TAG, WINDOW_TAG);
    expect(await refuseUnfitLocalModel('m-wt')).toMatch(/is the Dojo's decision model/);
  });

  it('the migration manifest\'s model list leaves it out (a migrated box is never asked to download it)', () => {
    expect(withoutDojoInternalTags(['qwen3.5:9b', WINDOW_TAG, STANDARD_DECISION_MODEL.tag])).toEqual(['qwen3.5:9b', STANDARD_DECISION_MODEL.tag]);
  });
});

describe('a missing or failed window tag is made again locally by the retry hook, never downloaded', () => {
  const install = async (): Promise<void> => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none')").run(BASE);
    await repair();
  };

  it('removed by hand: the Ollama health check\'s retry clears the recorded window (decide() falls back at once) and makes it again', async () => {
    ollama.names = ollama.names.filter((n) => n !== WINDOW_TAG);
    ollama.tagWindow = null;
    await install();
    expect(decisionTagWindow()).not.toBeNull();
    ollama.names = ollama.names.filter((n) => n !== WINDOW_TAG);   // removed in Ollama
    const creates = ollama.creates;
    upkeepWhenIncomplete(ollama.names, BASE);
    await upkeepSettled();
    expect(ollama.creates).toBe(creates + 1);
    expect(ollama.pulls).toBe(0);
    expect(decisionTagWindow()).not.toBeNull();
  });

  it('a creation that failed at install is retried by the same hook that retries a missing standard model', async () => {
    ollama.names = ollama.names.filter((n) => n !== WINDOW_TAG);
    ollama.tagWindow = null;
    ollama.createOk = false;
    await install();
    expect(decisionTagWindow()).toBeNull();
    ollama.createOk = true;
    upkeepWhenIncomplete(ollama.names, BASE);
    await upkeepSettled();
    expect(decisionTagWindow()).not.toBeNull();
    expect(ollama.pulls).toBe(0);
  });
});
