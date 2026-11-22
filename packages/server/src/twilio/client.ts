// Twilio REST client + webhook signature verification: a thin wrapper over fetch and node:crypto instead
// of the official SDK (axios-based, large), since we only send SMS, place calls and verify signatures.

import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { getTwilioCreds } from './auth.js';
import { formatForPlainTextChannel } from '../services/plain-text-format.js';
import { recordAtDoor, recordedId } from '../agent/v2/outbound.js';
import { recipientKind } from '../services/safe-senders.js';

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

async function twilioPost<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
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
      signal, // the caller's slot under the owner's Stop (`sms-outbound.ts`, `voice-outbound.ts`)
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

/**
 * Twilio refuses a Body over 1600 characters (error 21617), so a long answer goes out as several texts.
 * Cut at the last blank line, newline, sentence end or space before the cap (a hard cut only when none
 * exists); a hard cut backs off one unit rather than split a surrogate pair. Parts are trimmed and every
 * non-space character of the input survives, in order.
 */
export function splitForSms(text: string, maxLen = 1500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const head = rest.slice(0, maxLen);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
      const idx = head.lastIndexOf(sep);
      if (idx !== -1) { cut = idx + sep.length; break; }
    }
    if (cut <= 0) cut = maxLen;
    // Back off one unit if the hard cut would fall between the halves of an emoji.
    const prev = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) cut -= 1;
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail) parts.push(tail);
  return parts;
}

export async function sendSms(
  to: string,
  body: string,
  from: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: TwilioSmsResponse } | { ok: false; error: string; status?: number }> {
  if (!to.trim() || !body.trim() || !from.trim()) {
    return { ok: false, error: 'to, body, and from are all required.' };
  }
  // SMS cannot render markdown: strip it at the single SMS chokepoint so every send path goes out clean.
  const cleaned = formatForPlainTextChannel(body);
  // Up to 1600 characters goes out as one POST; only a longer body is split.
  const parts = cleaned.length > 1600 ? splitForSms(cleaned) : [cleaned];
  // Several parts go one at a time, awaiting each, so the person reads them in order.
  // Stop at the first refusal and say how far the message got.
  let first: TwilioSmsResponse | undefined;
  let failed: string | null = null;
  let failedStatus = 0;
  let failedIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const res = await twilioPost<TwilioSmsResponse>('/Messages.json', {
      To: to,
      From: from,
      Body: parts[i],
    }, signal);
    if (!res.ok) {
      failed = res.error;
      failedStatus = res.status;
      failedIndex = i;
      break;
    }
    if (!first) first = res.data;
  }
  // A single-part send keeps its error verbatim; a multi-part one names the failing part, so a
  // mid-list failure never silently loses part of the answer.
  const error = failed === null
    ? null
    : (parts.length > 1 ? `part ${failedIndex + 1} of ${parts.length} failed: ${failed}` : failed);
  // The door records every send, a FAILED one included; one row per sendSms call even when the
  // message went out in parts (it is one answer to one person).
  recordedId(recordAtDoor({
    outcome: error === null ? 'delivered' : 'failed',
    channel: 'sms',
    tool: 'sms-door',
    recipientId: to,
    detail: error !== null ? error : (parts.length > 1 ? `${parts.length} parts` : null),
  }), 'twilio: SMS door crossing', { to: recipientKind(to) });
  if (error !== null) {
    logger.warn('Twilio SMS send failed', { to: recipientKind(to), from, error, status: failedStatus });
    return { ok: false, error, status: failedStatus };
  }
  // Every part went, so the first part has data.
  logger.info('Twilio SMS sent', { sid: first?.sid, to: recipientKind(to), from, parts: parts.length });
  return { ok: true, data: first ?? ({} as TwilioSmsResponse) };
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
 * Place an outbound call. Twilio connects it to the TwiML URL, which typically returns a Stream verb
 * pointing at our Media Streams WebSocket so the agent can talk.
 */
export async function placeCall(
  to: string,
  from: string,
  twimlUrl: string,
  statusCallbackUrl?: string,
  signal?: AbortSignal,
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
  const res = await twilioPost<TwilioCallResponse>('/Calls.json', params, signal);
  // Placing a call reaches a person, so the door records it.
  recordedId(recordAtDoor({
    outcome: res.ok ? 'delivered' : 'failed',
    channel: 'phone',
    tool: 'phone-door',
    recipientId: to,
    detail: res.ok ? 'call placed' : res.error,
  }), 'twilio: phone door crossing', { to: recipientKind(to) });
  if (!res.ok) {
    logger.warn('Twilio call failed to place', { to: recipientKind(to), from, error: res.error, status: res.status });
    return { ok: false, error: res.error };
  }
  logger.info('Twilio call placed', { sid: res.data.sid, to: recipientKind(to), from });
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
// Twilio signs every inbound webhook: base64 HMAC-SHA1(authToken, full URL followed by the POST params
// sorted by key and concatenated as keyN+valueN), sent in X-Twilio-Signature. We MUST verify every inbound
// webhook (SMS, voice, status callbacks), or anyone who knows the public tunnel URL can forge inbound
// messages and trigger the agent.

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
