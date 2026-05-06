// ════════════════════════════════════════
// Phase 1B — engine-injected ack classifier
//
// Per Part VI #11 and Part XVI #6/#7. v1 has "MANDATORY: Acknowledge &
// Report" in the primary's system prompt — agents are supposed to send
// brief text ("On it, checking now...") before kicking off tools. Weak
// models forget. v2 takes it out of the LLM's hands: the engine writes
// a generic ack to the dashboard chat IF the agent is about to call a
// tool without producing acknowledgment text first.
//
// IMPORTANT (Part XVI #7): the engine ack is NEVER routed via iMessage,
// even when the trigger was iMessage. The user's original message is
// already their receipt; an instant "On it..." iMessage notification
// would be noise. The full reply still flows via iMessage when complete.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

export interface AckInjectorInput {
  /** Whether this is the first model response after a user message in the turn. */
  isFirstResponseInTurn: boolean;
  /** The agent's text content from the model response (may be empty). */
  responseText: string;
  /** Tools the agent is about to call. */
  plannedTools: ToolCall[];
  /** Whether the trigger was iMessage (engine ack still goes to dashboard, never iMessage). */
  triggeredByIMessage: boolean;
  /** Whether the trigger was inter-agent (A2A, group broadcast, PM poke, etc.) — no ack needed. */
  isInterAgentTrigger: boolean;
  /** Whether the agent is the user-facing primary. Sub-agents don't ack to dashboard. */
  isPrimaryAgent: boolean;
}

export interface AckInjectorResult {
  /** Engine-written ack text, or null if no ack needed. */
  ackText: string | null;
  /** Reason for the decision (for logging). */
  reason: string;
}

/**
 * Tools that are themselves visible/conversational and don't need a
 * pre-ack — the act of calling them IS the response.
 */
const SELF_ACKNOWLEDGING_TOOLS = new Set([
  'show_to_user',       // displays a file directly
  'imessage_send',      // proactive iMessage IS the response
  'image_create',       // ack message goes inline ("On it, generating now")
  'send_to_agent',      // agent-to-agent — not a user-facing turn anyway
  'broadcast_to_group',
]);

const ACK_TEXT_DEFAULT = 'Working on it…';

/**
 * Decide whether the engine should inject a generic ack before tool execution.
 *
 * Returns null (no ack) in any of these cases:
 *   - Not the first response in the turn (mid-tool-loop)
 *   - Agent already produced acknowledgment text
 *   - No tools planned (text-only response IS the ack)
 *   - Inter-agent trigger (A2A doesn't need user-facing acks)
 *   - Sub-agent (sub-agents don't have a user-facing chat to ack to)
 *   - Only self-acknowledging tools (image_create, show_to_user, etc.)
 */
export function ackInjector(input: AckInjectorInput): AckInjectorResult {
  if (!input.isFirstResponseInTurn) {
    return { ackText: null, reason: 'mid-tool-loop, not first response' };
  }
  if (!input.isPrimaryAgent) {
    return { ackText: null, reason: 'sub-agent has no user-facing chat to ack to' };
  }
  if (input.isInterAgentTrigger) {
    return { ackText: null, reason: 'inter-agent trigger does not need user ack' };
  }
  if (input.plannedTools.length === 0) {
    return { ackText: null, reason: 'no tools planned — text response IS the ack' };
  }
  if (input.responseText.trim().length > 0) {
    return { ackText: null, reason: 'agent already produced acknowledgment text' };
  }
  // If EVERY planned tool is self-acknowledging, no engine ack needed.
  if (input.plannedTools.every((tc) => SELF_ACKNOWLEDGING_TOOLS.has(tc.name))) {
    return { ackText: null, reason: 'planned tools are self-acknowledging' };
  }
  return {
    ackText: ACK_TEXT_DEFAULT,
    reason: `agent calling ${input.plannedTools.length} tool(s) without ack text — engine inserting`,
  };
}

/** Default ack text — exported for tests / future customization. */
export const DEFAULT_ACK_TEXT = ACK_TEXT_DEFAULT;
