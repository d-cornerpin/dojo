// ════════════════════════════════════════
// Google Workspace Auth Status & Connection Management
// ════════════════════════════════════════

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isGwsInstalled } from './client.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('gws-auth');

export interface GoogleWorkspaceConfig {
  enabled: boolean;
  connected: boolean;
  accountEmail: string | null;
  enabledServices: {
    gmail: boolean;
    calendar: boolean;
    drive: boolean;
    docs: boolean;
    sheets: boolean;
    slides: boolean;
  };
  lastVerifiedAt: string | null;
}

const DEFAULT_SERVICES = {
  gmail: true,
  calendar: true,
  drive: true,
  docs: true,
  sheets: true,
  slides: true,
};

// ── Config Getters ──

function getConfigValue(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setConfigValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

export function getGoogleWorkspaceConfig(): GoogleWorkspaceConfig {
  const servicesRaw = getConfigValue('gws_enabled_services');
  let services = { ...DEFAULT_SERVICES };
  if (servicesRaw) {
    try {
      services = { ...DEFAULT_SERVICES, ...JSON.parse(servicesRaw) };
    } catch { /* use defaults */ }
  }

  return {
    enabled: getConfigValue('gws_enabled') === 'true',
    connected: getConfigValue('gws_connected') === 'true',
    accountEmail: getConfigValue('gws_account_email'),
    enabledServices: services,
    lastVerifiedAt: getConfigValue('gws_last_verified_at'),
  };
}

export function isGoogleEnabled(): boolean {
  return getConfigValue('gws_enabled') === 'true';
}

export function isGoogleConnected(): boolean {
  return getConfigValue('gws_connected') === 'true';
}

export function getEnabledServices(): GoogleWorkspaceConfig['enabledServices'] {
  const config = getGoogleWorkspaceConfig();
  return config.enabledServices;
}

// ── Config Setters ──

export function setGoogleEnabled(enabled: boolean): void {
  setConfigValue('gws_enabled', String(enabled));
}

export function setGoogleConnected(connected: boolean, email?: string): void {
  setConfigValue('gws_connected', String(connected));
  if (email) {
    setConfigValue('gws_account_email', email);
  }
  if (connected) {
    setConfigValue('gws_last_verified_at', new Date().toISOString());
    broadcast({ type: 'google:connected', data: { email: email ?? '' } } as never);
  } else {
    broadcast({ type: 'google:disconnected' } as never);
  }
}

export function setEnabledServices(services: Partial<GoogleWorkspaceConfig['enabledServices']>): void {
  const current = getEnabledServices();
  const updated = { ...current, ...services };
  setConfigValue('gws_enabled_services', JSON.stringify(updated));
}

// ── Auth Verification ──

/**
 * Test whether gws is authenticated by making a lightweight Drive API call.
 * Returns the account email if authenticated, null otherwise.
 */
export function testGwsAuth(): { authenticated: boolean; email: string | null } {
  if (!isGwsInstalled()) {
    return { authenticated: false, email: null };
  }

  try {
    // Use gws auth status to check if authenticated — doesn't make any API calls,
    // just checks local credential state. More reliable than making a Drive API call
    // which can fail due to scope issues, API not enabled, etc.
    const result = execSync(
      'gws auth status',
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: EXTENDED_PATH } },
    );

    // gws auth status outputs to stderr first ("Using keyring backend: keyring"), then JSON to stdout
    // Try to parse JSON from the output
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { authenticated: false, email: null };

    const parsed = JSON.parse(jsonMatch[0]);
    const email = parsed?.user ?? null;
    const hasToken = parsed?.token_valid === true || parsed?.has_refresh_token === true;
    const isAuthed = parsed?.auth_method === 'oauth2' && hasToken;

    if (isAuthed && email) {
      setConfigValue('gws_last_verified_at', new Date().toISOString());
      return { authenticated: true, email };
    }

    return { authenticated: false, email: null };
  } catch (err) {
    // gws auth status may output JSON on stderr — try capturing that
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const stdout = (err as { stdout?: string })?.stdout ?? '';
    const combined = stdout + stderr;
    try {
      const jsonMatch = combined.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const email = parsed?.user ?? null;
        const hasToken = parsed?.token_valid === true || parsed?.has_refresh_token === true;
        if (parsed?.auth_method === 'oauth2' && hasToken && email) {
          setConfigValue('gws_last_verified_at', new Date().toISOString());
          return { authenticated: true, email };
        }
      }
    } catch { /* ignore parse errors */ }

    logger.warn('gws auth test failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { authenticated: false, email: null };
  }
}

// Extended PATH to find gcloud and gws (Homebrew, /usr/local, and npm-global fallback)
const EXTENDED_PATH = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/share/google-cloud-sdk/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
].join(':');

/**
 * Start the gws auth login flow (assumes client_secret.json is already in place).
 * Captures stdout to detect the OAuth URL and opens it in the browser manually,
 * since gws can't always open the browser from a child process.
 */
export function startAuthLogin(): { pid: number | undefined } {
  const env = { ...process.env, PATH: EXTENDED_PATH };

  const child = spawn('gws', ['auth', 'login'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env,
  });

  let urlOpened = false;

  const handleOutput = (data: Buffer) => {
    const text = data.toString();
    // Log output so it's visible in server console
    process.stderr.write(text);

    // Detect OAuth URL and open it in the browser
    if (!urlOpened) {
      const urlMatch = text.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+)/);
      if (urlMatch) {
        urlOpened = true;
        const url = urlMatch[1];
        logger.info('Opening Google OAuth URL in browser', { url: url.slice(0, 80) + '...' });
        try {
          execSync(`open "${url}"`, { timeout: 5000 });
        } catch (err) {
          logger.error('Failed to open browser', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };

  child.stdout?.on('data', handleOutput);
  child.stderr?.on('data', handleOutput);

  child.on('error', (err) => {
    logger.error('gws auth login failed to start', { error: err.message });
  });

  child.on('exit', (code) => {
    logger.info('gws auth login exited', { code });
    const auth = testGwsAuth();
    if (auth.authenticated) {
      setGoogleConnected(true, auth.email ?? undefined);
      setGoogleEnabled(true);
      logger.info('Google Workspace connected after auth login', { email: auth.email });
    }
  });

  return { pid: child.pid };
}

/**
 * Run `gws auth setup` to log into Google Cloud and select/create a project.
 * Returns the project ID and project-specific console URLs for the user.
 */
export function runGcloudSetup(): { success: boolean; email?: string; projectId?: string; error?: string } {
  const env = { ...process.env, PATH: EXTENDED_PATH };

  // Check if gcloud is already authed
  try {
    const account = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
      encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!account) {
      // Not logged in — need interactive login, can't do from API
      return { success: false, error: 'not_logged_in' };
    }

    // Get current project
    let projectId = execSync('gcloud config get-value project', {
      encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // If no project, try to find one or create one
    if (!projectId || projectId === '(unset)') {
      const projects = execSync('gcloud projects list --format="value(projectId)" --limit=1', {
        encoding: 'utf-8', timeout: 15000, env, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (projects) {
        projectId = projects.split('\n')[0];
        execSync(`gcloud config set project ${projectId}`, {
          encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        // Create a new project
        projectId = `dojo-${Date.now().toString(36)}`;
        try {
          execSync(`gcloud projects create ${projectId} --name="Agent DOJO"`, {
            encoding: 'utf-8', timeout: 30000, env, stdio: ['pipe', 'pipe', 'pipe'],
          });
          execSync(`gcloud config set project ${projectId}`, {
            encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          return { success: false, error: `Failed to create project: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }

    // Enable required APIs
    const apis = ['gmail.googleapis.com', 'calendar-json.googleapis.com', 'drive.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'slides.googleapis.com'];
    for (const api of apis) {
      try {
        execSync(`gcloud services enable ${api}`, {
          encoding: 'utf-8', timeout: 30000, env, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* may already be enabled or billing not set up — continue */ }
    }

    return { success: true, email: account, projectId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start interactive gcloud auth login (opens browser itself).
 */
export function startGcloudLogin(): { pid: number | undefined } {
  const env = { ...process.env, PATH: EXTENDED_PATH };
  const child = spawn('gcloud', ['auth', 'login'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
    env,
  });

  child.on('error', (err) => {
    logger.error('gcloud auth login failed', { error: err.message });
  });
  return { pid: child.pid };
}

/**
 * Check if client_secret.json exists at the expected path.
 */
export function hasClientSecret(): boolean {
  const secretPath = path.join(os.homedir(), '.config', 'gws', 'client_secret.json');
  return fs.existsSync(secretPath);
}

/**
 * Check gws auth on startup and log status.
 */
export function checkGwsOnStartup(): void {
  if (!isGwsInstalled()) {
    logger.warn('gws CLI is not installed — Google Workspace integration unavailable. Install with: npm install -g @googleworkspace/cli');
    return;
  }

  const version = (() => {
    try {
      return execSync('gws --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { return 'unknown'; }
  })();
  logger.info('gws CLI detected', { version });

  // If previously connected, verify auth is still valid
  if (isGoogleConnected()) {
    const auth = testGwsAuth();
    if (auth.authenticated) {
      logger.info('Google Workspace auth verified', { email: auth.email });
    } else {
      logger.warn('Google Workspace auth expired or invalid — marking as disconnected');
      setGoogleConnected(false);
    }
  }
}

/**
 * Get the Google Workspace access level for a given agent.
 * - "full": primary agent — all read + write tools
 * - "read": trainer, ronin, apprentice — read-only tools
 * - "none": PM agent — no Google tools
 *
 * Caller must pass isPrimary/isPM booleans to avoid circular imports.
 */
export function getAgentGoogleAccessLevel(agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  if (!isGoogleEnabled() || !isGoogleConnected()) return 'none';

  if (isPM) return 'none';
  if (isPrimary) return 'full';

  // All other agents (trainer, ronin, apprentice) get read-only
  return 'read';
}
