// Two rules for every channel send tool (iMessage, SMS, email, Teams, phone):
// 1. A send with no recipient never runs and never falls back to the addressee; the refusal
//    names who the turn talks to and the people the tool can reach.
// 2. A sent note names who received it and whether that is this turn's addressee.
// Both read the turn's address (turn-address.ts); A2A is not here, send_to_agent names its peer.

import type { ChannelKind, ToolResult } from '@dojo/shared';
import { outboundChannelForTool, outboundRecipientForTool } from './outbound.js';
import { describeAddressee, deliveryLabel, currentAddress, type TurnAddress } from './turn-address.js';
import { resolveRecipientDisplay } from '../../contacts/resolve-recipient.js';
import { addressesMatch } from '../../services/safe-senders.js';
import { isOwnerOn } from '../../services/owner-on.js';
import { getSafeSenders } from '../../services/imessage-bridge.js';
import { getSmsReachability, describeSmsRecipients } from '../../services/capability-registry.js';

/** The send tools whose recipient is a plain argument, with the argument names that carry it. */
const RECIPIENT_ARGS: Readonly<Record<string, readonly string[]>> = {
  imessage_send: ['recipient', 'to', 'handle'],
  sms_send: ['to', 'number', 'recipient'],
  gmail_send: ['to'],
  outlook_send: ['to'],
};

function baseName(name: string): string {
  return name.startsWith('user_') ? name.slice('user_'.length) : name;
}

function namedRecipient(name: string, args: Record<string, unknown> | undefined): boolean {
  const keys = RECIPIENT_ARGS[baseName(name)];
  if (!keys) return true;
  return keys.some((k) => {
    const v = args?.[k];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';
  });
}

// Rule 1: the refusal to hand back instead of running the send, or null when the call
// names a recipient (or is not a send tool with a plain recipient argument).
export function refuseSendWithNoRecipient(
  agentId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  toolCallId: string,
): ToolResult | null {
  const base = baseName(toolName);
  if (!(base in RECIPIENT_ARGS) || namedRecipient(base, args)) return null;
  const addr = currentAddress(agentId);
  const talkingTo = describeAddressee(addr) + (addr?.kind === 'person' && addr.senderId ? ` (address ${addr.senderId})` : '');
  const list = reachablePeople(base);
  const content =
    `${toolName} was NOT run: it needs a recipient, and it never defaults to the person this turn is talking to. ` +
    `This turn is talking to: ${talkingTo}. ` +
    (list ? `People you can reach with ${base}: ${list}. ` : '') +
    `Call again with the recipient set to the address of the person this message is for.`;
  return { toolCallId, name: toolName, content, isError: true };
}

/** The people this send tool can reach, as `Name <address>`, so the very next call can be right. */
function reachablePeople(base: string): string {
  try {
    if (base === 'imessage_send') {
      return getSafeSenders().map((x) => `${x.name} <${x.address}>${x.is_primary ? ' [the owner]' : ''}`).join(', ');
    }
    if (base === 'sms_send') {
      const r = getSmsReachability();
      return r.live ? describeSmsRecipients(r) : '';
    }
  } catch { /* no list is better than a failed refusal */ }
  return '';
}

function sameAsAddressee(addr: TurnAddress, channel: string, recipient: string): boolean {
  if (addr.kind !== 'person') return false;
  if (channel === 'teams') return !!addr.inboundContext?.chatId && addr.inboundContext.chatId === recipient;
  if (addr.senderId && addressesMatch(addr.senderId, recipient)) return true;
  // The owner has no address of their own on the dashboard: each channel's own owner rule decides, never a name.
  return addr.isOwner && isOwnerOn(channel, recipient);
}

// Rule 2: the note on a successful send. Empty when the call named no recipient argument:
// gmail_reply, gmail_draft, outlook_reply and outlook_forward name their real To/Cc themselves, read
// back from the message or draft.
export function recipientNoteFor(
  agentId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  const channel = outboundChannelForTool(toolName);
  if (channel === null) return '';
  const raw = outboundRecipientForTool(toolName, args);
  if (!raw) return '';
  const addr = currentAddress(agentId);
  let shown = raw;
  try { shown = resolveRecipientDisplay(channel as ChannelKind, raw); } catch { /* the raw handle is the honest fallback */ }
  const who = shown === raw ? raw : `${shown} (${raw})`;
  const sent = `Sent to ${who} by ${deliveryLabel(channel as never)}.`;
  // Routed channels only: a turn whose reply stays in the dashboard needs no contrast.
  if (!addr || !addr.routed) return ` ${sent}`;
  if (sameAsAddressee(addr, channel, raw)) return ` ${sent} This is the person this turn is talking to.`;
  return ` ${sent} This is not the person this turn is talking to (${addr.name}); your written reply still goes to ${addr.name}.`;
}

// Where the agent's written words go on a failure result, from the turn's address. Null
// when the reply stays in the dashboard, where the dashboard wording is already true.
export function routedReplyWords(agentId: string): { name: string; where: string; down: string; failed: string } | null {
  const addr = currentAddress(agentId);
  if (addr?.kind !== 'person' || !addr.routed) return null;
  const name = addr.name;
  // When this turn's own reply goes by iMessage, a down bridge (or a failed send) stops that reply too.
  if (addr.deliveryChannel === 'imessage') {
    return {
      name,
      where: `your written reply will not reach ${name} by iMessage either; it stays in the dashboard chat`,
      down: `You cannot reach ${name} by iMessage right now, and your written reply will not reach them either; it stays in the dashboard chat.`,
      failed: `Your iMessage did not go through, and your written reply will not reach ${name} by iMessage either right now; it stays in the dashboard chat.`,
    };
  }
  const where = `your written reply this turn goes to ${name} by ${deliveryLabel(addr.deliveryChannel)}, so tell them there`;
  return { name, where, down: `Tell ${name} that iMessage is turned off on this server: ${where}.`, failed: `Tell ${name} the message did not go through (${where}).` };
}
