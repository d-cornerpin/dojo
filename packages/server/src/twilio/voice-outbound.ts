// Outbound call flow: voice_call places the call via Twilio REST. When the callee answers, Twilio
// POSTs /webhook/voice (Direction=outbound-api) and we answer with TwiML <Connect><Stream>, handing the
// call to the voice-stream WebSocket, which attaches to the placeholder session created here on `start`.
// An opening_message, if given, is queued on that session and spoken first.

import { createLogger } from '../logger.js';
import { placeCall } from './client.js';
import { openAgentCall } from '../agent/abortable-call.js';
import {
  getDefaultFromNumber,
  getNumber,
  isVoiceEnabled,
} from './auth.js';
import { CallSession, getCallSession, registerCallSession, listActiveCallSessions } from './call-session.js';
import { getTunnelStatus } from '../services/tunnel.js';
import { getTwilioVoiceSafeCallers } from '../services/channel-safe-senders.js';
import { resolveRecipient } from './approved-number.js';
import { recipientKind } from '../services/safe-senders.js';

const logger = createLogger('twilio-voice-outbound');

export interface VoiceCallInput {
  to: string;
  opening_message?: string;
  purpose?: string;
  from?: string;
  /** The agent placing it, so the owner's Stop can abort it on its way to Twilio. */
  agentId?: string;
}

export interface VoiceCallResult {
  ok: boolean;
  message: string;
  callSid?: string;
}

export async function executeVoiceCall(input: VoiceCallInput): Promise<VoiceCallResult> {
  if (!isVoiceEnabled()) {
    return { ok: false, message: 'Voice NOT placed - Twilio Voice is not enabled. The owner needs to configure and enable Twilio in Settings → Channels → Twilio.' };
  }
  let to = (input.to ?? '').trim();
  if (!to) return { ok: false, message: 'Voice NOT placed - to (recipient number) is required.' };

  // Only a number the owner approved may be rung, matched exactly; the SAVED number is the one dialled.
  const callers = getTwilioVoiceSafeCallers();
  const approved = resolveRecipient(callers, to);
  if (!approved) {
    const valid = callers.length === 0 ? '(none configured yet)' : callers.map(s => `${s.name} <${s.address}>`).join(', ');
    return {
      ok: false,
      message: (
        `Voice NOT placed - recipient "${to}" is not on the Twilio Voice safe-caller allowlist. ` +
        `Valid recipients: ${valid}. ` +
        `If you need to call someone new, the owner has to add them in Settings → Channels → Twilio first.`
      ),
    };
  }
  to = approved.address;

  const tunnel = getTunnelStatus();
  if (tunnel.status !== 'active' || !tunnel.url) {
    return { ok: false, message: 'Voice NOT placed - the Cloudflare tunnel is not active. Voice calls require a public webhook URL for Twilio to hand the call to the dojo. Start the tunnel in Settings → Dojo → Remote Access first.' };
  }
  const base = tunnel.url.replace(/\/+$/, '');
  const voiceWebhook = `${base}/api/twilio/webhook/voice`;
  const statusWebhook = `${base}/api/twilio/webhook/voice-status`;

  const explicitFrom = (input.from ?? '').trim();
  const from = explicitFrom || getDefaultFromNumber();
  if (!from) {
    return { ok: false, message: 'Voice NOT placed - no Twilio number configured. The owner needs to add a number in Settings → Channels → Twilio.' };
  }
  const ownership = getNumber(from);
  if (!ownership) {
    return { ok: false, message: `Voice NOT placed - "${from}" is not a Twilio number the owner has configured.` };
  }
  if (!ownership.voiceEnabled) {
    return { ok: false, message: `Voice NOT placed - Voice is disabled on ${from}.` };
  }

  const slot = input.agentId === undefined ? null : openAgentCall(input.agentId, 'turn');
  const res = await placeCall(to, from, voiceWebhook, statusWebhook, slot?.signal).finally(() => slot?.release());
  if (!res.ok) {
    logger.warn('Outbound voice call failed', { to: recipientKind(to), from, error: res.error });
    return { ok: false, message: `Voice NOT placed - Twilio rejected the call: ${res.error}` };
  }

  // Placeholder session so the answering WS attaches without dropping events (`send` is rebound then).
  const placeholderSend = (_m: string) => {
    /* no-op until WS attaches */
    void _m;
  };
  const session = new CallSession({
    callSid: res.data.sid,
    streamSid: 'pending',
    direction: 'outbound',
    fromNumber: from,
    toNumber: to,
    send: placeholderSend,
    purpose: input.purpose?.trim() || undefined,
  });
  registerCallSession(session);

  // Queue the opening message only when provided: by default the agent stays silent on outbound until
  // the callee says hello (phone-mode rules, voice_call tool description).
  if (input.opening_message?.trim()) {
    void session.queueAgentSay(input.opening_message.trim()).catch(() => { /* swallow */ });
  }

  logger.info('Outbound voice call placed', { callSid: res.data.sid, to: recipientKind(to), from });
  return { ok: true, callSid: res.data.sid, message: `Voice call placed to ${to} (sid=${res.data.sid}). Connecting…` };
}

export function executeVoiceCallEnd(input: { call_id?: string; reason?: string }): { ok: boolean; message: string } {
  const callSid = (input.call_id ?? '').trim();
  if (!callSid) return { ok: false, message: 'Error: call_id is required.' };
  const session = getCallSession(callSid);
  if (!session) return { ok: false, message: `Error: no active call with sid="${callSid}".` };
  // Soft hangup: defer the disconnect by 6 s so the caller's goodbye lands first; the caller speaking
  // again cancels it. Never hard-cut after the agent's last word.
  session.requestSoftHangup(input.reason ?? 'agent_ended');
  // Tell Twilio to hang up after the same window, so its leg stays open during the closing ritual.
  setTimeout(() => {
    void (async () => {
      try {
        const { endCall } = await import('./client.js');
        // A cancelled soft hangup (caller spoke) leaves the Twilio leg up too.
        const cur = getCallSession(callSid);
        if (cur && !cur.hasPendingHangup() && !cur.isEnded()) return;
        await endCall(callSid);
      } catch { /* best effort */ }
    })();
  }, 6000);
  return { ok: true, message: `Call ${callSid} closing — waiting ~6 s for caller goodbye before disconnecting.` };
}

export function executeVoiceCallStatus(input: { call_id?: string }): { ok: boolean; message: string } {
  if (input.call_id?.trim()) {
    const session = getCallSession(input.call_id.trim());
    if (!session) return { ok: true, message: `No active call with sid="${input.call_id}".` };
    return { ok: true, message: `Call ${input.call_id} is ${session.isEnded() ? 'ended' : 'active'} (${session.direction}, from ${session.fromNumber} to ${session.toNumber}).` };
  }
  // No call_id: list all active sessions.
  const active = listActiveCallSessions();
  if (active.length === 0) return { ok: true, message: 'No active calls.' };
  const lines = active.map(a => `- ${a.callSid} (${a.direction}, ${a.fromNumber} → ${a.toNumber})`);
  return { ok: true, message: `Active calls (${active.length}):\n${lines.join('\n')}` };
}
