// 8904 — THE REASSIGN REFUSAL MUST NOT SEND THE OWNER'S DECISION TO WHOEVER THE AGENT IS
// TALKING TO.
//
// escalationPointer (row-authority.ts:171) writes the last sentence of the reassign door's
// refusals. For the main agent it was one fixed instruction — "ask ${getOwnerName()} in your
// conversation" — whoever that conversation happened to be with. On a turn answering a
// contact, "your conversation" IS the contact: the agent was told to put the owner's decision
// to a person who cannot make it, and to come back with that person's words as user_quote —
// which ownerAskedInThisTurn (row-authority.ts:144) can never confirm, because it proves the
// quote is in the OWNER's ask. The pointer now reads the turn's own address: a non-owner
// person's turn is named for what it is, and the owner's word is sourced where it can
// actually come from. Every other case — the owner's turn, an engine turn, no turn at all —
// gets the old sentence, byte for byte.
//
// Driven through checkMove: the live-holder refusal at row-authority.ts:262 ("assignee_gone
// does not apply") is one of the five refusals that append this pointer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { TurnAddress } from '../../agent/v2/turn-address.js';

const mockDb = { current: null as Database.Database | null };
// The turn in flight, as the turn-address words read it. `undefined` = outside any turn.
const mockTurn = { address: undefined as TurnAddress | undefined };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => 'notice-id' }));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
  isPrimaryAgent: (id: string) => id === 'primary',
}));
// The pointer reaches the turn through turnContext; an address is all it reads.
vi.mock('../../agent/turn-context.js', () => ({
  turnContext: () => (mockTurn.address === undefined ? undefined : { address: mockTurn.address }),
}));

import { checkMove } from '../row-authority.js';
import { createWorkTable, seedTrackerTask } from './work-fixture.js';

// All invented. The contact is the person the main agent is answering; the owner is the
// person whose decision the refusal is about — the two must never be conflated.
const CONTACT_TURN: TurnAddress = {
  kind: 'person', name: 'Sam Example', relation: 'known_contact', isOwner: false,
  senderId: '+15550000123', threadId: null, inboundChannel: 'imessage', boundChannel: 'imessage',
  inboundContext: null, deliveryChannel: 'imessage', routed: true, autoRoutes: true, heldWake: false,
};
const OWNER_TURN: TurnAddress = { ...CONTACT_TURN, name: 'the owner', relation: 'owner', isOwner: true };
const ENGINE_TURN: TurnAddress = {
  ...CONTACT_TURN, kind: 'engine', name: 'the platform', relation: 'engine', isOwner: false,
  senderId: null, inboundChannel: 'engine',
};

/** The sentence the pointer wrote before this task — the whole point of the non-contact cases
 *  is that it is still exactly this, in full. */
const OLD_SENTENCE = 'If it should happen anyway, ask the owner in your conversation and, '
  + 'if they say so, call again with user_quote set to their exact words.';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('primary', 'Main', 'idle')").run();
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('live-worker', 'Live', 'idle')").run();
}

/** The reassign door's live-holder refusal, spoken by `actorId` under the turn in `mockTurn`. */
function refusalBy(actorId: string): string {
  const r = checkMove({ taskId: 'move-1', by: 'agent', actorId, cause: 'assignee_gone' });
  if (r.ok) throw new Error('expected the live-holder refusal; the move was approved');
  return r.text;
}

beforeEach(() => {
  mockTurn.address = undefined;
  mockDb.current = new Database(':memory:');
  applySchema(mockDb.current);
  seedTrackerTask(mockDb.current, { id: 'move-1', title: 'hold the line', agentId: 'live-worker' });
});

describe('8904 — the escalation pointer reads the turn\'s address', () => {
  it('a contact turn: the owner\'s decision is not put to the contact', () => {
    mockTurn.address = CONTACT_TURN;
    const text = refusalBy('primary');
    expect(text).toContain('"assignee_gone" does not apply');   // the refusal this test drives
    expect(text).toContain('this turn is with Sam Example');
    expect(text).not.toContain('in your conversation');
    expect(text).toContain('If it should happen anyway: this turn is with Sam Example, not the owner, '
      + 'so do not put it to Sam Example. Leave it for the owner\'s own next message, or reach the owner '
      + 'yourself on a channel you may use, and only call again with user_quote set to the owner\'s exact words.');
  });

  it('the owner\'s own turn: the old sentence, byte for byte', () => {
    mockTurn.address = OWNER_TURN;
    expect(refusalBy('primary')).toContain(OLD_SENTENCE);
  });

  it('an engine turn is not a person\'s turn: the old sentence, byte for byte', () => {
    mockTurn.address = ENGINE_TURN;
    expect(refusalBy('primary')).toContain(OLD_SENTENCE);
  });

  it('outside a turn there is no address to read: the old sentence, byte for byte', () => {
    mockTurn.address = undefined;
    expect(refusalBy('primary')).toContain(OLD_SENTENCE);
  });

  it('CONTROL: a worker agent on a contact turn still gets the send_to_agent sentence', () => {
    mockTurn.address = CONTACT_TURN;
    const text = refusalBy('worker-helper');
    expect(text).toContain('tell the main agent (send_to_agent) so it can put the decision to the owner.');
    expect(text).not.toContain('this turn is with');
  });
});
