// ════════════════════════════════════════════════════════════════════════════════════════
// t141 — "NO ROW VISIBLE TODAY BECOMES INVISIBLE", AS A PROPERTY; AND THE DELETIONS, AS CENSUSES.
//
// §1 enumerates EVERY own-row shape the scopers can meet (role × lane × label × stamp × turn)
// and compares the live scopers against the PRE-t141 rule restated as an oracle over the state
// the old writer would have left. They must agree on every shape. That is the owner's rule
// ("label, never hide") made mechanical: labelling may change what a row SAYS, never WHETHER it
// is in view.
//
// §2 are the deletion censuses (G4: comment-stripped, counted in both directions).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation, scopeToA2AThread } from '../assembler.js';
import type { SubjectKind } from '../message-store.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

const C = 'conv-this';
const OTHER = 'conv-other';
const NOW = 42;
const PAST = 41;
const ownerCp: TurnCounterparty = { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false };

type Shape = { id: string; role: 'assistant' | 'tool'; lane: 'owner' | 'a2a'; kind: SubjectKind | null; conv: string | null; turn: number; tool: boolean };

/** Every shape the post-t141 writer (and migration 188) can leave, with the stamp the PRE-t141
 *  system would have shown the scoper for the same row: the late stamp wrote a person turn's
 *  owner-lane rows at turn END (so the in-flight turn's rows read NULL), and nothing else. */
function shapes(): Array<Shape & { oldConv: string | null }> {
  const out: Array<Shape & { oldConv: string | null }> = [];
  let i = 0;
  for (const role of ['assistant', 'tool'] as const)
    for (const lane of ['owner', 'a2a'] as const)
      for (const kind of ['conv', 'a2a_thread', 'engine_event', 'background', 'legacy', 'unknown', null] as const)
        for (const conv of [null, C, OTHER])
          for (const turn of [NOW, PAST])
            for (const tool of [true, false]) {
              // Only shapes the writers produce: a `conv` label always names its conversation;
              // `legacy` carries a reconstructed one; agent-thread / engine / background never do.
              if (kind === 'conv' && !conv) continue;
              if ((kind === 'a2a_thread' || kind === 'engine_event' || kind === 'background') && conv) continue;
              if (lane === 'a2a' && kind !== 'a2a_thread' && kind !== null) continue;
              // An UNLABELLED row of the live turn carrying a stamp is not a shape any writer makes:
              // the live turn's rows are written through `message-store.ts`, which labels them.
              if (kind === null && conv && turn === NOW) continue;
              const oldConv = kind === 'conv' && lane === 'owner' && turn === PAST ? conv
                : kind === null ? conv : null;   // an unlabelled row (fixture / bypass) carries its stamp as-is
              out.push({ id: `s${i++}`, role, lane, kind, conv, turn, tool, oldConv });
            }
  return out;
}

function asMessage(s: Shape): Message & { subjectKind?: SubjectKind | null } {
  const origin: MessageOrigin = { kind: 'self', relation: 'agent', channel: s.lane === 'a2a' ? 'a2a' : null, senderName: null, senderId: null, threadId: null, intent: null, authorized: true };
  return {
    id: s.id, agentId: 'a', role: s.role, tokenCount: 1, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-10-12 10:00:00', turnNumber: s.turn, conversationId: s.conv, origin,
    content: s.tool ? '[{"type":"tool_use","id":"t","name":"x","input":{}}]' : 'text',
    ...(s.kind === null ? {} : { subjectKind: s.kind }),
  } as Message & { subjectKind?: SubjectKind | null };
}

describe('§1 membership is unchanged on every shape (the oracle is the pre-t141 rule)', () => {
  const all = shapes();

  it('the owner\'s conversation keeps exactly what it kept before', () => {
    const live = new Set(scopeToHumanConversation(all.map(asMessage), ownerCp, C, NOW).map((m) => m.id));
    const oracle = new Set(all.filter((s) => !s.oldConv || s.oldConv === C).map((s) => s.id));
    const diff = all.filter((s) => live.has(s.id) !== oracle.has(s.id));
    expect(diff, JSON.stringify(diff.slice(0, 5))).toEqual([]);
    expect(all.length).toBeGreaterThan(60);
  });

  it('an agent thread keeps exactly what it kept before', () => {
    // On an agent-thread turn the live turn IS that thread's: a person-conversation row of the
    // live turn cannot exist there, so those shapes are not in this scoper's domain.
    const domain = all.filter((s) => !(s.turn === NOW && s.kind === 'conv'));
    const live = new Set(scopeToA2AThread(domain.map(asMessage), 'thread-x').map((m) => m.id));
    const oracle = new Set(domain.filter((s) => {
      const humanStamped = !!s.oldConv && s.lane !== 'a2a';
      return (s.tool && !humanStamped) || s.lane === 'a2a';
    }).map((s) => s.id));
    const diff = domain.filter((s) => live.has(s.id) !== oracle.has(s.id));
    expect(diff, JSON.stringify(diff.slice(0, 5))).toEqual([]);
  });

  it('the in-flight fact is the turn number: this turn\'s rows are kept whatever their stamp', () => {
    const mine = asMessage({ id: 'now', role: 'tool', lane: 'owner', kind: 'conv', conv: OTHER, turn: NOW, tool: true });
    expect(scopeToHumanConversation([mine], ownerCp, C, NOW).map((m) => m.id)).toEqual(['now']);
    expect(scopeToHumanConversation([mine], ownerCp, C, NOW + 1).map((m) => m.id)).toEqual([]);
  });
});
