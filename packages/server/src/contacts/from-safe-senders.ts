// Mirrors safe-sender allowlist entries into the contacts store so the name resolves later.
// Additive and one-way (removing a sender never deletes the contact), idempotent, best-effort.

import type { SafeSender } from '../services/imessage-bridge.js';
import { findMatchingContact, createContact, updateContact, type ContactInput } from './store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('contacts-safe-senders');

export type SafeSenderChannel = 'imessage' | 'gmail' | 'outlook' | 'teams' | 'sms' | 'voice';

type AddressField = 'emails' | 'phones' | 'imessageHandles';

// Contact field per channel. iMessage handles (phone or email) go in imessage_handles so the agent texts
// the exact trusted handle.
const FIELD_BY_CHANNEL: Record<SafeSenderChannel, AddressField> = {
  imessage: 'imessageHandles',
  gmail: 'emails',
  outlook: 'emails',
  teams: 'emails',
  sms: 'phones',
  voice: 'phones',
};

/** Config key to its channel, or null; gmail/outlook keys are per slot, so they match by prefix. */
export function configKeyToChannel(key: string): SafeSenderChannel | null {
  if (key === 'imessage_approved_senders') return 'imessage';
  if (key.startsWith('gmail_approved_senders')) return 'gmail';
  if (key.startsWith('outlook_approved_senders')) return 'outlook';
  if (key === 'teams_approved_senders') return 'teams';
  if (key === 'twilio_sms_approved_senders') return 'sms';
  if (key === 'twilio_voice_approved_callers') return 'voice';
  return null;
}

type SyncOutcome = 'created' | 'updated' | 'noop';

// Mirror one safe sender, matching by address only (never by name alone).
function syncOne(channel: SafeSenderChannel, sender: SafeSender, agentId: string | null): SyncOutcome {
  const address = sender.address?.trim();
  if (!address) return 'noop';
  const field = FIELD_BY_CHANNEL[channel];
  const name = (sender.name ?? '').trim();

// Any address field matches, so a handle already on file as an email still finds the person.
  const match = findMatchingContact(
    { emails: [address], phones: [address], imessageHandles: [address] },
    { allowNameMatch: false },
  );
  if (match) {
    const patch: ContactInput = {};
    if (!match[field].some((a) => a.toLowerCase() === address.toLowerCase())) {
      patch[field] = [address];
    }
// A safe-sender-derived contact tracks the current label; a hand-curated one keeps its name and gets
// the label as a preferred_name alias.
    const lname = name.toLowerCase();
    const nameAlreadyKnown =
      !name ||
      match.displayName.toLowerCase() === lname ||
      (match.preferredName ?? '').toLowerCase() === lname;
    if (!nameAlreadyKnown) {
      if (match.tags.includes('safe-sender')) patch.displayName = name;
      else if (!(match.preferredName ?? '').trim()) patch.preferredName = name; // never replace one the owner set
    }
    if (Object.keys(patch).length === 0) return 'noop';
    updateContact(match.id, patch, agentId, 'append');
    return 'updated';
  }

// New contact; the address stands in as display name when the sender has none.
  const createPatch: ContactInput = { displayName: name || address, tags: ['safe-sender'] };
  createPatch[field] = [address];
  createContact(createPatch, agentId);
  return 'created';
}

/**
 * Mirror a whole list (the dashboard replaces it each save); a failing entry is logged, never thrown.
 * agentId is null for a user save.
 */
export function syncSafeSendersToContacts(
  channel: SafeSenderChannel,
  senders: readonly SafeSender[],
  agentId: string | null,
): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  for (const sender of senders) {
    try {
      const outcome = syncOne(channel, sender, agentId);
      if (outcome === 'created') created++;
      else if (outcome === 'updated') updated++;
    } catch (err) {
      logger.warn('Failed to mirror safe sender to contacts', {
        channel,
        address: sender.address,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (created || updated) {
    logger.info('Mirrored safe senders to contacts', { channel, created, updated });
  }
  return { created, updated };
}

/** Single-sender mirror for the append paths (agent add_safe_sender, Twilio routes). */
export function syncSafeSenderToContacts(
  channel: SafeSenderChannel,
  sender: SafeSender,
  agentId: string | null,
): void {
  try {
    syncOne(channel, sender, agentId);
  } catch (err) {
    logger.warn('Failed to mirror safe sender to contacts', {
      channel,
      address: sender.address,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
