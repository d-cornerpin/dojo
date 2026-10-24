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
//   · the first refusal: one condense, then ONE wake for the re-assembly; no injury, no Healer.
//   · the re-assembly still over: the WINDOW_TOO_SMALL card, status paused (never error), no
//     re-run of any kind, no "stuck" text, and the Healer's attempt counter untouched.
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
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAlert: (words: string) => { seen.texts.push(words); },
}));
vi.mock('../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkAndCompact: async () => { seen.condenses++; return { compacted: true }; },
}));
vi.mock('../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 0,
}));

import { runMigrations } from '../../../db/migrations.js';
import { recoverFromError } from '../recovery.js';
import { initState, advance } from '../state.js';
import { clearErrors } from '../../errors.js';
import { pendingWakeups } from '../../shared-state.js';
import {
  validateAtProviderBoundary, AssemblyValidationError, assemblyTokens, type ValidatedMessage,
} from '../../../memory/assembly-validation.js';
import { contextWindowPolicy, estimateTokens } from '../../../memory/budget.js';
import { __resetStarvedWindowsForTests } from '../../../memory/window-starvation-card.js';
import { __resetOverBudgetAssemblyForTests } from '../over-budget-assembly.js';

vi.setConfig({ testTimeout: 60_000 });

const AGENT = 'agent-d18';
const MODEL = 'm-d18';
const WINDOW = 128_000;
const OUTPUT = 4_096;
const SYSTEM = 'You keep the dock ledger. '.repeat(40);

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
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
  pendingWakeups.clear();
  __resetStarvedWindowsForTests();
  __resetOverBudgetAssemblyForTests();
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

async function recover(error: unknown, turnNumber: number, loopCount = 1): Promise<void> {
  const state = advance(initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'keep counting', lastUserMessageId: null, inboundChannel: null, inboundContext: null,
    pendingTechniqueAck: null,
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
    expect(pendingWakeups.has(AGENT), 'one wake: the re-assembly').toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.reruns, 'no auto-wake re-ran the identical assembly').toBe(0);
    expect(agent().recovery_attempts ?? 0, 'the Healer\'s counter is untouched').toBe(0);
    expect(windowCards()).toEqual([]);
    expect(stuckTexts()).toEqual([]);
  });
});

describe('D18: the re-assembly still over budget stops with the card', () => {
  it('the card, status paused, zero re-runs, no stuck text, the Healer\'s counter unchanged', async () => {
    await recover(await boundaryRefusal(), 7);
    pendingWakeups.clear();   // the drain served the wake: turn 8 is the re-assembly
    await recover(await boundaryRefusal(), 8);
    expect(windowCards(), 'the owner is told what to change').toHaveLength(1);
    expect(agent().status, 'paused, never error').toBe('paused');
    expect(agent().last_error ?? '').toMatch(/^\[no_model_fits\]/);
    expect(pendingWakeups.has(AGENT), 'no wake after the stop').toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.reruns, 'zero re-runs').toBe(0);
    expect(stuckTexts(), 'no "stuck" text').toEqual([]);
    expect(agent().recovery_attempts ?? 0).toBe(0);
    expect(seen.condenses, 'one per refusal, the boundary\'s: the stop itself starts nothing').toBe(2);
  });

  it('a refusal later in a turn that already dialed is a fresh chain: it condenses again, no card', async () => {
    await recover(await boundaryRefusal(), 7);
    pendingWakeups.clear();
    await recover(await boundaryRefusal(), 8, 3);   // the re-assembly dialed; its third call grew past budget
    expect(windowCards()).toEqual([]);
    expect(agent().status).not.toBe('paused');
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });
});
