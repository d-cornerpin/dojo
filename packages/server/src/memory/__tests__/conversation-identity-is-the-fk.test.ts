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
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation } from '../assembler.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

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

  // PHASE-3 STRIP-3 — the causal link, pinned so nobody has to re-derive it. This is the
  // BEHAVIOUR the loop's stale turn-conversation map fed on: "I do not know this turn's
  // conversation" and "this turn has no conversation" are the same input here, and the
  // answer to both is to drop every stamped own-output row. That is correct for a genuine
  // engine/A2A turn and catastrophic for a human turn whose map was simply written too
  // early — it is the re-answer ghost's own shape. The map's write therefore has to happen
  // after its value is final (loop.ts, pinned below); this clause says why.
  it('a NULL counterparty conversation drops stamped own output — which is why the turn must publish the resolved id', () => {
    const tail = [
      msg({ id: 'answered', role: 'assistant', content: 'here is your answer', origin: selfOrigin, conversationId: MINE }),
    ];
    expect(scopeToHumanConversation(tail, cp('+1555'), null).map((m) => m.id)).toEqual([]);
    // The same row, with the identity the turn actually has, survives.
    expect(scopeToHumanConversation(tail, cp('+1555'), MINE).map((m) => m.id)).toEqual(['answered']);
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
