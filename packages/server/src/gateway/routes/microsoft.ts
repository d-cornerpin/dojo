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
  getFlowForState,
  clearOAuthFlow,
  testMicrosoftAuth,
  disconnectMicrosoft,
  disconnectMicrosoftAccount,
  setEnabledMsServices,
  setEnabledMsServicesForAccount,
  isMsEmailMonitoringEnabled,
  setMsEmailMonitoringEnabled,
  setMsEmailMonitoringEnabledForAccount,
  isMsEmailSendingEnabled,
  setMsEmailSendingEnabled,
  setMsEmailSendingEnabledForAccount,
  listMicrosoftAccountViews,
  type AccountSlot,
  type OAuthTarget,
} from '../../microsoft/auth.js';
import {
  getMicrosoftAccount,
  getPrimaryMicrosoftAccount,
  countMicrosoftAccounts,
  MAX_MS_ACCOUNTS_PER_KIND,
} from '../../microsoft/accounts.js';
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
    watchEmail: isMsEmailMonitoringEnabled(slot),
    sendEmail: isMsEmailSendingEnabled(slot),
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
      // Per-slot detail (legacy: position-1 of each kind)
      slots,
      // Path B: full per-account list (up to 5 per kind) + the cap.
      accounts: listMicrosoftAccountViews(),
      maxPerKind: MAX_MS_ACCOUNTS_PER_KIND,
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

// POST /api/microsoft/connect — three shapes (see Google /connect):
//   ?slot=agent|user            reconnect/connect that kind's primary
//   ?add=true&kind=agent|user   add a NEW account to the kind (cap-enforced)
//   ?accountId=<id>             reconnect a specific existing account
microsoftRouter.post('/connect', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { redirectUri?: string };
    const redirectUri = body.redirectUri?.trim() || 'http://localhost:3001/api/microsoft/callback';

    let target: OAuthTarget;
    const accountIdQ = c.req.query('accountId');
    const add = c.req.query('add') === 'true';
    if (accountIdQ) {
      const acc = getMicrosoftAccount(accountIdQ);
      if (!acc) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      target = { kind: acc.kind, accountId: acc.id };
    } else if (add) {
      const kind = parseSlot(c.req.query('kind'));
      if (countMicrosoftAccounts(kind) >= MAX_MS_ACCOUNTS_PER_KIND) {
        return c.json({ ok: false, error: `Limit of ${MAX_MS_ACCOUNTS_PER_KIND} ${kind} Microsoft accounts reached.` }, 409);
      }
      target = { kind };
    } else {
      const slot = parseSlot(c.req.query('slot'));
      target = { kind: slot, accountId: getPrimaryMicrosoftAccount(slot)?.id };
    }

    const { authUrl } = buildAuthUrl(redirectUri, target);
    logger.info('Microsoft auth URL generated', { target, redirectUri });
    return c.json({ ok: true, data: { authUrl, redirectUri, kind: target.kind, accountId: target.accountId ?? null } });
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

  const flow = getFlowForState(state);
  if (!flow) {
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=Unknown+state+token.+Try+connecting+again.`);
  }

  const result = await exchangeCodeForTokens(code, flow.redirectUri, flow.verifier, flow.target);
  clearOAuthFlow(state);

  const slot = flow.target.kind;
  if (result.success) {
    logger.info('Microsoft OAuth successful', { slot, email: result.email, accountType: result.accountType });

    // Restart the Teams watcher so it re-scans all connected accounts.
    try {
      const { stopTeamsWatcher, startTeamsWatcher } = await import('../../services/teams-watcher.js');
      stopTeamsWatcher();
      startTeamsWatcher();
    } catch (err) {
      logger.warn('Failed to restart Teams watcher after Microsoft reconnect', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.redirect(`${dashboardBase}/settings?tab=microsoft&connected=true&slot=${slot}`);
  } else {
    logger.error('Microsoft token exchange failed', { slot, error: result.error });
    return c.redirect(`${dashboardBase}/settings?tab=microsoft&error=${encodeURIComponent(result.error ?? 'Token exchange failed')}`);
  }
});

// POST /api/microsoft/disconnect?slot=agent|user  (or ?accountId=)
microsoftRouter.post('/disconnect', (c) => {
  const accountId = c.req.query('accountId');
  if (accountId) {
    const acc = getMicrosoftAccount(accountId);
    if (!acc) return c.json({ ok: false, error: 'Unknown account.' }, 400);
    disconnectMicrosoftAccount(accountId);
    return c.json({ ok: true, data: { accountId, kind: acc.kind } });
  }
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

// PUT /api/microsoft/services?slot=agent|user  (or ?accountId=)
microsoftRouter.put('/services', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const body = await c.req.json() as Partial<{ outlook: boolean; calendar: boolean; onedrive: boolean; teams: boolean; contacts: boolean; onenote: boolean; tasks: boolean }>;
    if (accountId) {
      if (!getMicrosoftAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setEnabledMsServicesForAccount(accountId, body);
      return c.json({ ok: true, data: { accountId } });
    }
    setEnabledMsServices(body, parseSlot(c.req.query('slot')));
    return c.json({ ok: true, data: { slot: parseSlot(c.req.query('slot')) } });
  } catch { return c.json({ ok: false, error: 'Invalid request body' }, 400); }
});

// PUT /api/microsoft/watch-email?slot=agent|user  (or ?accountId=)
microsoftRouter.put('/watch-email', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json() as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled boolean is required' }, 400);
    }
    if (accountId) {
      if (!getMicrosoftAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setMsEmailMonitoringEnabledForAccount(accountId, body.enabled);
    } else {
      setMsEmailMonitoringEnabled(body.enabled, slot);
    }
    logger.info('Outlook email-monitoring toggled', { accountId: accountId ?? slot, enabled: body.enabled });

    // Bounce the watcher so a fresh enable picks up lastCheckedAt seeding.
    // See google route for the same pattern + rationale.
    try {
      const { stopOutlookWatcher, startOutlookWatcher } = await import('../../services/outlook-watcher.js');
      stopOutlookWatcher();
      startOutlookWatcher();
    } catch (err) {
      logger.warn('Failed to bounce Outlook watcher after toggle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ ok: true, data: { accountId: accountId ?? null, slot, enabled: body.enabled } });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
});

// PUT /api/microsoft/send-email?slot=agent|user  (or ?accountId=) — toggle the
// agent's permission to send/reply/forward. Pure config flip; enforced in the
// tool executor.
microsoftRouter.put('/send-email', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json() as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled boolean is required' }, 400);
    }
    if (accountId) {
      if (!getMicrosoftAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setMsEmailSendingEnabledForAccount(accountId, body.enabled);
    } else {
      setMsEmailSendingEnabled(body.enabled, slot);
    }
    logger.info('Outlook email-sending toggled', { accountId: accountId ?? slot, enabled: body.enabled });
    return c.json({ ok: true, data: { accountId: accountId ?? null, slot, enabled: body.enabled } });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
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
