// ════════════════════════════════════════════════════════════════════════════════════
// t220 — A SUMMARY CALL THE CALLER STOPPED IS NOT A WRITER FAILURE.
//
// The fold gives its summary call an abort signal and cuts it when the turn's patience runs
// out. The cut surfaces in `summarize.ts` as a thrown error, and the catch there used to log
// it at ERROR ("SUMMARY_REFUSED summarization model call failed") and hand it to the billing
// breaker as if the writer had failed. A call whose own abort signal is aborted was ended by
// its caller: no error-level line, no breaker note, and no "not answering" mark on the writer,
// whatever the abort's reason was.
//
// Real here: the migrated in-memory DB, `generateSummary`, the health marks. Scripted: only
// the model call (`callModel`), the seam `summarize.ts` itself dials. Names are invented.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t220-summary', 'dojo.db'),
  };
});

interface LogLine { level: string; message: string }
const logLines: LogLine[] = [];
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const at = (level: string) => (message: string): void => { logLines.push({ level, message }); };
  return { ...actual, createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }) };
});

let script: (abortSignal?: AbortSignal) => never = () => { throw new Error('unscripted'); };
vi.mock('../../agent/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/model.js')>();
  return { ...actual, callModel: async (c: { abortSignal?: AbortSignal }) => script(c.abortSignal) };
});

const breakerNotes = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../providers/billing-breaker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/billing-breaker.js')>();
  return {
    ...actual,
    noteSummaryWriterFailure: (...a: Parameters<typeof actual.noteSummaryWriterFailure>) => {
      breakerNotes.calls += 1;
      return actual.noteSummaryWriterFailure(...a);
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { FOLD_IN_TURN_LIMIT, FOLD_STOPPED_BY_OWNER, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';

const AGENT = 'agent-t220-summary';
const PROVIDER = 'prov-t220';
const MODEL = 'm-t220-64k';

function seedBox(): void {
  const db = mockDb.current!;
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES (?, 'Under Test', 'openai-compatible', 'api_key')").run(PROVIDER);
  db.prepare(
    `INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Cloud 64K', 'cloud/64k', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Box Under Test', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL);
}

const marks = (): number =>
  (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'summary_writer_not_answering'").get() as { n: number }).n;
const errorLines = (): LogLine[] => logLines.filter((l) => l.level === 'error');

const summarise = (abortSignal?: AbortSignal) => generateSummary({
  content: 'Some filler lines of an invented conversation about a garden shed.',
  depth: 0, targetTokens: 200, agentId: AGENT, modelId: MODEL, abortSignal,
});

/** A model call that is cut by the caller's abort (with `reason`) and throws, as a transport does. */
function cutBy(ctl: AbortController, reason?: unknown): () => never {
  return () => {
    if (reason === undefined) ctl.abort(); else ctl.abort(reason);
    throw new Error(typeof reason === 'string' ? reason : 'This operation was aborted');
  };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  logLines.length = 0;
  breakerNotes.calls = 0;
  __resetSummaryWriterHealthForTests();
  seedBox();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t220 a summary call its caller aborted', () => {
  for (const [label, reason] of [
    ['the turn ran out of patience', FOLD_IN_TURN_LIMIT],
    ['the owner pressed Stop', FOLD_STOPPED_BY_OWNER],
    ['the caller aborted without saying why', undefined],
  ] as const) {
    it(`${label}: no error-level line, no breaker note, no mark on the writer`, async () => {
      const ctl = new AbortController();
      script = (s) => { expect(s).toBe(ctl.signal); return cutBy(ctl, reason)(); };

      const result = await summarise(ctl.signal);

      expect(result.ok, 'non-vacuity: the call really was cut and returned a refusal').toBe(false);
      expect(errorLines(), 'a stop the caller chose is not an error').toEqual([]);
      expect(breakerNotes.calls, 'the billing breaker is told nothing').toBe(0);
      expect(marks(), 'and the writer is not marked "not answering"').toBe(0);
    });
  }

  it('the line it does leave names the reason', async () => {
    const ctl = new AbortController();
    script = cutBy(ctl, FOLD_IN_TURN_LIMIT);
    await summarise(ctl.signal);
    expect(logLines.some((l) => l.level !== 'error' && l.message.includes(FOLD_IN_TURN_LIMIT))).toBe(true);
  });
});

describe('t220 CONTROL: a real failure on a call nobody aborted is unchanged', () => {
  it('logs at error level, tells the breaker, and marks the writer not answering', async () => {
    script = () => { throw new Error('the writer fell over'); };

    const result = await summarise(new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(errorLines().some((l) => l.message.startsWith('SUMMARY_REFUSED summarization model call failed'))).toBe(true);
    expect(breakerNotes.calls).toBe(1);
    expect(marks()).toBe(1);
  });
});
