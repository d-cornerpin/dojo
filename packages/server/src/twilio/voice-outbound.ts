// ════════════════════════════════════════
// Twilio Voice outbound (v2.9.18)
//
// Place an outbound call. The flow:
//
//   1. Agent calls voice_call(to, opening_message?)
//   2. Server places the call via Twilio REST. Twilio dials the
//      recipient.
//   3. When the recipient answers, Twilio POSTs to our
//      /webhook/voice endpoint with Direction=outbound-api - we
//      respond with TwiML that <Connect><Stream> hands the call to
//      our voice-stream WebSocket.
//   4. On WS open / `start` event, our handler recognizes the
//      CallSid as an outbound (placeholder session created in step
//      1) and attaches the send-back.
//   5. Agent's opening_message (if provided) gets spoken first by
//      enqueueing on the placeholder session.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { placeCall } from './client.js';
import {
  getDefaultFromNumber,
  getNumber,
  isVoiceEnabled,
} from './auth.js';
import { CallSession, getCallSession, registerCallSession, listActiveCallSessions } from './call-session.js';
import { getTunnelStatus } from '../services/tunnel.js';

const logger = createLogger('twilio-voice-outbound');

export interface VoiceCallInput {
  to: string;
  opening_message?: string;
  purpose?: string;
  from?: string;
}

export interface VoiceCallResult {
  ok: boolean;
  message: string;
  callSid?: string;
}

export async function executeVoiceCall(input: VoiceCallInput): Promise<VoiceCallResult> {
  if (!isVoiceEnabled()) {
    return { ok: false, message: 'Voice NOT placed - Twilio Voice is not enabled. The owner needs to configure and enable Twilio in Settings → Integrations.' };
  }
  const to = (input.to ?? '').trim();
  if (!to) return { ok: false, message: 'Voice NOT placed - to (recipient number) is required.' };

  const tunnel = getTunnelStatus();
  if (tunnel.status !== 'active' || !tunnel.url) {
    return { ok: false, message: 'Voice NOT placed - the Cloudflare tunnel is not active. Voice calls require a public webhook URL for Twilio to hand the call to the dojo. Start the tunnel in Settings → Dojo first.' };
  }
  const base = tunnel.url.replace(/\/+$/, '');
  const voiceWebhook = `${base}/api/twilio/webhook/voice`;
  const statusWebhook = `${base}/api/twilio/webhook/voice-status`;

  const explicitFrom = (input.from ?? '').trim();
  const from = explicitFrom || getDefaultFromNumber();
  if (!from) {
    return { ok: false, message: 'Voice NOT placed - no Twilio number configured. The owner needs to add a number in Settings → Integrations → Twilio.' };
  }
  const ownership = getNumber(from);
  if (!ownership) {
    return { ok: false, message: `Voice NOT placed - "${from}" is not a Twilio number the owner has configured.` };
  }
  if (!ownership.voiceEnabled) {
    return { ok: false, message: `Voice NOT placed - Voice is disabled on ${from}.` };
  }

  const res = await placeCall(to, from, voiceWebhook, statusWebhook);
  if (!res.ok) {
    logger.warn('Outbound voice call failed', { to, from, error: res.error });
    return { ok: false, message: `Voice NOT placed - Twilio rejected the call: ${res.error}` };
  }

  // Pre-register a placeholder CallSession so when the WS connects on
  // call-answer, we can attach the send-back without dropping any
  // events. The `send` field is updated when the WS arrives.
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

  // Queue the opening message ONLY if explicitly provided. The new
  // phone-mode rules (see voice_call tool description) say the
  // agent should leave silence on outbound until the callee says
  // hello, then respond. If opening_message is set anyway, the
  // agent has decided on purpose to queue audio at connect time.
  if (input.opening_message?.trim()) {
    void session.queueAgentSay(input.opening_message.trim()).catch(() => { /* swallow */ });
  }

  logger.info('Outbound voice call placed', { callSid: res.data.sid, to, from });
  return { ok: true, callSid: res.data.sid, message: `Voice call placed to ${to} (sid=${res.data.sid}). Connecting…` };
}

export function executeVoiceCallEnd(input: { call_id?: string; reason?: string }): { ok: boolean; message: string } {
  const callSid = (input.call_id ?? '').trim();
  if (!callSid) return { ok: false, message: 'Error: call_id is required.' };
  const session = getCallSession(callSid);
  if (!session) return { ok: false, message: `Error: no active call with sid="${callSid}".` };
  // v2.9.23 — soft hangup: defer the actual disconnect by 6 s so the
  // caller's goodbye can land first. If they speak again during the
  // window the timer cancels and the call continues. Per the dojo
  // phone-mode rules: never hard-cut after the agent's last word.
  session.requestSoftHangup(input.reason ?? 'agent_ended');
  // Also tell Twilio to hang up server-side AFTER the same window, so
  // their leg stays open during the closing ritual.
  setTimeout(() => {
    void (async () => {
      try {
        const { endCall } = await import('./client.js');
        // If the soft hangup was cancelled (caller spoke), don't tear
        // down the Twilio leg either.
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
  // No call_id → list all active sessions.
  const active = listActiveCallSessions();
  if (active.length === 0) return { ok: true, message: 'No active calls.' };
  const lines = active.map(a => `- ${a.callSid} (${a.direction}, ${a.fromNumber} → ${a.toNumber})`);
  return { ok: true, message: `Active calls (${active.length}):\n${lines.join('\n')}` };
}
