// A request served again after a turn that already sent a message does not send the same message again unless
// the agent means to: the first repeat is refused once with its reason, and the identical call then goes.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { writeToolReceipt } from '../../../../../receipts/store.js';
import { asTurn, type TurnRoot } from '../../../../turn-context.js';
import { initState } from '../../../state.js';
import { runRefusalGates } from '../refusal-gates.js';

const AGENT = randomUUID();
const ASK: TurnRoot = { kind: 'ask', id: randomUUID(), sourceMessageId: null };
const EMAIL = { to: 'person@example.com', subject: 'Plan', body: 'The plan for Friday.' };

/** Turn 1, serving `root`, sent a message: its door's receipt, unverified (as every iMessage receipt is). */
function sentOnTurnOne(root: TurnRoot, tool = 'gmail_send', recipient = EMAIL.to, sentText = `${EMAIL.subject}: ${EMAIL.body}`): void {
  asTurn(AGENT, { turnNumber: 1, root, convKey: null }, () => writeToolReceipt({
    agentId: AGENT, tool, tier: 3, verified: false, basis: 'exit-code', recipient, sentText, skipAudit: true,
  }));
}

/** One send on turn 2, serving the same request: the refusal's words, or null when the call goes. */
function sendOnTurnTwo(args: Record<string, unknown>, seen: Set<string>, name = 'gmail_send'): string | null {
  const state = initState({ agentId: AGENT, turnNumber: 2, lastUserMessageContent: null } as never);
  return runRefusalGates(state as never, { id: randomUUID(), name, arguments: args } as never,
    { agentId: AGENT, turnNumber: 2, turnCtx: { root: ASK, turnNumber: 2 }, refusedOnceSigs: seen } as never).refusal?.content ?? null;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe('a re-served request does not send the same message twice', () => {
  it('the same email is refused once with its reason; the identical second call goes through', () => {
    sentOnTurnOne(ASK);
    const seen = new Set<string>();
    expect(sendOnTurnTwo(EMAIL, seen)).toBe('[Engine: not sent] Turn 1 already sent this same message to person@example.com '
      + 'for this request. If you mean to send it again, repeat the exact same call now and it will go.');
    expect(sendOnTurnTwo(EMAIL, seen)).toBeNull();
  });

  it('the same text by iMessage, the number spelled another way, and the user account twin are the same send', () => {
    sentOnTurnOne(ASK, 'imessage_send', '+15550100100', 'On my way.');
    expect(sendOnTurnTwo({ recipient: '+1 (555) 010-0100', message: 'On my way.' }, new Set(), 'imessage_send')).toMatch(/^\[Engine: not sent\] Turn 1/);
    sentOnTurnOne(ASK);
    expect(sendOnTurnTwo(EMAIL, new Set(), 'user_gmail_send')).toMatch(/^\[Engine: not sent\] Turn 1/);
  });

  it('other words or another person go at once', () => {
    sentOnTurnOne(ASK);
    expect(sendOnTurnTwo({ ...EMAIL, body: 'A new plan.' }, new Set())).toBeNull();
    expect(sendOnTurnTwo({ ...EMAIL, to: 'other@example.com' }, new Set())).toBeNull();
  });

  it('the same email sent for another request does not count', () => {
    sentOnTurnOne({ ...ASK, id: randomUUID() });
    expect(sendOnTurnTwo(EMAIL, new Set())).toBeNull();
  });
});
