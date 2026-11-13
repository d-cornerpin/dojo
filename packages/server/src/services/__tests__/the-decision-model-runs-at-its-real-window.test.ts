// t268 ruling 2 — THE DECISION MODEL RUNS AT THE WINDOW THE DOJO RESERVES FOR IT, THROUGH A DERIVED TAG.
// B5 (`overhaul-plans/v35-writer-measure.md` → "The num_ctx question") measured that Ollama's `/v1/systemone`
// ignores `num_ctx` in every form (the runner stays at its built-in 8,192 and refuses anything longer) and
// refuses any body over 64 KiB (HTTP 413), while a derived tag carrying `PARAMETER num_ctx N` runs at N.
// Every Ollama call here is a scripted fetch: nothing pulls, creates or asks a real model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../local-standard.js';
import { standardState, upkeep } from '../ollama-upkeep.js';

/** The upkeep as Repair runs it, then the Settings state. */
const repair = async (): Promise<Awaited<ReturnType<typeof standardState>>> => { await upkeep('repair'); return standardState(); };
import { decisionWindowTokens, writerJobWindowTokens } from '../dojo-working-memory.js';
import { MEASURED_CHARS_PER_TOKEN } from '../token-density.js';
import { decide, type Question } from '../../agent/decide.js';

const BASE = 'http://127.0.0.1:47141';
const db = (): Database.Database => mockDb.current!;
/** B5's measured limits of the base tag, and what the scripted Ollama was asked. */
const ollama = {
  installed: new Set<string>(), tagWindow: null as number | null, createOk: true,
  creates: [] as Array<Record<string, unknown>>, asked: [] as Array<{ model: string; bytes: number; keys: string[]; state: Record<string, string> }>,
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(BASE);
  Object.assign(ollama, { installed: new Set([STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag]), tagWindow: null, createOk: true, creates: [], asked: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    if (path === '/api/tags') return Response.json({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) });
    if (path === '/api/ps') return Response.json({ models: [] });
    if (path === '/api/show') {
      if (body.model === STANDARD_DECISION_MODEL.windowTag) {
        return ollama.tagWindow === null ? new Response('not found', { status: 404 }) : Response.json({ parameters: `num_ctx                        ${ollama.tagWindow}\nstop "<|im_end|>"` });
      }
      return new Response('not found', { status: 404 });
    }
    if (path === '/api/create') {
      ollama.creates.push(body);
      if (!ollama.createOk) return new Response('boom', { status: 500 });
      ollama.tagWindow = (body.parameters as { num_ctx: number }).num_ctx;
      ollama.installed.add(String(body.model));
      return Response.json({ status: 'success' });
    }
    if (path === '/v1/systemone') {
      const bytes = Buffer.byteLength(init?.body ?? '');
      ollama.asked.push({ model: String(body.model), bytes, keys: Object.keys(body), state: body.state as Record<string, string> });
      if (bytes > 64 * 1024) return new Response('text and schema must not exceed 64 KiB', { status: 413 });
      return Response.json({ answers: { stated_current: { noul: 0.1 }, q: { noul: 0.2 } }, usage: { input_tokens: 10 } });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const Q: Record<string, Question> = { q: { type: 'noul', instructions: 'Is `reply` a question?' } };

describe('install makes the decision model\'s window real', () => {
  it('creates the derived tag FROM the standard decision model at the window the memory fit reserves, and decide() asks it', async () => {
    await repair();
    expect(ollama.creates).toHaveLength(1);
    const made = ollama.creates[0] as { model: string; from: string; parameters: { num_ctx: number } };
    expect(made).toMatchObject({ model: STANDARD_DECISION_MODEL.windowTag, from: STANDARD_DECISION_MODEL.tag });
    expect(await decisionWindowTokens()).toBe(made.parameters.num_ctx);   // one number: the tag, the fit, the sizing
    // A full 64 KiB body at this box's density fits it; it is no larger than the writer's job (the check's text).
    expect(made.parameters.num_ctx).toBeGreaterThanOrEqual(Math.ceil(64 * 1024 / MEASURED_CHARS_PER_TOKEN));
    expect(made.parameters.num_ctx).toBeLessThanOrEqual(await writerJobWindowTokens(null));
    await decide({ reply: 'Is it done?' }, Q, { purpose: 'probe' });
    expect(ollama.asked.map((a) => a.model)).toEqual([STANDARD_DECISION_MODEL.windowTag]);
  });

  it('is idempotent: a tag already at that window is left alone; a tag at another window is refreshed', async () => {
    await repair();
    await repair();
    expect(ollama.creates).toHaveLength(1);
    const want = (ollama.creates[0].parameters as { num_ctx: number }).num_ctx;
    ollama.tagWindow = 8_192;   // e.g. made by hand, or under an older density
    await repair();
    expect(ollama.creates).toHaveLength(2);
    expect(ollama.creates[1]).toMatchObject({ model: STANDARD_DECISION_MODEL.windowTag, parameters: { num_ctx: want } });
  });

  it('an Ollama that cannot create it: decide() keeps the base tag at its measured built-in 8,192, and the next install tries again', async () => {
    ollama.createOk = false;
    await repair();
    expect(await decisionWindowTokens()).toBe(8_192);
    await decide({ reply: 'x' }, Q, { purpose: 'probe' });
    expect(ollama.asked.map((a) => a.model)).toEqual([STANDARD_DECISION_MODEL.tag]);
    ollama.createOk = true;
    await repair();
    expect(await decisionWindowTokens()).toBeGreaterThan(8_192);
  });
});

describe('decide()\'s requests fit that window and Ollama\'s 64 KiB body', () => {
  it('sends no num_ctx (Ollama ignores it), and never dials a body over 64 KiB', async () => {
    await repair();
    await decide({ reply: 'x' }, Q, { purpose: 'probe' });
    expect(ollama.asked[0].keys).toEqual(['model', 'state', 'questions', 'keep_alive']);
    ollama.asked.length = 0;
    expect(await decide({ reply: 'y'.repeat(70_000) }, Q, { purpose: 'probe' })).toBeNull();
    expect(ollama.asked).toHaveLength(0);
  });

});
