// proof-fix P — A CHECK'S PARTS ARE SIZED AS OLLAMA COUNTS THEM, SO NONE IS REFUSED WITH HTTP 413.
// MEASURED on the dev box (Ollama 0.40.13, `/v1/systemone`, proof-fix-p-REPORT.md): Ollama's 64 KiB "text and
// schema" limit counts the JSON of `state` plus the JSON of `questions` plus 93 bytes of its own. The model name,
// `keep_alive` and any other top-level field are not counted; escapes and multi-byte characters count as the bytes
// they are in the body. The paid run lost every condensed summary's verdict this way: the part splitter filled
// the WHOLE body to 64 KiB, which Ollama counts as 16 to 24 bytes over.
// The fetch below is Ollama's door as measured: no real model is asked.
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
import { decide, decideRequestBody, type FailureClass, type Question } from '../../agent/decide.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-sized-parts';
const db = (): Database.Database => mockDb.current!;
/** Ollama's own count, as measured: refused over 64 KiB. */
const ollamaCounts = (body: { state: unknown; questions: unknown }): number =>
  Buffer.byteLength(JSON.stringify(body.state)) + Buffer.byteLength(JSON.stringify(body.questions)) + 93;
const refused: number[] = [];
let answered = 0;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  refused.length = 0; answered = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47151', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  // The dev box's window (`decision_model_window`): wide enough that the 64 KiB count, not the window, sizes a part.
  db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_window', '28672')").run();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { state: unknown; questions: Record<string, unknown> };
    const n = ollamaCounts(body);
    if (n > 64 * 1024) { refused.push(n); return new Response('{"error":"text and schema must not exceed 64 KiB"}', { status: 413 }); }
    answered++;
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { noul: 0.05 }])) });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

/** A condensed summary's source as `condensedSummaryInput` writes it: notes joined by blank lines (no row divider). */
const notes = (n: number, chars: number): string => Array.from({ length: n }, (_, i) =>
  `<summary id="sum_${i}" depth="0" conversation="the dashboard" earliest="2026-11-02 03:24" latest="2026-11-02 03:43">\n${`note${i} `.repeat(chars / 6)}\n</summary>`).join('\n\n');

describe('the summary check over a source larger than one request', () => {
  it('a condensed summary over four long notes: every part is accepted and the verdict is recorded', async () => {
    const source = notes(4, 15_000);
    const summary = `Summary of the background notes in this span. ${'note1 '.repeat(1300)}`;
    const c = await checkSummary(source, summary, AGENT);
    expect(refused).toEqual([]);
    expect(answered).toBeGreaterThan(1);   // it did need parts
    expect(c).not.toBeNull();
  });
});

describe('decide() refuses, before dialling, a request Ollama would refuse', () => {
  it('a state whose body is under 64 KiB but over Ollama\'s count is not sent; the caller hears too_large', async () => {
    const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
    const failures: FailureClass[] = [];
    // The body is 65,530 bytes, under 64 KiB, but Ollama counts it over (no model name, plus its own 93 bytes).
    const bodyOf = (n: number): number => Buffer.byteLength(decideRequestBody(STANDARD_DECISION_MODEL.tag, { x: 'a'.repeat(n) }, Q));
    const x = 'a'.repeat(65_530 - bodyOf(0));
    expect(bodyOf(x.length)).toBe(65_530);
    const r = await decide({ x }, Q, { purpose: 'sized_test', onFailure: (f) => failures.push(f) });
    expect(r).toBeNull();
    expect(refused).toEqual([]);
    expect(failures).toEqual(['too_large']);
  });
});
