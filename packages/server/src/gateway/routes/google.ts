// ════════════════════════════════════════
// Google Workspace API Routes — Native OAuth 2.0
// Multi-account (agent + user slots) as of v2.7.0.
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
  getFlowForState,
  clearOAuthFlow,
  disconnectGoogle,
  disconnectGoogleAccount,
  getMissingScopes,
  discoverGrantedScopes,
  isEmailMonitoringEnabled,
  setEmailMonitoringEnabled,
  setEmailMonitoringEnabledForAccount,
  isEmailSendingEnabled,
  setEmailSendingEnabled,
  setEmailSendingEnabledForAccount,
  setEnabledServicesForAccount,
  listGoogleAccountViews,
  ACCOUNT_SLOTS,
  type AccountSlot,
  type OAuthTarget,
} from '../../google/auth.js';
import {
  getGoogleAccount,
  getPrimaryGoogleAccount,
  countGoogleAccounts,
  MAX_ACCOUNTS_PER_KIND,
} from '../../google/accounts.js';
import { queryGoogleActivity, getTodayActivityCounts, getLastActivityTimestamp } from '../../google/activity-log.js';

const logger = createLogger('google-routes');

export const googleRouter = new Hono<AppEnv>();

/** Parse and validate the `slot` query param. Defaults to 'agent'. */
function parseSlot(value: string | undefined): AccountSlot {
  return value === 'user' ? 'user' : 'agent';
}

// GET /api/google/status — returns both slots' state in one payload
googleRouter.get('/status', async (c) => {
  // Probe granted scopes for each connected slot (no-op when already known).
  for (const slot of ACCOUNT_SLOTS) {
    await discoverGrantedScopes(slot);
  }

  const todayCounts = getTodayActivityCounts();
  const lastActivity = getLastActivityTimestamp();

  const slots: Record<AccountSlot, ReturnType<typeof buildSlotPayload>> = {
    agent: buildSlotPayload('agent'),
    user: buildSlotPayload('user'),
  };

  // Backward-compat top-level fields mirror the agent slot — existing
  // dashboards and integrations that read `enabled`/`connected`/`email`
  // directly keep working without modification.
  return c.json({
    ok: true,
    data: {
      // Per-slot detail (legacy: position-1 of each kind)
      slots,
      // Path B: full per-account list (up to 5 per kind) + the cap.
      accounts: listGoogleAccountViews(),
      maxPerKind: MAX_ACCOUNTS_PER_KIND,
      // Aggregate counters (not slot-specific)
      lastActivity,
      todayActivity: todayCounts,
      // Legacy single-account fields (= agent slot)
      enabled: slots.agent.enabled,
      connected: slots.agent.connected,
      email: slots.agent.email,
      services: slots.agent.services,
      lastVerified: slots.agent.lastVerified,
      missingScopes: slots.agent.missingScopes,
    },
  });
});

function buildSlotPayload(slot: AccountSlot) {
  const config = getGoogleWorkspaceConfig(slot);
  return {
    slot,
    enabled: config.enabled,
    connected: config.connected,
    email: config.accountEmail,
    services: config.enabledServices,
    lastVerified: config.lastVerifiedAt,
    missingScopes: getMissingScopes(slot),
    watchEmail: isEmailMonitoringEnabled(slot),
    sendEmail: isEmailSendingEnabled(slot),
  };
}

// POST /api/google/connect — start an OAuth flow. Three shapes:
//   ?slot=agent|user            reconnect/connect that kind's primary (back-compat)
//   ?add=true&kind=agent|user   add a NEW account to the kind (cap-enforced)
//   ?accountId=<id>             reconnect a specific existing account
googleRouter.post('/connect', (c) => {
  try {
    const url = new URL(c.req.url);
    const redirectUri = `${url.protocol}//${url.host}/api/google/callback`;

    let target: OAuthTarget;
    const accountIdQ = c.req.query('accountId');
    const add = c.req.query('add') === 'true';
    if (accountIdQ) {
      const acc = getGoogleAccount(accountIdQ);
      if (!acc) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      target = { kind: acc.kind, accountId: acc.id };
    } else if (add) {
      const kind = parseSlot(c.req.query('kind'));
      if (countGoogleAccounts(kind) >= MAX_ACCOUNTS_PER_KIND) {
        return c.json({ ok: false, error: `Limit of ${MAX_ACCOUNTS_PER_KIND} ${kind} Google accounts reached.` }, 409);
      }
      target = { kind };
    } else {
      const slot = parseSlot(c.req.query('slot'));
      // Reconnect the kind's primary (position-1) in place when it exists, so a
      // different email replaces it rather than spawning a second account.
      target = { kind: slot, accountId: getPrimaryGoogleAccount(slot)?.id };
    }

    const { authUrl } = buildAuthUrl(redirectUri, target);
    logger.info('Google OAuth flow started', { target, redirectUri });
    return c.json({ ok: true, data: { authUrl, kind: target.kind, accountId: target.accountId ?? null } });
  } catch (err) {
    return c.json({ ok: false, error: `Failed to start auth: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

// GET /api/google/callback — OAuth redirect handler (recovers slot from state)
googleRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    logger.error('Google OAuth error', { error });
    return c.html(`<html><body><h2>Google connection failed</h2><p>${error}</p><p>You can close this tab.</p><script>window.close()</script></body></html>`);
  }

  if (!code || !state) {
    return c.html('<html><body><h2>Missing authorization code or state</h2><p>You can close this tab.</p></body></html>');
  }

  // Recover the flow (kind + target account + redirect) from the state token.
  // The state→flow map is the authoritative "which flow is this completing."
  const flow = getFlowForState(state);
  if (!flow) {
    logger.warn('Google OAuth callback with unknown state', { state });
    return c.html('<html><body><h2>Invalid state parameter</h2><p>Please try connecting again from Settings.</p></body></html>');
  }

  const result = await exchangeCodeForTokens(code, flow.redirectUri, flow.verifier, flow.target);
  clearOAuthFlow(state);

  const slot = flow.target.kind;
  if (result.success) {
    logger.info('Google OAuth completed', { slot, email: result.email });
    const slotLabel = slot === 'user' ? "user's" : "agent's";
    return c.html(`<html><body><h2>Google Workspace connected!</h2><p>${slotLabel.charAt(0).toUpperCase() + slotLabel.slice(1)} account connected as ${result.email}.</p><p>You can close this tab and return to the Dojo.</p><script>window.close()</script></body></html>`);
  }

  logger.error('Google OAuth token exchange failed', { slot, error: result.error });
  return c.html(`<html><body><h2>Connection failed</h2><p>${result.error}</p><p>You can close this tab and try again from Settings.</p></body></html>`);
});

// POST /api/google/disconnect?slot=agent|user  (resets that kind's primary)
//                            ?accountId=<id>     (disconnects/removes one account)
googleRouter.post('/disconnect', (c) => {
  const accountId = c.req.query('accountId');
  if (accountId) {
    const acc = getGoogleAccount(accountId);
    if (!acc) return c.json({ ok: false, error: 'Unknown account.' }, 400);
    disconnectGoogleAccount(accountId);
    return c.json({ ok: true, data: { accountId, kind: acc.kind } });
  }
  const slot = parseSlot(c.req.query('slot'));
  disconnectGoogle(slot);
  return c.json({ ok: true, data: { slot } });
});

// POST /api/google/test?slot=agent|user — test a slot's connection
googleRouter.post('/test', async (c) => {
  const slot = parseSlot(c.req.query('slot'));
  const auth = await testGoogleAuth(slot);
  if (auth.authenticated) {
    setGoogleConnected(true, auth.email ?? undefined, slot);
    setGoogleEnabled(true, slot);
  }

  return c.json({
    ok: true,
    data: { working: auth.authenticated, email: auth.email, slot },
  });
});

// PUT /api/google/services?slot=agent|user  (or ?accountId=) — enable/disable
// services for a kind's primary account, or a specific account.
googleRouter.put('/services', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const body = await c.req.json() as Partial<{
      gmail: boolean;
      calendar: boolean;
      drive: boolean;
      docs: boolean;
      sheets: boolean;
      slides: boolean;
      forms: boolean;
    }>;

    if (accountId) {
      if (!getGoogleAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setEnabledServicesForAccount(accountId, body);
      logger.info('Google Workspace services updated', { accountId, ...body });
      return c.json({ ok: true, data: { accountId } });
    }
    const slot = parseSlot(c.req.query('slot'));
    setEnabledServices(body, slot);
    logger.info('Google Workspace services updated', { slot, ...body });
    return c.json({ ok: true, data: { slot } });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
});

// PUT /api/google/watch-email?slot=agent|user  (or ?accountId=) — toggle the
// Gmail watcher for a kind's primary account, or a specific account.
googleRouter.put('/watch-email', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json() as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled boolean is required' }, 400);
    }
    if (accountId) {
      if (!getGoogleAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setEmailMonitoringEnabledForAccount(accountId, body.enabled);
    } else {
      setEmailMonitoringEnabled(body.enabled, slot);
    }
    logger.info('Gmail email-monitoring toggled', { accountId: accountId ?? slot, enabled: body.enabled });

    // Bounce the watcher so the change takes effect immediately. The poll
    // loop reads isEmailMonitoringEnabled on every tick, so this is mostly
    // cosmetic for an enabled-true → enabled-false flip (next tick will
    // skip the slot anyway), but for a disabled → enabled flip on a freshly
    // connected slot the watcher needs the per-slot lastCheckedAt seeded —
    // which only happens in startGmailWatcher().
    try {
      const { stopGmailWatcher, startGmailWatcher, markGmailWatchBaselineNow } =
        await import('../../services/gmail-watcher.js');
      // Turning monitoring ON means "from now on": reset the cursor to now so the
      // restarted watcher notifies only mail arriving after this moment, never the
      // existing inbox (first enable) or mail that arrived while it was off (re-enable).
      if (body.enabled) markGmailWatchBaselineNow(accountId ?? slot);
      stopGmailWatcher();
      startGmailWatcher();
    } catch (err) {
      logger.warn('Failed to bounce Gmail watcher after toggle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ ok: true, data: { accountId: accountId ?? null, slot, enabled: body.enabled } });
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400);
  }
});

// PUT /api/google/send-email?slot=agent|user  (or ?accountId=) — toggle the
// agent's permission to send/reply/forward from a kind's primary account, or a
// specific account. Pure config flip; enforcement happens in the tool executor
// right before the Gmail API call. No watcher to bounce.
googleRouter.put('/send-email', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const slot = parseSlot(c.req.query('slot'));
    const body = await c.req.json() as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled boolean is required' }, 400);
    }
    if (accountId) {
      if (!getGoogleAccount(accountId)) return c.json({ ok: false, error: 'Unknown account.' }, 400);
      setEmailSendingEnabledForAccount(accountId, body.enabled);
    } else {
      setEmailSendingEnabled(body.enabled, slot);
    }
    logger.info('Gmail email-sending toggled', { accountId: accountId ?? slot, enabled: body.enabled });
    return c.json({ ok: true, data: { accountId: accountId ?? null, slot, enabled: body.enabled } });
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
