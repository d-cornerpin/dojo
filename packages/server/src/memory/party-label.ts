// Party labels for memory: a summary mixes many conversations, so each message is tagged with its party
// before compression, or a reader on another conversation acts on the wrong party's request.

import { getOwnerName } from '../config/platform.js';
import { getDb } from '../db/connection.js';
import type { Message } from '@dojo/shared';

/** A peer thread stays unnamed on purpose: a summary must not attribute agent coordination to a person. */
export function conversationLabel(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  try {
    const row = getDb().prepare(
      'SELECT channel, counterparty_id, counterparty_name FROM conversations WHERE id = ?',
    ).get(conversationId) as { channel: string; counterparty_id: string | null; counterparty_name: string | null } | undefined;
    if (!row) return null;
    if (row.channel === 'a2a') return 'an agent thread';
    if (row.channel === 'dashboard' || row.channel === 'voice' || row.counterparty_id === 'owner') return getOwnerName();
    const who = row.counterparty_name ?? row.counterparty_id;
    return who ? `${who} (${row.channel})` : row.channel;
  } catch { return null; }
}

export function summaryPartyTag(m: Message): string | null {
  const o = m.origin;
  if (o?.kind === 'agent') return `${o.senderName ?? 'another agent'} (agent)`;
  if (o?.kind === 'engine') return 'engine/system';
  if (o?.kind === 'user') {
    if (o.relation === 'owner') return getOwnerName();
    const who = o.senderName ?? o.senderId ?? 'a contact';
    return o.channel ? `${who} (${o.channel})` : who;
  }
  return conversationLabel(m.conversationId);
}

/** The party of a recalled row from another conversation; null for the served one, where it is not news. */
export function recalledRowLabel(rowConversationId: string | null | undefined, servedConversationId: string | null | undefined): string | null {
  if (!rowConversationId || rowConversationId === servedConversationId) return null;
  return conversationLabel(rowConversationId);
}
