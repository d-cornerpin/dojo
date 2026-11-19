// Outbound recipient display resolver: the single server-side lookup every outbound label writer uses.
// Contacts store, then the channel safe-sender registry, then the raw handle. Local reads only.

import type { ChannelKind } from '@dojo/shared';
import { findMatchingContact, type ContactRecord } from './store.js';
import { getSafeSenders, findSafeSenderByAddress, type SafeSender } from '../services/imessage-bridge.js';
import {
  getTwilioSmsSafeSenders,
  getTwilioVoiceSafeCallers,
  mailboxesSafeSenders,
  getTeamsSafeSenders,
} from '../services/channel-safe-senders.js';

// Contact field a handle lives in for this channel (iMessage handles have their own field).
function contactByChannelHandle(channel: ChannelKind, handle: string): ContactRecord | null {
  switch (channel) {
    case 'imessage': return findMatchingContact({ imessageHandles: [handle] });
    case 'sms':
    case 'phone': return findMatchingContact({ phones: [handle] });
    case 'email':
    case 'teams': return findMatchingContact({ emails: [handle] });
    default: return null;
  }
}

// Every safe-sender list the handle could be on; email checks every mailbox. A throwing read returns null
// so labeling never breaks a send.
function safeSenderNameFor(channel: ChannelKind, handle: string): string | null {
  const lists: SafeSender[][] = [];
  try {
    switch (channel) {
      case 'imessage':
        lists.push(getSafeSenders());
        break;
      case 'sms':
        lists.push(getTwilioSmsSafeSenders());
        break;
      case 'phone':
        lists.push(getTwilioVoiceSafeCallers());
        break;
      case 'email':
        lists.push(mailboxesSafeSenders('gmail'), mailboxesSafeSenders('outlook'));
        break;
      case 'teams':
        lists.push(getTeamsSafeSenders());
        break;
    }
  } catch {
    return null;
  }
  for (const list of lists) {
    const match = findSafeSenderByAddress(list, handle);
// Skip records whose name is just the address, which would echo the handle back.
    if (match?.name && match.name.trim() && match.name.trim() !== match.address.trim()) {
      return match.name.trim();
    }
  }
  return null;
}

/**
 * Display name for an outbound handle; the handle itself when nothing better is known (empty in, empty out).
 */
export function resolveRecipientDisplay(channel: ChannelKind, handle: string | null | undefined): string {
  const h = (handle ?? '').trim();
  if (!h) return handle ?? '';

  try {
    const contact = contactByChannelHandle(channel, h);
    if (contact?.displayName && contact.displayName.trim() && contact.displayName.trim() !== h) {
      return contact.displayName.trim();
    }
  } catch {
    /* best-effort; fall through to the registry */
  }

  return safeSenderNameFor(channel, h) ?? h;
}
