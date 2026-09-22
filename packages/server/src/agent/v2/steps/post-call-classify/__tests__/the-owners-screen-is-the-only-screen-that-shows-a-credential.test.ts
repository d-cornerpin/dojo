// ════════════════════════════════════════════════════════════════════════════════════════
// DESIGN RULING 13 — THE JOIN, DRIVEN END TO END.
//
// The ruling's carve-out has two halves that a unit test can check separately and be wrong
// about together: `isOwnerDashboardDelivery` (which counterparty shapes qualify) and the ONE
// LINE in `persist-assistant.ts` that asks it. A review replanted that line as
// `toOwnerDashboard: true` — the carve-out wide open for every peer, every contact and every
// A2A turn — and the whole server suite plus every gate stayed green. Nothing joined the two
// halves, so nothing noticed.
//
// These clauses drive `runPersistAssistant` itself, on a real in-memory database, with the
// broadcast door spied exactly as the other step tests spy it. They assert BOTH outputs of the
// seam for each counterparty shape:
//
//   THE ROW  — always the placeholder, for every shape including the owner's own. The ruling
//              is a RENDER, not a narrower persist: nothing comes to rest in the clear, so a
//              restart cannot present a dead (or rotated) credential as a live one and the
//              model can never read one back out of its own history.
//   THE FRAME — the copy the dashboard draws the bubble from. It carries the value only when
//              the turn is a POSITIVELY-STAMPED owner dashboard turn.
//
// No real credential appears here; the strings are test material with no meaning outside
// this file.
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-ruling13-join-test', 'dojo.db'),
  };
});

const frames: Array<{ type?: string; message?: { role?: string; content?: string } }> = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; message?: { role?: string; content?: string } }) => { frames.push(e); },
}));

import { runMigrations } from '../../../../../db/migrations.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues,
} from '../../../../../credentials/secret-values.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runPersistAssistant } from '../persist-assistant.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'kevin';
const TURN = 77;
/** What `credential_get` handed this agent back. */
const FETCHED = 'ruling13-join-gate-0000';
/** What the owner typed into a declared secret field. */
const TYPED = 'ruling13-join-typed-1111';

const OWNER_ON_DASHBOARD: TurnCounterparty = {
  kind: 'user', name: 'David', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false, channelStamped: true,
};

function ctxFor(over: Partial<PostCallClassifyContext> = {}, text = `Your gate code is ${FETCHED}.`): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: { agentId: AGENT, conversationId: null, turnNumber: TURN } as never,
    turnNumber: TURN, db: mockDb.current,
    agent: { id: AGENT, name: 'Kevin' } as never,
    counterparty: OWNER_ON_DASHBOARD as never,
    counterpartyIsAgentSender: false,
    inboundChannel: 'dashboard', latestUserSource: null,
    configuredModelId: 'floor', messageId: 'msg-1',
    noteTerminalAnswer: vi.fn(),
    result: {
      content: text,
      toolCalls: [{ id: 'tc1', name: 'vault_remember', input: { text: 'noted' } }] as ToolCall[],
      reasoningContent: null,
    } as unknown as PostCallClassifyContext['result'],
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}, text = `Your gate code is ${FETCHED}.`): PostCallScratch => ({
  persistedContent: text, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor',
  ...over,
} as PostCallScratch);

let state: AgentTurnState;

/** Runs the real step and returns what each surface ended up holding. */
async function drive(
  counterparty: TurnCounterparty,
  opts: { interAgentTurn?: boolean; text?: string } = {},
): Promise<{ row: string; frame: string }> {
  const text = opts.text ?? `Your gate code is ${FETCHED}.`;
  await runPersistAssistant(
    state,
    ctxFor({ counterparty: counterparty as never }, text),
    scratchFor({ interAgentTurn: opts.interAgentTurn ?? false }, text),
  );
  const row = mockDb.current!.prepare('SELECT content FROM messages WHERE id = ?')
    .get('msg-1') as { content: string } | undefined;
  const frame = frames.find((f) => f.type === 'chat:message' || f.type === 'interagent:message');
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
  noteHandedCredentialValues(AGENT, [FETCHED], 'out');
  noteHandedCredentialValues(AGENT, [TYPED], 'in');
  state = initState({
    agentId: AGENT, modelId: 'floor', inboundChannel: 'dashboard',
  } as never);
});

describe('the owner sees his own fetched credential, and only he does', () => {
  it('owner on a stamped dashboard turn: the FRAME carries the value and the ROW does not', async () => {
    const { row, frame } = await drive(OWNER_ON_DASHBOARD);
    expect(frame).toContain(FETCHED);
    // The whole of the C1 rework in one assertion: nothing at rest in the clear.
    expect(row).not.toContain(FETCHED);
    expect(row).toContain('<redacted-credential:');
  });

  it('the owner over iMessage: both surfaces keep the placeholder', async () => {
    const { row, frame } = await drive({ ...OWNER_ON_DASHBOARD, channel: 'imessage' });
    expect(frame).not.toContain(FETCHED);
    expect(row).not.toContain(FETCHED);
  });

  it('a known contact on the dashboard-shaped turn: placeholder', async () => {
    const { row, frame } = await drive({ ...OWNER_ON_DASHBOARD, relation: 'known_contact' });
    expect(frame).not.toContain(FETCHED);
    expect(row).not.toContain(FETCHED);
  });

  it('an A2A turn: placeholder on the peer lane and in the row', async () => {
    const { row, frame } = await drive(
      {
        kind: 'agent', name: 'peer', relation: 'agent', channel: 'a2a',
        senderId: null, threadId: 'th-1', senderIsAgent: false, channelStamped: false,
      },
      { interAgentTurn: true },
    );
    expect(frame).not.toContain(FETCHED);
    expect(row).not.toContain(FETCHED);
  });

  it('FAIL-CLOSED: an UNSTAMPED turn reads as owner/dashboard by default and still does not hydrate', async () => {
    // `deriveOrigin`'s last branch is "plain text = the owner on dashboard chat" and the
    // channel falls back to 'dashboard', so a row with no channel column and no parseable
    // inbound_meta arrives here looking exactly like the real thing. No stamps, no secret.
    const unstamped: TurnCounterparty = { ...OWNER_ON_DASHBOARD };
    delete (unstamped as { channelStamped?: boolean }).channelStamped;
    const { row, frame } = await drive(unstamped);
    expect(frame).not.toContain(FETCHED);
    expect(row).not.toContain(FETCHED);
  });

  it('a value the owner TYPED IN is not his to read back off a rendered row either', async () => {
    const { row, frame } = await drive(OWNER_ON_DASHBOARD, { text: `I saved ${TYPED} for you.` });
    expect(frame).not.toContain(TYPED);
    expect(row).not.toContain(TYPED);
  });

  it('a turn with no credential in flight broadcasts the stored JSON unchanged', async () => {
    forgetHandedCredentialValues();
    const { row, frame } = await drive(OWNER_ON_DASHBOARD, { text: 'nothing secret here' });
    expect(frame).toBe(row);
    expect(frame).toContain('nothing secret here');
  });
});
