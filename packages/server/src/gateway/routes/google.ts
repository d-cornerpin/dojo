// ════════════════════════════════════════
// Google Workspace API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import {
  getGoogleWorkspaceConfig,
  testGwsAuth,
  setGoogleConnected,
  setGoogleEnabled,
  setEnabledServices,
  startAuthLogin,
  runGcloudSetup,
  startGcloudLogin,
  hasClientSecret,
} from '../../google/auth.js';
import { isGwsInstalled, getGwsVersion } from '../../google/client.js';
import { queryGoogleActivity, getTodayActivityCounts, getLastActivityTimestamp } from '../../google/activity-log.js';

const GWS_CONFIG_DIR = path.join(os.homedir(), '.config', 'gws');
const CLIENT_SECRET_PATH = path.join(GWS_CONFIG_DIR, 'client_secret.json');

const logger = createLogger('google-routes');

export const googleRouter = new Hono<AppEnv>();

// GET /api/google/status
googleRouter.get('/status', (c) => {
  const config = getGoogleWorkspaceConfig();
  const gwsInstalled = isGwsInstalled();
  const version = gwsInstalled ? getGwsVersion() : null;
  const gcloudInstalled = (() => {
    try { execSync('which gcloud', { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }); return true; } catch {
      return fs.existsSync('/opt/homebrew/share/google-cloud-sdk/bin/gcloud');
    }
  })();
  const credentialsExist = fs.existsSync(CLIENT_SECRET_PATH);
  const todayCounts = getTodayActivityCounts();
  const lastActivity = getLastActivityTimestamp();

  return c.json({
    ok: true,
    data: {
      installed: gwsInstalled,
      gcloudInstalled,
      hasCredentials: credentialsExist,
      version,
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

// POST /api/google/connect
googleRouter.post('/connect', (c) => {
  if (!isGwsInstalled()) {
    return c.json({ ok: false, error: 'gws CLI is not installed. Run: npm install -g @googleworkspace/cli' }, 400);
  }

  try {
    const { pid } = startAuthLogin();
    logger.info('Started gws auth login', { pid });
    return c.json({ ok: true, data: { message: 'Auth login started. Complete the Google sign-in in your browser.', pid } });
  } catch (err) {
    return c.json({ ok: false, error: `Failed to start auth: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

// POST /api/google/disconnect
googleRouter.post('/disconnect', (c) => {
  setGoogleConnected(false);
  setGoogleEnabled(false);
  logger.info('Google Workspace disconnected');
  return c.json({ ok: true });
});

// POST /api/google/test
googleRouter.post('/test', (c) => {
  if (!isGwsInstalled()) {
    return c.json({ ok: true, data: { working: false, error: 'gws CLI not installed' } });
  }

  const auth = testGwsAuth();
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

// PUT /api/google/services
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
  } catch (err) {
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

// GET /api/google/install-check
// Used by the OOBE wizard to check if gws is installed
googleRouter.get('/install-check', (c) => {
  const installed = isGwsInstalled();
  const version = installed ? getGwsVersion() : null;
  return c.json({ ok: true, data: { installed, version } });
});

// GET /api/google/gcloud-status
// Lightweight check: is gcloud authed and does it have a project?
googleRouter.get('/gcloud-status', (c) => {
  const GCLOUD_PATH = '/opt/homebrew/share/google-cloud-sdk/bin/gcloud';
  const EXTENDED_PATH = [
    '/opt/homebrew/share/google-cloud-sdk/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH ?? '',
  ].join(':');
  const env = { ...process.env, PATH: EXTENDED_PATH };

  // Check if gcloud is even installed
  try {
    execSync('which gcloud', { encoding: 'utf-8', timeout: 3000, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // Also check the known Homebrew path directly
    if (!fs.existsSync(GCLOUD_PATH)) {
      return c.json({ ok: true, data: { loggedIn: false, installed: false } });
    }
  }

  try {
    const account = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
      encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!account) return c.json({ ok: true, data: { loggedIn: false, installed: true } });

    let projectId = execSync('gcloud config get-value project', {
      encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (projectId === '(unset)') projectId = '';

    return c.json({ ok: true, data: { loggedIn: true, installed: true, email: account, projectId: projectId || null } });
  } catch {
    return c.json({ ok: true, data: { loggedIn: false, installed: true } });
  }
});

// POST /api/google/gcloud-login
// Start interactive gcloud auth login (opens browser)
googleRouter.post('/gcloud-login', (c) => {
  try {
    const { pid } = startGcloudLogin();
    return c.json({ ok: true, data: { pid, message: 'Browser opened for Google sign-in' } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/google/gcloud-setup
// Run gcloud project setup (after user has logged in via gcloud-login)
googleRouter.post('/gcloud-setup', (c) => {
  const result = runGcloudSetup();
  if (result.success) {
    return c.json({ ok: true, data: { email: result.email, projectId: result.projectId } });
  }
  return c.json({ ok: false, error: result.error }, 400);
});

// GET /api/google/credentials-check
// Check if client_secret.json is in place
googleRouter.get('/credentials-check', (c) => {
  const exists = fs.existsSync(CLIENT_SECRET_PATH);
  return c.json({ ok: true, data: { hasCredentials: exists } });
});

// POST /api/google/credentials
// Accept client_secret.json content and write it to ~/.config/gws/
googleRouter.post('/credentials', async (c) => {
  try {
    const body = await c.req.json() as { clientSecret: string };
    if (!body.clientSecret) {
      return c.json({ ok: false, error: 'clientSecret is required' }, 400);
    }

    // Validate it's valid JSON with expected fields
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.clientSecret);
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON. Make sure you pasted the full contents of client_secret.json.' }, 400);
    }

    // Google client_secret.json has a "installed" or "web" key at the top level
    if (!parsed.installed && !parsed.web) {
      return c.json({ ok: false, error: 'This doesn\'t look like a Google OAuth client_secret.json file. It should have an "installed" or "web" key.' }, 400);
    }

    // Ensure directory exists
    fs.mkdirSync(GWS_CONFIG_DIR, { recursive: true });

    // Write the file
    fs.writeFileSync(CLIENT_SECRET_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
    logger.info('Google OAuth credentials saved', { path: CLIENT_SECRET_PATH });

    return c.json({ ok: true, data: { saved: true } });
  } catch (err) {
    return c.json({ ok: false, error: `Failed to save credentials: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});
