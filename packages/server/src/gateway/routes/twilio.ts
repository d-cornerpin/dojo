// ════════════════════════════════════════
// Twilio routes (v2.9.18)
//
// Two slices in one file:
//
//   /api/twilio/webhook/* — public, called by Twilio's servers,
//     authenticated via the X-Twilio-Signature header (HMAC-SHA1
//     of the canonical URL + sorted POST params).
//
//   /api/twilio/* (everything else) — JWT-protected by the gateway's
//     auth middleware. The dashboard's Channels → Twilio card uses
//     these for connect / disconnect / settings / number CRUD /
//     safe-sender CRUD.
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  getTwilioConfig,
  getTwilioCreds,
  setTwilioCredentials,
  clearTwilioCredentials,
  updateTwilioSettings,
  upsertTwilioNumber,
  removeTwilioNumber,
  type TwilioSettingsPatch,
} from '../../twilio/auth.js';
import { testTwilioCredentials, verifyTwilioSignature } from '../../twilio/client.js';
import { ingestInboundSms } from '../../twilio/sms-inbound.js';
import {
  getTwilioSmsSafeSenders,
  appendTwilioSmsSafeSender,
  getTwilioVoiceSafeCallers,
  appendTwilioVoiceSafeCaller,
} from '../../services/channel-safe-senders.js';
import { getDb } from '../../db/connection.js';
import { getTunnelStatus } from '../../services/tunnel.js';

const logger = createLogger('twilio-routes');

export const twilioRouter = new Hono<AppEnv>();

// ── Webhook URL helper (used by the dashboard) ──────────────────────

function getWebhookBase(): { ok: true; base: string } | { ok: false; reason: string } {
  const tunnel = getTunnelStatus();
  if (tunnel.status === 'active' && tunnel.url) {
    return { ok: true, base: tunnel.url.replace(/\/+$/, '') };
  }
  return { ok: false, reason: 'No active Cloudflare tunnel. Start the tunnel in Settings → Dojo → Tunnel before configuring Twilio webhooks.' };
}

// ── Signature verification middleware for webhook subroutes ─────────

async function verifySignatureOr401(c: import('hono').Context, params: Record<string, string>): Promise<Response | null> {
  const creds = getTwilioCreds();
  if (!creds) {
    return c.json({ ok: false, error: 'Twilio not configured.' }, 401);
  }
  const signature = c.req.header('X-Twilio-Signature') ?? '';
  // Twilio signs the EXACT URL it dialed, including scheme + host +
  // path + query string. Reconstruct from the headers behind the
  // tunnel — x-forwarded-proto and x-forwarded-host are what the
  // user-visible URL was. Read x-forwarded-host before host because
  // any reverse proxy in the chain (Vite's dev proxy with
  // changeOrigin=true, certain cloudflared configurations, etc.) may
  // rewrite Host to an internal hostname while preserving the
  // original in x-forwarded-host. Production (Cloudflare in front
  // of the platform directly) sets x-forwarded-host too, so this
  // path is correct in both modes.
  const proto = c.req.header('x-forwarded-proto') ?? 'https';
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
  const fullUrl = `${proto}://${host}${c.req.path}`;
  const valid = verifyTwilioSignature({
    signature,
    url: fullUrl,
    params,
    authToken: creds.token,
  });
  if (!valid) {
    logger.warn('Twilio webhook signature invalid', { path: c.req.path, fullUrl, hasSignature: Boolean(signature) });
    return c.json({ ok: false, error: 'Invalid signature.' }, 401);
  }
  return null;
}

// ── Public: SMS inbound webhook ────────────────────────────────────

twilioRouter.post('/webhook/sms', async (c) => {
  const formText = await c.req.text();
  const formParams = Object.fromEntries(new URLSearchParams(formText)) as Record<string, string>;
  const denied = await verifySignatureOr401(c, formParams);
  if (denied) return denied;

  const messageSid = formParams.MessageSid ?? formParams.SmsMessageSid ?? '';
  const from = formParams.From ?? '';
  const to = formParams.To ?? '';
  const body = formParams.Body ?? '';
  const numMedia = Number(formParams.NumMedia ?? '0') || 0;
  const mediaUrls: string[] = [];
  const mediaContentTypes: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const u = formParams[`MediaUrl${i}`];
    if (u) {
      mediaUrls.push(u);
      // Twilio declares the media MIME alongside each URL; carried through
      // so the MMS ingest (D15) can name files / pick categories without
      // trusting only the download response header.
      mediaContentTypes.push(formParams[`MediaContentType${i}`] ?? '');
    }
  }

  if (!messageSid || !from || !to) {
    return c.text('<Response/>', 400, { 'Content-Type': 'application/xml' });
  }

  try {
    await ingestInboundSms({ messageSid, fromNumber: from, toNumber: to, body, numMedia, mediaUrls, mediaContentTypes });
  } catch (err) {
    logger.error('Inbound SMS ingestion failed', {
      messageSid, from, to, error: err instanceof Error ? err.message : String(err),
    });
  }
  // Empty TwiML response - Twilio expects 200 with valid TwiML; we
  // ack without sending an immediate auto-reply. The agent's reply
  // (if any) goes via the outbound sendSms path.
  return c.text('<Response/>', 200, { 'Content-Type': 'application/xml' });
});

// ── Public: Voice inbound webhook (TwiML) ──────────────────────────
// Stubbed for now - the voice handler in step 4 will return TwiML
// that connects the call to our Media Streams WebSocket. For now
// the route exists so the auth middleware can route it correctly
// and unknown inbound calls land in the voicemail fallback once
// the voice infra is wired.

twilioRouter.post('/webhook/voice', async (c) => {
  const formText = await c.req.text();
  const formParams = Object.fromEntries(new URLSearchParams(formText)) as Record<string, string>;
  const denied = await verifySignatureOr401(c, formParams);
  if (denied) return denied;

  const { twimlConnectStream, twimlVoicemail, twimlReject } = await import('../../twilio/twiml.js');
  const { callerIsAllowlisted } = await import('../../twilio/call-session.js');
  const { isVoiceEnabled, getTwilioConfig } = await import('../../twilio/auth.js');

  if (!isVoiceEnabled()) {
    return c.text(twimlReject('busy'), 200, { 'Content-Type': 'application/xml' });
  }
  const cfg = getTwilioConfig();
  const from = formParams.From ?? '';
  const to = formParams.To ?? '';
  const direction = formParams.Direction ?? 'inbound';

  // Outbound calls (placed via /Calls.json by the agent) ALSO POST
  // here to fetch initial TwiML. Recognize via the Direction
  // parameter Twilio supplies. For those we always connect to the
  // Media Streams handler - the agent already authorized the call
  // by placing it.
  const webhook = getWebhookBase();
  if (!webhook.ok) {
    return c.text(twimlReject('busy'), 200, { 'Content-Type': 'application/xml' });
  }
  // WebSocket URL: same tunnel host, ws:// or wss:// scheme.
  const wsBase = webhook.base.replace(/^http/, 'ws');
  const streamUrl = `${wsBase}/api/twilio/voice-stream`;

  if (direction.startsWith('outbound')) {
    return c.text(twimlConnectStream(streamUrl, { from, to }), 200, { 'Content-Type': 'application/xml' });
  }

  // Inbound call: branch on the unknown-caller policy.
  const allowlisted = callerIsAllowlisted(from);
  if (allowlisted || cfg.voiceUnknownCallerAction === 'agent') {
    return c.text(twimlConnectStream(streamUrl, { from, to }), 200, { 'Content-Type': 'application/xml' });
  }
  if (cfg.voiceUnknownCallerAction === 'voicemail') {
    const statusCallback = `${webhook.base}/api/twilio/webhook/voicemail-recording`;
    const transcribeCallback = `${webhook.base}/api/twilio/webhook/voicemail-transcription`;
    return c.text(
      twimlVoicemail(cfg.voiceVoicemailGreeting, statusCallback, transcribeCallback),
      200,
      { 'Content-Type': 'application/xml' },
    );
  }
  // reject (default for unknown when set)
  logger.info('Inbound voice call rejected (unknown caller)', { from, to });
  return c.text(twimlReject('busy'), 200, { 'Content-Type': 'application/xml' });
});

twilioRouter.post('/webhook/voicemail-recording', async (c) => {
  const formText = await c.req.text();
  const formParams = Object.fromEntries(new URLSearchParams(formText)) as Record<string, string>;
  const denied = await verifySignatureOr401(c, formParams);
  if (denied) return denied;
  // The recording itself is stored on Twilio (we don't fetch the
  // audio - transcripts only). Persist the call log entry with the
  // recording metadata so the dashboard surfaces it.
  try {
    const callSid = formParams.CallSid;
    const recordingSid = formParams.RecordingSid;
    const duration = Number(formParams.RecordingDuration ?? '0') || 0;
    if (callSid && recordingSid) {
      getDb().prepare(`
        INSERT OR IGNORE INTO twilio_call_log (id, call_sid, direction, from_number, to_number, status, handler, started_at, ended_at, duration_seconds, ended_reason)
        VALUES (?, ?, 'inbound', ?, ?, 'completed', 'voicemail', datetime('now'), datetime('now'), ?, 'voicemail_recorded')
      `).run(
        recordingSid,
        callSid,
        formParams.From ?? '(unknown)',
        formParams.To ?? '(unknown)',
        duration,
      );
    }
  } catch (err) {
    logger.warn('Voicemail recording log insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.text('<Response/>', 200, { 'Content-Type': 'application/xml' });
});

twilioRouter.post('/webhook/voicemail-transcription', async (c) => {
  const formText = await c.req.text();
  const formParams = Object.fromEntries(new URLSearchParams(formText)) as Record<string, string>;
  const denied = await verifySignatureOr401(c, formParams);
  if (denied) return denied;
  try {
    const callSid = formParams.CallSid;
    const transcript = formParams.TranscriptionText ?? '';
    const from = formParams.From ?? '(unknown)';
    const to = formParams.To ?? '(unknown)';
    if (callSid && transcript) {
      // Update the call log row with the transcript.
      getDb().prepare(`
        UPDATE twilio_call_log
        SET transcript = ?
        WHERE call_sid = ?
      `).run(transcript, callSid);
      // Surface to the primary agent as a notification-shape message
      // (the owner decides whether the agent should act on it).
      const { getPrimaryAgentId, getOwnerName } = await import('../../config/platform.js');
      const { getAgentRuntime } = await import('../../agent/runtime.js');
      const primaryId = getPrimaryAgentId();
      if (primaryId) {
        const ownerName = getOwnerName();
        const content =
          `[SOURCE: VOICEMAIL NOTIFICATION — ${to}]\n\n` +
          `[VOICEMAIL EVENT] ${ownerName}'s Twilio number ${to} just received a voicemail. ` +
          `Caller: ${from}. The transcript appears below. This is NOT a request for you to do anything - ${ownerName} has not asked you to act on it. ` +
          `Decide whether to surface to ${ownerName}: family/known contact with a request → surface; spam / robocall → ignore.\n\n` +
          `Transcript:\n${transcript}\n\nCall SID: ${callSid}`;
        const { v4: uuidv4 } = await import('uuid');
        const msgId = uuidv4();
        getDb().prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
          VALUES (?, ?, 'user', ?, datetime('now'))
        `).run(msgId, primaryId, content);
        // v3.1.10 (attribution redesign §5, Phase 4) — stamp structured origin so
        // this notification rides the awareness lane by data, not by the legacy
        // [SOURCE: …] prose shim. A voicemail is a phone-channel notification ABOUT
        // the owner's number; the agent surfaces it, never auto-replies to the
        // caller, so authorized:false. This retires the last prose-only producer.
        const { recordInboundMeta } = await import('../../agent/v2/inbound-channel.js');
        recordInboundMeta(msgId, {
          channel: 'phone',
          accountKind: 'agent',
          authorized: false,
          sender: from,
          phoneFromNumber: from,
          phoneCallSid: callSid,
        });
        const { broadcast } = await import('../ws.js');
        broadcast({
          type: 'chat:message',
          agentId: primaryId,
          message: {
            id: msgId, agentId: primaryId, role: 'user' as const,
            content,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
        const runtime = getAgentRuntime();
        void runtime.handleMessage(primaryId, content).catch(err => {
          logger.error('Runtime handleMessage failed for voicemail', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  } catch (err) {
    logger.warn('Voicemail transcription handling failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.text('<Response/>', 200, { 'Content-Type': 'application/xml' });
});

twilioRouter.post('/webhook/voice-status', async (c) => {
  const formText = await c.req.text();
  const formParams = Object.fromEntries(new URLSearchParams(formText)) as Record<string, string>;
  const denied = await verifySignatureOr401(c, formParams);
  if (denied) return denied;
  try {
    const callSid = formParams.CallSid;
    const callStatus = formParams.CallStatus;
    if (callSid && callStatus) {
      // Update the call log row's status. Most rows are created with
      // status='in-progress' by the WS handler when the call starts;
      // this records terminal states (completed/no-answer/busy/failed).
      getDb().prepare(`
        UPDATE twilio_call_log
        SET status = ?
        WHERE call_sid = ?
      `).run(callStatus, callSid);
      if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'canceled') {
        const { endCallSession } = await import('../../twilio/call-session.js');
        endCallSession(callSid, callStatus);
      }
    }
  } catch (err) {
    logger.warn('voice-status callback handling failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.text('<Response/>', 200, { 'Content-Type': 'application/xml' });
});

// ── Auth-protected: config + numbers + safe-senders + connection test ──

twilioRouter.get('/config', (c) => {
  const cfg = getTwilioConfig();
  const webhook = getWebhookBase();
  // Never expose the auth_token, even masked - just whether one is set.
  return c.json({
    ok: true,
    data: {
      configured: cfg.configured,
      enabled: cfg.enabled,
      smsEnabled: cfg.smsEnabled,
      voiceEnabled: cfg.voiceEnabled,
      accountSid: cfg.accountSid,
      defaultFromNumber: cfg.defaultFromNumber,
      voiceMaxMinutesPerCall: cfg.voiceMaxMinutesPerCall,
      voiceUnknownCallerAction: cfg.voiceUnknownCallerAction,
      voiceVoicemailGreeting: cfg.voiceVoicemailGreeting,
      numbers: cfg.numbers,
      webhooks: webhook.ok
        ? {
            sms: `${webhook.base}/api/twilio/webhook/sms`,
            voice: `${webhook.base}/api/twilio/webhook/voice`,
            voiceStatus: `${webhook.base}/api/twilio/webhook/voice-status`,
          }
        : null,
      webhookError: webhook.ok ? null : webhook.reason,
    },
  });
});

twilioRouter.post('/credentials', async (c) => {
  const body = await c.req.json().catch(() => null) as { account_sid?: string; auth_token?: string } | null;
  if (!body?.account_sid || !body?.auth_token) {
    return c.json({ ok: false, error: 'account_sid and auth_token are required.' }, 400);
  }
  const test = await testTwilioCredentials(body.account_sid.trim(), body.auth_token);
  if (!test.ok) return c.json({ ok: false, error: test.error }, 400);
  setTwilioCredentials(body.account_sid.trim(), body.auth_token);
  return c.json({ ok: true, data: { accountSid: body.account_sid.trim(), friendlyName: test.friendlyName } });
});

twilioRouter.delete('/credentials', (c) => {
  clearTwilioCredentials();
  return c.json({ ok: true, data: { cleared: true } });
});

twilioRouter.post('/test-connection', async (c) => {
  const body = await c.req.json().catch(() => null) as { account_sid?: string; auth_token?: string } | null;
  // If body credentials are supplied, test those directly (used during
  // initial connect before saving). Otherwise test the stored creds.
  let sid: string | undefined;
  let token: string | undefined;
  if (body?.account_sid && body?.auth_token) {
    sid = body.account_sid.trim();
    token = body.auth_token;
  } else {
    const stored = getTwilioCreds();
    if (!stored) return c.json({ ok: false, error: 'Not configured.' }, 400);
    sid = stored.sid;
    token = stored.token;
  }
  const result = await testTwilioCredentials(sid, token);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true, data: { friendlyName: result.friendlyName } });
});

twilioRouter.patch('/settings', async (c) => {
  const body = await c.req.json().catch(() => null) as TwilioSettingsPatch | null;
  if (!body) return c.json({ ok: false, error: 'Body required.' }, 400);
  updateTwilioSettings(body);
  return c.json({ ok: true, data: getTwilioConfig() });
});

twilioRouter.post('/numbers', async (c) => {
  const body = await c.req.json().catch(() => null) as { number?: string; label?: string; is_default?: boolean; sms_enabled?: boolean; voice_enabled?: boolean } | null;
  if (!body?.number) return c.json({ ok: false, error: 'number is required.' }, 400);
  upsertTwilioNumber(body.number.trim(), {
    label: body.label ?? null,
    isDefault: body.is_default,
    smsEnabled: body.sms_enabled,
    voiceEnabled: body.voice_enabled,
  });
  return c.json({ ok: true, data: getTwilioConfig().numbers });
});

twilioRouter.delete('/numbers/:number', (c) => {
  const number = decodeURIComponent(c.req.param('number'));
  removeTwilioNumber(number);
  return c.json({ ok: true, data: getTwilioConfig().numbers });
});

twilioRouter.get('/safe-senders/sms', (c) => {
  return c.json({ ok: true, data: getTwilioSmsSafeSenders() });
});

twilioRouter.post('/safe-senders/sms', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: string; address?: string; is_primary?: boolean; sharing_level?: string } | null;
  if (!body?.name || !body?.address) return c.json({ ok: false, error: 'name and address are required.' }, 400);
  const r = appendTwilioSmsSafeSender({
    name: body.name.trim(),
    address: body.address.trim(),
    is_primary: body.is_primary === true,
    sharing_level: (body.sharing_level as 'open_book' | 'dont_overshare' | 'cautious' | 'project_only' | undefined) ?? 'cautious',
  });
  return c.json({ ok: true, data: { added: r.added, totalSenders: r.totalSenders } });
});

twilioRouter.delete('/safe-senders/sms/:address', (c) => {
  const address = decodeURIComponent(c.req.param('address'));
  const list = getTwilioSmsSafeSenders();
  const next = list.filter(s => s.address.toLowerCase() !== address.toLowerCase());
  if (next.length === list.length) return c.json({ ok: false, error: 'Not found.' }, 404);
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run('twilio_sms_approved_senders', JSON.stringify(next));
  return c.json({ ok: true, data: { totalSenders: next.length } });
});

twilioRouter.get('/safe-senders/voice', (c) => {
  return c.json({ ok: true, data: getTwilioVoiceSafeCallers() });
});

twilioRouter.post('/safe-senders/voice', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: string; address?: string; is_primary?: boolean; sharing_level?: string } | null;
  if (!body?.name || !body?.address) return c.json({ ok: false, error: 'name and address are required.' }, 400);
  const r = appendTwilioVoiceSafeCaller({
    name: body.name.trim(),
    address: body.address.trim(),
    is_primary: body.is_primary === true,
    sharing_level: (body.sharing_level as 'open_book' | 'dont_overshare' | 'cautious' | 'project_only' | undefined) ?? 'cautious',
  });
  return c.json({ ok: true, data: { added: r.added, totalSenders: r.totalSenders } });
});

twilioRouter.delete('/safe-senders/voice/:address', (c) => {
  const address = decodeURIComponent(c.req.param('address'));
  const list = getTwilioVoiceSafeCallers();
  const next = list.filter(s => s.address.toLowerCase() !== address.toLowerCase());
  if (next.length === list.length) return c.json({ ok: false, error: 'Not found.' }, 404);
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run('twilio_voice_approved_callers', JSON.stringify(next));
  return c.json({ ok: true, data: { totalSenders: next.length } });
});

// ── Recent calls (basic call log surface, step 9 will expand) ──

twilioRouter.get('/calls/recent', (c) => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
  const rows = getDb().prepare(`
    SELECT id, call_sid, direction, from_number, to_number, status, handler,
           started_at, ended_at, duration_seconds, agent_id, transcript, ended_reason
    FROM twilio_call_log
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return c.json({ ok: true, data: { calls: rows } });
});
