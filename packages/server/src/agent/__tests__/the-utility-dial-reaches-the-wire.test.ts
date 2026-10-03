// ⚠ THE SEAM, NOT THE POLICY. `utility-dials-do-not-detonate-the-box.test.ts` proves the numbers are
// right; this file proves they reach Ollama. The two are separate because the campaign has already paid
// once for a helper that was perfectly tested while the seam that used it was not — a cap nobody sends
// is a cap nobody has.
//
// It drives the REAL `callModel` against a REAL Ollama-shaped HTTP stub (the harness
// `an-ollama-refusal-is-not-a-failure.test.ts` established) and reads the REQUEST BODY the transport
// actually wrote. The three assertions are the three dials that detonated a user's box: `think`,
// `options.num_predict`, `options.num_ctx`.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: vi.fn(), recordProviderSuccess: vi.fn(),
}));
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t88-utility-dial-wire');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t88-utility-dial-wire', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';
import { utilityDial } from '../utility-dial.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t88-utility-dial-wire', '.dojo');

/** The window the affected box's auto-sizer recommended for a 4b model — the number in the incident. */
const RECOMMENDED_NUM_CTX = 28_672;
/** The model's configured "Max output", the field Settings showed and nothing honoured. */
const MAX_OUTPUT_TOKENS = 32_768;

interface OllamaBody {
  think?: boolean;
  options?: { num_ctx?: number; num_predict?: number };
  messages?: Array<{ role: string; content: string }>;
}

let server: http.Server;
let stubUrl = '';
let bodies: OllamaBody[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/chat')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw) as OllamaBody); } catch { bodies.push({}); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'A short title' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  // ⚠ THINKING ON AND A BIG RECOMMENDED WINDOW: the affected box's configuration exactly. The dial
  // has to override both, and an agent turn on the same model must not be touched.
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', 1, datetime('now'), datetime('now'))
  `).run(stubUrl);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, thinking_enabled, num_ctx_recommended, is_enabled,
                        created_at, updated_at)
    VALUES ('m-small-local', 'local-ollama', 'Small Local', 'small-local', '["text"]', 32768,
            ?, 1, ?, 1, datetime('now'), datetime('now'))
  `).run(MAX_OUTPUT_TOKENS, RECOMMENDED_NUM_CTX);
  // A vision-sized sibling: the engine charges an IMAGE a large fixed cost against the assembly budget
  // (measured: ~16,400 tokens), so a 32K-context model refuses ANY image outright — see the clause.
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, thinking_enabled, num_ctx_recommended, is_enabled,
                        created_at, updated_at)
    VALUES ('m-vision-local', 'local-ollama', 'Vision Local', 'vision-local', '["text","vision"]',
            131072, ?, 1, ?, 1, datetime('now'), datetime('now'))
  `).run(MAX_OUTPUT_TOKENS, RECOMMENDED_NUM_CTX);
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('a-fixture', 'Fixture Agent', 'm-small-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
  bodies = [];
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const dial = (purpose?: string, content = 'x'.repeat(1_200)): Promise<unknown> => callModel({
  agentId: 'a-fixture',
  modelId: 'm-small-local',
  messages: [{ role: 'user', content }],
  systemPrompt: '',
  tools: false,
  ...(purpose ? { purpose } : {}),
});

describe('a declared utility dial reaches the wire with all three dials turned down', () => {
  it('⚠ THINKING IS OFF even though the model has the toggle ON', async () => {
    await dial('ask_title');
    expect(bodies).toHaveLength(1);
    // The toggle is the user's choice for their AGENT's turns. Inheriting it here is what spent
    // 4,156 output tokens of reasoning on a 60-character title.
    expect(bodies[0].think).toBe(false);
  });

  it('⚠ THE OUTPUT CAP IS SENT AS options.num_predict — the knob that honoured nothing', async () => {
    await dial('ask_title');
    expect(bodies[0].options?.num_predict).toBe(utilityDial('ask_title')!.maxOutputTokens);
    expect(bodies[0].options?.num_predict).toBeLessThan(128);
  });

  it('⚠ THE WINDOW IS THE CALL\'S, NOT THE BOX\'S RECOMMENDATION', async () => {
    await dial('ask_title');
    const sent = bodies[0].options?.num_ctx ?? 0;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(RECOMMENDED_NUM_CTX / 4);
  });

  it('a summariser may ask for less than its ceiling, and it reaches the wire', async () => {
    await callModel({
      agentId: 'a-fixture', modelId: 'm-small-local', systemPrompt: '',
      messages: [{ role: 'user', content: 'summarise this' }],
      tools: false, purpose: 'memory_summarize', utilityTargetTokens: 300,
    });
    const sent = bodies[0].options?.num_predict ?? 0;
    expect(sent).toBeGreaterThanOrEqual(300);
    expect(sent).toBeLessThan(utilityDial('memory_summarize')!.maxOutputTokens);
  });
});

describe('⚠ M1 ON THE WIRE: a screenshot widens the window it rides in', () => {
  it('a vision caption with a big image asks for more window than its sentence would', async () => {
    // ⚠ THE WIRING, and a mutant is why this clause exists: deleting `imageBase64Lengths` from the
    // transport left every policy clause passing while the window went back to being sized on the
    // caption's one sentence — i.e. the floor, with a multi-thousand-token picture beside it.
    // The content shape is the one `canvas-view.ts` and `system-control.ts` send.
    // ⚠ THE SIZE IS ITSELF A FINDING. At 2 MB (and at 500 KB on this fixture's model) the call is
    // refused OUTRIGHT by the pre-existing assembly budget — "assembly is STILL over budget … failing
    // loud rather than sending an assembly known to be wrong" — so a truly enormous image already
    // fails LOUDLY rather than truncating. That BOUNDS M1: the silent-truncation risk lives in the
    // band between the 2,048 floor and that budget, and this image sits inside it.
    const bigImage = 'A'.repeat(350_000);           // ~260 KB decoded: an ordinary screen grab
    await callModel({
      agentId: 'a-fixture', modelId: 'm-vision-local', systemPrompt: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigImage } },
          { type: 'text', text: 'Describe what is on this screen.' },
        ] as never,
      }],
      tools: false, purpose: 'vision_caption',
    });
    const sent = bodies[0].options?.num_ctx ?? 0;
    // Text alone would have landed on the 2,048 floor; the image is what makes this bigger.
    expect(sent).toBeGreaterThan(2_048);
    // …and still bounded by the box's configured window, which is the memory budget speaking.
    expect(sent).toBeLessThanOrEqual(RECOMMENDED_NUM_CTX);
  });

  it('a TEXT caption on the same purpose stays small — the image is what costs, not the purpose', async () => {
    await callModel({
      agentId: 'a-fixture', modelId: 'm-small-local', systemPrompt: '',
      messages: [{ role: 'user', content: 'Describe what is on this screen.' }],
      tools: false, purpose: 'vision_caption',
    });
    expect(bodies[0].options?.num_ctx).toBeLessThanOrEqual(4_096);
  });
});

describe('⚠ M3: the Max-output knob gets a floor, because it was inert until now', () => {
  it('an implausibly small stored value is NOT bound, and the call falls back to the default', async () => {
    // The field has always been in Settings and was sent NOWHERE on this path, so whatever a box has
    // stored was never exercised by use. A user who once typed a tiny number into a dead knob must not
    // discover it by having their agent's turns truncated the day they update.
    mockDb.current!.prepare("UPDATE models SET max_output_tokens = 100 WHERE id = 'm-small-local'").run();
    clearClientCache();
    await dial(undefined);
    expect(bodies[0].options?.num_predict).toBeUndefined();
  });

  it('…and a sane stored value still binds, which is the whole point of the knob', async () => {
    mockDb.current!.prepare("UPDATE models SET max_output_tokens = 2048 WHERE id = 'm-small-local'").run();
    clearClientCache();
    await dial(undefined);
    expect(bodies[0].options?.num_predict).toBe(2048);
  });

  it('⚠ AND A UTILITY DIAL IS UNAFFECTED BY THE FLOOR — its cap comes from this engine', async () => {
    // 64 is below the floor on purpose: the floor exists to distrust a FIELD NOBODY COULD SEE WORKING,
    // not to second-guess a number this module chose for an 80-character artifact.
    mockDb.current!.prepare("UPDATE models SET max_output_tokens = 100 WHERE id = 'm-small-local'").run();
    clearClientCache();
    await dial('ask_title');
    expect(bodies[0].options?.num_predict).toBe(utilityDial('ask_title')!.maxOutputTokens);
  });
});

describe('⚠ AN AGENT TURN ON THE SAME MODEL IS UNTOUCHED — the whole blast radius of this package', () => {
  it('keeps the thinking toggle, the recommended window, and the configured Max output', async () => {
    await dial(undefined);
    expect(bodies).toHaveLength(1);
    // Thinking stays ON: it is the user's setting for their own agent's turns.
    expect(bodies[0].think).toBe(true);
    // The window stays the box's recommendation — this package does not re-size agent turns.
    expect(bodies[0].options?.num_ctx).toBe(RECOMMENDED_NUM_CTX);
    // …and `num_predict` now carries the model's own "Max output" setting, which is the OTHER half
    // of the dead-knob finding: the field existed in Settings and was sent nowhere.
    expect(bodies[0].options?.num_predict).toBe(MAX_OUTPUT_TOKENS);
  });

  it('an UNRECOGNISED purpose is treated as an agent turn, not as a utility dial', async () => {
    // A typo must not quietly cap a person's conversation at 64 tokens.
    await dial('ask-title');
    expect(bodies[0].think).toBe(true);
    expect(bodies[0].options?.num_ctx).toBe(RECOMMENDED_NUM_CTX);
    expect(bodies[0].options?.num_predict).toBe(MAX_OUTPUT_TOKENS);
  });
});
