// A coordination turn's own output rides the Inter-Agent lane, never the owner's chat feed.
// The broadcast call site is shared by both arms, so the event choice lives here, in one value.

import type { ChatMessageEvent, InterAgentMessageEvent, Message } from '@dojo/shared';

export interface OwnOutputBroadcast {
  /** The same flag that already picked the writer. True = coordination turn. */
  interAgentTurn: boolean;
  agentId: string;
  agentName: string | null;
  id: string;
  role: 'assistant' | 'tool';
  content: string;
  /** The reload route's own text form. The broadcast seam overwrites this from the row for
   *  `chat:message`; the Inter-Agent lane keeps what it is given. */
  createdAt: string;
  modelId?: string | null;
  conversationId?: string | null;
  attachments?: Message['attachments'];
  reasoningContent?: string | null;
}

export function ownOutputBroadcast(p: OwnOutputBroadcast): ChatMessageEvent | InterAgentMessageEvent {
  if (p.interAgentTurn) {
    return {
      type: 'interagent:message',
      agentId: p.agentId,
      message: {
        id: p.id,
        agentId: p.agentId,
        role: p.role,
        content: p.content,
        createdAt: p.createdAt,
        // No peer, no thread: direction is `role`. `originKind: null` = the agent's own voice,
        // not a subsystem notice; memory/interagent.ts documents the same rule on the write side.
        sourceAgentId: null,
        senderName: p.agentName,
        recipientName: null,
        threadId: null,
        intent: null,
        requiresResponse: false,
        originKind: null,
        attachments: p.attachments,
      },
    };
  }
  return {
    type: 'chat:message',
    agentId: p.agentId,
    message: {
      id: p.id,
      agentId: p.agentId,
      role: p.role as Message['role'],
      content: p.content,
      tokenCount: null,
      modelId: p.modelId ?? null,
      cost: null,
      latencyMs: null,
      createdAt: p.createdAt,
      attachments: p.attachments,
      reasoningContent: p.reasoningContent ?? undefined,
      // Deliberately on the OWNER arm only: `conversation_id` is stamped at turn teardown, so
      // this mid-turn broadcast is the live view's only chance; a reload-side fix must not regress it.
      conversationId: p.conversationId ?? null,
    },
  };
}
