// ════════════════════════════════════════════════════════════════════════════════════════
// t202 A2 — A NOTE WRITTEN WHILE A PERSON WAITS, THEN WRITTEN AGAIN BY DEFERRED RECOVERY,
// IS STORED ONCE AS FAR AS THE PERSON IS CONCERNED.
//
// Owner ruling (v3.4 decision 19): keep BOTH writers and de-duplicate. Driven against the real
// migration chain, not a stub: the terminal-text seam really writes the dimmed `[working-note]`
// system row, and the finalize recovery really writes the assistant row, so the clause below
// counts what a reload of the chat would count.
//
// ── WHAT "ONCE" MEANS, AND WHAT IT MAY NOT COST ──
// The recovery is the never-silent door (G-SUP-2): a waiting person must still get the words,
// so the recovery still delivers them (the assistant row, the bubble, the channel hand-off).
// What it does not do is leave a SECOND live copy beside the note it is promoting: the note it
// supersedes is retired (display suppression only — the row stays, nothing is deleted), found by
// the id the seam recorded when it wrote it, never by comparing words.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])),
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));
vi.mock('../../../compile-owed-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stillCompileOwed: () => [],
}));
vi.mock('../../../../../prompt/registry/assembler.js', () => ({ injectRegistryMessage: () => true }));

import { runMigrations } from '../../../../../db/migrations.js';
import { initState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { recoverDeferredReply } from '../../finalize/deferred-recovery.js';
import { openTurnContext, endTurnContext } from '../../../../turn-context.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import type { FinalizeContext } from '../../finalize/index.js';

const AGENT = 'agent-one';
const TURN = 61;
const THE_STATUS = 'The label tool works when I pass the label id rather than its name, so the '
  + 'remaining threads can be filed without another round trip.';

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  broadcastSpy.mockClear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'A probe agent', 'idle')").run(AGENT);
});

afterEach(() => {
  endTurnContext(AGENT);
  mockDb.current?.close();
  mockDb.current = null;
});

function seamCtx(turnCtx: unknown): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx, turnNumber: TURN, db: db(),
    agent: { id: AGENT, name: 'a probe agent' },
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: 'owner',
    hasUnansweredUser: true,
    triggerRow: null, isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null, latestUserSource: null,
    lastUserMessageContent: 'did the filing finish?',
    configuredModelId: 'm1', turnStartedAt: new Date().toISOString(), messageId: 'msg-1',
    result: {
      content: THE_STATUS,
      toolCalls: [{ id: 'c1', name: 'work_update', input: {} }] as ToolCall[],
      inputTokens: 10, outputTokens: 5, stopReason: 'tool_use',
    },
    maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined),
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
  } as unknown as PostCallClassifyContext;
}

const scratch = (): PostCallScratch => ({
  persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'm1',
}) as PostCallScratch;

/** The seam, then the finalize recovery, on one turn: the ordinary waiting-human path. */
async function driveSeamThenRecovery() {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.turnNumber = TURN;
  const state0 = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
  const out = await runTerminalText(state0, seamCtx(turnCtx), scratch());
  const recovered = recoverDeferredReply(out.state, {
    agentId: AGENT, turnNumber: TURN, turnCtx,
    counterparty: { kind: 'user', relation: 'owner', name: 'Owner', channel: 'dashboard', senderId: null },
    broadcast: (e: unknown) => broadcastSpy(e),
    noteTerminalAnswer: vi.fn(),
  } as unknown as FinalizeContext);
  return { turnCtx, recovered };
}

/** What a reload of the chat would show carrying these words: rows not retired. */
const liveRowsCarryingTheWords = (): Array<{ role: string; id: string }> =>
  db().prepare(
    `SELECT role, id FROM messages WHERE agent_id = ? AND retired_at IS NULL AND content LIKE ?`,
  ).all(AGENT, `%${THE_STATUS}%`) as Array<{ role: string; id: string }>;

const allRowsCarryingTheWords = (): Array<{ role: string; retired_at: number | null }> =>
  db().prepare(
    `SELECT role, retired_at FROM messages WHERE agent_id = ? AND content LIKE ?`,
  ).all(AGENT, `%${THE_STATUS}%`) as Array<{ role: string; retired_at: number | null }>;

describe('the ordinary waiting-human path: seam writes the note, recovery writes the answer', () => {
  it('leaves exactly ONE live row carrying the words, and it is the answer', async () => {
    const { recovered } = await driveSeamThenRecovery();

    // the person is still answered — never-silent is not what this trades away
    expect(recovered.lastAssistantTextForIM).toBe(THE_STATUS);
    const live = liveRowsCarryingTheWords();
    expect(live.map((r) => r.role), 'one live copy, as the assistant answer').toEqual(['assistant']);
  });

  it('keeps BOTH writers: the note row is still written at the seam, and only retired, never deleted', async () => {
    await driveSeamThenRecovery();
    const all = allRowsCarryingTheWords();
    expect(all.map((r) => r.role).sort()).toEqual(['assistant', 'system']);
    expect(all.find((r) => r.role === 'system')!.retired_at, 'the note is retired').not.toBeNull();
    expect(all.find((r) => r.role === 'assistant')!.retired_at, 'the answer is live').toBeNull();
  });

  it('when recovery does NOT fire (a real reply landed) the note stays live as the note it is', async () => {
    const turnCtx = openTurnContext(AGENT);
    turnCtx.turnNumber = TURN;
    const state0 = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
    const out = await runTerminalText(state0, seamCtx(turnCtx), scratch());
    const spoke = { ...out.state, lastAssistantTextForIM: 'Done.' };
    const same = recoverDeferredReply(spoke, {
      agentId: AGENT, turnNumber: TURN, turnCtx,
      counterparty: { kind: 'user', relation: 'owner', name: 'Owner', channel: 'dashboard', senderId: null },
      broadcast: () => {}, noteTerminalAnswer: vi.fn(),
    } as unknown as FinalizeContext);
    expect(same.lastAssistantTextForIM).toBe('Done.');
    expect(liveRowsCarryingTheWords().map((r) => r.role)).toEqual(['system']);
  });

  it('a second, DIFFERENT note on the same turn is not swept up with the one recovery promotes', async () => {
    const turnCtx = openTurnContext(AGENT);
    turnCtx.turnNumber = TURN;
    let state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
    // an earlier narration line of the same turn, demoted and not the deferred text
    const early = seamCtx(turnCtx);
    (early.result as { content: string }).content = 'Starting on the first batch now.';
    state = (await runTerminalText(state, early, scratch())).state;
    state = (await runTerminalText(state, seamCtx(turnCtx), scratch())).state;
    recoverDeferredReply(state, {
      agentId: AGENT, turnNumber: TURN, turnCtx,
      counterparty: { kind: 'user', relation: 'owner', name: 'Owner', channel: 'dashboard', senderId: null },
      broadcast: () => {}, noteTerminalAnswer: vi.fn(),
    } as unknown as FinalizeContext);
    const early1 = db().prepare(
      `SELECT retired_at FROM messages WHERE agent_id = ? AND content LIKE '%Starting on the first batch%'`,
    ).all(AGENT) as Array<{ retired_at: number | null }>;
    expect(early1).toHaveLength(1);
    expect(early1[0].retired_at, 'the other note stays live').toBeNull();
    expect(liveRowsCarryingTheWords().map((r) => r.role)).toEqual(['assistant']);
  });
});
