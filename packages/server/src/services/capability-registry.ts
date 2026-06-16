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
