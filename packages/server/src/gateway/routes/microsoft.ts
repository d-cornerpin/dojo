// ════════════════════════════════════════
// Microsoft 365 API Routes
// Public client with PKCE — no client secret needed
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  getMicrosoftWorkspaceConfig,
  getClientId,
  buildAuthUrl,
  exchangeCodeForTokens,
  getStoredVerifier,
  getStoredRedirectUri,
  testMicrosoftAuth,
  disconnectMicrosoft,
  setEnabledMsServices,
} from '../../microsoft/auth.js';
import { queryMicrosoftActivity, getTodayMsActivityCounts, getLastMsActivityTimestamp } from '../../microsoft/activity-log.js';

const logger = createLogger('ms-routes');

export const microsoftRouter = new Hono<AppEnv>();

// GET /api/microsoft/status
microsoftRouter.get('/status', (c) => {
  const config = getMicrosoftWorkspaceConfig();
  const todayCounts = getTodayMsActivityCounts();
  const lastActivity = getLastMsActivityTimestamp();

  return c.json({
    ok: true,
    data: {
      clientId: getClientId(),
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

// POST /api/microsoft/connect — generate auth URL and return it
microsoftRouter.post('/connect', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { redirectUri?: string };

    // Use the redirect URI from the frontend, or default to localhost:3001
    const redirectUri = body.redirectUri?.trim() || 'http://localhost:3001/api/microsoft/callback';
    const { authUrl } = buildAuthUrl(redirectUri);

    logger.info('Microsoft auth URL generated', { redirectUri });
    return c.json({ ok: true, data: { authUrl, redirectUri } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/microsoft/callback — OAuth redirect handler (UNAUTHENTICATED)
microsoftRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const errorDesc = c.req.query('error_description');

  const dashboardBase = process.env.NODE_ENV === 'production' ? 'http://localhost:3001' : 'http://localhost:3000';

  if (error) {
    logger.error('Microsoft OAuth error', { error, errorDesc });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(errorDesc ?? error)}`);
  }

  if (!code) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=No+authorization+code+received`);
  }

  const verifier = getStoredVerifier();
  const redirectUri = getStoredRedirectUri() ?? 'http://localhost:3001/api/microsoft/callback';

  if (!verifier) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=PKCE+verifier+missing.+Try+connecting+again.`);
  }

  const result = await exchangeCodeForTokens(code, redirectUri, verifier);

  if (result.success) {
    logger.info('Microsoft OAuth successful', { email: result.email, accountType: result.accountType });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&connected=true`);
  } else {
    logger.error('Microsoft token exchange failed', { error: result.error });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(result.error ?? 'Token exchange failed')}`);
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
  return c.json({ ok: true, data: { working: auth.authenticated, email: auth.email } });
});

// PUT /api/microsoft/services
microsoftRouter.put('/services', async (c) => {
  try {
    const body = await c.req.json() as Partial<{ outlook: boolean; calendar: boolean; onedrive: boolean; teams: boolean }>;
    setEnabledMsServices(body);
    return c.json({ ok: true });
  } catch { return c.json({ ok: false, error: 'Invalid request body' }, 400); }
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
