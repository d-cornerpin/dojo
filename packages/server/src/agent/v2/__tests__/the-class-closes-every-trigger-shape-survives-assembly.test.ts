// T83 FIX ROUND 2 (review) — THE LIVE-CHAIN COVERAGE GAP.
//
// `a-turns-trigger-survives-assembly.test.ts` (`memory/__tests__/`) proves the MECHANISM:
// given a `turnContext.engineEventKeepFullId`, does the real, unmocked assembler keep that
// one row live? It hand-supplies the id, so it never exercises the two real doors that
// PRODUCE it: `getPendingEngineEvent`'s own SQL (does it actually find the row?) and
// `runAssemble`'s rowid→id lookup (does it actually resolve the right id from it?).
//
// This file drives the REAL composition, end to end, for both trigger shapes the class
// covers:
//   ENGINE TURN:        getPendingEngineEvent (real SQL) → runAssemble (real rowid→id
//                        lookup, the fixed line) → assembleContext (real partition).
//   NOTIFICATION TURN:  runTurnClassification (real classification — RC-5.2's
//                        `isNotificationTurn` has no standalone function; this IS where it
//                        is computed) → runAssemble → assembleContext.
//
// What's mocked vs real (same split as `agent/v2/__tests__/integration.test.ts`, this
// file's own precedent for "real chain, real DB, peripheral I/O mocked"):
//   - DB: REAL better-sqlite3 in-memory, real migration chain.
//   - broadcast, techniques/store, memory/embeddings + vector-search, tool-docs token
//     measurement, agent/model's provider-facing calls: mocked (I/O boundaries; a live
//     model or a live semantic index is not this test's question).
//   - `injectRegistryMessage` alone: spied out of `prompt/registry/assembler.js` (the
//     REST of that module — `buildAssemblyContext`, `assembleSystemFromRegistry`, the
//     modules the real assembler itself calls — stays real via `importOriginal`).
//   - Everything else — `getPendingEngineEvent`, `runTurnClassification`, `runAssemble`,
//     `assembleContext`, `deriveOrigin`, the awareness partition, `applyIntegrityPass` —
//     runs for real.

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

const CONTEXT_WINDOW = 200000;
vi.mock('../../model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
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

const AGENT = 'agent-t83-livechain';
const MODEL = 'model-t83-livechain';

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

beforeEach(() => {
  tseq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedAgent();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T83 live chain — ENGINE TURN: getPendingEngineEvent → runAssemble → the real assembler', () => {
  it('the completion-report trigger, found by the REAL SQL and resolved by the REAL rowid→id lookup, survives as live content', async () => {
    // The incident's own shape: a freshly spawned agent whose only other tail content is
    // its own prior tool call.
    insertRow({
      id: 't83lc-assistant', role: 'assistant', lane: 'a2a',
      content: JSON.stringify([
        { type: 'tool_use', id: 'call_send', name: 'send_to_agent',
          input: { agent: 'BehaviorBot', intent: 'DELIVERABLE', thread_id: 'thread-abc', payload: 'the answer' } },
      ]),
    });
    insertRow({
      id: 't83lc-tool-result', role: 'tool', lane: 'a2a',
      content: JSON.stringify([
        { type: 'tool_result', tool_use_id: 'call_send', is_error: false,
          content: '[A2A:DELIVERABLE] Message delivered to "BehaviorBot" on thread thread-abc.' },
      ]),
    });
    insertRow({
      id: 't83lc-trigger', role: 'user', lane: 'events', originIntent: 'completion_report',
      content:
        `[Engine event: completion report owed] You just finished work the owner asked for while ` +
        `talking to another agent, so they have not seen the result yet: [${TRIGGER_FP}]. ` +
        `Send the owner ONE short completion note. If nothing is worth telling them, reply with [no-reply].`,
    });

    // DOOR 1, REAL: the actual query `close-the-loop.ts`'s wakeup relies on.
    const pendingEngineEvent = getPendingEngineEvent(AGENT);
    expect(pendingEngineEvent).not.toBeNull();
    expect(pendingEngineEvent?.originIntent).toBe('completion_report');

    // DOOR 2 + 3, REAL: `runAssemble`'s own rowid→id lookup, feeding the real assembler.
    const ctx = assembleCtxFor({ isEngineTurn: true, pendingEngineEvent });
    const out = await runAssemble(freshState(), ctx);

    if (out.directive !== 'proceed') throw new Error(`expected proceed, got exit: ${out.reason}`);
    expect(textOf(out.messages)).toContain(TRIGGER_FP);
    expect(out.assembled.messageEntryIds).not.toContain('lane.empty-context-fallback');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE OTHER SIDE OF DOOR 1 — and the reason the seed clock above is relative.
//
// The delivery chain's guarantee has a deliberate edge: an engine event is eligible while it
// is INSIDE its D8 lifecycle, and past the horizon it is not delivered at all. That is not a
// silent drop — `expireExhaustedEngineEvents` stamps `swept_at` (identity preserved) and
// posts exactly one agent notice, so what the person experiences is "the agent told me the
// reminder could not be delivered", never a completion note arriving stale out of yesterday.
// Nothing pinned that behaviourally before: `answered-edge.test.ts` pins the CONSTANT's value
// (`ENGINE_EVENT_EXPIRY_HOURS === 6`) and nothing drove the sweep. An unpinned edge is how a
// fixture came to depend on the horizon by accident instead of on purpose.
describe('T83 live chain — THE HORIZON: past the lifecycle the trigger is retired, loudly', () => {
  it('a completion report older than ENGINE_EVENT_EXPIRY_HOURS never wakes the agent, is swept, and the owner is told once', () => {
    insertRow({
      id: 't83lc-stale-trigger', role: 'user', lane: 'events', originIntent: 'completion_report',
      createdAt: Date.now() - (ENGINE_EVENT_EXPIRY_HOURS * 3600_000 + 60_000),
      content:
        `[Engine event: completion report owed] [${STALE_FP}] You just finished work the owner ` +
        `asked for while talking to another agent. Send the owner ONE short completion note.`,
    });

    // DOOR 1, REAL — and it says no, because the event is past its horizon.
    expect(getPendingEngineEvent(AGENT)).toBeNull();

    // Not silently lost: the row is disposed by the sanctioned signal, identity intact.
    const stale = mockDb.current!.prepare('SELECT swept_at FROM messages WHERE id = ?')
      .get('t83lc-stale-trigger') as { swept_at: number | string | null } | undefined;
    expect(stale?.swept_at ?? null).not.toBeNull();

    // And the person hears about it, exactly once, in the agent's own voice.
    const notices = mockDb.current!.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND origin_intent = 'engine_event_expired'",
    ).all(AGENT) as Array<{ content: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('could not deliver a scheduled reminder');
    expect(notices[0].content).toContain(STALE_FP);

    // Once, not once per consult: the `swept_at` .changes guard is the only once-guard.
    expect(getPendingEngineEvent(AGENT)).toBeNull();
    expect(mockDb.current!.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'engine_event_expired'",
    ).get(AGENT)).toEqual({ n: 1 });
  });
});

describe('T83 live chain — NOTIFICATION TURN: real classification → runAssemble → the real assembler', () => {
  it('the unauthorized-notice trigger, classified by the REAL isNotificationTurn logic and resolved by the REAL rowid→id lookup, survives as live content', async () => {
    // The RC-5.2 shape: a history-sparse agent (one prior self-output line) whose newest
    // inbound is one unauthorized mailbox notice.
    insertRow({
      id: 't83lc-prior-reply', role: 'assistant', lane: 'owner',
      content: 'Sure — noted, nothing else pending right now.',
    });
    insertRow({
      id: 't83lc-notif-trigger', role: 'user', lane: 'owner',
      inboundMeta: JSON.stringify({ channel: 'email', sender: 'unknown@example.com', authorized: false }),
      content:
        `[SOURCE: GMAIL NOTIFICATION] [MAILBOX EVENT] the owner's inbox just received an email. ` +
        `This email was NOT sent to you and is NOT a request for you to do anything. [${NOTIFICATION_FP}]`,
    });

    // DOOR 1, REAL: `isNotificationTurn` has no standalone function — this call IS where
    // it (and `mostRecentInbound`, the row it is computed from) gets decided.
    const preflightCtx: PreflightContext = {
      agentId: AGENT,
        startStatusHeartbeat: () => { /* not exercised */ },
      stopStatusHeartbeat: () => { /* not exercised */ },
      detectTaskThrashing: () => ({ thrashing: false }),
      engineBlockEscapeHatch: '',
      engineStartAckAfterMs: 0,
    };
    const scratch: PreflightScratch = { claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null };
    const turnCtxForClassification = {} as unknown as TurnContext;
    const classified = await runTurnClassification(turnCtxForClassification, preflightCtx, scratch, {
      db: mockDb.current!,
      waitingConvs: [],
      openHumanWorkAtTurnStart: false,
      triggerRow: null,
      chosenConvKey: '',
      lastUserMessageContent: '',
      unrepliedAssign: null,
    });

    if (classified.directive !== 'proceed') throw new Error(`expected proceed, got abandon: ${classified.reason}`);
    expect(classified.outputs.isNotificationTurn).toBe(true);
    expect(classified.outputs.mostRecentInbound?.rowid).toBeDefined();

    // DOOR 2 + 3, REAL: `runAssemble`'s own rowid→id lookup, feeding the real assembler.
    const ctx = assembleCtxFor({
      isNotificationTurn: classified.outputs.isNotificationTurn,
      mostRecentInbound: classified.outputs.mostRecentInbound,
    });
    const out = await runAssemble(freshState(), ctx);

    if (out.directive !== 'proceed') throw new Error(`expected proceed, got exit: ${out.reason}`);
    expect(textOf(out.messages)).toContain(NOTIFICATION_FP);
    expect(out.assembled.messageEntryIds).not.toContain('lane.empty-context-fallback');
  });
});
