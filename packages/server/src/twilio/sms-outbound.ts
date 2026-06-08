// ════════════════════════════════════════
// Twilio SMS outbound handler (v2.9.18)
// Handler for the agent-facing `sms_send` tool. Mirrors the
// imessage_send tool's recipient-resolution + allowlist guards.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { sendSms } from './client.js';
import {
  getDefaultFromNumber,
  getNumber,
  isSmsEnabled,
} from './auth.js';
import { getTwilioSmsSafeSenders } from '../services/channel-safe-senders.js';
import { addressesMatch } from '../services/imessage-bridge.js';

const logger = createLogger('twilio-sms-outbound');

export interface SmsSendInput {
  to: string;
  body: string;
  from?: string;
}

export interface SmsSendResult {
  ok: boolean;
  message: string;
  sid?: string;
}

export async function executeSmsSend(input: SmsSendInput, agentId: string): Promise<SmsSendResult> {
  if (!isSmsEnabled()) {
    return { ok: false, message: 'SMS NOT sent - Twilio SMS is not enabled. The owner needs to configure and enable Twilio in Settings → Channels.' };
  }
  const to = (input.to ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!to) return { ok: false, message: 'SMS NOT sent - recipient (to) is required.' };
  if (!body) return { ok: false, message: 'SMS NOT sent - body is required.' };
  if (body.length > 1600) {
    return { ok: false, message: 'SMS NOT sent - body exceeds 1600 characters (carrier limit). Split into multiple sends.' };
  }

  // Recipient allowlist: same shape as imessage_send. Sending to a
  // number outside the safe-sender list is refused unless the
  // recipient is on the allowlist (avoids the agent spamming
  // arbitrary numbers if jailbroken or fooled).
  const safeSenders = getTwilioSmsSafeSenders();
  const recipientIsKnown = safeSenders.some(s => addressesMatch(s.address, to));
  if (!recipientIsKnown) {
    const valid = safeSenders.length === 0
      ? '(none configured yet)'
      : safeSenders.map(s => `${s.name} <${s.address}>`).join(', ');
    return {
      ok: false,
      message: (
        `SMS NOT sent - recipient "${to}" is not on the Twilio SMS safe-sender allowlist. ` +
        `Valid recipients: ${valid}. ` +
        `If you need to text someone new, the owner has to add them in Settings → Channels → Twilio first.`
      ),
    };
  }

  // Resolve from-number. Explicit `from` arg wins, then per-number
  // SMS-enabled flag, then default. Verifies the from-number is one
  // the user actually owns.
  const explicitFrom = (input.from ?? '').trim();
  let from = explicitFrom || getDefaultFromNumber();
  if (!from) {
    return { ok: false, message: 'SMS NOT sent - no Twilio number configured to send from. The owner needs to add a number in Settings → Channels → Twilio.' };
  }
  const ownership = getNumber(from);
  if (!ownership) {
    return { ok: false, message: `SMS NOT sent - "${from}" is not a Twilio number the owner has configured. Use one of the configured numbers, or omit \`from\` to use the default.` };
  }
  if (!ownership.smsEnabled) {
    return { ok: false, message: `SMS NOT sent - SMS is disabled on ${from}. The owner can re-enable it in Settings → Channels → Twilio.` };
  }

  const result = await sendSms(to, body, from);
  if (!result.ok) {
    logger.warn('SMS send failed', { agentId, to, from, error: result.error });
    return { ok: false, message: `SMS NOT sent - Twilio rejected the send: ${result.error}` };
  }
  return {
    ok: true,
    sid: result.data.sid,
    message: `SMS sent (sid=${result.data.sid}) to ${to} from ${from}.`,
  };
}
