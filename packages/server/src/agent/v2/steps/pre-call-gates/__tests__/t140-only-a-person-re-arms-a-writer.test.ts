// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 7 (round-6 re-review I1', ruling of round 7) — ONLY A PERSON'S FRESH MESSAGE TO THIS
// AGENT RE-ARMS A WRITER THAT FAILED, AND ONLY FOR THIS AGENT.
//
// Round 6 re-armed every failed writer on any turn whose counterparty was a person — which is every
// turn that is not agent-to-agent, scheduled turns, self-wakes and long-job continuations included —
// and it re-armed them for every agent on the box. The reviewer's run: ten turn starts, two writers
// answering empty, twenty paid calls. The real change signals are: a person's fresh message to THIS
// agent (re-arms for this agent), the writer's provider answering any call, or the owner changing the
// Settings writer.
//
// (Harness copied from round 6's t140-no-writer-answering-means-no-dial.test.ts. Its header follows.)
//
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
import * as health from '../../../../../memory/summary-writer-health.js';
const { __resetSummaryWriterHealthForTests, noteSummaryWriterOutcome } = health;
import { writeUncondensedPlaceholders, hasUncondensedPlaceholders } from '../../../../../memory/uncondensed-placeholder.js';
import { advance, initState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-desk-a';
const OTHER = 'agent-t140-desk-b';
const THIRD = 'agent-t140-desk-c';   // a person writes to it; it has nothing to replace, so it dials nothing
const OWN = 'm-t140-own';
const WRITERS = [OWN, 'm-t140-w2'];
const db = (): Database.Database => mockDb.current!;
const PERSON: TurnCounterparty = { kind: 'user', name: 'the owner', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null } as unknown as TurnCounterparty;

function seed(): void {
  WRITERS.forEach((id, i) => {
    db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES (?, ?, 'openai-compatible', 'api_key')`).run(`p-${i}`, `P${i}`);
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
                  VALUES (?, ?, ?, ?, '["text","tools"]', 200000, 4096, 1, ?, ?)`).run(id, `p-${i}`, id, id, i + 1, i + 2);
  });
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Desk', ?, 'idle', '{}', datetime('now'))`).run(THIRD, OWN);
  for (const agent of [AGENT, OTHER]) {
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Desk', ?, 'idle', '{}', datetime('now'))`).run(agent, OWN);
    for (let i = 0; i < 40; i++) {
      insertMessage({ agentId: agent, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner', senderId: i % 2 === 0 ? 'owner' : null, content: `[row ${i}] Is the dock open? Yes.`, turnNumber: 1 + Math.floor(i / 2) });
    }
    const tenth = (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq LIMIT 1 OFFSET 9').get(agent) as { seq: number }).seq;
    writeUncondensedPlaceholders(agent, tenth);
  }
}

/** One gate run. `fresh`: the turn was started by a person's new message (its trigger row). */
async function gate(agentId: string, turnNumber: number, loopCount: number, fresh: boolean): Promise<void> {
  const s = advance(initState({
    agentId, contextWindow: 200_000, isAutoRouted: false, configuredModelId: OWN,
    turnNumber, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'is the dock open?', lastUserMessageId: fresh ? `msg-${agentId}-${turnNumber}` : null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount });
  const ctx = {
    agentId, turnNumber, contextWindow: 200_000, contextModelId: OWN, configuredModelId: OWN, isAutoRouted: false,
    counterparty: PERSON, assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: () => {}, stashContinuationIfHuman: vi.fn(), detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  await runPreCallGates(s, ctx);
  for (let i = 0; i < 400 && backgroundDrains.has(agentId); i++) await new Promise((r) => setTimeout(r, 5));
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

describe('t140 round 7 — only a person\'s fresh message to this agent re-arms a failed writer', () => {
  it('the reviewer\'s probe: one person\'s message, then ten turn starts that are not (self-wakes, continuations, scheduled) — the base level of calls, not twenty', async () => {
    await gate(AGENT, 500, 1, true);                         // a person writes: each writer tried once
    const afterPerson = summariser.calls.length;
    for (let t = 501; t <= 510; t++) await gate(AGENT, t, 1, false);   // turn starts nobody sent
    expect(afterPerson, 'precondition: each writer was tried once on the person\'s message').toBe(WRITERS.length);
    expect(summariser.calls.length, `writer calls: ${summariser.calls.join(', ')}`).toBe(WRITERS.length);
  });

  it('one agent\'s person does not re-arm the writers for another agent', async () => {
    await gate(OTHER, 600, 1, true);                         // the other agent's writers fail
    summariser.calls = [];
    await gate(AGENT, 700, 1, true);                         // a person writes to THIS agent: it retries…
    const forThisAgent = summariser.calls.length;
    summariser.calls = [];
    await gate(OTHER, 601, 1, false);                        // …and the other agent, whom nobody wrote to, does not
    expect(forThisAgent, 'precondition: this agent retried').toBeGreaterThan(0);
    expect(summariser.calls, 'the other agent dialled nothing').toEqual([]);
  });

  it('a person writing to an agent that dials nothing does not re-arm the writers for anyone else', async () => {
    await gate(OTHER, 600, 1, true);                         // the other agent's writers fail
    summariser.calls = [];
    await gate(THIRD, 650, 1, true);                         // a person writes to a third agent (nothing to replace)
    await gate(OTHER, 601, 1, false);                        // nobody wrote to the other agent
    expect(summariser.calls, 'nothing was dialled for an agent nobody wrote to').toEqual([]);
  });

  it('the writer answering any call re-arms it (its provider is back)', async () => {
    await gate(AGENT, 800, 1, true);                         // both writers fail and are passed over
    summariser.answering = true;
    summariser.calls = [];
    (health as unknown as { noteProviderAnswered: (m: string) => void }).noteProviderAnswered(OWN);   // a turn call on its provider answered
    await gate(AGENT, 800, 2, false);   // the next iteration of the same turn: no person in between
    expect(summariser.calls[0], 'the writer whose provider answered is tried again').toBe(OWN);
    expect(hasUncondensedPlaceholders(AGENT)).toBe(false);
  });

  it('the owner changing the Settings writer re-arms it', async () => {
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(OWN);
    await gate(AGENT, 900, 1, true);                         // the Settings writer fails
    // The owner picks another model on the same provider in Settings.
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
                  VALUES ('m-t140-own-b', 'p-0', 'own-b', 'own-b', '["text","tools"]', 200000, 4096, 1, 1, 2)`).run();
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', 'm-t140-own-b')").run();
    summariser.answering = true;
    summariser.calls = [];
    await gate(AGENT, 900, 2, false);   // the next iteration: no person in between
    expect(summariser.calls[0], 'the newly chosen writer is tried').toBe('m-t140-own-b');
  });
});
