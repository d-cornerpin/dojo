// ════════════════════════════════════════════════════════════════════════════════════════
// t168 (v3.3.3 run 9) — AN ABORTED SUMMARISER CALL IS A CANCELLED CALL, NOT A REFUSAL.
//
// The witness (a user's box, one agent): a summariser call was cut by an abort. `writeSummary`
// logged "SUMMARY_REFUSED summarizer produced no usable text" with the reason "summarizer call
// was aborted before it finished", `condense-until-fits` named the stage `summariser_refused`,
// and `notePassOutcome` armed the force-binding brake for fifteen minutes. From then on every
// emergency pass — forced ones included — was skipped ("backing off after a pass that reclaimed
// nothing"), while the agent's context grew past its budget. The brake is evidence that the
// WRITER cannot write; a call the turn, the owner's Stop or a teardown cancelled says nothing
// about the writer.
//
// What is real here: the migrated in-memory DB, `checkAndCompact` and its whole trigger, the
// real condenser, `summarize.ts` (`writeSummary`, `unusableOutput`, `settleSummaryCall`), the
// real brake and the real defect report. ONLY the model call is scripted, through the seam
// `summarize.ts` itself dials (`callModel`) — and the abort is made the way the world makes it:
// the pass's own signal is aborted while the call is in flight, and the call returns empty.
//
// All fixture text is filler and every name is invented.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t168-aborted', 'dojo.db'),
  };
});

interface LogLine { level: string; message: string; meta: Record<string, unknown> }
const logLines: LogLine[] = [];
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const at = (level: string) => (message: string, meta?: Record<string, unknown>): void => {
    logLines.push({ level, message, meta: meta ?? {} });
  };
  return { ...actual, createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }) };
});
const defectLines = (): LogLine[] => logLines.filter((l) => l.message.startsWith('COMPACTION_DEFECT'));
const brakeSkips = (): LogLine[] => logLines.filter((l) => l.message.startsWith('Compaction skipped: backing off'));

const frames: Array<{ type: string; code?: string; error?: string; retryable?: boolean }> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type: string; code?: string; error?: string; retryable?: boolean }) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

/** What the summariser's model call does next. Scripted per clause. */
interface ModelCall { abortSignal?: AbortSignal; utilityTargetTokens?: number }
let script: (c: ModelCall) => { content: string } = () => ({ content: '' });
let modelCalls = 0;
vi.mock('../../agent/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/model.js')>();
  return {
    ...actual,
    callModel: async (c: ModelCall) => { modelCalls += 1; return script(c); },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact, rebuildContextItems } from '../compaction.js';
import { compactionIsBraked, __resetBrakesForTests } from '../compaction-brakes.js';
import { compactionFailureReason, compactionFailingCardText } from '../compaction-defect.js';
import { rawContextSummaryTokens } from '../condense-until-fits.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';

const AGENT = 'agent-t168-aborted';
const PROVIDER = 'prov-t168';
const MODEL = 'm-t168-64k';
const WINDOW = 65_536;
const TAIL_ROWS = 40;
const TAIL_TOKENS_EACH = 800;

function seedBox(): void {
  const db = mockDb.current!;
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES (?, 'Under Test', 'openai-compatible', 'api_key')").run(PROVIDER);
  db.prepare(
    `INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Cloud 64K', 'cloud/64k', '["text"]', 1, 65536, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status, session_started_at) VALUES (?, 'Box Under Test', ?, 'idle', '1970-01-01')")
    .run(AGENT, MODEL);
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, ?, ?)`,
  );
  const body = 's'.repeat(TAIL_TOKENS_EACH * 4);
  db.transaction(() => {
    for (let i = 0; i < TAIL_ROWS; i += 1) insertMsg.run(`msg-${i}`, AGENT, body, TAIL_TOKENS_EACH, Date.now() - (TAIL_ROWS - i) * 1000);
  })();
}

/** Already-written summaries holding more than the assembler admits, each covering a real message. */
function seedSummaries(count: number, tokensEach: number): void {
  const db = mockDb.current!;
  const insert = db.prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, created_at)
     VALUES (?, ?, 0, 'leaf', ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare('INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
  const oldest = (db.prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY created_at ASC LIMIT 1').get(AGENT) as { id: string }).id;
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - (count - i) * 60_000).toISOString();
      insert.run(`sum-${i}`, AGENT, 's'.repeat(tokensEach * 4), tokensEach, at, at, at);
      link.run(`sum-${i}`, oldest);
    }
  })();
  rebuildContextItems(AGENT);
}

/** A model that writes what it was asked for. */
const writes = (c: ModelCall): { content: string } => ({ content: 's'.repeat((c.utilityTargetTokens ?? 500) * 4) });

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  frames.length = 0;
  logLines.length = 0;
  modelCalls = 0;
  script = () => ({ content: '' });
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  __resetBreakersForTests();
  __resetSummaryWriterHealthForTests();
  seedBox();
  seedSummaries(8, 6_000);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.useRealTimers();
});

describe('t168 (i) an aborted summariser call leaves no brake, and the next forced pass runs', () => {
  it('the turn cancels the pass mid-call: no brake, no defect, no card, no stage on file', async () => {
    const ctl = new AbortController();
    script = () => { ctl.abort(); return { content: '' }; };   // cut in flight, returns nothing
    const before = rawContextSummaryTokens(AGENT);

    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: ctl.signal });

    expect(modelCalls, 'non-vacuity: the summariser really was dialled and really was cut').toBeGreaterThan(0);
    expect(rawContextSummaryTokens(AGENT), 'and nothing was reclaimed').toBe(before);
    expect(compactionIsBraked(AGENT, true), 'a cancelled call is not evidence the writer cannot write').toBe(false);
    expect(compactionIsBraked(AGENT, false)).toBe(false);
    expect(compactionFailureReason(AGENT), 'no failing stage is recorded').toBeNull();
    expect(defectLines(), 'no defect line: nothing is broken').toEqual([]);
    expect(frames.filter((f) => f.code === 'COMPACTION_FAILING'), 'the owner is told nothing').toEqual([]);
  });

  it('and the next forced pass RUNS, and reclaims', async () => {
    const ctl = new AbortController();
    script = () => { ctl.abort(); return { content: '' }; };
    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: ctl.signal });
    const callsAfterAbort = modelCalls;
    const before = rawContextSummaryTokens(AGENT);

    script = writes;
    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: new AbortController().signal });

    expect(brakeSkips(), 'the pass was not skipped by a brake').toEqual([]);
    expect(modelCalls, 'it dialled the writer again').toBeGreaterThan(callsAfterAbort);
    expect(rawContextSummaryTokens(AGENT), 'and condensed').toBeLessThan(before);
  });

  it('an owner Stop reaching the pass the same way is also no brake', async () => {
    const ctl = new AbortController();
    script = () => { ctl.abort('fold-stopped-by-owner'); return { content: '' }; };
    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: ctl.signal });
    expect(compactionIsBraked(AGENT, true)).toBe(false);
    expect(defectLines()).toEqual([]);
  });
});

describe('t168 (iv) a real writer refusal still brakes, exactly as before', () => {
  it('an empty answer from a call nobody cancelled arms the force-binding brake, reports the stage and cards once', async () => {
    script = () => ({ content: '' });   // the model answered with nothing usable; no abort anywhere

    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: new AbortController().signal });

    expect(compactionIsBraked(AGENT, true), 'the brake binds even the next emergency').toBe(true);
    expect(compactionFailureReason(AGENT)).toBe('summariser_refused');
    const defects = defectLines();
    expect(defects.length, 'one defect line').toBe(1);
    expect(defects[0].level).toBe('error');
    expect(defects[0].meta).toMatchObject({ stage: 'summariser_refused', detail: 'summarizer returned empty text', repairableByTheOwner: true });
    const cards = frames.filter((f) => f.code === 'COMPACTION_FAILING');
    expect(cards.length, 'the owner is told once').toBe(1);
    expect(cards[0].error).toBe(compactionFailingCardText('summariser_refused'));
    expect(cards[0].retryable).toBe(true);

    // and the next forced pass inside the window dials nothing
    const callsAfterFirst = modelCalls;
    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true, abortSignal: new AbortController().signal });
    expect(modelCalls).toBe(callsAfterFirst);
  });

  it('a pass with no signal at all (a manual or routine caller) brakes on a refusal as it always did', async () => {
    script = () => ({ content: '' });
    await checkAndCompact(AGENT, MODEL, WINDOW, { force: true });
    expect(compactionIsBraked(AGENT, true)).toBe(true);
    expect(compactionFailureReason(AGENT)).toBe('summariser_refused');
  });
});
