// ════════════════════════════════════════
// Outbound recipient display resolver
//
// ONE cheap, deterministic, server-side name lookup used by every outbound
// label writer: the reply-destination routing markers (loop.ts), the engine
// ack channel pushes, and the explicit send-tool marker. Given a channel + the
// raw handle the model/engine is delivering to (a phone number, an email
// address, an iMessage handle), it returns the best human name we can prove
// from LOCAL state, never a network or model call:
//
//   1. the DOJO contacts store (the curated record the safe-sender mirror keeps
//      in sync), then
//   2. the channel's own safe-sender registry (the allowlist the owner trusted,
//      which carries a display name), then
//   3. the raw handle itself, unchanged, when nothing resolves.
//
// Step 3 is the honest fallback: an unknown number stays a number, so the badge
// reads "to +1555…" rather than inventing a name. Keeping this in one place is
// what stops the outbound badge wording from drifting between the auto-route
// path and the explicit-send path (the two used to resolve names differently,
// which is why an explicit send showed a raw number while an auto-route showed
// the name).
// ════════════════════════════════════════

import type { ChannelKind } from '@dojo/shared';
import { findMatchingContact, type ContactRecord } from './store.js';
import { getSafeSenders, findSafeSenderByAddress, type SafeSender } from '../services/imessage-bridge.js';
import {
  getTwilioSmsSafeSenders,
  getTwilioVoiceSafeCallers,
  getGmailSafeSenders,
  getOutlookSafeSenders,
  getTeamsSafeSenders,
} from '../services/channel-safe-senders.js';

// Match a handle against the contact-record field it lives in for this channel.
// iMessage handles can be a phone OR an email but are stored in their own field
// so the exact trusted handle matches; SMS/voice are phone numbers; mail/Teams
// are email addresses.
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

// Every safe-sender list a channel's handle could be trusted on. Email is not
// slot-scoped for display purposes: a name is a name whether it came in on the
// agent or user mailbox, so we check both. Best-effort throughout — a registry
// read that throws is swallowed so labeling never breaks a send.
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
        lists.push(getGmailSafeSenders('agent'), getGmailSafeSenders('user'));
        lists.push(getOutlookSafeSenders('agent'), getOutlookSafeSenders('user'));
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
    // Only treat the record's name as a resolved display name when it is a real
    // label, not the address copied into the name slot (legacy migration did
    // that), which would just echo the handle back.
    if (match?.name && match.name.trim() && match.name.trim() !== match.address.trim()) {
      return match.name.trim();
    }
  }
  return null;
}

/**
 * Resolve the display name for an outbound recipient handle on a channel.
 * Contacts store first, then the channel's safe-sender registry, then the raw
 * handle. Pure DB/config reads, no network, no model calls. Always returns a
 * non-empty string (the handle itself when nothing better is known).
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
    /* contacts read is best-effort; fall through to the registry + raw handle */
  }

  return safeSenderNameFor(channel, h) ?? h;
}
