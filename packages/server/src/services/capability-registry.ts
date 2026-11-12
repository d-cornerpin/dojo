// Capability registry: the single source of truth for what an agent can reach right now (channels and integration
// connection status). The per-turn prompt block and the channel_inspect tool both read these facts and only own
// their rendering, so their descriptions cannot drift. The tool surface stays in agent/tools.ts.

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

// What a closed channel door may say next: the SMS fact lives here so the doors that offer it cannot drift,
// but the wording does not, since each door frames it for the caller it is refusing.

export interface SmsReachability {
  /** Enabled end to end AND at least one approved recipient, the only state in which `sms_send` delivers
   *  (twilio/sms-outbound.ts refuses enabled-with-nobody-approved). */
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
    // An unreadable config is "not available", never a promise the sender cannot keep.
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

/**
 * A channel the agent can RECEIVE on, and whether inbound is live right now. Published so an agent does not infer
 * incapability from the absence of a statement about a live channel. Deliberately not an `IntegrationStatus`:
 * that shape is token health (ledger, tool-name family) and a channel has none of it. `configured` gates
 * printing: a channel the owner never set up has no truth to publish.
 */
export interface ChannelStatus {
  name: 'imessage' | 'sms' | 'teams' | 'email';
  displayName: string;
  configured: boolean;
  /** Inbound arrives without the agent asking (a poller/webhook is live for it). */
  inboundLive: boolean;
}

/**
 * Every channel family in a fixed order (byte-deterministic), derived from `getChannelCapabilities()` so it
 * cannot drift from what the doors believe.
 */
export function listChannelStatuses(): ChannelStatus[] {
  const c = getChannelCapabilities();
  const inboundMailbox = c.mailboxes.some((m) => m.monitorInbound);
  return [
    { name: 'email', displayName: 'Email', configured: c.mailboxes.length > 0, inboundLive: inboundMailbox },
    { name: 'imessage', displayName: 'iMessage', configured: c.imessage.configured, inboundLive: c.imessage.configured },
    { name: 'sms', displayName: 'SMS', configured: c.twilio.configured && c.twilio.smsEnabled, inboundLive: c.twilio.enabled && c.twilio.smsEnabled },
    { name: 'teams', displayName: 'Teams', configured: c.teams.available, inboundLive: c.teams.available },
  ];
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
      // A past connection (recorded email/timestamp) is user intent: leave a reconnect breadcrumb when tokens lapse.
      configured: plaud.connected || plaud.email !== null || plaud.connectedAt !== null,
      connected: plaud.connected,
    });
  } catch { /* module unavailable */ }

  return statuses;
}
