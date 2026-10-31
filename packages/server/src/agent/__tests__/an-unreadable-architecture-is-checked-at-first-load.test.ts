// v3.5 BACKLOG 3.5 (29b) — A MODEL WHOSE ARCHITECTURE CANNOT BE READ IS NOT JUDGED ON ITS WEIGHTS ALONE.
//
// The fit sizes the need as the weights plus the KV cache of the window the model will run at. When
// `/api/show` cannot be read (no entry, or a `model_info` missing the fields `kvBytesPerTokenOf` needs),
// the working memory was silently charged as 0: the model passed on its weights alone, nothing was
// marked, and nothing re-checked it at its first load. This unreadable case now takes the same path as
// Ollama-down and not-downloaded-yet: allowed, marked, and judged when the model first loads.
// The whole setup (fixture, scripted Ollama) is copied from `local-model-fit.test.ts`.
// Ollama is a scripted fetch; nothing real is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { localModelFit, refuseUnfitLocalModel, refuseUncheckedAtFirstLoad } from '../local-model-fit.js';
import { pickDesktopReserve, ENGINE_RESERVE_BYTES } from '../../services/num-ctx-calculator.js';
import { writerReservedWindowTokens } from '../../services/dojo-working-memory.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { uncheckedFitWords } from '../../healer/owner-notices.js';

const GIB = 1024 ** 3;
const EMBEDDER = 274_302_471;
/** A Qwen-shaped architecture: 128-wide heads, 8 KV heads → 4,096 × blocks bytes of KV per token. */
const arch = (blocks: number): Record<string, unknown> => ({
  'general.architecture': 'qwen3', 'qwen3.block_count': blocks, 'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144,
});
const kvPerToken = (blocks: number): number => 2 * blocks * 8 * 128 * 2;
const ollama = {
  up: true,
  tags: [
    { name: 'nomic-embed-text:latest', size: EMBEDDER },
    { name: STANDARD_DECISION_MODEL.tag, size: STANDARD_DECISION_MODEL.bytes },
    { name: STANDARD_WRITER_MODEL.tag, size: STANDARD_WRITER_MODEL.bytes },
    { name: 'qwen3.5:9b', size: 6_600_000_000 },
    { name: 'qwen3.5:2b', size: 2_700_000_000 },
    { name: 'tiny:1b', size: 800_000_000 },
  ],
  show: { 'qwen3.5:9b': arch(36), 'qwen3.5:2b': arch(28), 'tiny:1b': arch(16), [STANDARD_WRITER_MODEL.tag]: arch(36) } as Record<string, Record<string, unknown>>,
};
const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, api: string, caps = '["chat"]'): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES (?, ?, ?, ?, ?, 262144, 1)`).run(id, provider, api, api, caps);
};
let totalRam = 16 * GIB;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  frames.list.length = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
  model('m-9b', 'ollama-local', 'qwen3.5:9b');
  model('m-2b', 'ollama-local', 'qwen3.5:2b');
  model('m-1b', 'ollama-local', 'tiny:1b');
  model('m-unlisted', 'ollama-local', 'not-pulled:3b');
  model('m-cloud', 'cloud', 'big-cloud');
  model('m-writer', 'ollama-local', STANDARD_WRITER_MODEL.tag);
  model('m-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, '["decision"]');
  ollama.up = true;
  ollama.show['qwen3.5:9b'] = arch(36);   // these tests blank or change it: each one starts from the full fixture
  totalRam = 16 * GIB;
  vi.spyOn(os, 'totalmem').mockImplementation(() => totalRam);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (!ollama.up) throw new Error('fetch failed: ECONNREFUSED');
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: ollama.tags });
    if (p === '/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name: string }).name;
      const mi = ollama.show[name];
      return mi ? Response.json({ model_info: mi }) : new Response('not found', { status: 404 });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

/** Open memory on the Dojo's own box, by the calculator's reserves, the pair and the writer's job window. */
async function openOn(total: number): Promise<number> {
  const writerWorking = kvPerToken(36) * await writerReservedWindowTokens(null);
  return total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - EMBEDDER
    - STANDARD_DECISION_MODEL.bytes - STANDARD_WRITER_MODEL.bytes - writerWorking;
}
const AT_32K = 32_000;

describe('the third case Ollama cannot size: the architecture that sizes the working memory is unreadable', () => {
  const uncheckedVerdict = (v: Awaited<ReturnType<typeof localModelFit>>): void => {
    expect(v!.unchecked).toBe(true);
    expect(v!.fits).toBe(true);
    expect(v!.message).toBe(uncheckedFitWords('qwen3.5:9b'));
  };

  it('/api/show has no entry for the model: allowed and marked for the first load, not judged on weights alone', async () => {
    delete ollama.show['qwen3.5:9b'];   // the stub answers 404
    uncheckedVerdict(await localModelFit('m-9b'));
  });

  it('model_info has an architecture but none of the fields the KV cost needs: the same', async () => {
    ollama.show['qwen3.5:9b'] = { 'general.architecture': 'qwen3' };
    uncheckedVerdict(await localModelFit('m-9b'));
  });

  it('the pick is allowed and marked; at the first load /api/show is asked again and an unfit model is refused then', async () => {
    // (1) the owner picks the model while (2) /api/show cannot be read: (3) allowed, marked `agent:m-9b`.
    delete ollama.show['qwen3.5:9b'];
    expect(await refuseUnfitLocalModel('m-9b', null)).toBeNull();
    expect(!!db().prepare("SELECT 1 FROM healer_state WHERE scope = 'local_fit_unchecked' AND key = 'agent:m-9b'").get()).toBe(true);
    // (4) at its first load /api/show now answers (full arch(36)): the model needs ~11.3 GB, the 16 GB box has less open.
    ollama.show['qwen3.5:9b'] = arch(36);
    await expect(refuseUncheckedAtFirstLoad('m-9b')).rejects.toThrow(/^qwen3\.5:9b needs about 11\.3 GB of memory/);
  });

  it('control: with a readable architecture the verdict is the one it always was — judged, never marked', async () => {
    const open = await openOn(16 * GIB);
    const v = await localModelFit('m-9b');
    expect(v!.unchecked).toBeUndefined();
    expect(v!.fits).toBe(false);
    expect(v!.openBytes).toBe(open);
    expect(v!.needBytes).toBe(6_600_000_000 + kvPerToken(36) * AT_32K);
  });
});
