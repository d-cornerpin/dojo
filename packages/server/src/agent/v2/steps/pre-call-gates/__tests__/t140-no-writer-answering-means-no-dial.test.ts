// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 6 (final review I1, ruling R-V333-15) — WHEN NO SUMMARY WRITER IS ANSWERING, THE GATE
// DOES NOT DIAL ONE.
//
// Round 5 let the background placeholder replacement try EVERY non-broken writer on EVERY gate run.
// An empty answer never opens the billing breaker, so with placeholders present and the writers
// answering empty, a tool loop paid every writer on every iteration: the reviewer measured 40
// writer calls over ten gate runs where v3.3.2 made 4.
//
// The smart signal is the writer's health, not a count: a writer that failed is not dialled again —
// by a turn or by the background — until something has changed. The change signals are real
// events: a person starts a new turn, the owner picks another writer in Settings, or the writer
// answers. While no writer is answering, the placeholders stay, labelled, and nothing is dialled.
//
// THE DOOR: `runPreCallGates`, as the driver calls it, on a migrated DB; the summariser is scripted.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 2_000,
}));

/** Every writer answers empty unless `answering` says otherwise; outcomes are recorded as the real wrapper does. */
const summariser = vi.hoisted(() => ({ answering: false, calls: [] as string[] }));
vi.mock('../../../../../memory/summarize.js', async () => {
  const health = await import('../../../../../memory/summary-writer-health.js');
  return {
    generateSummary: async (args: { modelId?: string; abortSignal?: AbortSignal }) => {
      summariser.calls.push(args.modelId ?? '?');
      health.noteSummaryWriterOutcome(args.modelId, summariser.answering, args.abortSignal);
      return summariser.answering
        ? { ok: true, text: 'Earlier the crew counted the north dock.', tokenCount: 8 }
        : { ok: false, reason: 'summarizer returned empty text' };
    },
  };
});
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
import { __resetSummaryWriterHealthForTests } from '../../../../../memory/summary-writer-health.js';
import { writeUncondensedPlaceholders, hasUncondensedPlaceholders } from '../../../../../memory/uncondensed-placeholder.js';
import { advance, initState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-quiet-writers';
const OWN = 'm-t140-own';
const WRITERS = [OWN, 'm-t140-w2', 'm-t140-w3', 'm-t140-w4'];
const db = (): Database.Database => mockDb.current!;
const PERSON: TurnCounterparty = { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null } as unknown as TurnCounterparty;

function seed(): void {
  WRITERS.forEach((id, i) => {
    db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES (?, ?, 'openai-compatible', 'api_key')`).run(`p-${i}`, `P${i}`);
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
                  VALUES (?, ?, ?, ?, '["text","tools"]', 200000, 4096, 1, ?, ?)`).run(id, `p-${i}`, id, id, i + 1, i + 2);
  });
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Busy Desk', ?, 'idle', '{}', datetime('now'))`).run(AGENT, OWN);
  for (let i = 0; i < 40; i++) {
    insertMessage({ agentId: AGENT, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner', senderId: i % 2 === 0 ? 'owner' : null, content: `[row ${i}] Is the dock open? Yes.`, turnNumber: 1 + Math.floor(i / 2) });
  }
  const tenth = (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq LIMIT 1 OFFSET 9').get(AGENT) as { seq: number }).seq;
  writeUncondensedPlaceholders(AGENT, tenth);
}

async function gate(turnNumber: number, loopCount: number): Promise<void> {
  const s = advance(initState({
    agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: OWN,
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'is the dock open?', lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount });
  const ctx = {
    agentId: AGENT, turnNumber, contextWindow: 200_000, contextModelId: OWN, configuredModelId: OWN, isAutoRouted: false,
    counterparty: PERSON, assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: () => {}, stashContinuationIfHuman: vi.fn(), detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  await runPreCallGates(s, ctx);
  for (let i = 0; i < 400 && backgroundDrains.has(AGENT); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear(); pendingWakeups.clear(); stoppedAgents.clear(); turnContinuationCounts.clear();
  __resetBrakesForTests(); __resetEstimateCacheForTests(); __resetSummaryWriterHealthForTests();
  summariser.answering = false;
  summariser.calls = [];
  seed();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t140 round 6 — no writer answering: the gate does not dial', () => {
  it.fails('the reviewer\'s case: placeholders present, all four writers answering empty, ten iterations of one turn — at most v3.3.2\'s four calls', async () => {
    expect(hasUncondensedPlaceholders(AGENT), 'precondition: placeholder notes').toBe(true);
    for (let loop = 1; loop <= 10; loop++) await gate(500, loop);
    expect(summariser.calls.length, `writer calls over ten iterations: ${summariser.calls.join(', ')}`).toBeLessThanOrEqual(4);
    expect(hasUncondensedPlaceholders(AGENT), 'the notes stay, labelled, while no writer answers').toBe(true);
  });

  it('…and once a writer is answering again, a person\'s next turn is the signal: the notes are replaced', async () => {
    for (let loop = 1; loop <= 3; loop++) await gate(500, loop);
    summariser.answering = true;
    summariser.calls = [];
    await gate(501, 1);   // a person speaks again
    expect(summariser.calls.length, 'a person\'s new turn retried the writers').toBeGreaterThan(0);
    expect(hasUncondensedPlaceholders(AGENT), 'no note left once a writer answered').toBe(false);
  });
});
