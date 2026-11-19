// System services API routes

import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { getIMBridgeStatus, sendIMessage, startIMBridge, getDefaultSender, getSafeSenders, findSafeSenderByAddress } from '../../services/imessage-bridge.js';
import { withOutboundAsyncIfAbsent, PLATFORM_SENDER } from '../../agent/v2/outbound.js';
import { getResourceInfo } from '../../services/resource-monitor.js';
import { checkOllamaHealth, getOllamaStatus } from '../../services/ollama.js';
import { getOllamaLock, getActiveOllamaModelsByProvider } from '../../services/ollama-lock.js';
import { getPresence, setPresence, isImessageConfigured, type PresenceStatus } from '../../services/presence.js';
import { getTunnelStatus, enableTunnel, disableTunnel, isCloudflaredInstalled, installCloudflared, setTunnelToken, setNamedTunnelUrl, type TunnelMode } from '../../services/tunnel.js';

// In-memory provider health tracking, updated by model.ts after successful calls
const providerLastSuccess = new Map<string, string>();
const providerErrorCounts = new Map<string, number>();

// Consecutive failures (including stream idle timeouts) at which the provider's Health card flips
// unhealthy. recordProviderSuccess zeroes the count, so the card clears on the first healthy call.
export const PROVIDER_DEGRADED_THRESHOLD = 3;

/** `call`: the model that answered and what the call was for (the signal a waiting summary span wakes on). */
export function recordProviderSuccess(providerId: string, call?: { modelId?: string; purpose?: string }): void {
  const prev = providerErrorCounts.get(providerId) ?? 0;
  if (prev >= PROVIDER_DEGRADED_THRESHOLD) {
    logger.info('Provider recovered: calls succeeding again after repeated failures; Health card clearing', {
      providerId, previousErrorCount: prev,
    });
  }
  providerLastSuccess.set(providerId, new Date().toISOString());
  providerErrorCounts.set(providerId, 0);
  // A call that actually worked is the only evidence that beats a recorded permanent failure, so it
  // closes the breaker too.
  noteProviderSuccess(providerId);
  if (call?.purpose !== 'memory_summarize') clearOn({ kind: 'writer-answered', providerKey: providerId, modelId: call?.modelId });   // a summary call's own outcome speaks for itself
}

export function recordProviderError(providerId: string): void {
  const next = (providerErrorCounts.get(providerId) ?? 0) + 1;
  providerErrorCounts.set(providerId, next);
  if (next === PROVIDER_DEGRADED_THRESHOLD) {
    logger.warn('Provider degraded: repeated consecutive call failures or timeouts; Health card flipping unhealthy until a call succeeds', {
      providerId, errorCount: next,
    });
  }
}
import { getProviderCredential } from '../../config/loader.js';
import { noteProviderSuccess } from '../../providers/billing-breaker.js';
import { clearOn } from '../../memory/writer.js';
import { routeFailure } from './route-failure.js';
import { homeDir } from '../../home.js';

const logger = createLogger('services-routes');
const servicesRouter = new Hono();

// GET /watchdog (watchdog status)
servicesRouter.get('/watchdog', (c) => {
  // The watchdog owns its own liveness store (a JSON file under ~/.dojo) and this route only reads
  // it. Missing or unreadable means it has never reported in, so running:false.
  try {
    const statePath = path.join(homeDir(), '.dojo', 'watchdog-state.json');
    let lastHeartbeat: string | null = null;
    // The watchdog stores `{ message, at }`; both travel in its own shape or neither does, so a
    // state file missing `at` reads as no alert rather than an alert with an unparseable time.
    let lastAlert: { message: string; at: string } | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
        lastHeartbeat?: unknown;
        lastAlert?: { message?: unknown; at?: unknown } | null;
      };
      if (typeof parsed.lastHeartbeat === 'string') lastHeartbeat = parsed.lastHeartbeat;
      if (parsed.lastAlert
        && typeof parsed.lastAlert.message === 'string'
        && typeof parsed.lastAlert.at === 'string') {
        lastAlert = { message: parsed.lastAlert.message, at: parsed.lastAlert.at };
      }
    } catch {
      // File absent or unreadable (watchdog not running yet, or crash mid-boot): fall through with nulls.
    }

    const isRecent = lastHeartbeat
      ? (Date.now() - new Date(lastHeartbeat).getTime()) < 300000 // 5 minutes
      : false;

    return c.json({
      ok: true,
      data: {
        running: isRecent,
        lastHeartbeat,
        lastAlert,
      },
    });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// GET /imessage (bridge status)
servicesRouter.get('/imessage', (c) => {
  const status = getIMBridgeStatus();
  // The Health card's test box prefills its To field with the owner's own (starred)
  // address; the dashboard only learns it here.
  return c.json({ ok: true, data: { ...status, ownerAddress: getDefaultSender() } });
});

// POST /imessage/test (send test message)
servicesRouter.post('/imessage/test', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.recipient !== 'string' || typeof body.message !== 'string') {
    return c.json({ ok: false, error: 'recipient and message (strings) are required' }, 400);
  }

  // The text path of `sendIMessage` revalidates nothing (the attachment path does),
  // so this route is the door: only an address on the owner's approved list is sent
  // to, and the send goes to the record's own address, not the free-typed text.
  const approved = findSafeSenderByAddress(getSafeSenders(), body.recipient.trim());
  if (!approved) {
    return c.json({ ok: false, error: `"${body.recipient.trim()}" is not on your approved iMessage list. Add it in Settings → Channels → iMessage Bridge first.` }, 400);
  }

  try {
    // The send is recorded as a platform outbound (a message to a real person, sent from a route).
    const sent = await withOutboundAsyncIfAbsent(
      { agentId: PLATFORM_SENDER, tool: 'imessage-test', channel: 'imessage', recipientId: approved.address },
      () => sendIMessage(approved.address, body.message),
    );
    if (sent !== true) {
      return c.json({ ok: false, error: 'The test message did not go through (neither the imsg tool nor AppleScript could send it).' }, 502);
    }
    return c.json({ ok: true, data: { sent: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send test iMessage', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /imessage/welcome (send welcome message and start the bridge, used during OOBE)
servicesRouter.post('/imessage/welcome', async (c) => {
  const body = await c.req.json().catch(() => null);
  const rawRecipient = body?.recipient;

  if (typeof rawRecipient !== 'string' || rawRecipient.trim() === '') {
    return c.json({ ok: false, error: 'recipient is required' }, 400);
  }
  const recipient = rawRecipient.trim();

  try {
    startIMBridge(recipient);

    const sent = await withOutboundAsyncIfAbsent(
      { agentId: PLATFORM_SENDER, tool: 'oobe-welcome', channel: 'imessage', recipientId: recipient },
      () => sendIMessage(recipient, '🥋 Welcome to the D.O.J.O! Your agent platform is set up and ready. You can talk to your agents through iMessage when you\'re away from the dashboard.'),
    );
    if (sent !== true) {
      // The bridge did start, so say that truthfully next to the send that did not go through.
      return c.json({ ok: false, error: 'The welcome message did not go through (neither the imsg tool nor AppleScript could send it).', data: { sent: false, bridgeStarted: true } }, 502);
    }

    return c.json({ ok: true, data: { sent: true, bridgeStarted: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send welcome iMessage', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /providers/health (provider health check)
servicesRouter.get('/providers/health', async (c) => {
  const db = getDb();
  const providers = db.prepare(`
    SELECT id, name, type, base_url FROM providers WHERE id != '__system__'
  `).all() as Array<{ id: string; name: string; type: string; base_url: string | null }>;

  const results: Array<{ id: string; name: string; type: string; healthy: boolean; lastSuccess?: string | null; errorCount?: number; error?: string }> = [];

  for (const provider of providers) {
    if (provider.type === 'ollama') {
      const healthy = await checkOllamaHealth(provider.base_url ?? undefined);
      results.push({ id: provider.id, name: provider.name, type: provider.type, healthy });
    } else {
      const credential = getProviderCredential(provider.id);
      if (credential) clearOn({ kind: 'writer-answered', providerKey: provider.id });   // this check's poll is the re-test of a waiting writer nobody calls
      const errorCount = providerErrorCounts.get(provider.id) ?? 0;
      const degraded = errorCount >= PROVIDER_DEGRADED_THRESHOLD;
      results.push({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        healthy: !!credential && !degraded,
        lastSuccess: providerLastSuccess.get(provider.id) ?? null,
        errorCount,
        error: !credential
          ? 'No API key configured'
          : degraded
            ? 'Repeated failures or timeouts on recent calls; the agent retries automatically and this clears on the next successful call'
            : undefined,
      });
    }
  }

  return c.json({ ok: true, data: results });
});

// GET /resources (system resources, shaped for dashboard)
servicesRouter.get('/resources', async (c) => {
  const info = getResourceInfo();
  const totalMb = info.memory.total;
  const usedMb = info.memory.used;
  const percentage = totalMb > 0 ? (usedMb / totalMb) * 100 : 0;

  // Check Ollama (live check, not just cached status)
  let ollama: { running: boolean; models: string[] } | null = null;
  try {
    await checkOllamaHealth();
    const ollamaStatus = getOllamaStatus();
    ollama = { running: ollamaStatus.available, models: ollamaStatus.models };
  } catch {
    ollama = { running: false, models: [] };
  }

  // CPU usage approximation from the 5-minute load average (loadAvg[1]), a smoother reading.
  const cpuCount = (await import('node:os')).cpus().length || 1;
  const cpuUsage = Math.min(100, Math.round((info.cpu.loadAvg[1] / cpuCount) * 100));

  return c.json({
    ok: true,
    data: {
      memory: { total: totalMb, used: usedMb, free: info.memory.free, percentage },
      cpu: { usage: cpuUsage, loadAvg: info.cpu.loadAvg },
      ollama,
      ollamaLock: getOllamaLock().getStatus(),
    },
  });
});

// GET /ollama/lock (Ollama concurrency lock status, per provider)
servicesRouter.get('/ollama/lock', (c) => {
  const lockStatus = getOllamaLock().getStatus();
  const byProvider = getActiveOllamaModelsByProvider();
  // One warning record per provider currently over its limit; the dashboard renders each as its own
  // banner naming the specific machine.
  const warnings = byProvider
    .filter(p => p.count > lockStatus.maxConcurrentModels)
    .map(p => ({
      providerId: p.providerId,
      providerName: p.providerName,
      count: p.count,
      maxConcurrentModels: lockStatus.maxConcurrentModels,
      models: p.models,
    }));
  return c.json({
    ok: true,
    data: {
      ...lockStatus,
      activeAgentModelsByProvider: byProvider,
      warnings,
    },
  });
});

// GET /presence (user presence status)
servicesRouter.get('/presence', (c) => {
  return c.json({
    ok: true,
    data: {
      status: getPresence(),
      // Gates the composer's in-dojo/away toggle: shown only while iMessage is switched on.
      imessageConfigured: isImessageConfigured(),
    },
  });
});

servicesRouter.post('/presence', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.status || !['in_dojo', 'away'].includes(body.status)) {
    return c.json({ ok: false, error: 'status must be "in_dojo" or "away"' }, 400);
  }
  setPresence(body.status as PresenceStatus);
  return c.json({ ok: true, data: { status: body.status } });
});


// GET /tunnel (tunnel status)
servicesRouter.get('/tunnel', (c) => {
  return c.json({ ok: true, data: getTunnelStatus() });
});

// POST /tunnel/enable (enable tunnel)
servicesRouter.post('/tunnel/enable', async (c) => {
  const body = await c.req.json().catch(() => null);
  const mode = (body?.mode === 'named' ? 'named' : 'quick') as TunnelMode;
  const result = enableTunnel(mode);
  return c.json({ ok: result.ok, error: result.error, data: getTunnelStatus() });
});

// POST /tunnel/disable (disable tunnel)
servicesRouter.post('/tunnel/disable', (c) => {
  disableTunnel();
  return c.json({ ok: true, data: getTunnelStatus() });
});

// POST /tunnel/token (save named tunnel token, and optionally the public URL)
servicesRouter.post('/tunnel/token', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.token !== 'string' || body.token.trim() === '') {
    return c.json({ ok: false, error: 'Token is required' }, 400);
  }
  // setNamedTunnelUrl trims, so a non-string url would throw after the token is saved: check it
  // before any write. null/undefined clear it.
  if (body.url !== undefined && body.url !== null && typeof body.url !== 'string') {
    return c.json({ ok: false, error: 'url must be text' }, 400);
  }
  setTunnelToken(body.token.trim());
  // The same payload can carry the public URL from Cloudflare's Published Application Routes.
  // Optional; null/empty clears it.
  if (body.url !== undefined) setNamedTunnelUrl(body.url);
  return c.json({ ok: true });
});

// POST /tunnel/named-url (set just the named-tunnel URL, no token change)
servicesRouter.post('/tunnel/named-url', async (c) => {
  const body = await c.req.json().catch(() => null);
  // setNamedTunnelUrl trims, so a non-string url would throw: check it first. null/undefined clear it.
  if (body?.url !== undefined && body?.url !== null && typeof body?.url !== 'string') {
    return c.json({ ok: false, error: 'url must be text' }, 400);
  }
  setNamedTunnelUrl(body?.url ?? null);
  return c.json({ ok: true, data: getTunnelStatus() });
});

// POST /tunnel/install-cloudflared (install cloudflared via brew)
servicesRouter.post('/tunnel/install-cloudflared', (c) => {
  if (isCloudflaredInstalled()) {
    return c.json({ ok: true, data: { alreadyInstalled: true } });
  }
  const result = installCloudflared();
  return c.json({ ok: result.ok, error: result.error });
});

export { servicesRouter };
