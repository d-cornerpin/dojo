// v3.5 A1 — ONE MODULE NAMES THE DOJO'S TWO STANDARD LOCAL MODELS, INSTALLS THEM, AND POINTS THE
// ENGINE AT THEM. Every Ollama call is a scripted fetch: nothing here pulls a real model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { standardModelRowId, STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../local-standard.js';
import { standardState, upkeep } from '../ollama-upkeep.js';
import { getSystemModel } from '../../router/selector.js';
import { summaryWriterCandidates } from '../../memory/writer.js';

const ROLE_KEYS = ['healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model'];
const db = (): Database.Database => mockDb.current!;

/** The upkeep as Repair runs it, then the Settings state. */
const repair = async (): Promise<Awaited<ReturnType<typeof standardState>>> => { await upkeep('repair'); return standardState(); };

/** A scripted Ollama: what is installed, and every pull asked of it. */
const ollama = { installed: new Set<string>(), pulls: [] as string[], up: true };

function pullStream(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`${JSON.stringify({ status: 'pulling', digest: 'sha256:a', total: 100, completed: 50 })}\n`));
      ctrl.enqueue(enc.encode(`${JSON.stringify({ status: 'success' })}\n`));
      ctrl.close();
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  ollama.installed = new Set(['nomic-embed-text:latest']);
  ollama.pulls = [];
  ollama.up = true;
  for (const k of ROLE_KEYS) db().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(k, `role-model-${k}`);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (!ollama.up) throw new Error('fetch failed: ECONNREFUSED');
    const path = new URL(url).pathname;
    if (path === '/api/tags') return Response.json({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) });
    if (path === '/api/ps') return Response.json({ models: [] });
    if (path === '/api/show') return new Response('not found', { status: 404 });
    if (path === '/api/pull') {
      const model = (JSON.parse(init?.body ?? '{}') as { model: string }).model;
      ollama.pulls.push(model);
      ollama.installed.add(model);
      return pullStream();
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

const roleKeys = (): Record<string, string | undefined> =>
  Object.fromEntries(ROLE_KEYS.map((k) => [k, (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value]));
const configValue = (k: string): string | undefined =>
  (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const systemTier = (): string[] =>
  (db().prepare("SELECT model_id FROM router_tier_models WHERE tier_id = 'system' ORDER BY priority").all() as Array<{ model_id: string }>).map((r) => r.model_id);

describe('the upkeep installs the pair', () => {
  it('on a box with neither model pulls both, registers both rows, assigns the tier and the two keys, and leaves the role agents alone', async () => {
    const before = roleKeys();
    const state = await repair();
    expect(ollama.pulls).toEqual([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag]);

    const rows = db().prepare("SELECT api_model_id, is_enabled, provider_id FROM models WHERE api_model_id IN (?, ?) ORDER BY api_model_id")
      .all(STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag) as Array<{ api_model_id: string; is_enabled: number; provider_id: string }>;
    expect(rows.map((r) => r.api_model_id).sort()).toEqual([STANDARD_WRITER_MODEL.tag, STANDARD_DECISION_MODEL.tag].sort());
    expect(rows.every((r) => r.is_enabled === 1)).toBe(true);
    const provider = db().prepare('SELECT type, base_url FROM providers WHERE id = ?').get(rows[0].provider_id) as { type: string; base_url: string };
    expect(provider.type).toBe('ollama');

    const writerId = standardModelRowId('writer');
    const decisionId = standardModelRowId('decision');
    expect(writerId).toBeTruthy();
    expect(decisionId).toBeTruthy();
    expect(systemTier()).toEqual([writerId]);
    // Owner ruling 2026-10-24 ("The agents model."): the install never picks the summary writer; each agent's own model writes.
    expect(configValue('compaction_model_id')).toBeUndefined();
    expect(configValue('decision_model_id')).toBe(decisionId);
    expect(roleKeys()).toEqual(before);

    expect(state.decision).toBe('installed');
    expect(state.writer).toBe('installed');
    expect(state.ollama).toBe('running');
  });

  it('with both present pulls nothing and still repairs a missing assignment', async () => {
    await repair();
    ollama.pulls = [];
    db().prepare("DELETE FROM router_tier_models WHERE tier_id = 'system'").run();
    db().prepare("DELETE FROM config WHERE key IN ('decision_model_id', 'compaction_model_id')").run();

    await repair();
    expect(ollama.pulls).toEqual([]);
    expect(systemTier()).toEqual([standardModelRowId('writer')]);
    expect(configValue('decision_model_id')).toBe(standardModelRowId('decision'));
    expect(configValue('compaction_model_id')).toBeUndefined();
  });

  it("never overwrites a summary writer the owner picked", async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('big-writer', 'cloud', 'Big', 'big', '[\"chat\"]', 200000, 1)").run();
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'big-writer')").run();
    await repair();
    expect(configValue('compaction_model_id')).toBe('big-writer');
  });

  it('the engine answers with the writer afterwards: the system tier and the first summary writer', async () => {
    await repair();
    expect(getSystemModel()).toBe(standardModelRowId('writer'));
    expect(summaryWriterCandidates()[0]).toBe(standardModelRowId('writer'));   // an auto-routed agent: the writer as the fallback
  });

  it('getSystemModel answers the writer even when the tier row was lost', async () => {
    await repair();
    db().prepare("DELETE FROM router_tier_models WHERE tier_id = 'system'").run();
    expect(getSystemModel()).toBe(standardModelRowId('writer'));
  });
});

describe('standardState (REVIEW FOCUS 3: nothing silently fails)', () => {
  it('says Ollama is not running when it does not answer, and pulls nothing', async () => {
    ollama.up = false;
    const s = await repair();
    expect(s.ollama).not.toBe('running');
    expect(s.note).toMatch(/Ollama is not/);
  });

  it('says which model is missing', async () => {
    const s = await standardState();
    expect(s.decision).toBe('missing');
    expect(s.writer).toBe('missing');
    expect(s.note).toContain(STANDARD_DECISION_MODEL.tag);
  });

  it('installed on a 16 GB box: the plain installed sentence', async () => {
    const os = await import('node:os');
    const spy = vi.spyOn(os.default, 'totalmem').mockReturnValue(16 * 1024 ** 3);
    await repair();
    expect((await standardState()).note).toBe('Both standard models are installed (6.2 GB).');
    spy.mockRestore();
  });

  it('installed on an 8 GB box: the memory squeeze is explained', async () => {
    const os = await import('node:os');
    const spy = vi.spyOn(os.default, 'totalmem').mockReturnValue(8 * 1024 ** 3);
    await repair();
    expect((await standardState()).note).toBe(
      "This box has 8 GB; the Dojo's two models need about 6 GB of memory beside the desktop and the engine, so a local agent model will not fit alongside them.",
    );
    spy.mockRestore();
  });
});
