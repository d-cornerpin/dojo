// ════════════════════════════════════════
// Twilio REST client + webhook signature verification (v2.9.18)
// Thin wrapper over fetch + node:crypto. Avoids the official Twilio
// SDK (axios-based, large) since we only need three things: send
// SMS, place outbound call, verify webhook signatures.
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { getTwilioCreds } from './auth.js';

const logger = createLogger('twilio-client');

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

interface TwilioErrorBody {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}

function authHeader(sid: string, token: string): string {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

async function twilioPost<T>(path: string, params: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  const creds = getTwilioCreds();
  if (!creds) return { ok: false, error: 'Twilio is not configured.', status: 400 };
  const body = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${TWILIO_API_BASE}/Accounts/${creds.sid}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(creds.sid, creds.token),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: `Twilio network error: ${err instanceof Error ? err.message : String(err)}`, status: 0 };
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as TwilioErrorBody;
      if (parsed.message) msg = parsed.message;
    } catch { /* keep generic */ }
    return { ok: false, error: msg, status: res.status };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: `Twilio returned non-JSON: ${text.slice(0, 200)}`, status: res.status };
  }
}

// ── SMS ──

export interface TwilioSmsResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
  body: string;
  date_created: string;
}

export async function sendSms(
  to: string,
  body: string,
  from: string,
): Promise<{ ok: true; data: TwilioSmsResponse } | { ok: false; error: string }> {
  if (!to.trim() || !body.trim() || !from.trim()) {
    return { ok: false, error: 'to, body, and from are all required.' };
  }
  const res = await twilioPost<TwilioSmsResponse>('/Messages.json', {
    To: to,
    From: from,
    Body: body,
  });
  if (!res.ok) {
    logger.warn('Twilio SMS send failed', { to, from, error: res.error, status: res.status });
    return { ok: false, error: res.error };
  }
  logger.info('Twilio SMS sent', { sid: res.data.sid, to, from });
  return { ok: true, data: res.data };
}

// ── Voice ──

export interface TwilioCallResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
  date_created: string;
}

/**
 * Place an outbound call. The call connects to Twilio's TwiML URL,
 * which returns instructions (typically a Stream verb pointing at
 * our Media Streams WebSocket so the agent can talk).
 */
export async function placeCall(
  to: string,
  from: string,
  twimlUrl: string,
  statusCallbackUrl?: string,
): Promise<{ ok: true; data: TwilioCallResponse } | { ok: false; error: string }> {
  if (!to.trim() || !from.trim() || !twimlUrl.trim()) {
    return { ok: false, error: 'to, from, and twimlUrl are all required.' };
  }
  const params: Record<string, string> = {
    To: to,
    From: from,
    Url: twimlUrl,
  };
  if (statusCallbackUrl) {
    params.StatusCallback = statusCallbackUrl;
    params.StatusCallbackMethod = 'POST';
    params.StatusCallbackEvent = 'initiated ringing answered completed';
  }
  const res = await twilioPost<TwilioCallResponse>('/Calls.json', params);
  if (!res.ok) {
    logger.warn('Twilio call failed to place', { to, from, error: res.error, status: res.status });
    return { ok: false, error: res.error };
  }
  logger.info('Twilio call placed', { sid: res.data.sid, to, from });
  return { ok: true, data: res.data };
}

/** Hang up an in-progress call. */
export async function endCall(callSid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!callSid) return { ok: false, error: 'callSid is required.' };
  const res = await twilioPost<unknown>(`/Calls/${callSid}.json`, { Status: 'completed' });
  if (!res.ok) {
    logger.warn('Twilio call end failed', { callSid, error: res.error });
    return { ok: false, error: res.error };
  }
  return { ok: true };
}

// ── Account ping (used by the dashboard "Test connection" button) ──

export async function testTwilioCredentials(
  accountSid: string,
  authToken: string,
): Promise<{ ok: true; friendlyName: string | null } | { ok: false; error: string }> {
  // Twilio's /Accounts/{sid}.json is a cheap auth check.
  let res: Response;
  try {
    res = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}.json`, {
      headers: {
        'Authorization': authHeader(accountSid, authToken),
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 401) return { ok: false, error: 'Invalid Account SID or Auth Token.' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  try {
    const data = await res.json() as { friendly_name?: string };
    return { ok: true, friendlyName: data.friendly_name ?? null };
  } catch {
    return { ok: false, error: 'Twilio returned non-JSON.' };
  }
}

// ── Webhook signature verification ──
//
// Twilio signs every inbound webhook with HMAC-SHA1(authToken, S)
// where S is the full URL the request was made to, followed by the
// POST params sorted alphabetically by key and concatenated as
// keyN+valueN. The signature is sent in X-Twilio-Signature, base64-
// encoded.
//
// We MUST verify this on every inbound webhook (SMS, voice, status
// callbacks). Without verification, anyone who knows our public
// tunnel URL can forge inbound messages and trigger the agent.

export function verifyTwilioSignature(args: {
  signature: string;
  url: string;
  params: Record<string, string | string[]>;
  authToken: string;
}): boolean {
  if (!args.signature || !args.authToken) return false;
  // Twilio sorts params by key and concatenates as key+value.
  const sortedKeys = Object.keys(args.params).sort();
  let data = args.url;
  for (const key of sortedKeys) {
    const raw = args.params[key];
    // URLSearchParams can yield repeated keys; Twilio's algorithm
    // expects them sorted with their values in arrival order.
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      data += key + v;
    }
  }
  const expected = crypto.createHmac('sha1', args.authToken).update(data).digest('base64');
  // Constant-time comparison to avoid timing side-channels.
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
