// ════════════════════════════════════════
// Plaud Auth + Connection State
// Owns the "is Plaud connected?" question for the rest of the platform.
// The actual OAuth tokens live in ~/.plaud/tokens.json (managed by the
// Plaud CLI itself). We track connection status + account email in the
// config table so the dashboard and agent prompts don't have to shell
// out for every check.
// ════════════════════════════════════════

import { spawn, type ChildProcess } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { runPlaudCommand, runPlaudJson } from './client.js';

const logger = createLogger('plaud-auth');

const CONFIG_KEY_CONNECTED = 'plaud_connected';
const CONFIG_KEY_EMAIL = 'plaud_email';
const CONFIG_KEY_CONNECTED_AT = 'plaud_connected_at';

export interface PlaudStatus {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  /** True while an interactive `plaud login` subprocess is running. */
  loginInProgress: boolean;
  /** The auth URL the CLI emitted, if a login is in progress. */
  loginUrl: string | null;
}

function readConfigValue(key: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeConfigValue(key: string, value: string): void {
  getDb()
    .prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `)
    .run(key, value);
}

function deleteConfigValue(key: string): void {
  getDb().prepare('DELETE FROM config WHERE key = ?').run(key);
}

export function isPlaudConnected(): boolean {
  return readConfigValue(CONFIG_KEY_CONNECTED) === 'true';
}

export function getPlaudStatus(): PlaudStatus {
  return {
    connected: isPlaudConnected(),
    email: readConfigValue(CONFIG_KEY_EMAIL),
    connectedAt: readConfigValue(CONFIG_KEY_CONNECTED_AT),
    loginInProgress: loginProcess !== null,
    loginUrl: pendingLoginUrl,
  };
}

/**
 * Refresh the connection state by calling `plaud me`. Returns:
 *   - { connected: true, email }  - tokens are valid, email parsed
 *   - { connected: true, email: null } - tokens are valid but the email
 *     couldn't be extracted from the CLI output (shape unknown). Caller
 *     should still treat this as connected; the email is just unavailable.
 *   - { connected: false } - tokens missing/expired, reauth required.
 */
export async function refreshPlaudAccountInfo(): Promise<{ connected: boolean; email: string | null }> {
  // Try JSON form first.
  const jsonResult = await runPlaudJson<Record<string, unknown>>(['me', '--json'], { timeoutMs: 15_000 });
  if (jsonResult.ok) {
    const email = extractEmailFromJson(jsonResult.data);
    persistConnectedState(email);
    return { connected: true, email };
  }
  // Some CLI versions don't support --json on `me`; fall back to plain.
  const plainResult = await runPlaudCommand(['me'], { timeoutMs: 15_000 });
  if (plainResult.ok) {
    const email = extractEmailFromText(plainResult.stdout);
    persistConnectedState(email);
    if (!email) {
      logger.warn('Plaud login succeeded but email could not be parsed from output', {
        stdoutSample: plainResult.stdout.slice(0, 500),
      });
    }
    return { connected: true, email };
  }
  // Both failed - probably actually disconnected (no tokens, expired, etc).
  if (plainResult.needsReauth || jsonResult.needsReauth) {
    logger.info('Plaud disconnected (reauth required)');
    writeConfigValue(CONFIG_KEY_CONNECTED, 'false');
    deleteConfigValue(CONFIG_KEY_EMAIL);
  } else {
    logger.warn('Plaud `me` command failed (both --json and plain)', {
      jsonError: jsonResult.error,
      plainError: plainResult.error,
    });
  }
  return { connected: false, email: null };
}

function extractEmailFromJson(data: Record<string, unknown>): string | null {
  // Plaud CLI output shape is loosely documented; check the common spots.
  const direct = data.email ?? data.userEmail ?? data.mail;
  if (typeof direct === 'string' && direct.includes('@')) return direct;
  const user = data.user as Record<string, unknown> | undefined;
  if (user) {
    const nested = user.email ?? user.userEmail ?? user.mail;
    if (typeof nested === 'string' && nested.includes('@')) return nested;
  }
  const profile = data.profile as Record<string, unknown> | undefined;
  if (profile) {
    const pnested = profile.email ?? profile.userEmail;
    if (typeof pnested === 'string' && pnested.includes('@')) return pnested;
  }
  // Last resort: scan stringified JSON for an email pattern.
  return extractEmailFromText(JSON.stringify(data));
}

function extractEmailFromText(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function persistConnectedState(email: string | null): void {
  writeConfigValue(CONFIG_KEY_CONNECTED, 'true');
  if (email) {
    writeConfigValue(CONFIG_KEY_EMAIL, email);
  }
  if (!readConfigValue(CONFIG_KEY_CONNECTED_AT)) {
    writeConfigValue(CONFIG_KEY_CONNECTED_AT, new Date().toISOString());
  }
}

// ── Login subprocess management ───────────────────────────────────────
// One login at a time. The Plaud CLI's `login` subcommand opens a browser
// or prints an OAuth URL the user must visit. We spawn it as a long-
// running child process, scan stdout for the URL, broadcast that to the
// dashboard, and watch for the process to exit (success → connected;
// non-zero → failed).

let loginProcess: ChildProcess | null = null;
let pendingLoginUrl: string | null = null;

export function isLoginInProgress(): boolean {
  return loginProcess !== null;
}

/**
 * Start the Plaud login flow. Spawns `npx -y @plaud-ai/cli login` and
 * captures the auth URL from stdout. The URL is broadcast over WebSocket
 * as `plaud:auth_url` so the dashboard can render a "Click here to
 * authorize" link. The subprocess's exit fires `plaud:connected` (or
 * `plaud:login_failed`).
 *
 * Returns immediately with `{ alreadyRunning: true }` if a login is
 * already in flight.
 */
export async function startPlaudLogin(): Promise<{ started: boolean; alreadyRunning?: boolean }> {
  if (loginProcess !== null) {
    return { started: false, alreadyRunning: true };
  }

  pendingLoginUrl = null;
  const child = spawn('npx', ['-y', '@plaud-ai/cli@latest', 'login'], {
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
      // Discourage the CLI from trying to open a browser locally - in a
      // headless server context that just confuses the OAuth flow. The
      // CLI should fall back to printing the URL.
      BROWSER: 'none',
      NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loginProcess = child;

  // Watch both stdout and stderr for the auth URL. Plaud CLI is not
  // strict about which stream the URL prints on, so scan both.
  const urlPattern = /(https?:\/\/[^\s)]+)/;
  const handleChunk = (source: 'stdout' | 'stderr') => (buf: Buffer) => {
    const text = buf.toString('utf8');
    logger.debug('Plaud login subprocess output', { source, text: text.slice(0, 500) });
    if (!pendingLoginUrl) {
      const match = text.match(urlPattern);
      if (match) {
        pendingLoginUrl = match[1];
        logger.info('Plaud auth URL captured', { url: pendingLoginUrl });
        broadcast({ type: 'plaud:auth_url', url: pendingLoginUrl } as never);
      }
    }
  };
  child.stdout?.on('data', handleChunk('stdout'));
  child.stderr?.on('data', handleChunk('stderr'));

  child.on('exit', async (code, signal) => {
    logger.info('Plaud login subprocess exited', { code, signal });
    const wasSuccessful = code === 0;
    loginProcess = null;
    pendingLoginUrl = null;

    if (wasSuccessful) {
      // Login subprocess exited cleanly - the OAuth flow finished and
      // tokens were written. Mark connected immediately. The follow-up
      // `me` call is a best-effort email fetch; if it doesn't work, the
      // user is still connected (agent tools will function), the
      // dashboard just won't display their email.
      writeConfigValue(CONFIG_KEY_CONNECTED, 'true');
      writeConfigValue(CONFIG_KEY_CONNECTED_AT, new Date().toISOString());
      const info = await refreshPlaudAccountInfo();
      broadcast({ type: 'plaud:connected', email: info.email } as never);
    } else {
      broadcast({
        type: 'plaud:login_failed',
        error: `Plaud CLI exited with code ${code ?? signal ?? 'unknown'}.`,
      } as never);
    }
  });

  child.on('error', (err) => {
    logger.error('Plaud login subprocess error', { error: err.message });
    loginProcess = null;
    pendingLoginUrl = null;
    broadcast({ type: 'plaud:login_failed', error: err.message } as never);
  });

  return { started: true };
}

/**
 * Cancel an in-flight login subprocess. Used when the user clicks
 * "Cancel" on the Connect modal before completing the OAuth flow.
 */
export function cancelPlaudLogin(): { cancelled: boolean } {
  if (loginProcess === null) return { cancelled: false };
  try { loginProcess.kill('SIGTERM'); } catch { /* best effort */ }
  loginProcess = null;
  pendingLoginUrl = null;
  return { cancelled: true };
}

/**
 * Log out of Plaud - runs `plaud logout` which clears
 * ~/.plaud/tokens.json. Also clears our config-table connection state.
 */
export async function plaudLogout(): Promise<{ ok: boolean; error?: string }> {
  if (loginProcess !== null) {
    cancelPlaudLogin();
  }
  const result = await runPlaudCommand(['logout'], { timeoutMs: 15_000 });
  // Even if the CLI fails (e.g., no session), wipe our state so the UI
  // shows disconnected. The user can re-Connect cleanly.
  writeConfigValue(CONFIG_KEY_CONNECTED, 'false');
  deleteConfigValue(CONFIG_KEY_EMAIL);
  deleteConfigValue(CONFIG_KEY_CONNECTED_AT);
  broadcast({ type: 'plaud:disconnected' } as never);
  if (!result.ok && !/not.{0,5}logged in|no session/i.test(result.stderr + result.stdout)) {
    return { ok: false, error: result.error ?? 'Plaud logout failed.' };
  }
  return { ok: true };
}
