// ════════════════════════════════════════
// System Services API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { getIMBridgeStatus, sendIMessage, startIMBridge } from '../../services/imessage-bridge.js';
import { getResourceInfo } from '../../services/resource-monitor.js';
import { checkOllamaHealth, getOllamaStatus, listOllamaModels } from '../../services/ollama.js';
import { getOllamaLock, getActiveOllamaModelsByProvider, getOllamaMaxConcurrent } from '../../services/ollama-lock.js';
import { getWSStatus } from '../ws.js';
import { getPresence, setPresence, isImessageConfigured, type PresenceStatus } from '../../services/presence.js';
import {
  getTunnelStatus, enableTunnel, disableTunnel, startTunnel, stopTunnel,
  isCloudflaredInstalled, installCloudflared, setTunnelToken, type TunnelMode,
} from '../../services/tunnel.js';

// In-memory provider health tracking — updated by model.ts after successful calls
const providerLastSuccess = new Map<string, string>();
const providerErrorCounts = new Map<string, number>();

export function recordProviderSuccess(providerId: string): void {
  providerLastSuccess.set(providerId, new Date().toISOString());
  providerErrorCounts.set(providerId, 0);
}

export function recordProviderError(providerId: string): void {
  providerErrorCounts.set(providerId, (providerErrorCounts.get(providerId) ?? 0) + 1);
}
import { getProviderCredential } from '../../config/loader.js';

const logger = createLogger('services-routes');
const servicesRouter = new Hono();

// GET /watchdog — watchdog status
servicesRouter.get('/watchdog', (c) => {
  // Watchdog is a separate process; check if it recently reported in
  try {
    const db = getDb();
    const lastHeartbeat = db.prepare(`
      SELECT value FROM config WHERE key = 'watchdog_last_heartbeat'
    `).get() as { value: string } | undefined;

    const lastAlert = db.prepare(`
      SELECT value FROM config WHERE key = 'watchdog_last_alert'
    `).get() as { value: string } | undefined;

    const isRecent = lastHeartbeat
      ? (Date.now() - new Date(lastHeartbeat.value).getTime()) < 300000 // 5 minutes
      : false;

    return c.json({
      ok: true,
      data: {
        running: isRecent,
        lastHeartbeat: lastHeartbeat?.value ?? null,
        lastAlert: lastAlert?.value ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /imessage — bridge status
servicesRouter.get('/imessage', (c) => {
  const status = getIMBridgeStatus();
  return c.json({ ok: true, data: status });
});

// POST /imessage/test — send test message
servicesRouter.post('/imessage/test', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.recipient !== 'string' || typeof body.message !== 'string') {
    return c.json({ ok: false, error: 'recipient and message (strings) are required' }, 400);
  }

  try {
    sendIMessage(body.recipient, body.message);
    return c.json({ ok: true, data: { sent: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send test iMessage', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /imessage/welcome — send welcome message and start the bridge (used during OOBE)
servicesRouter.post('/imessage/welcome', async (c) => {
  const body = await c.req.json().catch(() => null);
  const recipient = body?.recipient as string | undefined;

  if (!recipient) {
    return c.json({ ok: false, error: 'recipient is required' }, 400);
  }

  try {
    // Start the bridge first
    startIMBridge(recipient);

    // Send welcome message
    sendIMessage(recipient, '🥋 Welcome to the D.O.J.O! Your agent platform is set up and ready. You can talk to your agents through iMessage when you\'re away from the dashboard.');

    return c.json({ ok: true, data: { sent: true, bridgeStarted: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to send welcome iMessage', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /providers/health — provider health check
servicesRouter.get('/providers/health', async (c) => {
  const db = getDb();
  const providers = db.prepare(`
    SELECT id, name, type, base_url FROM providers
  `).all() as Array<{ id: string; name: string; type: string; base_url: string | null }>;

  const results: Array<{ id: string; name: string; type: string; healthy: boolean; lastSuccess?: string | null; errorCount?: number; error?: string }> = [];

  for (const provider of providers) {
    if (provider.type === 'ollama') {
      const healthy = await checkOllamaHealth(provider.base_url ?? undefined);
      results.push({ id: provider.id, name: provider.name, type: provider.type, healthy });
    } else {
      // For API providers, check if credential exists
      const credential = getProviderCredential(provider.id);
      results.push({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        healthy: !!credential,
        lastSuccess: providerLastSuccess.get(provider.id) ?? null,
        errorCount: providerErrorCounts.get(provider.id) ?? 0,
        error: credential ? undefined : 'No API key configured',
      });
    }
  }

  return c.json({ ok: true, data: results });
});

// GET /resources — system resources (shaped for dashboard)
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

  // CPU usage approximation from load average
  // Use 5-minute average (loadAvg[1]) for a smoother, less spiky reading
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

// GET /ollama/models — list Ollama models
servicesRouter.get('/ollama/models', async (c) => {
  const baseUrl = c.req.query('baseUrl') ?? undefined;
  const models = await listOllamaModels(baseUrl);
  return c.json({ ok: true, data: models });
});

// GET /ollama/status — Ollama status
servicesRouter.get('/ollama/status', (c) => {
  const status = getOllamaStatus();
  return c.json({ ok: true, data: status });
});

// GET /ollama/lock — Ollama concurrency lock status (per-provider)
servicesRouter.get('/ollama/lock', (c) => {
  const lockStatus = getOllamaLock().getStatus();
  const byProvider = getActiveOllamaModelsByProvider();
  // One warning record per provider that's currently over its limit.
  // The dashboard renders each warning as a separate banner naming the
  // specific machine, so having the Mac Mini at 2 concurrent and the Mac
  // Studio at 1 no longer triggers a single lumped "3 models across all
  // Ollama providers" message.
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

// GET /ws-status — WebSocket connection info
servicesRouter.get('/ws-status', (c) => {
  return c.json({ ok: true, data: getWSStatus() });
});

// GET /presence — get user presence status
servicesRouter.get('/presence', (c) => {
  return c.json({
    ok: true,
    data: {
      status: getPresence(),
      imessageConfigured: isImessageConfigured(),
    },
  });
});

// POST /presence — set user presence status
servicesRouter.post('/presence', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.status || !['in_dojo', 'away'].includes(body.status)) {
    return c.json({ ok: false, error: 'status must be "in_dojo" or "away"' }, 400);
  }
  setPresence(body.status as PresenceStatus);
  return c.json({ ok: true, data: { status: body.status } });
});

// ── Tunnel (Remote Access) ──

// GET /tunnel — tunnel status
servicesRouter.get('/tunnel', (c) => {
  return c.json({ ok: true, data: getTunnelStatus() });
});

// POST /tunnel/enable — enable tunnel
servicesRouter.post('/tunnel/enable', async (c) => {
  const body = await c.req.json().catch(() => null);
  const mode = (body?.mode === 'named' ? 'named' : 'quick') as TunnelMode;
  const result = enableTunnel(mode);
  return c.json({ ok: result.ok, error: result.error, data: getTunnelStatus() });
});

// POST /tunnel/disable — disable tunnel
servicesRouter.post('/tunnel/disable', (c) => {
  disableTunnel();
  return c.json({ ok: true, data: getTunnelStatus() });
});

// POST /tunnel/token — save named tunnel token
servicesRouter.post('/tunnel/token', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.token) return c.json({ ok: false, error: 'Token is required' }, 400);
  setTunnelToken(body.token);
  return c.json({ ok: true });
});

// POST /tunnel/install-cloudflared — install cloudflared via brew
servicesRouter.post('/tunnel/install-cloudflared', (c) => {
  if (isCloudflaredInstalled()) {
    return c.json({ ok: true, data: { alreadyInstalled: true } });
  }
  const result = installCloudflared();
  return c.json({ ok: result.ok, error: result.error });
});

export { servicesRouter };
