// ════════════════════════════════════════
// Safe senders -> contacts mirror
//
// When someone is added to a channel's safe-sender allowlist (via the
// dashboard Settings/Channels UI or the agent's add_safe_sender tool), mirror
// them into the DOJO contacts store so the name resolves later. Without this, a
// user who adds "Jain" to the iMessage safe-sender list and then says "text
// Jain about X" sends the agent hunting the vault for a contact that never
// existed -- it spins out on the missing record.
//
// Properties:
//   - Additive + one-way: a safe-sender add creates or augments a contact;
//     REMOVING a safe sender never deletes the contact (the contact store is a
//     knowledge record, not the allowlist).
//   - Idempotent: re-running over a full list is a no-op once the address is on
//     file, so the dashboard's "replace the whole list" save is safe to mirror
//     in its entirety every time.
//   - Best-effort: a contacts failure must never block the safe-sender write,
//     so every entry is wrapped and only logged on failure.
// ════════════════════════════════════════

import type { SafeSender } from '../services/imessage-bridge.js';
import { findMatchingContact, createContact, updateContact, type ContactInput } from './store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('contacts-safe-senders');

export type SafeSenderChannel = 'imessage' | 'gmail' | 'outlook' | 'teams' | 'sms' | 'voice';

type AddressField = 'emails' | 'phones' | 'imessageHandles';

// Which contact field a channel's address belongs in. iMessage handles can be a
// phone OR an email, but they live in imessage_handles so the agent texts the
// exact handle the user trusted; SMS/voice are phone numbers; mail/Teams are
// email-style addresses.
const FIELD_BY_CHANNEL: Record<SafeSenderChannel, AddressField> = {
  imessage: 'imessageHandles',
  gmail: 'emails',
  outlook: 'emails',
  teams: 'emails',
  sms: 'phones',
  voice: 'phones',
};

/**
 * Map a config key (the dashboard's safe-sender write target) to its channel,
 * or null if the key is not a safe-sender list. Gmail/Outlook are per-slot
 * (`..._agent` / `..._user`), so they match on prefix.
 */
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

// Mirror one safe sender. Match by the channel's address first, then by exact
// display name, so adding an iMessage handle to an existing "Jain" record
// augments it instead of forking a duplicate.
function syncOne(channel: SafeSenderChannel, sender: SafeSender, agentId: string | null): SyncOutcome {
  const address = sender.address?.trim();
  if (!address) return 'noop';
  const field = FIELD_BY_CHANNEL[channel];
  const name = (sender.name ?? '').trim();

  const match = findMatchingContact({ [field]: [address], displayName: name || undefined });
  if (match) {
    const patch: ContactInput = {};
    // Add the channel address if the matched contact doesn't carry it yet.
    if (!match[field].some((a) => a.toLowerCase() === address.toLowerCase())) {
      patch[field] = [address];
    }
    // Reconcile the name so the person stays findable by their CURRENT
    // safe-sender label. A safe-sender-derived contact (tagged below) tracks
    // that label, so a rename ("Test" -> "Ted") updates display_name. For a
    // contact the user curated by hand, don't clobber the name -- record the
    // label as a searchable preferred_name alias instead.
    const lname = name.toLowerCase();
    const nameAlreadyKnown =
      !name ||
      match.displayName.toLowerCase() === lname ||
      (match.preferredName ?? '').toLowerCase() === lname;
    if (!nameAlreadyKnown) {
      if (match.tags.includes('safe-sender')) patch.displayName = name;
      else patch.preferredName = name;
    }
    if (Object.keys(patch).length === 0) return 'noop';
    updateContact(match.id, patch, agentId, 'append');
    return 'updated';
  }

  // New contact. Fall back to the address as the display name when the safe
  // sender carried none, so the record is at least matchable later.
  const createPatch: ContactInput = { displayName: name || address, tags: ['safe-sender'] };
  createPatch[field] = [address];
  createContact(createPatch, agentId);
  return 'created';
}

/**
 * Mirror a whole channel safe-sender list into contacts (the dashboard replaces
 * the entire list on each save, so we re-mirror the lot; idempotent). agentId is
 * the actor, or null for a dashboard/user-driven save.
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
