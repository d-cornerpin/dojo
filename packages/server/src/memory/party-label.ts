// memory/party-label.ts — conversation/party labels for memory (channel-aware redesign)
//
// A summary or archive is a compression of messages from MANY conversations (the
// owner on the dashboard, a contact on iMessage, a colleague on email, another
// agent over A2A). Without per-message attribution those collapse into an
// unattributed blob ("dentist → 3pm; offsite budget question; blog blocked"), and
// when the agent later reads that on a DIFFERENT conversation's turn it acts on the
// wrong party's request (the owner's dentist reply stamped to a contact's thread).
// So we tag each message with WHICH conversation it belongs to before it is
// compressed, and the compressor/dreamer is instructed to carry that label into
// every fact. The memory of a conversation must carry that conversation's identity.

import { getOwnerName } from '../config/platform.js';
import { getDb } from '../db/connection.js';
import type { Message } from '@dojo/shared';

/** Turn a `conversations.id` into a party label.
 *
 *  ── REKEY (PHASE-2 T10I). This was `convKeyToLabel`, which PARSED a composite string back
 *  into the parts it was built from. Those parts are columns in `conversations`, so it reads
 *  them — and gains the counterparty's NAME, which the string never carried ("+15551234
 *  (imessage)" becomes "Alex Chen (imessage)"). A peer thread stays unnamed on purpose: a
 *  summary must not attribute agent coordination to a person. One PK lookup per own-output row
 *  on a batch (summarisation) path, not a turn path. */
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

/** Human-readable "who this message belongs to" for memory input tags. */
export function summaryPartyTag(m: Message): string | null {
  const o = m.origin;
  if (o?.kind === 'agent') return `${o.senderName ?? 'another agent'} (agent)`;
  if (o?.kind === 'engine') return 'engine/system';
  if (o?.kind === 'user') {
    if (o.relation === 'owner') return getOwnerName();
    const who = o.senderName ?? o.senderId ?? 'a contact';
    return o.channel ? `${who} (${o.channel})` : who;
  }
  // assistant (self) / tool work — tag with the conversation it was part of
  return conversationLabel(m.conversationId);
}
