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
  getTenantId,
  buildAuthUrl,
  exchangeCodeForTokens,
  testMicrosoftAuth,
  disconnectMicrosoft,
  setEnabledMsServices,
} from '../../microsoft/auth.js';
import { queryMicrosoftActivity, getTodayMsActivityCounts, getLastMsActivityTimestamp } from '../../microsoft/activity-log.js';

const logger = createLogger('ms-routes');

export const microsoftRouter = new Hono<AppEnv>();

// Store the redirect URI used during configure so callback can reuse it exactly
let storedRedirectUri: string | null = null;

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
      clientId: getClientId() ?? null,
      tenantId: getTenantId() ?? null,
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
    const body = await c.req.json() as { clientId: string; clientSecret?: string; redirectUri?: string; accountType?: 'msa' | 'entra'; tenantId?: string };
    if (!body.clientId?.trim()) {
      return c.json({ ok: false, error: 'clientId is required' }, 400);
    }

    // Store account type before credentials so getAuthBase() uses the right endpoint
    if (body.accountType) {
      const { setAccountType } = await import('../../microsoft/auth.js');
      setAccountType(body.accountType);
    }

    setClientCredentials(body.clientId.trim(), body.clientSecret?.trim(), body.tenantId?.trim());

    // Use the redirect URI from the frontend if provided (it knows the actual URL the user is on).
    // This handles localhost, tunnels, and any other access method.
    const redirectUri = body.redirectUri?.trim() || `http://localhost:3001/api/microsoft/callback`;
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
  const adminConsent = c.req.query('admin_consent');

  // Handle admin consent callback (no code, just approval confirmation)
  if (adminConsent) {
    const dashboardBase = process.env.NODE_ENV === 'production' ? 'http://localhost:3001' : 'http://localhost:3000';
    if (adminConsent === 'True') {
      logger.info('Microsoft admin consent granted');
      return c.redirect(`${dashboardBase}/settings?tab=microsoft&admin_consent=granted`);
    } else {
      return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=Admin+consent+was+denied`);
    }
  }

  // Redirect back to the dashboard using the same origin the user started from
  const dashboardBase = (() => {
    if (storedRedirectUri) {
      try {
        const url = new URL(storedRedirectUri);
        // Strip the /api/microsoft/callback path to get just the origin
        return url.origin;
      } catch { /* fall through */ }
    }
    return process.env.NODE_ENV === 'production' ? 'http://localhost:3001' : 'http://localhost:3000';
  })();

  if (error) {
    logger.error('Microsoft OAuth error', { error, errorDesc });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(errorDesc ?? error)}`);
  }

  if (!code) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=No+authorization+code+received`);
  }

  const redirectUri = storedRedirectUri ?? 'http://localhost:3001/api/microsoft/callback';
  const result = await exchangeCodeForTokens(code, redirectUri);

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
