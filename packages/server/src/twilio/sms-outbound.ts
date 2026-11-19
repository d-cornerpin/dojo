// Handler for the agent-facing `sms_send` tool; mirrors imessage_send's recipient resolution and allowlist guards.

import { createLogger } from '../logger.js';
import { sendSms } from './client.js';
import {
  getDefaultFromNumber,
  getNumber,
  isSmsEnabled,
} from './auth.js';
import { getTwilioSmsSafeSenders } from '../services/channel-safe-senders.js';
import { resolveRecipient } from './approved-number.js';
import { recipientKind } from '../services/safe-senders.js';
import { openAgentCall } from '../agent/abortable-call.js';

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
  let to = (input.to ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!to) return { ok: false, message: 'SMS NOT sent - recipient (to) is required.' };
  if (!body) return { ok: false, message: 'SMS NOT sent - body is required.' };
  if (body.length > 1600) {
    return { ok: false, message: 'SMS NOT sent - body exceeds 1600 characters (carrier limit). Split into multiple sends.' };
  }

  // Recipient allowlist, same shape as imessage_send: a number outside the safe-sender list is refused,
  // so a fooled or jailbroken agent cannot spam arbitrary numbers.
  const safeSenders = getTwilioSmsSafeSenders();
  const approved = resolveRecipient(safeSenders, to);
  if (!approved) {
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

  // Text the SAVED number, never the text the agent typed.
  to = approved.address;

  // From-number: an explicit `from` wins, else the default; it must be a number the owner configured
  // with SMS enabled.
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

  // The owner's Stop aborts the text while it is still on its way to Twilio. Once Twilio has accepted
  // it, it cannot be called back; the result tells the owner which happened.
  const slot = openAgentCall(agentId, 'turn');
  const result = await sendSms(to, body, from, slot.signal).finally(() => slot.release());
  const stopped = slot.signal.aborted;
  if (!result.ok) {
    logger.warn('SMS send failed', { agentId, to: recipientKind(to), from, error: result.error });
    if (stopped) {
      return { ok: false, message: 'SMS NOT sent - the owner pressed Stop before it reached Twilio.' };
    }
    return { ok: false, message: `SMS NOT sent - the send failed: ${result.error}` };
  }
  return {
    ok: true,
    sid: result.data.sid,
    message: `SMS sent (sid=${result.data.sid}) to ${to} from ${from}.`,
  };
}
