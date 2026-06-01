// ════════════════════════════════════════
// Per-channel safe-sender allowlists (v2.7.24)
//
// Each external channel (iMessage, Gmail, Outlook, Teams) has its own
// allowlist of senders the agent is authorized to AUTO-reply to. Adding
// someone to the iMessage list does NOT grant the agent permission to
// auto-reply to that same person's emails or Teams DMs — those are
// separate trust contexts maintained per channel.
//
// iMessage is the original allowlist (lives in services/imessage-bridge.ts
// under the `imessage_approved_senders` config key + bridge cache). The
// other three live here as thin wrappers around config-key-backed JSON.
//
// All four lists share the SafeSender shape + parseSafeSenders parser +
// addressesMatch helper from imessage-bridge.ts.
//
// Empty list ⇒ no one is on the allowlist ⇒ the engine will not auto-
// route inbound replies on that channel. The notification still arrives;
// the agent decides whether to surface it to the user. The agent can
// still send proactively or in-thread via the explicit tool call (subject
// to per-tool safety guards).
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { parseSafeSenders, type SafeSender } from './imessage-bridge.js';

export type AccountSlot = 'agent' | 'user';

// v2.7.24 — gmail and outlook are per-slot (agent vs user mailbox), so each
// slot has its own safe-sender list. Adding Sarah to the agent slot's gmail
// list does NOT authorize the agent to auto-reply to Sarah's emails arriving
// at the user slot's gmail. This matches the per-slot "Allow sending email"
// toggle in the UI and the underlying isEmailSendingEnabled(slot) check.
// Teams runs on a single Microsoft account (no slot fan-out today), so its
// list stays single-keyed.

function gmailConfigKey(slot: AccountSlot): string {
  return `gmail_approved_senders_${slot}`;
}
function outlookConfigKey(slot: AccountSlot): string {
  return `outlook_approved_senders_${slot}`;
}
const TEAMS_CONFIG_KEY = 'teams_approved_senders';

function readByKey(key: string): SafeSender[] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

export function getGmailSafeSenders(slot: AccountSlot): SafeSender[] {
  return readByKey(gmailConfigKey(slot));
}

export function getOutlookSafeSenders(slot: AccountSlot): SafeSender[] {
  return readByKey(outlookConfigKey(slot));
}

export function getTeamsSafeSenders(): SafeSender[] {
  return readByKey(TEAMS_CONFIG_KEY);
}

// v2.7.24 — append a sender to a channel's safe-sender list and persist.
// Used by the agent's add_safe_sender tool when the user asks the agent to
// start a conversation with someone on that channel. Dedup by address
// (case-insensitive); returns whether the addition was a new entry.
export interface AppendChannelSenderResult {
  ok: true;
  added: boolean;
  totalSenders: number;
}

function appendToKey(key: string, sender: SafeSender): AppendChannelSenderResult {
  const list = readByKey(key);
  const target = sender.address.toLowerCase();
  if (list.some((s) => s.address.toLowerCase() === target)) {
    return { ok: true, added: false, totalSenders: list.length };
  }
  const next = [...list, sender];
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(next));
  return { ok: true, added: true, totalSenders: next.length };
}

export function appendGmailSafeSender(slot: AccountSlot, sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(gmailConfigKey(slot), sender);
}
export function appendOutlookSafeSender(slot: AccountSlot, sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(outlookConfigKey(slot), sender);
}
export function appendTeamsSafeSender(sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(TEAMS_CONFIG_KEY, sender);
}
