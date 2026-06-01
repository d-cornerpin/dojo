// ════════════════════════════════════════
// Reply-Destination Resolver (v2.7.23)
//
// Decides where the model's terminal assistant text gets delivered at
// end-of-turn. The model just writes text; this resolver tells the engine
// which channel to route through. OpenClaw-inspired (see their
// src/auto-reply/reply/source-reply-delivery-mode.ts).
//
// Replaces the v2.7.22 "model must call imessage_send for every reply"
// pattern, which failed in practice because the model's trained default
// for conversational/short replies is to stream text, not call a tool.
// Asking the model to flip mid-stream lost ~50% of replies into dashboard
// chat that David never saw on iMessage.
//
// Two layers:
//
//  1. Inbound channel binding (read from state.inboundChannel) → reply
//     goes back via the SAME channel the inbound came in on. A reply to
//     an iMessage thread goes back to that iMessage. A reply on the
//     dashboard goes back to dashboard.
//
//  2. Away override → when presence === 'away' AND the natural reply
//     destination is 'dashboard' AND the iMessage bridge is configured,
//     rewrite the destination to 'imessage'. This means proactive agent
//     messages (no inbound trigger) reach the user on their phone when
//     they're not at the dashboard.
//
// The watchdog/sendAlert path is independent of this resolver — it goes
// direct to iMessage when configured and is not subject to routing.
// ════════════════════════════════════════

import type { AgentTurnState } from './state.js';

export type ReplyDestination = 'imessage' | 'teams' | 'dashboard';

export interface ResolveReplyDestinationParams {
  state: Pick<AgentTurnState, 'inboundChannel'>;
  presence: 'in_dojo' | 'away';
  imessageBridgeConfigured: boolean;
}

export function resolveReplyDestination(params: ResolveReplyDestinationParams): ReplyDestination {
  const { state, presence, imessageBridgeConfigured } = params;

  // Layer 1: bind to the inbound channel when one is set.
  if (state.inboundChannel === 'imessage') return 'imessage';
  if (state.inboundChannel === 'teams') return 'teams';

  // Layer 2: dashboard inbound or proactive turn → default to dashboard,
  // then apply the away override if applicable.
  const base: ReplyDestination = 'dashboard';
  if (presence === 'away' && imessageBridgeConfigured) {
    return 'imessage';
  }
  return base;
}
