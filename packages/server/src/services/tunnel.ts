// ════════════════════════════════════════
// Cloudflare Tunnel Manager
// Quick tunnels (trycloudflare.com) and named tunnels (custom domain)
// ════════════════════════════════════════

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// ── Cross-boot state files ──
//
// The in-process `tunnelProcess` guard above only knows about a cloudflared
// this process spawned. When tsx-watch SIGKILLs the parent (dev reloads) or
// the uncaughtException handler exits without stopTunnel, cloudflared is
// orphaned and the next boot has no idea it's still up. These two files carry
// the minimum state across a process boundary so autoStartTunnel can (1)
// reclaim an orphaned quick tunnel and (2) back off after a Cloudflare throttle
// instead of stacking another request onto the account-less pool. Both live
// under ~/.dojo alongside the rest of the platform state.
const DOJO_DIR = path.join(os.homedir(), '.dojo');
const TUNNEL_PIDFILE = path.join(DOJO_DIR, 'tunnel.pid');
const TUNNEL_BACKOFF_FILE = path.join(DOJO_DIR, 'tunnel-backoff.json');

// Backoff window: 2^consecutiveFails minutes, capped at 30 minutes.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

interface TunnelPidRecord { pid: number; port: number; startedAt: number; }
interface TunnelBackoffRecord { lastFailAt: number; consecutiveFails: number; }

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
      const cleaned = buf.replace(/\x1b\[[0-9;]*m/g, '').trim();
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
  // Quick tunnel rate limit. cloudflared logs the trycloudflare API failure
  // as a "failed to request quick Tunnel" line and the throttled HTTP response
  // carries the "429 Too Many Requests" status. Earlier this gated on the
  // literal token "QuickTunnel", which cloudflared never emits (it prints
  // "quick Tunnel", lower-case with a space), so the recognizer silently
  // missed and the raw stderr wall leaked to the dashboard. Match the 429
  // status text directly instead. Cloudflare's account-less tunnel pool
  // throttles aggressively when restarted frequently or shared from one IP.
  if (/429\s*Too\s*Many\s*Requests/i.test(tail)) {
    return 'Quick tunnel rate-limited (429 Too Many Requests). Cloudflare throttles account-less trycloudflare.com tunnels when restarted often. Wait a few minutes and try again, or set up a named tunnel in Settings → Remote Access for a permanent URL.';
  }
  // Generic 1015 (Cloudflare global rate limit). The trycloudflare challenge
  // page carries "error code: 1015" in its HTML body, so this catches the
  // throttle even when the 429 status line is not in the captured tail.
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

/**
 * True when the exit output is a recognized Cloudflare throttle of the
 * account-less quick-tunnel pool (429 / error 1015). The cross-reload backoff
 * keys off this specific subset: a throttle means "stop asking for a while",
 * whereas other recognized failures (port in use, missing binary, connector
 * registration) are not helped by waiting.
 */
function isQuickTunnelThrottle(tail: string): boolean {
  return /429\s*Too\s*Many\s*Requests/i.test(tail) || /error code:\s*1015/i.test(tail);
}

// ── Pidfile reclaim (cross-boot) ──
//
// Quick tunnels can't be adopted (the trycloudflare URL only appears once in
// the spawning process's stderr and can't be re-derived), so the correct shape
// is reclaim-and-respawn: kill a stale cloudflared left behind by a previous
// boot, then start fresh.

function writeTunnelPidfile(pid: number, port: number): void {
  try {
    const record: TunnelPidRecord = { pid, port, startedAt: Date.now() };
    fs.writeFileSync(TUNNEL_PIDFILE, JSON.stringify(record));
  } catch (err) {
    logger.warn('Failed to write tunnel pidfile', { error: err instanceof Error ? err.message : String(err) });
  }
}

function removeTunnelPidfile(): void {
  try { fs.rmSync(TUNNEL_PIDFILE, { force: true }); } catch { /* best-effort */ }
}

function readTunnelPidfile(): TunnelPidRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(TUNNEL_PIDFILE, 'utf-8')) as Partial<TunnelPidRecord>;
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * If the pidfile names a live cloudflared from a previous boot, terminate it.
 * We only kill a pid we can positively confirm is cloudflared (signal 0 for
 * liveness, then `ps -o comm=` for identity) so a recycled pid belonging to an
 * unrelated process is never touched.
 */
function reclaimStaleTunnel(): void {
  const record = readTunnelPidfile();
  if (!record) return;
  const { pid } = record;

  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) { removeTunnelPidfile(); return; }

  let isCloudflared = false;
  try {
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf-8', timeout: 5000 }).trim();
    isCloudflared = /cloudflared/.test(comm);
  } catch { isCloudflared = false; }
  if (!isCloudflared) { removeTunnelPidfile(); return; }

  logger.warn('reclaimed stale tunnel from previous boot', { pid });
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  // Escalate to SIGKILL after a short grace if it survives the SIGTERM.
  setTimeout(() => {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }, 2000);
  removeTunnelPidfile();
}

// ── Quick-tunnel throttle backoff (cross-boot) ──

function readTunnelBackoff(): TunnelBackoffRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(TUNNEL_BACKOFF_FILE, 'utf-8')) as Partial<TunnelBackoffRecord>;
    return {
      lastFailAt: typeof parsed.lastFailAt === 'number' ? parsed.lastFailAt : 0,
      consecutiveFails: typeof parsed.consecutiveFails === 'number' ? parsed.consecutiveFails : 0,
    };
  } catch {
    return { lastFailAt: 0, consecutiveFails: 0 };
  }
}

function recordQuickTunnelThrottle(): void {
  const prev = readTunnelBackoff();
  try {
    const next: TunnelBackoffRecord = { lastFailAt: Date.now(), consecutiveFails: prev.consecutiveFails + 1 };
    fs.writeFileSync(TUNNEL_BACKOFF_FILE, JSON.stringify(next));
  } catch (err) {
    logger.warn('Failed to persist tunnel backoff state', { error: err instanceof Error ? err.message : String(err) });
  }
}

function clearQuickTunnelBackoff(): void {
  try { fs.rmSync(TUNNEL_BACKOFF_FILE, { force: true }); } catch { /* best-effort */ }
}

/** Milliseconds still to wait before a quick-tunnel auto-start is allowed. 0 = clear. */
function quickTunnelBackoffRemainingMs(): number {
  const { lastFailAt, consecutiveFails } = readTunnelBackoff();
  if (!lastFailAt || consecutiveFails <= 0) return 0;
  const delay = Math.min(2 ** consecutiveFails * BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  const remaining = lastFailAt + delay - Date.now();
  return remaining > 0 ? remaining : 0;
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
  });
}

/**
 * v2.5.6 — read the user-entered named-tunnel URL (e.g. https://primary.theagentdojo.com).
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
    // Record the pid so a hard-killed boot (tsx SIGKILL / uncaughtException
    // exit) can be reclaimed by the next autoStartTunnel instead of orphaning
    // cloudflared and stacking another quick tunnel onto the throttled pool.
    if (proc.pid) writeTunnelPidfile(proc.pid, port);

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
        // A healthy URL acquisition means Cloudflare is no longer throttling;
        // reset the cross-reload backoff counter.
        clearQuickTunnelBackoff();
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
      // Our process is gone; drop its reclaim record so a future boot doesn't
      // chase a dead (or recycled) pid.
      removeTunnelPidfile();

      if (code !== 0 && code !== null && isQuickTunnelThrottle(tail)) {
        // Recognized Cloudflare throttle (429 / 1015). The cross-reload backoff
        // owns this case: do NOT auto-restart (that just stacks another request
        // onto the throttled account-less pool). Record the failure, surface a
        // single-line explanation, and downgrade to WARN. A throttle is
        // non-fatal dev noise, not a broken tunnel the user must act on now.
        recordQuickTunnelThrottle();
        tunnelStatus = 'error';
        tunnelError = recognizeKnownTunnelFailure(tail) ?? formatTunnelExitError(code, tail);
        logger.warn('Quick tunnel throttled by Cloudflare', { code, error: tunnelError });
      } else if (wasActive && !restartAttempted && code !== 0) {
        // Non-throttle crash after a healthy start: attempt one restart.
        restartAttempted = true;
        logger.warn('Tunnel crashed, attempting restart', { exitCode: code, output: tail });
        setTimeout(() => startQuickTunnel(port), 2000);
      } else if (code !== 0 && code !== null) {
        // Recognized (non-throttle) failures get a one-line explanation at
        // WARN. Unrecognized failures keep ERROR + the full stderr tail so the
        // user still notices real tunnel breakage.
        const friendly = recognizeKnownTunnelFailure(tail);
        tunnelStatus = 'error';
        tunnelError = friendly ?? formatTunnelExitError(code, tail);
        if (friendly) {
          logger.warn('Tunnel exited (recognized failure)', { code, error: friendly });
        } else {
          logger.error('Tunnel exited', { code, output: tail });
        }
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
  removeTunnelPidfile();
  tunnelStatus = 'inactive';
  tunnelUrl = null;
  tunnelError = null;
  tunnelStartedAt = null;
  broadcastStatus();
  logger.info('Tunnel stopped');
}

/**
 * Synchronous best-effort kill for the crash path. The uncaughtException
 * handler exits the process within ~100ms without awaiting, so it can't use
 * the async dynamic-import shutdown path or stopTunnel's setTimeout SIGKILL
 * escalation. Sending an immediate SIGKILL here keeps cloudflared from
 * outliving the crash and getting reclaimed (or stacking another throttled
 * quick tunnel) on the next boot. The pidfile reclaim in autoStartTunnel is
 * still the primary safety net; this must never throw.
 */
export function killTunnelSync(): void {
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGKILL'); } catch { /* ignore */ }
    tunnelProcess = null;
  }
  removeTunnelPidfile();
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
  if (!config.enabled || !isCloudflaredInstalled()) return;

  // Reclaim a cloudflared orphaned by a hard-killed previous boot (tsx SIGKILL
  // on reload, or an uncaughtException exit that skipped stopTunnel). The
  // in-process tunnelProcess guard can't see a process from a prior process,
  // so without this each reload stacks another quick tunnel onto the pool.
  reclaimStaleTunnel();

  // Cross-reload backoff: after a recognized Cloudflare throttle (429 / 1015)
  // on the account-less quick pool, skip auto-start for an exponential window
  // so rapid dev reloads stop hammering trycloudflare.com. Auto-start is the
  // ONLY lane that backs off; a manual start from the dashboard/API/agent-tool
  // (startTunnel / enableTunnel) bypasses this because the user asked for it
  // explicitly. Named tunnels don't use the throttled pool, so they never gate.
  if (config.mode === 'quick') {
    const remainingMs = quickTunnelBackoffRemainingMs();
    if (remainingMs > 0) {
      logger.warn('Skipping quick-tunnel auto-start: backing off after Cloudflare throttle', {
        remainingSeconds: Math.ceil(remainingMs / 1000),
      });
      return;
    }
  }

  logger.info('Auto-starting tunnel on boot', { mode: config.mode });
  startTunnel(config.mode, port);
}
