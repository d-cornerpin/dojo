// ════════════════════════════════════════════════════════════════════════════════
// WHICH EVENT FAMILY DOES THE AGENT'S OWN OUTPUT RIDE? (PHASE-1 T9, research 17 §C4)
//
// One question, one owner. The engine persists the agent's own assistant/tool rows in FOUR
// places (`agent/v2/loop.ts`: the tool_use row, the attachment echo, the XML-fallback
// collapse, the tool_result row), and each one is shaped
//
//     if (interAgentTurn) { insertInterAgentOwnOutput(…) } else { insertMessageIfAbsent(…) }
//     broadcast({ type: 'chat:message', … })          ← SHARED, outside the branch
//
// The broadcast sat OUTSIDE the branch, so a coordination turn's output went out on the
// owner's chat feed. Research 17 called that D2 and traced two owner-visible symptoms to
// it: a2a rows entering the tool-pill grouping and eating a visible sibling's chip row
// live (bug a-2), and the Inter-Agent lane's LIVE view being structurally empty of the
// agent's own half — its history route (`GET /api/interagent/:agentId`,
// `lane IN ('a2a','events')`, no role filter) has always served those rows on reload.
//
// ⚠ THE LANDMINE, recorded because an earlier draft of the plan stepped on it. The pinned
// line is SHARED. Converting `broadcast({type:'chat:message'})` in place converts the
// owner-chat arm too and kills live streaming for every ordinary turn. The fix is not a
// line edit — it is lifting the decision into a value, which is this function. The
// `interAgentTurn` flag that already chooses the WRITER now also chooses the EVENT, from
// one place, and a unit test drives both arms.
//
// requirement preserved: "the agent's own inter-agent-turn output never surfaces as owner
// chat" — carried before by the row's physical table, then by `lane='a2a'` + the
// fail-closed `chat_messages` view, and now by the wire as well.
// ════════════════════════════════════════════════════════════════════════════════

import type { ChatMessageEvent, InterAgentMessageEvent, Message } from '@dojo/shared';

export interface OwnOutputBroadcast {
  /** The same flag that already picked the writer. True = coordination turn. */
  interAgentTurn: boolean;
  /** The author (its own history), and the lane/chat feed this belongs to. */
  agentId: string;
  /** Display name for the Inter-Agent lane's sender label; unused on the chat arm. */
  agentName: string | null;
  id: string;
  role: 'assistant' | 'tool';
  content: string;
  /** The reload route's own text form. The broadcast seam overwrites this from the row for
   *  `chat:message`; the Inter-Agent lane keeps what it is given. */
  createdAt: string;
  modelId?: string | null;
  convKey?: string | null;
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
        // Own output carries no peer and no thread: the DIRECTION is `role`, exactly as
        // the row records it (memory/interagent.ts documents the same rule on the write
        // side). `originKind: null` marks it peer-side rather than engine-side, so the
        // lane styles it as the agent's own voice, not a subsystem notice.
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
      // Carried on the OWNER arm only, and deliberately: conv_key is stamped on the row
      // at turn teardown, so a mid-turn broadcast is the only place the live view can
      // learn it. That is research 17 §C2's defect (bug (a), "tool chips vanish on
      // refresh") and §C2 is not this task's — T9 must not regress the live half while
      // the reload half waits for its owner.
      convKey: p.convKey ?? null,
    },
  };
}
