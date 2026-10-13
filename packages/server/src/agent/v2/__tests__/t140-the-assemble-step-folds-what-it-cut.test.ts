// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (re-review 2 §5, mutants M1 / M1b) — THE ASSEMBLE STEP ITSELF folds what its
// assembly cut. The memory-side witnesses drive the door directly; this one drives `runAssemble`
// (the engine's own step, real assembler, real DB — the harness of
// `the-class-closes-every-trigger-shape-survives-assembly.test.ts`, copied) on a 32K agent whose
// newest exchange carries a ~12K row, with only the summariser scripted. A step that bypassed the
// door, or zeroed the out-of-view number it hands the door, leaves rows out of view unsummarised.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
const summariser = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../runtime.js', () => ({
  clearConsumedOneShotFlags: () => { /* not exercised */ },
  injectAttachmentBlocks: () => [],
}));

vi.mock('../../../techniques/store.js', () => ({
  listTechniques: () => [],
  getTechniqueDetail: () => null,
  recordTechniqueUsage: () => undefined,
}));

vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
  semanticTechniqueMatches: async () => [],
}));

vi.mock('../../../memory/vector-search.js', () => ({
  vectorSearch: async () => [],
}));

vi.mock('../../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

const CONTEXT_WINDOW = 32000;
vi.mock('../../model.js', () => ({
  // The only model call `runAssemble` can make is the out-of-view fold's summariser.
  callModel: async () => {
    summariser.calls++;
    return { content: `Summary ${summariser.calls}: earlier the crew counted the depot and filed the manifests.`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

vi.mock('../../../prompt/registry/assembler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../prompt/registry/assembler.js')>()),
  injectRegistryMessage: (_id: string, _messages: unknown[]) => false,
}));

import { advance, initState, type AgentTurnState } from '../state.js';
import { runAssemble, ASSEMBLE_PHASE, type AssembleContext } from '../steps/assemble/index.js';
import { runTurnClassification } from '../steps/preflight/turn-classification.js';
import type { PreflightContext, PreflightScratch } from '../steps/preflight/index.js';
import { getPendingEngineEvent, ENGINE_EVENT_EXPIRY_HOURS } from '../counterparty.js';
import type { TurnContext } from '../../turn-context.js';
import { runMigrations } from '../../../db/migrations.js';

const AGENT = 'agent-t140-assemble-step';
const MODEL = 'model-t140-assemble-step';

// ⚠ THE SEED CLOCK IS RELATIVE, AND THAT IS LOAD-BEARING — NEVER PIN IT TO A LITERAL INSTANT.
//
// This line WAS `Date.parse('2026-09-20T23:21:30Z')`: the author's own wall clock at the hour
// the file was written (b35c386f, 2026-09-21T01:04Z). It passed that night and turned red BY
// ITSELF at 2026-09-21T05:21:30Z, with no commit anywhere near it. `getPendingEngineEvent`'s
// D8 lifecycle gate is `created_at >= unixepoch('now', '-ENGINE_EVENT_EXPIRY_HOURS hours')`,
// and the first thing that function does is call `expireExhaustedEngineEvents`, which SWEEPS
// anything past that same horizon — so the literal's own age was the fuse, and T0 + 6h was
// the hour it burned down. Three later sittings each measured the failure as "pre-existing"
// against their own diff and routed around it; `counterparty.ts` is byte-identical from
// v3.1.25 to now, so there was never an introducing commit to find.
//
// A real engine event is read SECONDS after it is written — `close-the-loop.ts` inserts the
// completion report and queues the self-wake in the same breath — so "freshly queued" is the
// honest fixture for the delivery chain, and it must be expressed relative to the clock the
// SQL actually reads. The horizon's own behaviour is not thereby untested: the third test
// below seeds deliberately PAST it and pins what the engine does instead.
const T0 = Date.now() - 60_000;

const TRIGGER_FP = 'LIVE-CHAIN-COMPLETION-REPORT-FINGERPRINT-4c02';
const NOTIFICATION_FP = 'LIVE-CHAIN-MAILBOX-NOTICE-FINGERPRINT-9b73';
const STALE_FP = 'LIVE-CHAIN-STALE-COMPLETION-FINGERPRINT-7e31';

let tseq = 0;

function insertRow(p: {
  id: string; role: string; content: string; lane: 'owner' | 'a2a' | 'events';
  originIntent?: string | null; inboundMeta?: string | null;
  /** Epoch ms. Defaults to the fresh seed clock; only the horizon test overrides it. */
  createdAt?: number;
}): void {
  tseq += 1;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at, origin_intent,
                           inbound_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, 'live', 1, ?, ?, ?, ?)`,
  ).run(
    p.id, AGENT, p.role, p.lane, p.content,
    p.lane === 'events' ? 'engine-note' : p.lane === 'a2a' ? 'a2a' : (p.role === 'assistant' ? 'agent-text' : 'user-text'),
    p.lane === 'owner' ? 'user-visible' : 'agent-only',
    Math.max(1, Math.ceil(p.content.length / 4)), p.createdAt ?? (T0 + tseq * 1000), p.originIntent ?? null,
    p.inboundMeta ?? null,
  );
}

function seedAgent(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'ds4-local', 'DS4', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'T83LiveChain', MODEL);
}

const textOf = (msgs: Array<{ content: unknown }>): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/** Contract.test.ts's own shape: only the fields this chain actually reads/writes. */
function turnCtxFor(): AssembleContext['turnCtx'] {
  return {
    agentId: AGENT,
    conversationId: null,
    lastAssembledAtIso: null,
    assemblerOverheadTokens: 0,
    freshTailDropWarned: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    startAckSteersInjected: 0,
    startAckSteerInjectedAtLoop: 0,
    inboundClassifiedAsWork: false,
  } as unknown as AssembleContext['turnCtx'];
}

const OWNER_ON_DASHBOARD = {
  kind: 'user' as const, name: 'the owner', relation: 'owner' as const, channel: 'dashboard' as const,
  senderId: null, threadId: null, senderIsAgent: false,
};

function freshState(loopCount = 2): AgentTurnState {
  return advance(initState(AGENT, MODEL), { phase: ASSEMBLE_PHASE, loopCount });
}

function assembleCtxFor(overrides: Partial<AssembleContext>): AssembleContext {
  return {
    agentId: AGENT,
    turnCtx: turnCtxFor(),
    turnNumber: 2,
    db: mockDb.current!,
    contextModelId: MODEL,
    contextWindow: CONTEXT_WINDOW,
    counterparty: OWNER_ON_DASHBOARD,
    counterpartyIsAgentSender: false,
    chosenConvKey: null,
    hasUnansweredUser: false,
    isA2ATurn: false,
    isEngineTurn: false,
    isNotificationTurn: false,
    lastUserMessageContent: null,
    latestTtsEngine: null,
    latestUserSource: null,
    mostRecentIsA2A: false,
    pendingEngineEvent: null,
    mostRecentInbound: null,
    waitingConvs: [],
    engineStartAckDeliveredThisTurn: false,
    staleTaskWindowMinutes: 60,
    startAckRepliedNow: () => false,
    ...overrides,
  };
}


const LARGE = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(620);

beforeEach(() => {
  tseq = 0;
  summariser.calls = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedAgent();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 round 3 — runAssemble folds the rows its assembly took out of view', () => {
  it('a 32K agent whose newest reply is ~12K tokens: after the step, no row is neither in view nor summarised, and the summariser ran', async () => {
    for (let t = 1; t <= 14; t++) {
      insertRow({ id: `u${t}`, role: 'user', lane: 'owner', content: `[u${t}] Which bay is the next crate for?` });
      insertRow({ id: `a${t}`, role: 'assistant', lane: 'owner', content: `[a${t}] Bay four, beside the ramp; the seal is intact.` });
    }
    insertRow({ id: 'u15', role: 'user', lane: 'owner', content: '[u15] Read me the manifest.' });
    insertRow({ id: 'a15', role: 'assistant', lane: 'owner', content: `[a15] ${LARGE}` });

    const out = await runAssemble(freshState(), assembleCtxFor({ hasUnansweredUser: false }));
    if (out.directive !== 'proceed') throw new Error(`expected proceed, got exit: ${out.reason}`);
    const view = textOf(out.messages);
    const covered = new Set((mockDb.current!.prepare(
      'SELECT sm.message_id AS id FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE s.agent_id = ?',
    ).all(AGENT) as Array<{ id: string }>).map((r) => r.id));
    const lost = (mockDb.current!.prepare('SELECT id, content FROM messages WHERE agent_id = ?').all(AGENT) as Array<{ id: string; content: string }>)
      .filter((r) => { const m = /\[(u|a)\d+\]/.exec(r.content)?.[0]; return m && !view.includes(m) && !covered.has(r.id); })
      .map((r) => r.id);
    expect(lost, 'rows out of view with no summary after the assemble step').toEqual([]);
    expect(summariser.calls, 'the step folded what it cut').toBeGreaterThan(0);
    expect(view, 'and the summary it wrote is in the view the turn dials').toMatch(/Summary 1: earlier the crew/);
  });
});
