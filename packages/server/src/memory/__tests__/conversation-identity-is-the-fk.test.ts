// PHASE-2 T10I — conversation identity is `messages.conversation_id`, not `messages.conv_key`.
//
// RULING 11's order is backfill (`147`) -> readers -> drop (`148`). These clauses are the
// READER half, and they are written RED-first: every one of them fails at T10H's HEAD,
// because at that HEAD the identity readers scope on a composite string.
//
// ⚠ WHY THIS IS NOT A RENAME, in one line: `conv_key` also carried three ENGINE SENTINELS
// (`engine`, `engine-steer`, `engine-notice`) on rows that are not in any conversation, and it
// could not distinguish two mail threads from one sender. `conversation_id` is a real FK into
// a real table with `UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)`, so it
// is STRICTLY more precise. The clauses below pin the three things that must not change with
// the precision gain:
//   (a) an UNSTAMPED row is still "this turn's own in-flight work" and is still KEPT — that
//       three-valued semantics (mine / another's / not yet stamped) is the re-answer ghost
//       guard (owner transcripts 2026-07-07, 2026-07-09) and it survives verbatim;
//   (b) another conversation's SETTLED output is still dropped;
//   (c) an events-lane rider is still not a conversation.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation } from '../assembler.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** Blank comments, keeping line count, so prose ABOUT the column is never read as a live use. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/^\s*--[^\n]*/gm, (m) => ' '.repeat(m.length));

const selfOrigin: MessageOrigin = {
  kind: 'self', relation: 'agent', channel: null,
  senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
};
function userOrigin(channel: 'imessage', senderId: string, name: string): MessageOrigin {
  return { kind: 'user', relation: 'known_contact', channel, senderName: name, senderId, threadId: null, intent: null, authorized: true };
}
function msg(p: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { agentId: 'a1', tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-07-30 12:00:00', ...p } as Message;
}
const cp = (senderId: string): TurnCounterparty =>
  ({ kind: 'user', name: 'Alex', relation: 'known_contact', channel: 'imessage', senderId, threadId: null, senderIsAgent: false });

describe('T10I — the assembler scopes on conversation_id', () => {
  // The counterparty's conversation, as the FK. `scopeToHumanConversation` must be able to
  // decide membership from it, which is what the extra argument is for: the turn resolved
  // this at pickup (loop.ts) and hands it down, rather than every reader re-deriving a string.
  const MINE = 'conv-mine';
  const THEIRS = 'conv-theirs';

  it('keeps THIS conversation\'s own settled output and drops ANOTHER conversation\'s', () => {
    const tail = [
      msg({ id: 'mine', role: 'assistant', content: 'here is your answer', origin: selfOrigin, conversationId: MINE }),
      msg({ id: 'theirs', role: 'assistant', content: 'a different party\'s answer', origin: selfOrigin, conversationId: THEIRS }),
    ];
    const kept = scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id);
    expect(kept).toContain('mine');
    expect(kept).not.toContain('theirs');
  });

  it('KEEPS an unstamped own-output row — that is this turn\'s in-flight work, and dropping it is the bug', () => {
    const tail = [msg({ id: 'inflight', role: 'assistant', content: 'working…', origin: selfOrigin, conversationId: null })];
    expect(scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id)).toEqual(['inflight']);
  });

  it('still excludes ANOTHER human\'s inbound (the no-bleed property, carried across the re-point)', () => {
    const tail = [
      msg({ id: 'other-human', role: 'user', content: 'dinner?', origin: userOrigin('imessage', '+1999', 'Sam'), conversationId: THEIRS }),
      msg({ id: 'my-human', role: 'user', content: 'the flight time?', origin: userOrigin('imessage', '+1555', 'Alex'), conversationId: MINE }),
    ];
    const kept = scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id);
    expect(kept).toContain('my-human');
    expect(kept).not.toContain('other-human');
  });
});

describe('T10I — the identity readers no longer read messages.conv_key', () => {
  it('conversation-scoped recall scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/memory/recall.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/conversation_id = \?/);
    // The three-valued semantics must survive: an untagged row is still restricted to the
    // agent's OWN activity, never a bare `IS NULL` (inv 4 — another human's unclaimed inbound).
    expect(s).toMatch(/conversation_id IS NULL AND \(role IN \('assistant','tool'\)/);
  });

  it('the active-directive pin scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/memory/directive.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/conversation_id = \?/);
  });

  it('the answered-in-this-conversation edge scopes on conversation_id', () => {
    const s = stripComments(src('packages/server/src/agent/v2/answered-edge.ts'));
    // `turns.conv_key` is a DIFFERENT column on a DIFFERENT table and is NOT in scope —
    // `work.origin_conv_key` still joins to it (tracker/delivery-evidence.ts). The clause
    // therefore pins the messages-side read only.
    expect(s).not.toMatch(/m1\.conv_key/);
    expect(s).toMatch(/m1\.conversation_id = \?/);
  });

  it('the re-answer guard tells "another conversation" apart by FK, and riders by LANE', () => {
    const s = stripComments(src('packages/server/src/agent/v2/re-answer-guard.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/conversation_id/);
    // The sentinel exclusion was `conv_key NOT IN ('engine','engine-steer')`. An events-lane
    // row is what that was reaching for, and the lane column says it without a fake key.
    expect(s).toMatch(/lane <> 'events'/);
  });

  it('the turn\'s own output is tagged with the conversation, at turn END (not at insert)', () => {
    const s = stripComments(src('packages/server/src/memory/message-store.ts'));
    expect(s).not.toMatch(/conv_key/);
    expect(s).toMatch(/tagTurnOutputConversationId/);
    // The "do not re-tag" guard is the whole reason the tag is late: an already-tagged row
    // belongs to an earlier turn. Preserved as the same NULL test on the new column.
    expect(s).toMatch(/conversation_id IS NULL/);
  });

  it('the recently-answered block and the F9 sibling batch-claim scope on conversation_id', () => {
    const s = stripComments(src('packages/server/src/agent/v2/loop.ts'));
    expect(s).not.toMatch(/conv_key = \?/);
    expect(s).toMatch(/AND conversation_id = \?/);
  });

  it('the party label for own-output rows comes from the conversation, not from parsing a key', () => {
    const s = stripComments(src('packages/server/src/memory/party-label.ts'));
    expect(s).not.toMatch(/convKeyToLabel/);
  });

  it('the dashboard receives conversationId and tells a background row by LANE, not by a sigil', () => {
    const s = stripComments(src('packages/dashboard/src/pages/Chat.tsx'));
    expect(s).not.toMatch(/convKey/);
  });
});

describe('T10I — NEGATIVE CONTROLS: the four conv_key columns that are NOT in scope stay', () => {
  // Without these, every clause above could be satisfied by deleting the wrong thing. These
  // four columns are on OTHER tables, are read by live joins, and this task does not touch
  // them (`work.origin_conv_key` <-> `turns.conv_key` is the delivery-evidence join).
  it('work.origin_conv_key still exists and is still joined to turns.conv_key', () => {
    expect(stripComments(src('packages/server/src/tracker/delivery-evidence.ts')))
      .toMatch(/conv_key IS NOT NULL AND conv_key = \?/);
    expect(stripComments(src('packages/server/src/work/tracker-store.ts'))).toMatch(/origin\.convKey/);
  });
  it('turns.conv_key is still recorded', () => {
    expect(stripComments(src('packages/server/src/agent/v2/turn-record.ts'))).toMatch(/conv_key/);
  });
  it('tool_receipts.conv_key is still recorded and read', () => {
    expect(stripComments(src('packages/server/src/receipts/store.ts'))).toMatch(/conv_key/);
    expect(stripComments(src('packages/server/src/agent/v2/outbound-ledger.ts'))).toMatch(/conv_key/);
  });
  it('conversationKey() itself SURVIVES — it still keys the waiting set and the four columns above', () => {
    expect(stripComments(src('packages/server/src/agent/v2/counterparty.ts')))
      .toMatch(/export function conversationKey/);
  });
});
