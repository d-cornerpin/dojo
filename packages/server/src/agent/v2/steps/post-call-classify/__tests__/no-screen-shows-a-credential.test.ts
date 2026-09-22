// ════════════════════════════════════════════════════════════════════════════════════════
// DESIGN RULING 13 AS CORRECTED — THE PERSIST SEAM, BOTH ARMS, DRIVEN END TO END.
//
//   "The agent should not reply with credentials. The user can see them in the credentials
//    store in the vault tab instead."  — the owner, 2026-09-22
//
// ── WHY THIS FILE EXISTS RATHER THAN MORE UNIT CLAUSES ──────────────────────────────────
// The task's first cut built an owner-dashboard reveal and pinned its two halves
// separately; a review replanted the one line that joined them and the whole suite stayed
// green. The correction deleted the reveal, but the lesson is the reason this file survives
// it: a redaction is a property of the ROW AND THE FRAME that a real turn produces, not of a
// function called with hand-picked arguments. So these clauses run the real
// `runTerminalText` -> `runPersistAssistant` sequence on a real migrated database with the
// broadcast door spied, and read the row back with SQL.
//
// TWO ARMS, ONE ANSWER, which is the whole of round 8's complaint:
//   • the reply that RIDES WITH A TOOL CALL   (`redactAssistantBlocksForPersist`)
//   • the TOOL-LESS reply — the memory-recall path — scrubbed at its birth point in
//     `terminal-text.ts`, which is what this round added.
// Before that second scrub the two arms disagreed at rest, and the dev box still holds the
// row that proves it (run `bmubkziexro`, rowid 81467: `content` in the clear beside a
// `reasoning_content` that was redacted, one row, one persist call).
//
// No real credential appears here; the strings are test material.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-ruling13-chat-test', 'dojo.db'),
  };
});

const frames: Array<{ type?: string; message?: { role?: string; content?: string }; content?: string }> = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e as never); },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { noteHandedCredentialValues, forgetHandedCredentialValues } from '../../../../../credentials/secret-values.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { runPersistAssistant } from '../persist-assistant.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'kevin';
const TURN = 77;
const FETCHED = 'ruling13-chat-gate-0000';

const OWNER_ON_DASHBOARD: TurnCounterparty = {
  kind: 'user', name: 'David', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};

function ctxFor(text: string, toolCalls: ToolCall[], over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, conversationId: null, turnNumber: TURN,
      deferredUserReplyWithTools: null, root: null,
    } as never,
    turnNumber: TURN, db: mockDb.current,
    agent: { id: AGENT, name: 'Kevin' } as never,
    counterparty: OWNER_ON_DASHBOARD as never,
    counterpartyIsAgentSender: false,
    hasUnansweredUser: true,
    inboundChannel: 'dashboard', latestUserSource: null,
    configuredModelId: 'floor', messageId: 'msg-1',
    noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(),
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
    result: { content: text, toolCalls, reasoningContent: null } as unknown as PostCallClassifyContext['result'],
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}): PostCallScratch => ({
  persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor',
  ...over,
} as PostCallScratch);

let state: AgentTurnState;

/**
 * The real sequence: the classifier decides what the turn says, then the persist step
 * writes and broadcasts it. Nothing between them is stubbed.
 *
 * `carried` is how the text reaches the persist step on a tool-riding iteration. The
 * classifier usually DEFERS a reply that arrives beside tool calls (`turnCtx
 * .deferredUserReplyWithTools`), so the text-block arm of the persist seam is reached on
 * the iterations where it does not — which is the arm being asserted here. Handing the
 * step its scratch directly is how a test reaches that arm without re-deciding, in the
 * test, a classification the classifier owns.
 */
async function drive(
  text: string, toolCalls: ToolCall[], carried = false,
  over: Partial<PostCallClassifyContext> = {},
): Promise<{ row: string; frame: string }> {
  const sc = carried ? scratchFor({ persistedContent: text }) : scratchFor();
  if (!carried) await runTerminalText(state, ctxFor(text, toolCalls, over), sc);
  await runPersistAssistant(state, ctxFor(text, toolCalls, over), sc);
  const row = mockDb.current!.prepare('SELECT content FROM messages WHERE id = ?')
    .get('msg-1') as { content: string } | undefined;
  const frame = frames.find((f) => f.type === 'chat:message');
  return { row: row?.content ?? '', frame: frame?.message?.content ?? '' };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  frames.length = 0;
  forgetHandedCredentialValues();
  noteHandedCredentialValues(AGENT, [FETCHED]);
  state = initState({ agentId: AGENT, modelId: 'floor', inboundChannel: 'dashboard' } as never);
});

describe('neither arm of the persist seam puts a credential on a screen', () => {
  it('the credential_get path — a reply riding with a tool call — stores and broadcasts the placeholder', async () => {
    const { row, frame } = await drive(`Your gate code is ${FETCHED}.`, [
      { id: 'tc1', name: 'vault_remember', input: { text: 'noted' } } as unknown as ToolCall,
    ], true);
    expect(row).not.toContain(FETCHED);
    expect(row).toContain('<redacted-credential:');
    expect(frame).not.toContain(FETCHED);
    expect(frame).toBe(row);          // one string feeds both; a reload cannot disagree
  });

  it('THE MEMORY-RECALL PATH — a tool-less reply — is scrubbed too, which it was not before', async () => {
    // Round 8's shape, and the row the dev box still holds (81467). The RED this clause
    // plants is `let persistedContent = result.content` with no scrub.
    const { row, frame } = await drive(`Your gate code is ${FETCHED}.`, []);
    expect(row).not.toContain(FETCHED);
    expect(row).toContain('<redacted-credential:');
    expect(frame).not.toContain(FETCHED);
    expect(frame).toBe(row);
  });

  it('BOTH PATHS give the owner the same answer, which is what round 8 actually asked for', async () => {
    const withTool = await drive(`Your gate code is ${FETCHED}.`, [
      { id: 'tc1', name: 'vault_remember', input: { text: 'noted' } } as unknown as ToolCall,
    ], true);
    // A second turn, the other shape, same agent and same value.
    frames.length = 0;
    mockDb.current!.prepare('DELETE FROM messages').run();
    const toolLess = await drive(`Your gate code is ${FETCHED}.`, []);
    const placeholderOf = (s: string) => s.replace(/.*?(<redacted-credential:[a-z0-9]+>).*/s, '$1');
    expect(placeholderOf(toolLess.row)).toBe(placeholderOf(withTool.row));
    expect(toolLess.row).not.toContain(FETCHED);
    expect(withTool.row).not.toContain(FETCHED);
  });

  it('the WORKING-NOTE row and its frame are downstream of the same scrub', async () => {
    // `terminal-text.ts` can demote a reply to a `role='system'` working note, which is a
    // messages row the at-rest audit forbids a secret in just as firmly. Scrubbing at the
    // birth point is what makes that true without a second scrub here.
    //
    // ⚠ RE-REVIEW FINDING N1 — THIS CLAUSE USED TO BE VACUOUS, and the finding is the whole
    // reason the three arguments below are what they are. It drove with `toolCalls: []`, and
    // the demotion arm lives inside `if (persistedContent && result.toolCalls.length > 0)`
    // (`terminal-text.ts:136`) — so it produced NO note at all: the reviewer's probe read
    // `{ sysRows: 0, noteFrames: 0 }`, its loop re-asserted the assistant row the clause above
    // already covers, and re-deriving the note from raw `result.content` left the whole suite
    // green. A clause named for a row it never wrote is the exact shape of the miss this file's
    // own header exists to prevent.
    //
    // THE THREE ARGUMENTS ARE THE ARM'S OWN PRECONDITIONS, and nothing more: a tool call
    // (line 136), `carried: false` so `runTerminalText` actually runs and decides, and
    // `hasUnansweredUser: false` so the promotion arm at :216 does not consume the text as a
    // start line or an owed compile — the three ways a reply riding a tool call escapes being
    // demoted. What is asserted is the ROW and the FRAME, by name.
    await drive(`Your gate code is ${FETCHED}.`, [
      { id: 'tc1', name: 'vault_remember', input: { text: 'noted' } } as unknown as ToolCall,
    ], false, { hasUnansweredUser: false });

    const sysRows = mockDb.current!.prepare("SELECT content FROM messages WHERE role = 'system'")
      .all() as Array<{ content: string }>;
    expect(sysRows.length, 'the demotion arm was not reached — this clause is vacuous again').toBe(1);
    expect(sysRows[0].content).not.toContain(FETCHED);
    expect(sysRows[0].content).toContain('<redacted-credential:');

    const noteFrames = frames.filter((f) => f.type === 'chat:workingnote');
    expect(noteFrames.length, 'the dashboard converts the streamed bubble from this frame').toBe(1);
    expect(JSON.stringify(noteFrames[0])).not.toContain(FETCHED);

    // And the blanket sweep the clause always carried, now over a database that has the row in it.
    const anyRow = mockDb.current!.prepare('SELECT content FROM messages').all() as Array<{ content: string }>;
    for (const r of anyRow) expect(r.content).not.toContain(FETCHED);
    for (const f of frames) expect(JSON.stringify(f)).not.toContain(FETCHED);
  });

  it('a turn with no credential in flight is untouched, byte for byte', async () => {
    forgetHandedCredentialValues();
    const { row, frame } = await drive('the weather is fine', []);
    expect(row).toBe('the weather is fine');
    expect(frame).toBe(row);
  });
});
