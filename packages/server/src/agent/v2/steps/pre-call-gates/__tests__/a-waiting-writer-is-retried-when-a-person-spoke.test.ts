// A waiting writer is asked again when a person writes to this agent: the person's fresh message at the turn's first
// gate frees its failed writers for this agent only. Turn starts that are not a person (self-wakes, continuations,
// scheduled turns) free nothing, and one agent's person frees nothing for another. Driven through the real gate.

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
  const health = await import('../../../../../memory/writer.js');
  return {
    generateSummary: async (args: { agentId: string; modelId?: string; abortSignal?: AbortSignal }) => {
      summariser.calls.push(args.modelId ?? '?');
      health.settleSummaryCall(summariser.answering ? { ok: true, text: 'a summary', tokenCount: 1 } : { ok: false, reason: 'no answer' }, args.agentId, args.modelId, args.abortSignal);
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
import { STANDARD_WRITER_MODEL } from '../../../../../services/local-standard.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { backgroundDrains, pendingWakeups, stoppedAgents } from '../../../../shared-state.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import * as health from '../../../../../memory/writer.js';
const { __resetSummaryWriterHealthForTests } = health;
import { writeUncondensedPlaceholders, hasUncondensedPlaceholders } from '../../../../../memory/out-of-view.js';
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
  // t268 round 5 (edited): the second writer is the Dojo's small local writer — the one fallback after the agent's own
  // model (a second cloud model was "the cheapest", a tail the round removed).
  WRITERS.forEach((id, i) => {
    if (i === 0) db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES (?, ?, 'openai-compatible', 'api_key')`).run(`p-${i}`, `P${i}`);
    else db().prepare(`INSERT INTO providers (id, name, type, auth_type, base_url) VALUES (?, ?, 'ollama', 'none', 'http://127.0.0.1:11439')`).run(`p-${i}`, `P${i}`);
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
                  VALUES (?, ?, ?, ?, '["text","tools"]', 200000, 4096, 1, ?, ?)`).run(id, `p-${i}`, id, i === 0 ? id : STANDARD_WRITER_MODEL.tag, i + 1, i + 2);
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
    inboundChannel: 'dashboard', inboundContext: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount });
  const ctx = {
    agentId, turnNumber, contextWindow: 200_000, contextModelId: OWN, configuredModelId: OWN, isAutoRouted: false,
    counterparty: PERSON, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: () => {},
  } as unknown as PreCallGatesContext;
  await runPreCallGates(s, ctx);
  for (let i = 0; i < 400 && backgroundDrains.has(agentId); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear(); pendingWakeups.clear(); stoppedAgents.clear();
  __resetBrakesForTests(); __resetEstimateCacheForTests(); __resetSummaryWriterHealthForTests();
  summariser.answering = false;
  summariser.calls = [];
  seed();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a waiting writer is retried when a person spoke', () => {
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

  it('the mark is the writer\'s: a person writing to any agent of its order buys one try, spent once, then none', async () => {
    await gate(OTHER, 600, 1, true);                         // the writers fail
    summariser.calls = [];
    await gate(THIRD, 650, 1, true);                         // a person writes to a third agent (nothing to replace)
    await gate(OTHER, 601, 1, false);                        // the next fold spends that one try
    expect(summariser.calls.length, 'each writer tried once').toBe(WRITERS.length);
    await gate(OTHER, 602, 1, false);
    expect(summariser.calls.length, 'and not again until a new signal').toBe(WRITERS.length);
  });

});
