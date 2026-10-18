// ════════════════════════════════════════════════════════════════════════════════════════
// t211 (D7a, ctx 11) — ONE RESPONSE'S BATCH OF PARALLEL TOOL RESULTS IS ADMITTED AGAINST THE ROOM THE TURN HAS.
//
// Each result was admitted on its own: up to one view (15,000 tokens) each. One stored `tool` row holds ALL the
// results of one response, and the call with its results is one unit for the trim and the fold. Six results of
// 12,000 tokens each on a 65K window therefore landed as ~72K tokens in one row, more than the live
// conversation's whole room: the trim keeps the newest group whatever it costs, so the array exceeded its
// budget and the boundary dropped the rest of the conversation.
//
// Wanted: the batch together fits the room the turn has (no fixed number): the largest results switch to their
// pointer form first (the start, the end with the engine's trailer, a label naming the size and the exact
// `tool_result_read` call), each is still kept whole in storage, and the row stores the bytes the model will
// see, so every later assembly renders the same ones.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => null,
  queueEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../../../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../../permissions.js', () => ({ getAgentPermissions: () => ({}) }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
vi.mock('../../../loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const executeToolSpy = vi.fn();
vi.mock('../../../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../tools/index.js')>('../../../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../../../tool-outcome.js')>('../../../../tool-outcome.js');
  return {
    ...actual,
    executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...(a as []))),
    getFilteredTools: () => [],
  };
});

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { estimateAssembledTokens } from '../../../../../memory/compaction.js';
import { assembleContext } from '../../../../../memory/assembler.js';
import { contextWindowPolicy, estimateTokens } from '../../../../../memory/budget.js';
import { assemblyTokens } from '../../../../../memory/assembly-validation.js';
import { findToolResult } from '../../../../../memory/kept-results.js';
import { advance, initState } from '../../../state.js';
import type { RepeatCallState } from '../../../identical-call-brake.js';
import { runExecute, EXECUTE_PHASE, type ExecuteContext } from '../index.js';

const AGENT = 'agent-batch';
const MODEL = 'model-batch';
const WINDOW = 65_000;
const db = (): Database.Database => mockDb.current!;

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, WINDOW);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Batcher', 'idle', ?)").run(AGENT, MODEL);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-dash', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
  // An ordinary conversation already in view.
  for (let i = 0; i < 12; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    insertMessage({
      agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, conversationId: 'conv-dash', turnNumber: 1 + Math.floor(i / 2),
      content: `[c${i}] ${'Go through the ledger bay by bay and tell me what differs. '.repeat(20)}`,
    });
  }
}

let TOKENS_EACH = 12_000;
/** A result of about 12,000 tokens: numbered lines, then the engine's trailer line. */
function bigResult(tag: string): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = 1; chars < TOKENS_EACH * 4; i++) {
    const line = `${tag} line ${i}: bay total matches the manifest entry for lot ${i}`;
    lines.push(line);
    chars += line.length + 1;
  }
  lines.push(`[exit code 0 for ${tag}]`);
  return lines.join('\n');
}

function ctxFor(toolCalls: ToolCall[]): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, convKey: 'ck-1', conversationId: 'conv-dash', servedWork: undefined,
      toolPhaseEndedBySpinBrake: false, anyToolStartedThisTurn: false,
      startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
    } as unknown as ExecuteContext['turnCtx'],
    turnNumber: 7,
    db: db() as unknown as ExecuteContext['db'],
    agent: { id: AGENT, name: null } as unknown as ExecuteContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as ExecuteContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    triggerWorkId: null,
    triggerConversationId: null,
    turnStartedAt: new Date().toISOString(),
    persistRoutingMarker: vi.fn(),
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    identicalCallState: new Map() as RepeatCallState,
    reminderLaneRefusedSigs: new Set<string>(),
    startAckArmed: false,
    startAckArmedAtMs: Date.now(),
    fireStartAckIfOwed: vi.fn(async () => undefined),
    result: { content: '', toolCalls, inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' } as unknown as ExecuteContext['result'],
    messageId: 'msg-call',
    persistedContent: null,
    interAgentTurn: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: MODEL,
    staleTaskWindowMinutes: 45,
    maxToolLoops: 75,
    engineBlockEscapeHatch: '[escape hatch]',
    engineStartAckAfterMs: 20000,
  } as ExecuteContext;
}

const call = (i: number): ToolCall => ({ id: `tc-${i}`, name: 'exec', arguments: { command: `./audit --bay ${i}` } } as ToolCall);

/** Run one response of `n` parallel calls, each returning `bigResult`. Returns the stored tool row's blocks. */
async function runBatch(n: number, decorate: (id: string, content: string) => string = (_i, c) => c): Promise<Array<{ tool_use_id: string; content: string }>> {
  const calls = Array.from({ length: n }, (_, i) => call(i));
  insertMessage({
    id: 'msg-call', agentId: AGENT, role: 'assistant', turnNumber: 7,
    content: JSON.stringify(calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))),
  });
  const { admitToolResult } = await vi.importActual<typeof import('../../../../tools/index.js')>('../../../../tools/index.js');
  executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => {
    const whole = bigResult(tc.id);
    const admitted = admitToolResult(tc.name, tc.id, whole, false);
    return { toolCallId: tc.id, name: tc.name, content: decorate(tc.id, admitted.content), isError: false, ...(admitted.keptWhole ? { keptWhole: admitted.keptWhole } : {}) };
  });
  await runExecute(advance(initState(AGENT, MODEL), { phase: EXECUTE_PHASE, loopCount: 2 }), ctxFor(calls));
  const row = db().prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'tool' ORDER BY seq DESC LIMIT 1").get(AGENT) as { content: string };
  return JSON.parse(row.content);
}

beforeEach(() => { TOKENS_EACH = 12_000; mockDb.current = new Database(':memory:'); runMigrations(); seed(); executeToolSpy.mockReset(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t211 D7a — the batch is admitted against the room the turn has', () => {
  it('six 12,000-token results on a 65K window: the row holds what the live conversation has room for, and every result keeps its start, its end and a way to read the rest', async () => {
    const view = (await estimateAssembledTokens(AGENT, WINDOW, MODEL)).view;
    const headroom = Math.floor(view.tailRoomTokens / 2);
    expect(headroom, 'the premise: the room is measurable and smaller than the batch').toBeGreaterThan(0);
    expect(headroom).toBeLessThan(6 * TOKENS_EACH);

    const blocks = await runBatch(6);
    expect(blocks).toHaveLength(6);
    const rowTokens = blocks.reduce((t, b) => t + estimateTokens(b.content), 0);
    expect(rowTokens, 'the batch together fits the headroom').toBeLessThanOrEqual(headroom);
    let pointers = 0;
    for (const [i, b] of blocks.entries()) {
      expect(b.content, `result ${i}: its start`).toContain(`tc-${i} line 1:`);
      expect(b.content, `result ${i}: its end, with the engine's trailer`).toContain(`[exit code 0 for tc-${i}]`);
      // Whole, or its pointer: the cut is named and the rest is one call away. The largest give way first, so
      // the ones that were not needed to make room stay as the tool returned them.
      if (b.content !== bigResult(`tc-${i}`)) {
        expect(b.content, `result ${i}: the cut is named and the rest is one call away`).toMatch(/KEPT WHOLE[\s\S]*tool_result_read/);
        pointers++;
      }
      expect(findToolResult(AGENT, `tc-${i}`)?.content, `result ${i} is kept whole`).toBe(bigResult(`tc-${i}`));
    }
    expect(pointers, 'the room needed most of them to give way').toBeGreaterThanOrEqual(4);
  });

  it('the array the next call is sent holds the conversation with the batch inside its budget', async () => {
    await runBatch(6);
    const ctx = await assembleContext(AGENT, MODEL);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 2048 });
    const budget = policy.assemblyBudgetTokens - estimateTokens(ctx.systemPrompt);
    expect(assemblyTokens(ctx.messages as never)).toBeLessThanOrEqual(budget);
    expect(JSON.stringify(ctx.messages), 'the conversation before the batch is still in view').toContain('[c2]');
  });

  it('a small batch that fits is stored exactly as the tools returned it', async () => {
    const blocks = await runBatch(1);
    expect(blocks[0].content).toBe(bigResult('tc-0'));
  });
});

describe('t211 D7a — when even the pointers do not fit, the room is shared', () => {
  it('forty results: every one still says how big it is and how to read it, and the batch fits', async () => {
    const view = (await estimateAssembledTokens(AGENT, WINDOW, MODEL)).view;
    const headroom = Math.floor(view.tailRoomTokens / 2);
    const blocks = await runBatch(40);
    expect(blocks).toHaveLength(40);
    expect(blocks.reduce((t, b) => t + estimateTokens(b.content), 0)).toBeLessThanOrEqual(headroom);
    for (const [i, b] of blocks.entries()) {
      expect(b.content, `result ${i}`).toMatch(/KEPT WHOLE[\s\S]*tool_result_read/);
      expect(findToolResult(AGENT, `tc-${i}`)?.content, `result ${i} is kept whole`).toBe(bigResult(`tc-${i}`));
    }
  });

  it('what the engine added around a result survives a narrower view of it', async () => {
    const blocks = await runBatch(40, (_id, c) => `${c}\n[Engine notice: the next identical call is refused.]`);
    for (const [i, b] of blocks.entries()) expect(b.content, `result ${i}`).toContain('[Engine notice: the next identical call is refused.]');
  });

  it('a result the executor already made a pointer (past one view) narrows too, with its notice intact', async () => {
    TOKENS_EACH = 30_000;
    const view = (await estimateAssembledTokens(AGENT, WINDOW, MODEL)).view;
    const headroom = Math.floor(view.tailRoomTokens / 2);
    const blocks = await runBatch(40, (_id, c) => `${c}\n[Engine notice: the next identical call is refused.]`);
    expect(blocks.reduce((t, b) => t + estimateTokens(b.content), 0)).toBeLessThanOrEqual(headroom);
    for (const [i, b] of blocks.entries()) {
      expect(b.content, `result ${i}`).toContain('[Engine notice: the next identical call is refused.]');
      expect(b.content, `result ${i}`).toMatch(/KEPT WHOLE[\s\S]*tool_result_read/);
      expect(findToolResult(AGENT, `tc-${i}`)?.content, `result ${i} is kept whole`).toBe(bigResult(`tc-${i}`));
    }
  });
});
