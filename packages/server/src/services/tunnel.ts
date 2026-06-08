// ════════════════════════════════════════
// Cloudflare Tunnel Manager
// Quick tunnels (trycloudflare.com) and named tunnels (custom domain)
// ════════════════════════════════════════

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getProviderCredential, setProviderCredential } from '../config/loader.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from './imessage-bridge.js';

const logger = createLogger('tunnel');

// ── State ──

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStatus: 'inactive' | 'starting' | 'active' | 'error' = 'inactive';
let tunnelError: string | null = null;
let tunnelStartedAt: number | null = null;
let restartAttempted = false;

export type TunnelMode = 'quick' | 'named';

export interface TunnelStatus {
  enabled: boolean;
  mode: TunnelMode;
  status: 'inactive' | 'starting' | 'active' | 'error';
  url: string | null;
  error: string | null;
  startedAt: number | null;
  cloudflaredInstalled: boolean;
}

// ── Config persistence ──

function getConfig(): { enabled: boolean; mode: TunnelMode } {
  try {
    const db = getDb();
    const enabled = db.prepare("SELECT value FROM config WHERE key = 'tunnel_enabled'").get() as { value: string } | undefined;
    const mode = db.prepare("SELECT value FROM config WHERE key = 'tunnel_mode'").get() as { value: string } | undefined;
    return {
      enabled: enabled?.value === 'true',
      mode: (mode?.value === 'named' ? 'named' : 'quick') as TunnelMode,
    };
  } catch {
    return { enabled: false, mode: 'quick' };
  }
}

function setConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

// ── Output buffering ──
//
// cloudflared writes its useful diagnostics (auth failures, port conflicts,
// network errors, certificate issues) to stderr. Pre-2026-04-30 we threw
// all of that away and only kept the trycloudflare URL match, so when the
// process exited with a non-zero code the dashboard surfaced "cloudflared
// exited with code N" with no further context. Now we keep a rolling
// 4KB tail and include it in the error message.

const TUNNEL_OUTPUT_TAIL_BYTES = 4000;

function createOutputBuffer() {
  let buf = '';
  return {
    append(chunk: string): void {
      buf += chunk;
      if (buf.length > TUNNEL_OUTPUT_TAIL_BYTES * 2) {
        buf = buf.slice(-TUNNEL_OUTPUT_TAIL_BYTES);
      }
    },
    tail(): string {
      // Strip ANSI color codes (cloudflared prints colored logs) and trim.
      const cleaned = buf.replace(/\[[0-9;]*m/g, '').trim();
      return cleaned.slice(-TUNNEL_OUTPUT_TAIL_BYTES);
    },
  };
}

function formatTunnelExitError(code: number, tail: string): string {
  const base = `cloudflared exited with code ${code}`;
  if (!tail) return base;
  // First try to recognize specific failure shapes and surface a
  // human-readable one-liner instead of a wall of cloudflared log
  // spew. Falls through to the raw-tail fallback if no pattern hits.
  const friendly = recognizeKnownTunnelFailure(tail);
  if (friendly) return friendly;
  // Pull the most informative line(s) — typically the last error/warning
  // entries. We pick the last 6 non-empty lines, which is usually enough
  // context to read what went wrong without flooding the dashboard.
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  const recent = lines.slice(-6).join('\n');
  return `${base}\n${recent}`;
}

/**
 * Map common cloudflared failure modes to short user-readable strings.
 * Returns null when no pattern matches so the raw tail fallback runs.
 *
 * Pattern recognition is intentionally narrow: each entry maps a
 * specific log signature to ONE message. If cloudflared rewords its
 * error in a future release, the pattern misses and we fall back to
 * showing the raw tail — no silent mis-translation.
 */
function recognizeKnownTunnelFailure(tail: string): string | null {
  // Quick tunnel rate limit. Shows up as "status_code=\"429 Too Many
  // Requests\"" inside the QuickTunnel response error. Cloudflare's
  // account-less tunnel pool throttles aggressively when restarted
  // frequently or shared from one IP.
  if (/QuickTunnel/.test(tail) && /429\s*Too\s*Many\s*Requests/i.test(tail)) {
    return 'Quick tunnel rate-limited (429 Too Many Requests). Cloudflare throttles account-less trycloudflare.com tunnels when restarted often. Wait a few minutes and try again, or set up a named tunnel in Settings → Remote Access for a permanent URL.';
  }
  // Generic 1015 (Cloudflare global rate limit).
  if (/error code:\s*1015/i.test(tail)) {
    return 'Cloudflare rate-limited this connection (error 1015). Wait a few minutes and try again. If it keeps happening, switch to a named tunnel.';
  }
  // No cloudflared binary on PATH at exec time (rare; install checker
  // usually catches this first, but the binary can disappear mid-session
  // if Homebrew removes it).
  if (/cloudflared.*not found|command not found/i.test(tail)) {
    return 'cloudflared binary is missing. Install it from Settings → Remote Access (Install cloudflared button) and try again.';
  }
  // Connector failed to register — usually auth/cert problem on a named
  // tunnel. Quick tunnels never hit this path.
  if (/Connector registration error|Failed to fetch tunnel/i.test(tail)) {
    return 'Could not register the tunnel connector with Cloudflare. Your tunnel credentials or cert may have expired — re-run "cloudflared tunnel login" and recreate the tunnel.';
  }
  // Port already in use (cloudflared can't bind its metrics endpoint).
  if (/address already in use|bind: address already in use/i.test(tail)) {
    return 'A cloudflared process is already running on this machine. Stop the other one (or kill it from Activity Monitor) and try again.';
  }
  return null;
}

// ── cloudflared detection ──

export function isCloudflaredInstalled(): boolean {
  try {
    execSync('which cloudflared', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function installCloudflared(): { ok: boolean; error?: string } {
  try {
    execSync('brew install cloudflare/cloudflare/cloudflared', {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ── Tunnel Management ──

function broadcastStatus(): void {
  broadcast({
    type: 'system:tunnel_status',
    data: getTunnelStatus(),
  } as never);
}

/**
 * v2.5.6 — read the user-entered named-tunnel URL (e.g. https://kevin.theagentdojo.com).
 * Quick tunnels parse their URL from cloudflared stderr; named tunnels can't
 * (the URL lives in Cloudflare's dashboard, not in cloudflared's logs), so
 * we ask the user to type it in once and persist it here.
 */
export function getNamedTunnelUrl(): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'tunnel_named_url'").get() as { value: string } | undefined;
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

export function setNamedTunnelUrl(url: string | null): void {
  if (!url || !url.trim()) {
    try { getDb().prepare("DELETE FROM config WHERE key = 'tunnel_named_url'").run(); } catch { /* ignore */ }
    return;
  }
  // v2.7.25 — strip trailing slash before persisting so downstream URL
  // concatenations (download links, share links, etc.) don't end up
  // with "https://host//path". Users routinely copy-paste URLs with a
  // trailing slash from their browser address bar; normalize on save.
  const normalized = url.trim().replace(/\/+$/, '');
  setConfig('tunnel_named_url', normalized);
}

export function getTunnelStatus(): TunnelStatus {
  const config = getConfig();
  // For named tunnels, prefer the user-saved public URL over the (always
  // null) parsed URL — cloudflared running a named tunnel doesn't emit the
  // hostname anywhere we can scrape it from.
  const url = config.mode === 'named'
    ? (tunnelUrl ?? getNamedTunnelUrl())
    : tunnelUrl;
  return {
    enabled: config.enabled,
    mode: config.mode,
    status: tunnelStatus,
    url,
    error: tunnelError,
    startedAt: tunnelStartedAt,
    cloudflaredInstalled: isCloudflaredInstalled(),
  };
}

export function startTunnel(mode?: TunnelMode, port?: number): { ok: boolean; error?: string } {
  if (tunnelProcess) {
    return { ok: false, error: 'Tunnel already running' };
  }

  if (!isCloudflaredInstalled()) {
    return { ok: false, error: 'cloudflared is not installed. Install it with: brew install cloudflare/cloudflare/cloudflared' };
  }

  const config = getConfig();
  const tunnelMode = mode ?? config.mode;
  const dashboardPort = port ?? (process.env.NODE_ENV === 'production' ? 3001 : 3000);

  tunnelStatus = 'starting';
  tunnelError = null;
  tunnelUrl = null;
  restartAttempted = false;
  broadcastStatus();

  if (tunnelMode === 'quick') {
    return startQuickTunnel(dashboardPort);
  } else {
    return startNamedTunnel();
  }
}

function startQuickTunnel(port: number): { ok: boolean; error?: string } {
  logger.info('Starting quick tunnel', { port });

  try {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    tunnelProcess = proc;

    // Buffer cloudflared's recent output. When it exits non-zero we surface
    // the tail to the dashboard — pre-2026-04-30 the only signal was
    // "cloudflared exited with code 1" with no clue WHY (auth failure,
    // bad token, port conflict, network, …) which made tunnel breakage
    // very hard to diagnose.
    const outputBuffer = createOutputBuffer();

    // Parse stdout/stderr for the URL. cloudflared prints to stderr.
    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      outputBuffer.append(text);
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !tunnelUrl) {
        tunnelUrl = urlMatch[0];
        tunnelStatus = 'active';
        tunnelStartedAt = Date.now();
        logger.info('Quick tunnel active', { url: tunnelUrl });
        broadcastStatus();

        // Send the new URL via iMessage so the owner always has it.
        // 'notice' severity — routes to iMessage like critical does, but
        // without the "[CRITICAL]" prefix. This is a friendly status
        // announcement, not an incident, so it shouldn't shout.
        try {
          sendAlert(`Dojo is online at ${tunnelUrl}`, 'notice');
        } catch { /* iMessage bridge may not be running yet */ }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', (err) => {
      tunnelStatus = 'error';
      tunnelError = err.message;
      tunnelProcess = null;
      logger.error('Tunnel process error', { error: err.message });
      broadcastStatus();
    });

    proc.on('exit', (code) => {
      const wasActive = tunnelStatus === 'active';
      const tail = outputBuffer.tail();
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;

      if (wasActive && !restartAttempted && code !== 0) {
        // Attempt one restart
        restartAttempted = true;
        logger.warn('Tunnel crashed, attempting restart', { exitCode: code, output: tail });
        setTimeout(() => startQuickTunnel(port), 2000);
      } else if (code !== 0 && code !== null) {
        tunnelStatus = 'error';
        tunnelError = formatTunnelExitError(code, tail);
        logger.error('Tunnel exited', { code, output: tail });
      }
      broadcastStatus();
    });

    // Timeout — if no URL after 30s, mark as error
    setTimeout(() => {
      if (tunnelStatus === 'starting') {
        tunnelStatus = 'error';
        tunnelError = 'Tunnel failed to start within 30 seconds';
        stopTunnel();
        broadcastStatus();
      }
    }, 30000);

    return { ok: true };
  } catch (err) {
    tunnelStatus = 'error';
    tunnelError = err instanceof Error ? err.message : String(err);
    broadcastStatus();
    return { ok: false, error: tunnelError };
  }
}

function startNamedTunnel(): { ok: boolean; error?: string } {
  // Get token from secrets
  const token = getProviderCredential('cloudflare_tunnel');
  if (!token) {
    tunnelStatus = 'error';
    tunnelError = 'No tunnel token configured';
    broadcastStatus();
    return { ok: false, error: 'No tunnel token configured. Add your Cloudflare tunnel token first.' };
  }

  logger.info('Starting named tunnel');

  try {
    const proc = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    tunnelProcess = proc;

    const outputBuffer = createOutputBuffer();

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      outputBuffer.append(text);
      // Named tunnels log "Connection registered" when active
      if (text.includes('Registered tunnel connection') || (text.includes('Connection') && text.includes('registered'))) {
        if (tunnelStatus !== 'active') {
          tunnelStatus = 'active';
          tunnelStartedAt = Date.now();
          tunnelUrl = null; // URL is configured on Cloudflare's side
          logger.info('Named tunnel active');
          broadcastStatus();
        }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', (err) => {
      tunnelStatus = 'error';
      tunnelError = err.message;
      tunnelProcess = null;
      logger.error('Named tunnel process error', { error: err.message });
      broadcastStatus();
    });

    proc.on('exit', (code) => {
      const wasActive = tunnelStatus === 'active';
      const tail = outputBuffer.tail();
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;

      if (wasActive && !restartAttempted && code !== 0) {
        restartAttempted = true;
        logger.warn('Named tunnel crashed, attempting restart', { exitCode: code, output: tail });
        setTimeout(() => startNamedTunnel(), 2000);
      } else if (code !== 0 && code !== null) {
        tunnelStatus = 'error';
        tunnelError = formatTunnelExitError(code, tail);
        logger.error('Named tunnel exited', { code, output: tail });
      }
      broadcastStatus();
    });

    // Named tunnels take longer to connect
    setTimeout(() => {
      if (tunnelStatus === 'starting') {
        tunnelStatus = 'error';
        tunnelError = 'Tunnel failed to connect within 60 seconds';
        stopTunnel();
        broadcastStatus();
      }
    }, 60000);

    return { ok: true };
  } catch (err) {
    tunnelStatus = 'error';
    tunnelError = err instanceof Error ? err.message : String(err);
    broadcastStatus();
    return { ok: false, error: tunnelError };
  }
}

export function stopTunnel(): void {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
      // Force kill after 5s if still running
      setTimeout(() => {
        if (tunnelProcess) {
          try { tunnelProcess.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 5000);
    } catch { /* ignore */ }
    tunnelProcess = null;
  }
  tunnelStatus = 'inactive';
  tunnelUrl = null;
  tunnelError = null;
  tunnelStartedAt = null;
  broadcastStatus();
  logger.info('Tunnel stopped');
}

export function enableTunnel(mode: TunnelMode, port?: number): { ok: boolean; error?: string } {
  setConfig('tunnel_enabled', 'true');
  setConfig('tunnel_mode', mode);
  return startTunnel(mode, port);
}

export function disableTunnel(): void {
  setConfig('tunnel_enabled', 'false');
  stopTunnel();
}

export function setTunnelToken(token: string): void {
  setProviderCredential('cloudflare_tunnel', token, 'api_key');
}

// ── Auto-start on boot ──

export function autoStartTunnel(port?: number): void {
  const config = getConfig();
  if (config.enabled && isCloudflaredInstalled()) {
    logger.info('Auto-starting tunnel on boot', { mode: config.mode });
    startTunnel(config.mode, port);
  }
}
