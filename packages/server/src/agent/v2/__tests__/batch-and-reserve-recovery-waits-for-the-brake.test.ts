// ════════════════════════════════════════════════════════════════════════════════════════
// t211 (D7b, ctx 11) — THE ERROR-RECOVERY FORCED COMPACTIONS WAIT FOR THE EVENT THAT CAN CHANGE THE ANSWER.
//
// t168 gave a surrendered full context one park: `parkAfterForcedPass` queues the wake now when the forced
// pass reclaimed, and dates the job's task for the compaction brake's expiry when the brake binds
// (a skipped pass changes nothing, so a wake into the same rows and the same brake re-ran the same wall 1,216
// times in twelve minutes). The two forced compactions in `recovery.ts` (context overflow, and the one-shot
// after a declared-patience exhaustion) were two copies of the old park: pass, then an unconditional immediate
// wake. They also read the agent's configured model, bailed when it was the auto-router, and measured the
// window of THAT model instead of the model the failed call dialed.
//
// What is real here: the recovery cascade, the real brake, the real park, the real wait module. Scripted: the
// compaction pass itself (it asks the real brake first and reports to it, as `checkAndCompact` does).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AgentError } from '../../errors.js';
import { initState } from '../state.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { compactionIsBraked, notePassOutcome, LOW_YIELD_BACKOFF_MS, __resetBrakesForTests } from '../../../memory/compaction-brakes.js';
import { __resetFullContextWaitForTests } from '../full-context-wait.js';
import { runMigrations } from '../../../db/migrations.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

const NONE = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
const WON = { leafCreated: 2, condensedCreated: 1, tokensReclaimed: 5_000 };
let nextPass: 'reclaims' | 'nothing' = 'nothing';
const passes: Array<{ modelId: string; contextWindow: number; options: Record<string, unknown> | undefined }> = [];
const checkAndCompactSpy = vi.fn(async (agentId: string, modelId: string, contextWindow: number, options?: Record<string, unknown>) => {
  if (compactionIsBraked(agentId, true)) return NONE;   // the entry point's own first question
  passes.push({ modelId, contextWindow, options });
  if (nextPass === 'reclaims') { notePassOutcome(agentId, true, WON); return WON; }
  notePassOutcome(agentId, true, NONE, { stage: 'nothing_left_to_condense', detail: 'scripted' });
  return NONE;
});
vi.mock('../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../memory/compaction.js')>()),
  checkAndCompact: (...a: unknown[]) => checkAndCompactSpy(...(a as [string, string, number])),
}));
// The one clock is not driven here: the park's due time on the job's task row is what each case reads.
vi.mock('../owed.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), armOwedClock: () => undefined }));
vi.mock('../../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { recoverFromError } from '../recovery.js';

const AGENT = 'agent-recovery';
const MIN = 60_000;
const DIALED_WINDOW = 32_000;

function seed(modelId: string): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('small-model', 'p', 'S', 's-1', '["tools"]', ?, 1)`).run(DIALED_WINDOW);
  if (modelId !== 'auto') { /* the agent's own model row is the dialed one */ }
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'A', ?, 'idle', '{}', 'sensei')")
    .run(AGENT, modelId === 'auto' ? null : modelId);
}
const stateFor = (configuredModelId: string, contextWindow: number, locked: string | null = null) => {
  const s = initState({
    agentId: AGENT, contextWindow, isAutoRouted: configuredModelId === 'auto', configuredModelId, turnNumber: 5,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'go on', lastUserMessageId: 'm-1',
    inboundChannel: 'dashboard', inboundContext: null,
  });
  return locked ? { ...s, lockedModelId: locked } : s;
};
const overflow = (): AgentError => new AgentError('prompt is too long: 250000 tokens > 200000 maximum', AGENT, { code: 'context_overflow' });
/** When the job's task is due (null: nothing parked). */
const jobDue = (): number | null => (mockDb.current!.prepare("SELECT MIN(next_attempt_at) AS due FROM work WHERE agent_id = ? AND kind = 'task'").get(AGENT) as { due: number | null }).due;
const dueNow = (): boolean => { const d = jobDue(); return d !== null && d <= Date.now(); };
/** The failed turn serves the owner's request, so its park has a task to date. */
async function recover(...a: Parameters<typeof recoverFromError>): Promise<void> {
  const bag = openTurnContext(AGENT);
  bag.turnNumber = 5;
  bag.root = { kind: 'ask', id: 'm-1', sourceMessageId: 'm-1' };
  try { await recoverFromError(...a); } finally { endTurnContext(AGENT); }
}
function armTheBrake(): void {
  notePassOutcome(AGENT, true, NONE, { stage: 'summariser_refused', detail: 'scripted refusal', modelId: 'small-model' });
  expect(compactionIsBraked(AGENT, true), 'non-vacuity: the brake binds a forced pass').toBe(true);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  __resetBrakesForTests();
  __resetFullContextWaitForTests();
  checkAndCompactSpy.mockClear();
  passes.length = 0;
  nextPass = 'nothing';
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('t211 D7b — a recovery pass the brake skipped does not wake the agent into the same wall', () => {
  it('context overflow with the brake on: no immediate wake; one timer wake at the brake\'s expiry', async () => {
    seed('small-model');
    armTheBrake();
    await recover(stateFor('small-model', DIALED_WINDOW), overflow(), { isUserFacingTurn: true });
    expect(dueNow(), 'nothing can change in the next half second, so no immediate wake').toBe(false);
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS - MIN);
    expect(dueNow(), 'a minute before the expiry: still waiting').toBe(false);
    await vi.advanceTimersByTimeAsync(MIN + 5);
    expect(dueNow(), 'at the expiry: due').toBe(true);
  });

  it('declared-patience exhaustion with the brake on: the same wait', async () => {
    seed('small-model');
    armTheBrake();
    const exhausted = new AgentError('declared patience exceeded', AGENT, { code: 'declared_patience_exceeded' });
    await recover(stateFor('small-model', DIALED_WINDOW), exhausted, { isUserFacingTurn: false });
    expect(dueNow()).toBe(false);
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    expect(dueNow()).toBe(true);
  });

  it('control: a pass that reclaims queues the wake at once, as before', async () => {
    seed('small-model');
    nextPass = 'reclaims';
    await recover(stateFor('small-model', DIALED_WINDOW), overflow(), { isUserFacingTurn: true });
    expect(dueNow()).toBe(true);
  });
});

describe('t211 D7b — the pass is for the model the failed call dialed', () => {
  it('an auto-routed agent: the pass runs (it no longer bails on the auto-router) against the locked model\'s window', async () => {
    seed('auto');
    nextPass = 'reclaims';
    await recover(stateFor('auto', 200_000, 'small-model'), overflow(), { isUserFacingTurn: true });
    expect(passes.length, 'the pass ran').toBe(1);
    expect(passes[0].contextWindow).toBe(DIALED_WINDOW);
    expect(passes[0].options?.dialedModelId).toBe('small-model');
    expect(dueNow()).toBe(true);
  });
});
