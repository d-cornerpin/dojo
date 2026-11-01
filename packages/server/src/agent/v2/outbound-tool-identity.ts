// ════════════════════════════════════════════════════════════════════════════════
// WHAT A SEND TOOL DECLARES — split from `outbound.ts` (proof-fix-f) when the declaration grew
// the text being sent: the outbound scope writes an outside send's INTENT before its transport
// runs, and the intent says what may reach the person if the process dies mid-send.
// ════════════════════════════════════════════════════════════════════════════════
import { channelOfSendTool } from '@dojo/shared';
import type { DeliveryChannel, OutboundIntent } from './outbound.js';

/**
 * The channel a send TOOL delivers on, or null when the tool reaches nobody.
 *
 * This is what lets the engine open a scope at the single tool-dispatch door instead of at
 * each of the ten send paths PINNED §8 lists as unrecorded — `gmail_reply`, `gmail_forward`,
 * `outlook_reply`, `outlook_forward`, `teams_send_message`, `teams_send_channel_message`,
 * `voice_call`, and the four that were already partly covered — and it is derived from the
 * shared `channelOfSendTool` map rather than being a second hand-maintained list.
 *
 * `user_` twins run the BASE tool's executor (the same reasoning `RECEIPT_EXEMPT` records),
 * so they resolve to the base name's channel.
 *
 * `send_to_agent` / `broadcast_to_group` deliberately return null: their rows are written
 * inside the A2A transport, one per PEER, by the call PHASE-2 T4 landed. A scope here would
 * fold a fan-out to five agents into one row, which is a worse answer than no scope.
 */
export function outboundChannelForTool(name: string): DeliveryChannel | null {
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  if (base === 'teams_send_channel_message') return 'teams';
  const ch = channelOfSendTool(base);
  if (ch === null) return null;
  // ChannelKind and the deliveries channel union agree on every send channel; the extra
  // members of the delivery union (dashboard, voice, a2a) have no send tool.
  return ch as DeliveryChannel;
}

/** The recipient a send tool named, for the ledger's `recipient_id`. Best-effort: a missing
 *  or reply-shaped argument simply leaves the column null, exactly as it does today. */
export function outboundRecipientForTool(
  name: string, args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  if (base.startsWith('teams_')) return first('chat_id', 'channel_id', 'team_id');
  if (base === 'imessage_send') return first('to', 'recipient', 'handle');
  if (base === 'sms_send' || base === 'voice_call') return first('to', 'number', 'recipient');
  return first('to', 'recipient');
}

/** The words a send tool puts in front of the person, for the intent row. Best-effort, like the recipient. */
export function outboundTextForTool(args: Record<string, unknown> | undefined): string | null {
  for (const k of ['message', 'body', 'text', 'content']) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The whole declaration the tool-dispatch door opens a scope with, or null for a tool that reaches nobody. */
export function outboundIntentForTool(
  agentId: string, name: string, args: Record<string, unknown> | undefined, conversationId: string | null,
): OutboundIntent | null {
  const channel = outboundChannelForTool(name);
  if (channel === null) return null;
  return { agentId, tool: name, channel, recipientId: outboundRecipientForTool(name, args), conversationId, text: outboundTextForTool(args) };
}
