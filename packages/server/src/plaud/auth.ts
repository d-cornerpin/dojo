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
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

const logger = createLogger('plaud-auth');

const CONFIG_KEY_CONNECTED = 'plaud_connected';
const CONFIG_KEY_EMAIL = 'plaud_email';
const CONFIG_KEY_CONNECTED_AT = 'plaud_connected_at';

export interface PlaudStatus {
  connected: boolean;
  /**
   * UX-REPAIR T38: the card needs THREE states, not two. "Never connected" and
   * "was connected, the login expired" are different things to say to a person,
   * and only the second one is an instruction. Derived, not stored: a
   * `plaud_connected_at` stamp with `plaud_connected` false is a login that
   * used to work — which is exactly `notePlaudReauthRequired`'s transition.
   */
  reauthRequired: boolean;
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
  // FA-TS1: connect/disconnect flips isPlaudConnected(), which gates the Plaud
  // tool block in getFilteredTools. All connect/disconnect paths funnel the
  // connected flag through here, so one guard covers them.
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
 * UX-REPAIR T38 — THE ONE OWNER OF THE EXPIRY TRANSITION.
 *
 * OWNER REPORT: when the Plaud login expires, nothing tells the user. The
 * expiry was always DETECTED — `runPlaudCommand` computes `needsReauth` from
 * the CLI's exit code 2 — and then thrown away: the eight `plaud_*` tools
 * turned it into a sentence for the MODEL and returned, so the stored
 * `plaud_connected` flag stayed `true`, the card kept saying "Connected as
 * … since 25 May", the tool gate kept offering the tools, and the person who
 * had to go and renew the login heard nothing. The only path that flipped the
 * flag, `refreshPlaudAccountInfo`, is reachable only from a route no UI calls.
 *
 * THE STORED FLAG IS THE EPISODE LATCH. No new state, no timer, no counter:
 * the first failing call flips `plaud_connected` to false and speaks; every
 * later call in the same episode sees it already false and says nothing (T27's
 * lesson — once per episode, not once per call). A reconnect sets it true
 * again, which arms the next episode.
 *
 * IT SPEAKS THROUGH THE EXISTING TOAST PATH AND NO OTHER (owner directive):
 * `chat:error` → `Chat.tsx`'s severity switch, at severity `error`, which that
 * switch defines as "stays until dismissed". A login the user must go and renew
 * is not something to auto-dismiss out from under them. The `AUTH_INVALID` code
 * already exists for exactly this class ("the engine can't proceed and the user
 * needs to act"), so no code is invented either.
 *
 * `agentId` is the agent whose tool call hit the expiry — the toast lane is
 * per-agent (`Chat.tsx` filters on it), and that agent's conversation is where
 * the failure just happened. Null when nothing agent-shaped is in hand (the
 * status/refresh route): the state still moves and the card is still told; only
 * the toast is skipped, because addressing one to an invented agent would put it
 * in a chat where nothing happened.
 *
 * @returns true if this call was the transition (and therefore spoke).
 */
export function notePlaudReauthRequired(agentId?: string | null): boolean {
  if (!isPlaudConnected()) return false;
  writeConfigValue(CONFIG_KEY_CONNECTED, 'false');
  // The email and the connect stamp DELIBERATELY survive: they describe the
  // account whose login expired, which is what the card needs to name so the
  // user knows WHICH login to renew. `plaud_connected` is the only authority on
  // connectedness (it is what `isPlaudConnected` reads), so keeping the address
  // changes no gate. A real `logout` still wipes both.
  logger.info('Plaud login expired (reauth required)', { agentId: agentId ?? null });
  try { broadcast({ type: 'plaud:disconnected' }); } catch { /* best effort */ }
  if (agentId) {
    try {
      broadcast({
        type: 'chat:error',
        agentId,
        error: 'Your Plaud login has expired, so I can\'t reach your recordings. '
             + 'Reconnect it in Settings → Integrations → Plaud.',
        code: 'AUTH_INVALID',
        severity: 'error',
        retryable: false,
      });
    } catch { /* best effort */ }
  }
  return true;
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
    // T38: one owner for this transition. This branch used to write the flag
    // and wipe the email itself — a second copy of the same state change, and
    // the copy that nothing was listening to. The email now survives (see
    // `notePlaudReauthRequired`) so the card can name the expired account.
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
        broadcast({ type: 'plaud:auth_url', url: pendingLoginUrl });
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
    loginProcess = null;
    pendingLoginUrl = null;
    broadcast({ type: 'plaud:login_failed', error: err.message });
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
  broadcast({ type: 'plaud:disconnected' });
  if (!result.ok && !/not.{0,5}logged in|no session/i.test(result.stderr + result.stdout)) {
    return { ok: false, error: result.error ?? 'Plaud logout failed.' };
  }
  return { ok: true };
}
