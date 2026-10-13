// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — CONDENSE ONLY WHEN NEEDED (tracker #13; decision #16 re-opened and reversed by the
// owner, 2026-10-12: OR-V333-SET (1)).
//
// THE RULING, in his words as recorded: condense only when the working view is getting full
// for the model actually used, or messages are about to leave view — and then only the
// messages leaving view, never what the agent is reading.
//
// ── THE WITNESS ─────────────────────────────────────────────────────────────────────────
// The pre-call gate's routine arm fired a background summarise whenever more than 30
// unsummarised rows sat outside the newest N rows, "regardless of token level". After t94 the
// live view is every row since the compaction boundary, so those rows were IN VIEW: the agent
// was reading them word for word while they were folded into a summary, and the cache broke
// behind the summaries lane every time. A busy agent with a mailbox crosses 30 rows within a
// handful of small asks, so a small ask on a quiet window condensed.
//
// ── THE DOOR ────────────────────────────────────────────────────────────────────────────
// `runPreCallGates` — the engine's pre-call step, exactly as the driver calls it — against a
// REAL migrated database, the real compaction trigger, the real tail horizon and the real
// leaf compaction. Mocked: the summariser's model call (its text is not the subject), the
// vault archive (a file write), the websocket. A background condense is awaited by watching
// the same one-per-agent latch the gate sets, so "nothing was condensed" is never read before
// a condense could have finished.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

vi.mock('../../../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 2_000,
}));

const generateSummarySpy = vi.fn();
vi.mock('../../../../../memory/summarize.js', () => ({
  generateSummary: (...args: unknown[]) => generateSummarySpy(...args),
}));

vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

vi.mock('../../../../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { backgroundDrains, pendingWakeups, stoppedAgents, turnContinuationCounts } from '../../../../shared-state.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-busy';
const MODEL = 'm-t140-200k';
const WINDOW = 200_000;   // getFreshTailCount(200_000) === 80 rows

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type) VALUES ('p-t140', 'P', 'openai-compatible', 'api_key')`,
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
     VALUES (?, 'p-t140', 'Roomy', 'roomy', '["text","tools"]', ?, 4096, 1)`,
  ).run(MODEL, WINDOW);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Busy Desk', ?, 'idle', '{}', datetime('now'))`,
  ).run(AGENT, MODEL);
}

/** A busy, aged inbox: many small inbound notices and short exchanges, all tiny in tokens. */
function seedBusyHistory(rows: number): void {
  for (let i = 0; i < rows; i++) {
    if (i % 3 === 0) {
      insertMessage({
        agentId: AGENT, role: 'user', lane: 'owner', senderId: 'mailbox', authorized: false,
        content: `[SOURCE: GMAIL NOTIFICATION] New email ${i}: shipping update for order ${i}.`, turnNumber: 1 + Math.floor(i / 3),
      });
    } else if (i % 3 === 1) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `Quick one ${i}: is the dock open?`, turnNumber: 1 + Math.floor(i / 3) });
    } else {
      insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `Yes, the dock is open (${i}).`, turnNumber: 1 + Math.floor(i / 3) });
    }
  }
}

function summaryCount(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?').get(AGENT) as { n: number }).n;
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function freshState(): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber: 99, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'is the dock open?', lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
  return advance(s, { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
}

function makeCtx(): PreCallGatesContext & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  const ctx = {
    agentId: AGENT, turnNumber: 99, contextWindow: WINDOW, contextModelId: MODEL,
    configuredModelId: MODEL, isAutoRouted: false, counterparty: OWNER,
    assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (event: WsEvent) => { events.push(event); },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  return Object.assign(ctx, { events });
}

/** Wait until no background condense is in flight for this agent (bounded). */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!backgroundDrains.has(AGENT)) return;
  }
  throw new Error('a background condense never settled');
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear();
  pendingWakeups.clear();
  stoppedAgents.clear();
  turnContinuationCounts.clear();
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'Earlier dock questions, all answered.', tokenCount: 9 }));
  seedAgent();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 W2 — a small ask on an aged, busy agent condenses nothing', () => {
  it.fails('RED at 00a2b34d: 150 tiny rows, no token pressure, and the gate still fires a summarise', async () => {
    seedBusyHistory(150);
    const out = await runPreCallGates(freshState(), makeCtx());
    expect(out.directive).toBe('proceed');
    await settle();
    expect(generateSummarySpy, 'no summariser call: the view is nowhere near full and nothing is leaving it').not.toHaveBeenCalled();
    expect(summaryCount()).toBe(0);
  });
});
