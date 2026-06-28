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
import type { Message } from '@dojo/shared';

/** Turn a conv_key ("owner" | "imessage:alex chen" | "email:x@y" | "a2a:…") into a label. */
export function convKeyToLabel(convKey: string | null | undefined): string | null {
  if (!convKey) return null;
  if (convKey === 'owner') return getOwnerName();
  const idx = convKey.indexOf(':');
  if (idx === -1) return convKey;
  const channel = convKey.slice(0, idx);
  const who = convKey.slice(idx + 1);
  if (channel === 'a2a') return 'an agent thread';
  return who ? `${who} (${channel})` : channel;
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
  return convKeyToLabel(m.convKey);
}
