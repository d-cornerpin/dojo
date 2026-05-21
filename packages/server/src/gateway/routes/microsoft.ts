// ════════════════════════════════════════
// Microsoft 365 API Routes
// Public client with PKCE — no client secret needed.
// Multi-account (agent + user slots) as of v2.7.0.
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
  getSlotForState,
  testMicrosoftAuth,
  disconnectMicrosoft,
  setEnabledMsServices,
  ACCOUNT_SLOTS,
  type AccountSlot,
} from '../../microsoft/auth.js';
import { queryMicrosoftActivity, getTodayMsActivityCounts, getLastMsActivityTimestamp } from '../../microsoft/activity-log.js';
import { getInstallStatus, installOfficePackages, checkAndUpdateStatus } from '../../microsoft/office-packages.js';

const logger = createLogger('ms-routes');

export const microsoftRouter = new Hono<AppEnv>();

function parseSlot(value: string | undefined): AccountSlot {
  return value === 'user' ? 'user' : 'agent';
}

function buildSlotPayload(slot: AccountSlot) {
  const config = getMicrosoftWorkspaceConfig(slot);
  return {
    slot,
    enabled: config.enabled,
    connected: config.connected,
    email: config.accountEmail,
    accountType: config.accountType,
    services: config.enabledServices,
    lastVerified: config.lastVerifiedAt,
  };
}

// GET /api/microsoft/status
microsoftRouter.get('/status', (c) => {
  const todayCounts = getTodayMsActivityCounts();
  const lastActivity = getLastMsActivityTimestamp();

  checkAndUpdateStatus();
  const officeStatus = getInstallStatus();

  const slots: Record<AccountSlot, ReturnType<typeof buildSlotPayload>> = {
    agent: buildSlotPayload('agent'),
    user: buildSlotPayload('user'),
  };

  return c.json({
    ok: true,
    data: {
      clientId: getClientId(),
      // Per-slot detail
      slots,
      lastActivity,
      todayActivity: todayCounts,
      officeTools: officeStatus,
      // Legacy single-account fields (= agent slot)
      enabled: slots.agent.enabled,
      connected: slots.agent.connected,
      email: slots.agent.email,
      accountType: slots.agent.accountType,
      services: slots.agent.services,
      lastVerified: slots.agent.lastVerified,
    },
  });
});

// POST /api/microsoft/connect?slot=agent|user
microsoftRouter.post('/connect', async (c) => {
  try {
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json().catch(() => ({})) as { redirectUri?: string };
    const redirectUri = body.redirectUri?.trim() || 'http://localhost:3001/api/microsoft/callback';
    const { authUrl } = buildAuthUrl(redirectUri, slot);

    logger.info('Microsoft auth URL generated', { slot, redirectUri });
    return c.json({ ok: true, data: { authUrl, redirectUri, slot } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/microsoft/callback — recovers slot from state token
microsoftRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const errorDesc = c.req.query('error_description');
  const state = c.req.query('state');

  const dashboardBase = process.env.NODE_ENV === 'production' ? 'http://localhost:3001' : 'http://localhost:3000';

  if (error) {
    logger.error('Microsoft OAuth error', { error, errorDesc });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(errorDesc ?? error)}`);
  }

  if (!code || !state) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=No+authorization+code+or+state+received`);
  }

  const slot = getSlotForState(state);
  if (!slot) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=Unknown+state+token.+Try+connecting+again.`);
  }

  const verifier = getStoredVerifier(slot);
  const redirectUri = getStoredRedirectUri(slot) ?? 'http://localhost:3001/api/microsoft/callback';

  if (!verifier) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=PKCE+verifier+missing.+Try+connecting+again.`);
  }

  const result = await exchangeCodeForTokens(code, redirectUri, verifier, slot);

  if (result.success) {
    logger.info('Microsoft OAuth successful', { slot, email: result.email, accountType: result.accountType });

    // Restart the Teams watcher only for the agent slot — the watcher
    // only knows about one account (the agent's). User-slot Teams use
    // is on-demand via tool calls; no background polling.
    if (slot === 'agent') {
      try {
        const { stopTeamsWatcher, startTeamsWatcher } = await import('../../services/teams-watcher.js');
        stopTeamsWatcher();
        startTeamsWatcher();
      } catch (err) {
        logger.warn('Failed to restart Teams watcher after Microsoft reconnect', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.redirect(`${dashboardBase}/settings?tab=microsoft&connected=true&slot=${slot}`);
  } else {
    logger.error('Microsoft token exchange failed', { slot, error: result.error });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(result.error ?? 'Token exchange failed')}`);
  }
});

// POST /api/microsoft/disconnect?slot=agent|user
microsoftRouter.post('/disconnect', (c) => {
  const slot = parseSlot(c.req.query('slot'));
  disconnectMicrosoft(slot);
  return c.json({ ok: true, data: { slot } });
});

// POST /api/microsoft/test?slot=agent|user
microsoftRouter.post('/test', async (c) => {
  const slot = parseSlot(c.req.query('slot'));
  const auth = await testMicrosoftAuth(slot);
  return c.json({ ok: true, data: { working: auth.authenticated, email: auth.email, slot } });
});

// PUT /api/microsoft/services?slot=agent|user
microsoftRouter.put('/services', async (c) => {
  try {
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json() as Partial<{ outlook: boolean; calendar: boolean; onedrive: boolean; teams: boolean }>;
    setEnabledMsServices(body, slot);
    return c.json({ ok: true, data: { slot } });
  } catch { return c.json({ ok: false, error: 'Invalid request body' }, 400); }
});

// POST /api/microsoft/install-office-tools — retry Office package installation
microsoftRouter.post('/install-office-tools', (c) => {
  installOfficePackages();
  return c.json({ ok: true, data: { message: 'Installation started' } });
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
// Silence unused-var warning if ACCOUNT_SLOTS isn't referenced elsewhere here.
void ACCOUNT_SLOTS;
