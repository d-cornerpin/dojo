// ════════════════════════════════════════
// Capability registry — single source of truth for "what can this agent
// reach right now" across channels and integrations.
//
// Why this exists (remediation Invariant I, catalog rows 2/19): the per-turn
// prompt block and the channel_inspect tool used to DERIVE connection state
// independently (same slot loops, same caps assembly, written twice), so the
// two descriptions could drift apart. Every describe-path now reads the FACTS
// from here and only owns its rendering. Twilio already has a single fact
// getter (getTwilioConfig); it is passed through for one-door convenience.
//
// Scope (Phase 1): channels + integration connection status. The tool surface
// keeps its single source in agent/tools.ts (getAllToolDefinitions /
// getFilteredTools); model capabilities stay in shared types. Phase 3 folds
// model selection into this door.
// ════════════════════════════════════════

import {
  getGoogleWorkspaceConfig,
  isGoogleConnected,
  isGoogleEnabled,
  isEmailMonitoringEnabled,
  isEmailSendingEnabled,
} from '../google/auth.js';
import {
  getMicrosoftWorkspaceConfig,
  isMicrosoftConnected,
  isMicrosoftEnabled,
  isMsEmailMonitoringEnabled,
  isMsEmailSendingEnabled,
  getMsAccountType,
} from '../microsoft/auth.js';
import { isImessageConfigured } from './presence.js';
import { getTwilioConfig } from '../twilio/auth.js';
import { getPlaudStatus } from '../plaud/auth.js';
import { getTwilioSmsSafeSenders } from './channel-safe-senders.js';

export interface MailboxCapability {
  provider: 'gmail' | 'outlook';
  slot: 'agent' | 'user';
  /** Account address; null when the slot is connected but unlabeled. */
  address: string | null;
  monitorInbound: boolean;
  sendOutbound: boolean;
}

export interface ChannelCapabilities {
  /** Connected mailboxes only (disconnected slots are reported via listIntegrationStatuses). */
  mailboxes: MailboxCapability[];
  imessage: { configured: boolean };
  /** Teams needs a connected Entra-ID (work/school) Microsoft account. */
  teams: { available: boolean };
  twilio: {
    configured: boolean;
    enabled: boolean;
    smsEnabled: boolean;
    voiceEnabled: boolean;
    numbers: Array<{ number: string; label: string | null; isDefault: boolean }>;
  };
}

export interface IntegrationStatus {
  name: 'google' | 'microsoft' | 'plaud';
  /** Set up in config (user intent exists), regardless of token health. */
  configured: boolean;
  /** Live connection right now; false means tools of this family are filtered out. */
  connected: boolean;
}

export function getChannelCapabilities(): ChannelCapabilities {
  const mailboxes: MailboxCapability[] = [];

  for (const slot of ['agent', 'user'] as const) {
    try {
      if (!isGoogleConnected(slot)) continue;
      mailboxes.push({
        provider: 'gmail',
        slot,
        address: getGoogleWorkspaceConfig(slot).accountEmail ?? null,
        monitorInbound: isEmailMonitoringEnabled(slot),
        sendOutbound: isEmailSendingEnabled(slot),
      });
    } catch { /* slot not configured */ }
  }

  for (const slot of ['agent', 'user'] as const) {
    try {
      if (!isMicrosoftConnected(slot)) continue;
      mailboxes.push({
        provider: 'outlook',
        slot,
        address: getMicrosoftWorkspaceConfig(slot).accountEmail ?? null,
        monitorInbound: isMsEmailMonitoringEnabled(slot),
        sendOutbound: isMsEmailSendingEnabled(slot),
      });
    } catch { /* slot not configured */ }
  }

  let imessageConfigured = false;
  try { imessageConfigured = isImessageConfigured(); } catch { /* bridge module unavailable */ }

  let teamsAvailable = false;
  try {
    teamsAvailable = isMicrosoftConnected('agent') && getMsAccountType() === 'entra';
  } catch { /* account type unknown */ }

  let twilio: ChannelCapabilities['twilio'] = {
    configured: false, enabled: false, smsEnabled: false, voiceEnabled: false, numbers: [],
  };
  try {
    const cfg = getTwilioConfig();
    twilio = {
      configured: cfg.configured,
      enabled: cfg.enabled,
      smsEnabled: cfg.smsEnabled,
      voiceEnabled: cfg.voiceEnabled,
      numbers: cfg.numbers.map((n) => ({ number: n.number, label: n.label ?? null, isDefault: n.isDefault ?? false })),
    };
  } catch { /* twilio not configured */ }

  return { mailboxes, imessage: { configured: imessageConfigured }, teams: { available: teamsAvailable }, twilio };
}

// ── UX-REPAIR ROUND 7 T29 — WHAT A CLOSED CHANNEL DOOR IS ALLOWED TO SAY NEXT ──
//
// Round-7 S3: the user asked for a text and no text was sent on any channel. Both agents
// reached for the DISABLED iMessage bridge, and the engine's own door text then sent them the
// wrong way — "respond to them in the dashboard chat instead" — while `twilio_config` on that
// same box had `enabled=1, sms_enabled=1` and David's number on the approved list. The door
// was not wrong about iMessage; it was wrong about the alternative, and it was wrong because
// it never asked.
//
// The fact lives HERE, with the rest of "what can this agent reach right now", so the two
// doors that offer it cannot drift into two different answers. THE WORDING does not live here:
// each door frames it for the caller it is refusing (one can act on it; the other must
// escalate), and a shared sentence would have to be vague enough to fit both.

export interface SmsReachability {
  /** Enabled end to end AND at least one approved recipient — the only state in which
   *  `sms_send` would actually deliver. Enabled-with-nobody-approved is not an alternative:
   *  `twilio/sms-outbound.ts` refuses it, so offering it would be the same lie one door over. */
  live: boolean;
  /** Approved recipients, rendered "Name (+1555…)" where a name exists. */
  approved: string[];
}

/** Read at the moment of refusal, never asserted statically. */
export function getSmsReachability(): SmsReachability {
  try {
    const cfg = getTwilioConfig();
    if (!cfg.configured || !cfg.enabled || !cfg.smsEnabled) return { live: false, approved: [] };
    const approved = getTwilioSmsSafeSenders()
      .map((s) => (s.name ? `${s.name} (${s.address})` : s.address));
    return { live: approved.length > 0, approved };
  } catch {
    // Same posture as every other block in this file: an unreadable config is "not
    // available", never a promise the sender cannot keep.
    return { live: false, approved: [] };
  }
}

/** The recipients clause, bounded so a long allowlist cannot run away with a door's text. */
export function describeSmsRecipients(r: SmsReachability, limit = 3): string {
  if (r.approved.length === 0) return '';
  const shown = r.approved.slice(0, limit).join(', ');
  const rest = r.approved.length - Math.min(limit, r.approved.length);
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

export function listIntegrationStatuses(): IntegrationStatus[] {
  const statuses: IntegrationStatus[] = [];

  try {
    statuses.push({
      name: 'google',
      configured: isGoogleEnabled('agent') || isGoogleEnabled('user'),
      connected: isGoogleConnected('agent') || isGoogleConnected('user'),
    });
  } catch { /* module unavailable */ }

  try {
    statuses.push({
      name: 'microsoft',
      configured: isMicrosoftEnabled('agent') || isMicrosoftEnabled('user'),
      connected: isMicrosoftConnected('agent') || isMicrosoftConnected('user'),
    });
  } catch { /* module unavailable */ }

  try {
    const plaud = getPlaudStatus();
    statuses.push({
      name: 'plaud',
      // A past connection (recorded email/timestamp) is user intent: the
      // family should leave a reconnect breadcrumb when tokens lapse.
      configured: plaud.connected || plaud.email !== null || plaud.connectedAt !== null,
      connected: plaud.connected,
    });
  } catch { /* module unavailable */ }

  return statuses;
}
