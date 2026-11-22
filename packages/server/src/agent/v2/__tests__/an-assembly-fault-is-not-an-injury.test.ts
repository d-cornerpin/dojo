// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 — AN OVER-BUDGET ASSEMBLY CONDENSES OR STOPS WITH THE CARD; IT IS NEVER AN INJURY.
//
// The witness (the dev log, 2026-10-19 16:41): the boundary refused 99,462 tokens against 98,703 with
// no droppable lane. Recovery matched none of its steps and fell to `recordInjury` (class `unknown`,
// status `error`); the Healer's auto-wake re-ran the IDENTICAL assembly 5 s later, three times, then
// texted the owner the agent was "stuck for a few tries", and a session reset followed.
//
// Driven through the real doors: the refusal is the real boundary's (`validateAtProviderBoundary`),
// recovery is `recoverFromError`, and the Healer is the real `onAgentInjured` with its real timers.
// Only the condense (`checkAndCompact`, which dials a summary writer) is scripted.
//   · a refusal whose instructions and tools FIT (measured as the no-fit release measures it): wait for
//     the condense, then ONE wake for the re-assembly (the full-context-wait park) — again on a repeat,
//     and when the condense failed. Never the card, never an injury, never an owner text.
//   · a refusal whose instructions and tools truly overflow: the WINDOW_TOO_SMALL card, status paused
//     (never error), no re-run of any kind, no "stuck" text, the Healer's counter untouched — and a
//     config edit that does not make it fit does not release it.
// (Fix round 1, orchestrator ruling: the plan's "still over after one condense ⇒ instructions and tools
//  overflow" is not true; the card is shown only when the measurement says so.)
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));

const seen = vi.hoisted(() => ({
  cards: [] as Array<Record<string, unknown>>,
  texts: [] as string[],
  reruns: 0,
  condenses: 0,
  condenseFails: false,
  /** Fix round 2: whether the scripted pass makes progress (a summary written) or buys nothing. */
  progress: true,
  toolPayload: 0,
}));
vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { seen.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => { seen.reruns++; }),
  }),
}));
// The one clock is not driven here: the park's due time on the job's task row is what each case reads.
vi.mock('../owed.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), armOwedClock: () => undefined }));
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAlert: (words: string) => { seen.texts.push(words); },
}));
vi.mock('../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The scripted pass records its outcome as the real one does (the compaction door and
  // the brake), so a pass that bought nothing or threw arms the brake the park waits for.
  checkAndCompact: async (agentId: string) => {
    return (await compactionDoor(agentId, async () => {
      seen.condenses++;
      if (seen.condenseFails) throw new Error('the summary writer did not answer');
      const result = { leafCreated: seen.progress ? 1 : 0, condensedCreated: 0, tokensReclaimed: 0 };
      notePassOutcome(agentId, true, result);
      return result;
    }, { measure: async () => ({ assembledTokens: 0, budgetTokens: 1 }) }))!;
  },
}));
vi.mock('../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => seen.toolPayload,
}));

import { runMigrations } from '../../../db/migrations.js';
import { recoverFromError } from '../recovery.js';
import { initState, advance } from '../state.js';
import { clearErrors } from '../../errors.js';
import { endTurnContext } from '../../turn-context.js';
import { liveTurn } from './helpers/live-turn.js';
import { compactionBrakeMsLeft } from '../../../memory/compaction-brakes.js';
import {
  validateAtProviderBoundary, AssemblyValidationError, assemblyTokens, type ValidatedMessage,
} from '../../../memory/assembly-validation.js';
import { contextWindowPolicy, estimateTokens } from '../../../memory/budget.js';
import { __resetStarvedWindowsForTests } from '../../../memory/window-starvation-card.js';
import { compactionDoor } from '../../../memory/compaction-brakes.js';
import { notePassOutcome } from '../../../memory/compaction-brakes.js';
import { noteModelsChanged } from '../honest-stop-lock.js';
import * as coldImport1 from '../../../memory/compaction-brakes.js';

vi.setConfig({ testTimeout: 60_000 });

const AGENT = 'agent-d18';
const MODEL = 'm-d18';
const WINDOW = 128_000;
const OUTPUT = 4_096;
const SYSTEM = 'You keep the dock ledger. '.repeat(40);

const db = (): Database.Database => mockDb.current!;

beforeEach(async () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-d18', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, context_window, max_output_tokens) VALUES (?, 'prov-d18', 'Dock Model', 'dock-model', ?, ?)`).run(MODEL, WINDOW, OUTPUT);
  d.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Dock Counter', 'working', ?), ('hl', 'Healer', 'idle', ?)").run(AGENT, MODEL, MODEL);
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
  seen.cards.length = 0;
  seen.texts.length = 0;
  seen.reruns = 0;
  seen.condenses = 0;
  seen.condenseFails = false;
  seen.progress = true;
  seen.toolPayload = 0;
  coldImport1.__resetBrakesForTests();
  __resetStarvedWindowsForTests();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  clearErrors(AGENT);
  mockDb.current?.close();
  mockDb.current = null;
});

/** The witness's refusal, by the real boundary: rows over budget by a few hundred tokens, no droppable lane. */
async function boundaryRefusal(): Promise<AssemblyValidationError> {
  const budget = contextWindowPolicy(WINDOW, { toolPayloadTokens: 0, maxOutputTokens: OUTPUT }).assemblyBudgetTokens
    - estimateTokens(SYSTEM);
  const line = 'Counted another stack of crates on the north dock and wrote the total on the board. ';
  const rows: ValidatedMessage[] = [{ role: 'user', content: 'keep counting' }, { role: 'assistant', content: 'counting' }];
  let body = '';
  while (assemblyTokens([...rows, { role: 'user', content: body }]) <= budget + 700) body += line;
  const messages = [...rows, { role: 'user' as const, content: body }];
  try {
    await validateAtProviderBoundary({
      agentId: AGENT, modelId: MODEL, messages, systemPrompt: SYSTEM, contextWindow: WINDOW, maxOutputTokens: OUTPUT,
      laneIds: messages.map(() => null),
    });
  } catch (e) {
    if (e instanceof AssemblyValidationError) return e;
    throw e;
  }
  throw new Error('the boundary did not refuse; the witness is gone');
}

/** A wake due now: a park dated the job's task for now; the job turn's pickup clears it. */
const jobDueNow = (): boolean => !!db().prepare("SELECT 1 FROM work WHERE agent_id = ? AND kind = 'task' AND next_attempt_at <= ?").get(AGENT, Date.now());
const jobPickedUp = (): void => { db().prepare("UPDATE work SET next_attempt_at = NULL WHERE agent_id = ?").run(AGENT); };

/** One turn's recovery; the turn serves the owner's request, so its park has a task to date. */
async function recover(error: unknown, turnNumber: number, loopCount = 1): Promise<void> {
  const bag = liveTurn(AGENT, { turnNumber: turnNumber, root: { kind: 'ask', id: 'm-keep-counting', sourceMessageId: 'm-keep-counting' } });
  try { await recoverOnce(error, turnNumber, loopCount); } finally { endTurnContext(AGENT); }
}

async function recoverOnce(error: unknown, turnNumber: number, loopCount: number): Promise<void> {
  const state = advance(initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'keep counting', lastUserMessageId: null, inboundChannel: null, inboundContext: null,
  }), { loopCount });
  await recoverFromError(state, error, { isUserFacingTurn: true });
}

const agent = (): { status: string; last_error: string | null; recovery_attempts: number | null } =>
  db().prepare('SELECT status, last_error, recovery_attempts FROM agents WHERE id = ?').get(AGENT) as never;
const windowCards = (): unknown[] => seen.cards.filter((c) => c.code === 'WINDOW_TOO_SMALL');
const stuckTexts = (): string[] => seen.texts.filter((t) => /stuck/i.test(t));

describe('D18: the first over-budget refusal condenses and re-assembles once; it is no injury', () => {
  it('one condense, ONE wake for the re-assembly, status never error, the Healer never runs', async () => {
    await recover(await boundaryRefusal(), 7);
    expect(seen.condenses, 'the boundary condensed for the dialed window').toBe(1);
    expect(agent().status, 'an engine refusal is not an injury').not.toBe('error');
    expect(jobDueNow(), 'one wake: the re-assembly').toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.reruns, 'no auto-wake re-ran the identical assembly').toBe(0);
    expect(agent().recovery_attempts ?? 0, 'the Healer\'s counter is untouched').toBe(0);
    expect(windowCards()).toEqual([]);
    expect(stuckTexts()).toEqual([]);
  });
});

describe('D18 fix round 1: the woken re-assembly still over while instructions and tools fit', () => {
  it('a pass that made progress: the full-context-wait park again, one wake — never the card, never paused, never a text', async () => {
    await recover(await boundaryRefusal(), 7);
    jobPickedUp();   // the drain served the wake: turn 8 is the re-assembly
    await recover(await boundaryRefusal(), 8);
    expect(windowCards(), 'the instructions and tools fit: the card would be false').toEqual([]);
    expect(agent().status).not.toBe('paused');
    expect(agent().status).not.toBe('error');
    expect(jobDueNow(), 'one more wake: the next re-assembly').toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.reruns, 'no Healer auto-wake').toBe(0);
    expect(seen.texts, 'no owner text of any kind').toEqual([]);
    expect(seen.condenses).toBe(2);
  });

  // Fix round 2: these two asserted another IMMEDIATE wake, which is the silent loop. A pass that bought
  // nothing, or threw, arms the brake, and the park waits for it.
  it('fix round 2: a pass that bought NOTHING arms the brake, and the park waits for it — no immediate wake', async () => {
    seen.progress = false;
    await recover(await boundaryRefusal(), 7);
    expect(compactionBrakeMsLeft(AGENT), 'the brake is on').not.toBeNull();
    expect(jobDueNow(), 'no wake at once into the same refusal').toBe(false);
    expect(windowCards()).toEqual([]);
    expect(seen.texts).toEqual([]);
  });

  it('the condense FAILED: the brake arms and the park waits for it; no card, no text', async () => {
    seen.condenseFails = true;
    await recover(await boundaryRefusal(), 7);
    expect(windowCards()).toEqual([]);
    expect(agent().status).not.toBe('paused');
    expect(agent().status).not.toBe('error');
    expect(compactionBrakeMsLeft(AGENT)).not.toBeNull();
    expect(jobDueNow()).toBe(false);
    expect(seen.texts).toEqual([]);
  });
});

describe('D18 fix round 1: instructions and tools truly overflow the window', () => {
  /** A tool surface that alone fills the window: measured, the agent cannot run on its model. */
  const overflowingTools = (): void => { seen.toolPayload = 125_000; };

  it('the card, status paused, zero re-runs, no stuck text, the Healer\'s counter unchanged', async () => {
    overflowingTools();
    await recover(await boundaryRefusal(), 7);
    expect(windowCards(), 'the owner is told what to change').toHaveLength(1);
    expect(agent().status, 'paused, never error').toBe('paused');
    expect(agent().last_error ?? '').toMatch(/^\[no_model_fits\]/);
    expect(jobDueNow(), 'no wake after the stop').toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.reruns, 'zero re-runs').toBe(0);
    expect(stuckTexts(), 'no "stuck" text').toEqual([]);
    expect(agent().recovery_attempts ?? 0).toBe(0);
  });

  it('a config edit that does not make it fit does not release it', async () => {
    overflowingTools();
    await recover(await boundaryRefusal(), 7);
    expect(agent().status).toBe('paused');
    await noteModelsChanged();
    expect(agent().status, 'still unfit: still parked').toBe('paused');
    expect(seen.reruns, 'not woken into the same refusal').toBe(0);
  });
});
