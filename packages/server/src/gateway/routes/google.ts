// ════════════════════════════════════════
// Google Workspace API Routes — Native OAuth 2.0
// No gws CLI dependency.
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  getGoogleWorkspaceConfig,
  testGoogleAuth,
  setGoogleConnected,
  setGoogleEnabled,
  setEnabledServices,
  buildAuthUrl,
  exchangeCodeForTokens,
  getStoredState,
  getStoredRedirectUri,
  disconnectGoogle,
} from '../../google/auth.js';
import { queryGoogleActivity, getTodayActivityCounts, getLastActivityTimestamp } from '../../google/activity-log.js';

const logger = createLogger('google-routes');

export const googleRouter = new Hono<AppEnv>();

// GET /api/google/status
googleRouter.get('/status', (c) => {
  const config = getGoogleWorkspaceConfig();
  const todayCounts = getTodayActivityCounts();
  const lastActivity = getLastActivityTimestamp();

  return c.json({
    ok: true,
    data: {
      enabled: config.enabled,
      connected: config.connected,
      email: config.accountEmail,
      services: config.enabledServices,
      lastVerified: config.lastVerifiedAt,
      lastActivity,
      todayActivity: todayCounts,
    },
  });
});

// POST /api/google/connect — start OAuth flow
googleRouter.post('/connect', (c) => {
  try {
    // Build redirect URI from the request's origin
    const url = new URL(c.req.url);
    const redirectUri = `${url.protocol}//${url.host}/api/google/callback`;
    const { authUrl } = buildAuthUrl(redirectUri);

    logger.info('Google OAuth flow started', { redirectUri });
    return c.json({ ok: true, data: { authUrl } });
  } catch (err) {
    return c.json({ ok: false, error: `Failed to start auth: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

// GET /api/google/callback — OAuth redirect handler
googleRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    logger.error('Google OAuth error', { error });
    return c.html(`<html><body><h2>Google connection failed</h2><p>${error}</p><p>You can close this tab.</p><script>window.close()</script></body></html>`);
  }

  if (!code) {
    return c.html('<html><body><h2>Missing authorization code</h2><p>You can close this tab.</p></body></html>');
  }

  // Validate state parameter
  const storedState = getStoredState();
  if (state !== storedState) {
    logger.warn('Google OAuth state mismatch', { expected: storedState, received: state });
    return c.html('<html><body><h2>Invalid state parameter</h2><p>Please try connecting again from Settings.</p></body></html>');
  }

  const redirectUri = getStoredRedirectUri();
  if (!redirectUri) {
    return c.html('<html><body><h2>Session expired</h2><p>Please try connecting again from Settings.</p></body></html>');
  }

  const result = await exchangeCodeForTokens(code, redirectUri);

  if (result.success) {
    logger.info('Google OAuth completed', { email: result.email });
    return c.html(`<html><body><h2>Google Workspace connected!</h2><p>Connected as ${result.email}.</p><p>You can close this tab and return to the Dojo.</p><script>window.close()</script></body></html>`);
  }

  logger.error('Google OAuth token exchange failed', { error: result.error });
  return c.html(`<html><body><h2>Connection failed</h2><p>${result.error}</p><p>You can close this tab and try again from Settings.</p></body></html>`);
});

// POST /api/google/disconnect
googleRouter.post('/disconnect', (c) => {
  disconnectGoogle();
  return c.json({ ok: true });
});

// POST /api/google/test — test current connection
googleRouter.post('/test', async (c) => {
  const auth = await testGoogleAuth();
  if (auth.authenticated) {
    setGoogleConnected(true, auth.email ?? undefined);
    setGoogleEnabled(true);
  }

  return c.json({
    ok: true,
    data: {
      working: auth.authenticated,
      email: auth.email,
    },
  });
});

// PUT /api/google/services — enable/disable individual services
googleRouter.put('/services', async (c) => {
  try {
    const body = await c.req.json() as Partial<{
      gmail: boolean;
      calendar: boolean;
      drive: boolean;
      docs: boolean;
      sheets: boolean;
      slides: boolean;
    }>;

    setEnabledServices(body);
    logger.info('Google Workspace services updated', body);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/google/activity
googleRouter.get('/activity', (c) => {
  const agentId = c.req.query('agent') ?? undefined;
  const action = c.req.query('action') ?? undefined;
  const actionType = c.req.query('type') as 'read' | 'write' | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const entries = queryGoogleActivity({ agentId, action, actionType, limit, offset });
  return c.json({ ok: true, data: entries });
});
