// ════════════════════════════════════════
// Microsoft 365 API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  getMicrosoftWorkspaceConfig,
  isMicrosoftConnected,
  setClientCredentials,
  getClientId,
  buildAuthUrl,
  exchangeCodeForTokens,
  testMicrosoftAuth,
  disconnectMicrosoft,
  setEnabledMsServices,
} from '../../microsoft/auth.js';
import { queryMicrosoftActivity, getTodayMsActivityCounts, getLastMsActivityTimestamp } from '../../microsoft/activity-log.js';

const logger = createLogger('ms-routes');

export const microsoftRouter = new Hono<AppEnv>();

// Store the redirect URI used during configure so callback can reuse it
let storedRedirectUri: string | null = null;

function getRedirectUri(c: { req: { url: string } }): string {
  if (storedRedirectUri) return storedRedirectUri;
  const url = new URL(c.req.url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port}/api/microsoft/callback`;
}

// GET /api/microsoft/status
microsoftRouter.get('/status', (c) => {
  const config = getMicrosoftWorkspaceConfig();
  const hasClientId = !!getClientId();
  const todayCounts = getTodayMsActivityCounts();
  const lastActivity = getLastMsActivityTimestamp();

  return c.json({
    ok: true,
    data: {
      hasClientId,
      enabled: config.enabled,
      connected: config.connected,
      email: config.accountEmail,
      accountType: config.accountType,
      services: config.enabledServices,
      lastVerified: config.lastVerifiedAt,
      lastActivity,
      todayActivity: todayCounts,
    },
  });
});

// POST /api/microsoft/configure — store client credentials and return auth URL
microsoftRouter.post('/configure', async (c) => {
  try {
    const body = await c.req.json() as { clientId: string; clientSecret?: string };
    if (!body.clientId?.trim()) {
      return c.json({ ok: false, error: 'clientId is required' }, 400);
    }

    setClientCredentials(body.clientId.trim(), body.clientSecret?.trim());

    // Use the production port (3001) for the redirect URI — this is what Microsoft will redirect to.
    // In dev, Vite proxies /api/* to 3001, so the callback hits 3001 directly.
    const port = process.env.NODE_ENV === 'production' ? '3001' : '3001'; // Always 3001 — the API server
    const redirectUri = `http://localhost:${port}/api/microsoft/callback`;
    storedRedirectUri = redirectUri;
    const authUrl = buildAuthUrl(redirectUri);

    logger.info('Microsoft credentials stored, auth URL generated', { redirectUri });
    return c.json({ ok: true, data: { authUrl, redirectUri } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/microsoft/callback — OAuth redirect handler (UNAUTHENTICATED — exempt from JWT)
microsoftRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const errorDesc = c.req.query('error_description');

  if (error) {
    logger.error('Microsoft OAuth error', { error, errorDesc });
    // Redirect to settings with error
    const port = process.env.NODE_ENV === 'production' ? '3001' : '3000';
    return c.redirect(`http://localhost:${port}/#/settings?tab=microsoft&error=${encodeURIComponent(errorDesc ?? error)}`);
  }

  if (!code) {
    return c.redirect('http://localhost:3000/#/settings?tab=microsoft&error=No+authorization+code+received');
  }

  const redirectUri = storedRedirectUri ?? 'http://localhost:3001/api/microsoft/callback';
  const result = await exchangeCodeForTokens(code, redirectUri);

  const port = process.env.NODE_ENV === 'production' ? '3001' : '3000';
  if (result.success) {
    logger.info('Microsoft OAuth successful', { email: result.email, accountType: result.accountType });
    return c.redirect(`http://localhost:${port}/#/settings?tab=microsoft&connected=true`);
  } else {
    logger.error('Microsoft token exchange failed', { error: result.error });
    return c.redirect(`http://localhost:${port}/#/settings?tab=microsoft&error=${encodeURIComponent(result.error ?? 'Token exchange failed')}`);
  }
});

// POST /api/microsoft/disconnect
microsoftRouter.post('/disconnect', (c) => {
  disconnectMicrosoft();
  return c.json({ ok: true });
});

// POST /api/microsoft/test
microsoftRouter.post('/test', async (c) => {
  const auth = await testMicrosoftAuth();
  return c.json({
    ok: true,
    data: { working: auth.authenticated, email: auth.email },
  });
});

// PUT /api/microsoft/services
microsoftRouter.put('/services', async (c) => {
  try {
    const body = await c.req.json() as Partial<{
      outlook: boolean;
      calendar: boolean;
      onedrive: boolean;
      teams: boolean;
    }>;
    setEnabledMsServices(body);
    logger.info('Microsoft services updated', body);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/microsoft/activity
microsoftRouter.get('/activity', (c) => {
  const agentId = c.req.query('agent') ?? undefined;
  const action = c.req.query('action') ?? undefined;
  const actionType = c.req.query('type') as 'read' | 'write' | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const entries = queryMicrosoftActivity({ agentId, action, actionType, limit, offset });
  return c.json({ ok: true, data: entries });
});
