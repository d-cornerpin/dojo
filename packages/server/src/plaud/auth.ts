// Plaud auth and connection state: owns the "is Plaud connected?" question. The OAuth tokens live in
// ~/.plaud/tokens.json (managed by the CLI); status and email are cached in the config table.

import { plaudExpiredText } from '../agent/engine-lines.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { runPlaudCommand, runPlaudJson } from './client.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

const logger = createLogger('plaud-auth');

const CONFIG_KEY_CONNECTED = 'plaud_connected';
const CONFIG_KEY_EMAIL = 'plaud_email';
const CONFIG_KEY_CONNECTED_AT = 'plaud_connected_at';

export interface PlaudStatus {
  connected: boolean;
  /** Derived: a connect stamp with `plaud_connected` false means the login expired. */
  reauthRequired: boolean;
  email: string | null;
  connectedAt: string | null;
  loginInProgress: boolean;
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
  setConfigValue(key, value);
  // Connect state gates the Plaud tools in getFilteredTools; every path funnels through here.
  if (key === CONFIG_KEY_CONNECTED) bumpToolConfigGeneration();
}

function deleteConfigValue(key: string): void {
  getDb().prepare('DELETE FROM config WHERE key = ?').run(key);
  if (key === CONFIG_KEY_CONNECTED) bumpToolConfigGeneration();
}

export function isPlaudConnected(): boolean {
  return readConfigValue(CONFIG_KEY_CONNECTED) === 'true';
}

export function getPlaudStatus(): PlaudStatus {
  const connected = isPlaudConnected();
  const connectedAt = readConfigValue(CONFIG_KEY_CONNECTED_AT);
  return {
    connected,
    reauthRequired: !connected && connectedAt !== null,
    email: readConfigValue(CONFIG_KEY_EMAIL),
    connectedAt,
    loginInProgress: loginProcess !== null,
    loginUrl: pendingLoginUrl,
  };
}

/**
 * The one owner of the expiry transition. The stored `plaud_connected` flag is the episode latch: the
 * first failing call flips it to false and speaks, later calls see it false and stay silent.
 * Speaks via the `chat:error` toast (stays until dismissed) to `agentId`; with none, only state and card move.
 * @returns true if this call was the transition.
 */
export function notePlaudReauthRequired(agentId?: string | null): boolean {
  if (!isPlaudConnected()) return false;
  writeConfigValue(CONFIG_KEY_CONNECTED, 'false');
  // The email and connect stamp survive so the card can name the expired account;
  // `plaud_connected` alone decides connectedness. A real `logout` wipes both.
  logger.info('Plaud login expired (reauth required)', { agentId: agentId ?? null });
  try { broadcast({ type: 'plaud:disconnected' }); } catch { /* best effort */ }
  if (agentId) {
    try {
      broadcast({
        type: 'chat:error',
        agentId,
        // The Dojo speaks, never "I"; the agent is told.
        error: plaudExpiredText(),
        code: 'AUTH_INVALID',
        severity: 'error',
        cardClass: 'action',   // the user signs in again
        retryable: false,
      });
      void import('../agent/dojo-voice.js').then(({ tellAgentWhatDojoSent }) => tellAgentWhatDojoSent({
        agentId, recipient: 'the owner (a dashboard card)', text: plaudExpiredText(), why: 'because the Plaud login expired',
      })).catch(() => undefined);
    } catch { /* best effort */ }
  }
  return true;
}

/**
 * Refresh the connection state by calling `plaud me`. Connected with a null email means the output
 * shape was unknown; treat it as connected. Not connected means tokens are missing or expired.
 */
export async function refreshPlaudAccountInfo(): Promise<{ connected: boolean; email: string | null }> {
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
    // Single owner of the expiry transition; the email survives so the card can name the account.
    notePlaudReauthRequired(null);
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

// One login at a time: `login` prints an OAuth URL the user must visit. We spawn it, scan its output for the
// URL and broadcast it; exit 0 means connected, non-zero means failed.

let loginProcess: ChildProcess | null = null;
let pendingLoginUrl: string | null = null;

/**
 * Start the Plaud login flow and broadcast the auth URL as `plaud:auth_url`; exit fires `plaud:connected`
 * or `plaud:login_failed`. Returns `{ alreadyRunning: true }` if a login is in flight.
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
      // Keep the CLI from opening a browser on a headless server; it then prints the URL.
      BROWSER: 'none',
      NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loginProcess = child;

  // The URL may print on either stream, so scan both.
  const urlPattern = /(https?:\/\/[^\s)]+)/;
  const handleChunk = (source: 'stdout' | 'stderr') => (buf: Buffer) => {
    const text = buf.toString('utf8');
    logger.debug('Plaud login subprocess output', { source, text: text.slice(0, 500) });
    if (!pendingLoginUrl) {
      const match = text.match(urlPattern);
      if (match) {
        pendingLoginUrl = match[1];
        logger.info('Plaud auth URL captured', { url: pendingLoginUrl });
        broadcast({ type: 'plaud:auth_url', url: pendingLoginUrl });
      }
    }
  };
  child.stdout?.on('data', handleChunk('stdout'));
  child.stderr?.on('data', handleChunk('stderr'));

  child.on('exit', async (code, signal) => {
    logger.info('Plaud login subprocess exited', { code, signal });
    // A child that is no longer the live login was cancelled or replaced; its
    // exit must not clear the current login's state or report a failure.
    if (loginProcess !== child) return;
    const wasSuccessful = code === 0;
    loginProcess = null;
    pendingLoginUrl = null;

    if (wasSuccessful) {
      // Exit 0 means the tokens were written: mark connected now. The `me` call after is a best-effort
      // email fetch; without it the user is still connected.
      writeConfigValue(CONFIG_KEY_CONNECTED, 'true');
      writeConfigValue(CONFIG_KEY_CONNECTED_AT, new Date().toISOString());
      const info = await refreshPlaudAccountInfo();
      broadcast({ type: 'plaud:connected', email: info.email });
    } else {
      broadcast({
        type: 'plaud:login_failed',
        error: `Plaud CLI exited with code ${code ?? signal ?? 'unknown'}.`,
      });
    }
  });

  child.on('error', (err) => {
    logger.error('Plaud login subprocess error', { error: err.message });
    // Same stale-child guard as the exit handler.
    if (loginProcess !== child) return;
    loginProcess = null;
    pendingLoginUrl = null;
    broadcast({ type: 'plaud:login_failed', error: err.message });
  });

  return { started: true };
}

/** Cancel an in-flight login subprocess (the Connect modal's Cancel button). */
export function cancelPlaudLogin(): { cancelled: boolean } {
  if (loginProcess === null) return { cancelled: false };
  try { loginProcess.kill('SIGTERM'); } catch { /* best effort */ }
  loginProcess = null;
  pendingLoginUrl = null;
  return { cancelled: true };
}

/** Run `plaud logout` and clear our config-table connection state. */
export async function plaudLogout(): Promise<{ ok: boolean; error?: string }> {
  if (loginProcess !== null) {
    cancelPlaudLogin();
  }
  const result = await runPlaudCommand(['logout'], { timeoutMs: 15_000 });
  // Wipe our state even if the CLI fails, so the UI shows disconnected.
  writeConfigValue(CONFIG_KEY_CONNECTED, 'false');
  deleteConfigValue(CONFIG_KEY_EMAIL);
  deleteConfigValue(CONFIG_KEY_CONNECTED_AT);
  broadcast({ type: 'plaud:disconnected' });
  if (!result.ok && !/not.{0,5}logged in|no session/i.test(result.stderr + result.stdout)) {
    return { ok: false, error: result.error ?? 'Plaud logout failed.' };
  }
  return { ok: true };
}
