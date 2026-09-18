// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T77b — THE BOOT PRICE REFRESH POINTS AT THE SAME PLACE THE CHAT CALL DOES.
//
// T63 deleted the hand-rolled `${baseUrl}/v1/models` from the two config routes and made
// `resolveOpenAIBaseUrl` (agent/model.ts) the single answer for where an OpenAI-compatible
// provider's API is. It missed a third copy: `services/pricing-sync.ts` still built the URL
// by hand, so the boot refresh — which runs against EVERY validated openai-compatible
// provider — asked a base URL that already ends in `/v1` for `…/v1/v1/models` and took a 404.
// That is the owner's local DS4 log: the provider validates and chats fine through the door
// T63 fixed, and the price sync alone reports the box broken.
//
// The census that came with the fix, recorded so nobody re-runs it:
//   • `services/capabilities.ts` (`buildOpenRouterModelsEndpoint`) DOES NOT FIRE. Its only
//     caller is `probeOpenRouter`, reached only behind `isOpenRouter(providerBaseUrl)`; a
//     local install falls to the generic `return []` and builds no URL at all.
//   • `services/litellm-pricing-sync.ts` DOES NOT FIRE. It fetches one fixed GitHub raw JSON
//     URL and never touches a provider base URL; a non-DeepSeek openai-compatible row is
//     refused by `acceptedLiteLlmProvidersForRow` before any fetch.
//
// Controls below hold the two shapes that already worked BYTE-IDENTICAL.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t77b-pricing-sync');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t77b-pricing-sync', 'dojo.db'),
  };
});

// Every provider in this file has a key stored; the no-key arm is the loader's own
// business and is covered where the loader is tested.
vi.mock('../../config/loader.js', async (importActual) => {
  const actual = await importActual<typeof import('../../config/loader.js')>();
  return { ...actual, getProviderCredential: () => 'sk-test-key' };
});

import { runMigrations } from '../../db/migrations.js';
import { syncAllProviderPricing, providerModelsUrl } from '../pricing-sync.js';
import { resolveOpenAIBaseUrl } from '../../agent/model.js';

// ── The stub: an OpenAI-compatible server whose catalog lives at /v1/models ──

let server: http.Server;
let stubRoot = '';
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4', pricing: { prompt: '0.0000004', completion: '0.0000016' } }],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function seedProvider(id: string, baseUrl: string): void {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES (?, ?, 'openai-compatible', ?, 'api_key', 1, datetime('now'), datetime('now'))
  `).run(id, id, baseUrl);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, context_window, max_output_tokens,
                        input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, 'DeepSeek V4', 'deepseek-v4', 128000, 8192, 0, 0, 1, datetime('now'), datetime('now'))
  `).run(`${id}-model`, id);
}

/** Prices round-trip through a float multiply (per-token → per-million), so they are
 *  compared to six places rather than by identity. */
function expectPriced(id: string, input: number, output: number): void {
  const row = mockDb.current!
    .prepare('SELECT input_cost_per_m, output_cost_per_m FROM models WHERE id = ?')
    .get(`${id}-model`) as { input_cost_per_m: number; output_cost_per_m: number };
  expect(row.input_cost_per_m).toBeCloseTo(input, 6);
  expect(row.output_cost_per_m).toBeCloseTo(output, 6);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  hits.length = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T77b — the boot price refresh resolves the models URL the one way', () => {
  it('THE DEFECT — a base URL that already ends in /v1 is not doubled', async () => {
    seedProvider('local-ds4', `${stubRoot}/v1`);
    await syncAllProviderPricing();

    expect(hits).toEqual(['/v1/models']);
    expectPriced('local-ds4', 0.4, 1.6);
  });

  it('a base URL typed WITHOUT the /v1 reaches the same endpoint', async () => {
    seedProvider('local-bare', stubRoot);
    await syncAllProviderPricing();

    expect(hits).toEqual(['/v1/models']);
    expectPriced('local-bare', 0.4, 1.6);
  });

  it('a trailing slash is not a different provider', async () => {
    seedProvider('local-slash', `${stubRoot}/v1/`);
    await syncAllProviderPricing();

    expect(hits).toEqual(['/v1/models']);
  });

  // ── CONTROLS: the two shapes that already worked, byte for byte ──

  it('CONTROL — the OpenRouter URL is byte-identical to what the hand-build produced', () => {
    expect(providerModelsUrl('https://openrouter.ai/api'))
      .toBe('https://openrouter.ai/api/v1/models?output_modalities=text,image,audio,video');
    // the modality union rides only OpenRouter, exactly as before
    expect(providerModelsUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/models');
  });

  it('CONTROL — cloud DeepSeek is still skipped before any URL is built', async () => {
    seedProvider('deepseek', 'https://api.deepseek.com');
    await syncAllProviderPricing();

    expect(hits).toEqual([]);
    expectPriced('deepseek', 0, 0);
  });

  it('CONTROL — the URL rule is the client\'s own, not a second copy of it', () => {
    for (const base of [
      'https://openrouter.ai/api',
      'http://localhost:8000/v1',
      'http://localhost:8000',
      'https://api.deepseek.com',
    ]) {
      expect(providerModelsUrl(base).split('?')[0])
        .toBe(`${resolveOpenAIBaseUrl(base)}/models`);
    }
  });

  it('CONTROL — a non-openai-compatible provider is untouched', async () => {
    mockDb.current!.prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
      VALUES ('anthropic', 'Anthropic', 'anthropic', NULL, 'api_key', 1, datetime('now'), datetime('now'))
    `).run();
    await syncAllProviderPricing();
    expect(hits).toEqual([]);
  });
});
