// PHASE-1 T9 — the agent's OWN inter-agent output leaves `chat:*`.
//
// The pinned landmine, in full (PHASE-1.md T9, corrected 2026-07-27): the three (measured
// at HEAD: FOUR) own-output broadcasts in `agent/v2/loop.ts` sit AFTER an
// `if (interAgentTurn) { … } else { … }` that persists on both arms. Converting the pinned
// LINE converts the owner-chat arm with it and kills live streaming for ordinary turns.
// So the decision "which event family does this row ride" is lifted OUT of the four
// duplicated literals into one function, where it is a value the test can drive both ways
// instead of a branch nobody can reach from a unit test.
//
// requirement preserved: an agent's coordination output reaches the dashboard's Inter-Agent
// lane live (it never did — the lane's history route already served those rows, so the lane
// was reload-only), and never rides the owner's chat feed.

import { describe, it, expect } from 'vitest';
import { ownOutputBroadcast } from '../interagent-broadcast.js';

const BASE = {
  agentId: 'agent-a',
  agentName: 'Scout',
  id: 'msg-1',
  role: 'assistant' as const,
  content: 'thinking out loud to a peer',
  createdAt: '2026-07-28 09:00:00',
};

describe('T9 — own-output event family', () => {
  it('an inter-agent turn rides interagent:message, never chat:message', () => {
    const ev = ownOutputBroadcast({ ...BASE, interAgentTurn: true });
    expect(ev.type).toBe('interagent:message');
    if (ev.type !== 'interagent:message') throw new Error('unreachable');
    expect(ev.agentId).toBe('agent-a');
    expect(ev.message.id).toBe('msg-1');
    expect(ev.message.role).toBe('assistant');
    expect(ev.message.content).toBe('thinking out loud to a peer');
    // Own output: the agent IS the sender, so there is no peer to attribute and no
    // thread — the DIRECTION lives in `role`, exactly as the row does (interagent.ts).
    expect(ev.message.sourceAgentId).toBeNull();
    expect(ev.message.threadId).toBeNull();
    expect(ev.message.originKind).toBeNull();
    expect(ev.message.senderName).toBe('Scout');
  });

  it('an ORDINARY turn keeps chat:message — the else-arm is untouched (the pinned landmine)', () => {
    const ev = ownOutputBroadcast({ ...BASE, interAgentTurn: false });
    expect(ev.type).toBe('chat:message');
    if (ev.type !== 'chat:message') throw new Error('unreachable');
    expect(ev.message.id).toBe('msg-1');
    expect(ev.message.content).toBe('thinking out loud to a peer');
  });

  it('carries the fields the owner-chat literals carried, so the else-arm loses nothing', () => {
    const ev = ownOutputBroadcast({
      ...BASE,
      interAgentTurn: false,
      modelId: 'deepseek/v4-flash',
      conversationId: 'conv-owner-1',
      attachments: [{ fileId: 'f1', filename: 'a.png', mimeType: 'image/png', size: 1, path: '/a.png', category: 'image' }],
      reasoningContent: 'because',
    });
    if (ev.type !== 'chat:message') throw new Error('unreachable');
    expect(ev.message.modelId).toBe('deepseek/v4-flash');
    expect(ev.message.conversationId).toBe('conv-owner-1');
    expect(ev.message.attachments).toHaveLength(1);
    expect(ev.message.reasoningContent).toBe('because');
  });

  it('a tool-result row takes the same fork', () => {
    const a2a = ownOutputBroadcast({ ...BASE, role: 'tool', interAgentTurn: true });
    const owner = ownOutputBroadcast({ ...BASE, role: 'tool', interAgentTurn: false });
    expect(a2a.type).toBe('interagent:message');
    expect(owner.type).toBe('chat:message');
  });
});
