// proof-fix S — A PART THE DECISION MODEL REFUSES AS TOO LARGE IS SPLIT FURTHER, SO THE CHECK COMPLETES.
// A later Ollama may count a request differently from the 93-byte rule proof-fix P measured (0.40.13). This fake
// door refuses above a threshold that is NOT that rule (here: JSON(state) + JSON(questions) > 24,000 bytes, with
// HTTP 413). Before the fix the refused part made the whole check `unavailable`; now the part is halved and its
// pieces are checked. No real model is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { checkSummary } from '../summary-check.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-split-refused';
const LIMIT = 24_000;
const refused: number[] = [];
let answered = 0;
let always413 = false;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  refused.length = 0; answered = 0; always413 = false;
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47151', 'none', 1)").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db.prepare("INSERT INTO config (key, value) VALUES ('decision_model_window', '28672')").run();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { state: unknown; questions: Record<string, unknown> };
    const n = Buffer.byteLength(JSON.stringify(body.state)) + Buffer.byteLength(JSON.stringify(body.questions));
    if (always413 || n > LIMIT) { refused.push(n); return new Response('{"error":"text and schema must not exceed 64 KiB"}', { status: 413 }); }
    answered++;
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { noul: 0.05 }])) });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const notes = (n: number, chars: number): string => Array.from({ length: n }, (_, i) =>
  `<summary id="sum_${i}" depth="0">\n${`note${i} `.repeat(chars / 6)}\n</summary>`).join('\n\n');
const rows = (n: number, chars: number): string => Array.from({ length: n }, (_, i) => `row ${i} ${'word '.repeat(chars / 5)}`).join('\n---\n');

describe('a part the model refuses as too large is split and its pieces are checked', () => {
  it('a source with no row divider: the refused part is halved until accepted, and the verdict is recorded', async () => {
    const c = await checkSummary(notes(4, 15_000), `Summary of the notes. ${'note1 '.repeat(200)}`, AGENT, { background: true });
    expect(refused.length).toBeGreaterThan(0);   // the model did refuse a part
    expect(answered).toBeGreaterThan(1);
    expect(c.answers).not.toBeNull();
    expect(c.answers!.invented).toMatchObject({ noul: 0.05 });
  });

  it('a source of whole rows: the same,', async () => {
    const c = await checkSummary(rows(8, 9_000), 'A short summary.', AGENT, { background: true });
    expect(refused.length).toBeGreaterThan(0);
    expect(c.answers).not.toBeNull();
  });

  it('a waited check (an agent asks) is split the same way', async () => {
    const c = await checkSummary(notes(3, 15_000), 'A short summary.', AGENT);
    expect(c.answers).not.toBeNull();
  });

  it('a piece that cannot be split smaller is recorded unavailable as before, and the splitting ends', async () => {
    always413 = true;
    const c = await checkSummary(notes(2, 3_000), 'A short summary.', AGENT, { background: true });
    expect(c.answers).toBeNull();
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(40);
  });
});

describe('splitting a refused part by characters', () => {
  it('never cuts between the two halves of one character: a source of emoji is checked and answered', async () => {
    const c = await checkSummary('\u{1F600}'.repeat(14_000), 'A short summary.', AGENT, { background: true });
    expect(refused.length).toBeGreaterThan(0);
    expect(c.answers).not.toBeNull();
  });
});
