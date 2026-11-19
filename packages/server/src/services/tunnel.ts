// Cloudflare tunnel manager: quick tunnels (trycloudflare.com) and named tunnels (custom domain).

import { sendAlert } from './imessage-bridge.js';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { getProviderCredential, setProviderCredential } from '../config/loader.js';
import { homeDir } from '../home.js';

const logger = createLogger('tunnel');

// ── State ──

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStatus: 'inactive' | 'starting' | 'active' | 'error' = 'inactive';
let tunnelError: string | null = null;
let tunnelStartedAt: number | null = null;
let restartAttempted = false;
// Bumped by every stopTunnel; a delayed restart compares against it so a stopped tunnel is not restarted.
let intentionalStopGeneration = 0;

// The in-process `tunnelProcess` only knows a cloudflared this process spawned. These two files under
// ~/.dojo carry state across boots so autoStartTunnel can reclaim an orphaned quick tunnel and back off
// after a Cloudflare throttle.
const DOJO_DIR = path.join(homeDir(), '.dojo');
const TUNNEL_PIDFILE = path.join(DOJO_DIR, 'tunnel.pid');
const TUNNEL_BACKOFF_FILE = path.join(DOJO_DIR, 'tunnel-backoff.json');

// Start deadline: cloudflared output re-arms it, so only a child silent for QUIET_MS is stopped, and
// CEILING_MS stops a chatty child from holding `starting` forever.
const TUNNEL_START_QUIET_MS = 30_000;
const TUNNEL_START_CEILING_MS = 5 * 60_000;

/** Set by each start path; the child's output streams bump it via `noteTunnelOutput`. */
let startWatch: { lastOutputAt: number; startedAt: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

/** Called for every chunk either stream produces, as evidence of liveness. */
function noteTunnelOutput(): void {
  if (startWatch) startWatch.lastOutputAt = Date.now();
}

/** Stop watching: the tunnel reached a verdict. */
function clearStartWatch(): void {
  if (startWatch?.timer) clearTimeout(startWatch.timer);
  startWatch = null;
}

/** Arm the start deadline for the booting path; `label` names that path in the error message. */
function armTunnelStartDeadline(label: string): void {
  clearStartWatch();
  const watch: NonNullable<typeof startWatch> = { lastOutputAt: Date.now(), startedAt: Date.now(), timer: null };
  startWatch = watch;
  const tick = (): void => {
    if (tunnelStatus !== 'starting') { clearStartWatch(); return; }
    const quietFor = Date.now() - watch.lastOutputAt;
    const aliveFor = Date.now() - watch.startedAt;
    if (quietFor < TUNNEL_START_QUIET_MS && aliveFor < TUNNEL_START_CEILING_MS) {
      watch.timer = setTimeout(tick, Math.min(TUNNEL_START_QUIET_MS - quietFor, 5_000));
      watch.timer.unref?.();
      return;
    }
    tunnelStatus = 'error';
    tunnelError = aliveFor >= TUNNEL_START_CEILING_MS
      ? `${label} did not produce a URL within ${Math.round(TUNNEL_START_CEILING_MS / 1000)} seconds`
      : `${label} went silent for ${Math.round(quietFor / 1000)} seconds before producing a URL`;
    logger.warn('Tunnel start deadline reached', { tunnelError, quietForMs: quietFor, aliveForMs: aliveFor });
    clearStartWatch();
    stopTunnel();
  };
  watch.timer = setTimeout(tick, TUNNEL_START_QUIET_MS);
  watch.timer.unref?.();
}

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

// cloudflared writes its diagnostics (auth, port, network, certificate errors) to stderr; a rolling 4KB
// tail is kept and included in the exit error.
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
  // Recognize specific failure shapes first and surface a one-liner; otherwise fall back to the raw tail.
  const friendly = recognizeKnownTunnelFailure(tail);
  if (friendly) return friendly;
  // The last 6 non-empty lines are usually enough context without flooding the dashboard.
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  const recent = lines.slice(-6).join('\n');
  return `${base}\n${recent}`;
}

/**
 * Maps common cloudflared failure modes to short user-readable strings, or null when none matches.
 * Patterns are narrow on purpose: a reworded cloudflared error falls back to the raw tail, never a
 * wrong translation.
 */
function recognizeKnownTunnelFailure(tail: string): string | null {
  // Quick tunnel rate limit: match the "429 Too Many Requests" status text; cloudflared prints "quick Tunnel"
  // with a space, so a "QuickTunnel" token never matches.
  if (/429\s*Too\s*Many\s*Requests/i.test(tail)) {
    return 'Quick tunnel rate-limited (429 Too Many Requests). Cloudflare throttles account-less trycloudflare.com tunnels when restarted often. Wait a few minutes and try again, or set up a named tunnel in Settings → Dojo → Remote Access for a permanent URL.';
  }
  // Cloudflare global rate limit: the challenge page carries "error code: 1015" even when no 429 line is captured.
  if (/error code:\s*1015/i.test(tail)) {
    return 'Cloudflare rate-limited this connection (error 1015). Wait a few minutes and try again. If it keeps happening, switch to a named tunnel.';
  }
  // No cloudflared binary at exec time (it can disappear mid-session if Homebrew removes it).
  if (/cloudflared.*not found|command not found/i.test(tail)) {
    return 'cloudflared binary is missing. Install it from Settings → Dojo → Remote Access (Install cloudflared button) and try again.';
  }
  // Connector failed to register, usually an auth or cert problem on a named tunnel.
  if (/Connector registration error|Failed to fetch tunnel/i.test(tail)) {
    return 'Could not register the tunnel connector with Cloudflare. Your tunnel credentials or cert may have expired — re-run "cloudflared tunnel login" and recreate the tunnel.';
  }
  // cloudflared cannot bind its metrics port.
  if (/address already in use|bind: address already in use/i.test(tail)) {
    return 'A cloudflared process is already running on this machine. Stop the other one (or kill it from Activity Monitor) and try again.';
  }
  return null;
}

/**
 * True when the exit output is a Cloudflare throttle of the account-less quick-tunnel pool. Only a
 * throttle drives the cross-boot backoff; other recognized failures are not helped by waiting.
 */
function isQuickTunnelThrottle(tail: string): boolean {
  return /429\s*Too\s*Many\s*Requests/i.test(tail) || /error code:\s*1015/i.test(tail);
}

// A quick tunnel's URL appears once in the spawning process's stderr and cannot be re-derived, so a stale
// cloudflared from a previous boot is killed and a fresh one started.

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
 * If the pidfile names a live cloudflared from a previous boot, terminate it. Only a pid confirmed to be
 * cloudflared (signal 0, then `ps -o comm=`) is killed, so a recycled pid is never touched.
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

/**
 * The user-entered named-tunnel URL. A named tunnel's URL lives in Cloudflare's dashboard, not in
 * cloudflared's logs, so the user types it in once and it is persisted here.
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
  // Strip trailing slashes so concatenated links do not end up as "https://host//path".
  const normalized = url.trim().replace(/\/+$/, '');
  setConfigValue('tunnel_named_url', normalized);
}

export function getTunnelStatus(): TunnelStatus {
  const config = getConfig();
  // A named tunnel never emits its hostname, so prefer the user-saved public URL.
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
    // Record the pid so the next autoStartTunnel can reclaim a cloudflared orphaned by a hard-killed boot.
    if (proc.pid) writeTunnelPidfile(proc.pid, port);

    // Rolling tail of cloudflared output, surfaced to the dashboard when it exits non-zero.
    const outputBuffer = createOutputBuffer();

    // Parse stdout/stderr for the URL; cloudflared prints to stderr.
    const handleOutput = (data: Buffer) => {
      noteTunnelOutput();
      const text = data.toString();
      outputBuffer.append(text);
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !tunnelUrl) {
        tunnelUrl = urlMatch[0];
        tunnelStatus = 'active';
        tunnelStartedAt = Date.now();
        // A healthy URL means Cloudflare is no longer throttling; reset the cross-boot backoff counter.
        clearQuickTunnelBackoff();
        logger.info('Quick tunnel active', { url: tunnelUrl });

        // The new remote dashboard address is texted to the owner, whose old link is now dead.
        // 'notice' reaches the phone without the "[CRITICAL]" prefix.
        try {
          void sendAlert(`The dashboard is online at ${tunnelUrl}`, 'notice', { kind: 'remote-address' });
        } catch { /* iMessage bridge may not be running yet */ }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', (err) => {
      if (tunnelProcess !== proc) {
        // A stopped-and-replaced child must not overwrite the tunnel that replaced it.
        logger.warn('Ignoring error from stale tunnel process', { error: err.message });
        return;
      }
      tunnelStatus = 'error';
      tunnelError = err.message;
      tunnelProcess = null;
      logger.error('Tunnel process error', { error: err.message });
    });

    proc.on('exit', (code) => {
      if (tunnelProcess !== proc) {
        // A stopped-and-replaced child must not overwrite the new tunnel's state or arm a restart.
        logger.warn('Ignoring exit from stale tunnel process', { pid: proc.pid, code });
        return;
      }
      clearStartWatch();
      const wasActive = tunnelStatus === 'active';
      const tail = outputBuffer.tail();
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;
      // Drop the reclaim record so a future boot does not chase a dead (or recycled) pid.
      removeTunnelPidfile();

      if (code !== 0 && code !== null && isQuickTunnelThrottle(tail)) {
        // A recognized throttle (429 / 1015) is owned by the cross-boot backoff: no auto-restart, which
        // would stack another request onto the throttled pool. Logged at WARN, not a fault to act on now.
        recordQuickTunnelThrottle();
        tunnelStatus = 'error';
        tunnelError = recognizeKnownTunnelFailure(tail) ?? formatTunnelExitError(code, tail);
        logger.warn('Quick tunnel throttled by Cloudflare', { code, error: tunnelError });
      } else if (wasActive && !restartAttempted && code !== 0) {
        // Non-throttle crash after a healthy start: attempt one restart.
        restartAttempted = true;
        logger.warn('Tunnel crashed, attempting restart', { exitCode: code, output: tail });
        const gen = intentionalStopGeneration;
        setTimeout(() => {
          if (intentionalStopGeneration !== gen || tunnelProcess) return;
          startQuickTunnel(port);
        }, 2000);
      } else if (code !== 0 && code !== null) {
        // Recognized failures get a one-line explanation at WARN; unrecognized ones keep ERROR and the tail.
        const friendly = recognizeKnownTunnelFailure(tail);
        tunnelStatus = 'error';
        tunnelError = friendly ?? formatTunnelExitError(code, tail);
        if (friendly) {
          logger.warn('Tunnel exited (recognized failure)', { code, error: friendly });
        } else {
          logger.error('Tunnel exited', { code, output: tail });
        }
      }
    });

    armTunnelStartDeadline('Tunnel');

    return { ok: true };
  } catch (err) {
    tunnelStatus = 'error';
    tunnelError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: tunnelError };
  }
}

function startNamedTunnel(): { ok: boolean; error?: string } {
  const token = getProviderCredential('cloudflare_tunnel');
  if (!token) {
    tunnelStatus = 'error';
    tunnelError = 'No tunnel token configured';
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
      noteTunnelOutput();
      const text = data.toString();
      outputBuffer.append(text);
      // Named tunnels log "Connection registered" when active.
      if (text.includes('Registered tunnel connection') || (text.includes('Connection') && text.includes('registered'))) {
        if (tunnelStatus !== 'active') {
          tunnelStatus = 'active';
          tunnelStartedAt = Date.now();
          tunnelUrl = null; // URL is configured on Cloudflare's side
          logger.info('Named tunnel active');
        }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', (err) => {
      if (tunnelProcess !== proc) {
        logger.warn('Ignoring error from stale tunnel process', { error: err.message });
        return;
      }
      tunnelStatus = 'error';
      tunnelError = err.message;
      tunnelProcess = null;
      logger.error('Named tunnel process error', { error: err.message });
    });

    proc.on('exit', (code) => {
      if (tunnelProcess !== proc) {
        logger.warn('Ignoring exit from stale tunnel process', { pid: proc.pid, code });
        return;
      }
      const wasActive = tunnelStatus === 'active';
      const tail = outputBuffer.tail();
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;

      if (wasActive && !restartAttempted && code !== 0) {
        restartAttempted = true;
        logger.warn('Named tunnel crashed, attempting restart', { exitCode: code, output: tail });
        const gen = intentionalStopGeneration;
        setTimeout(() => {
          if (intentionalStopGeneration !== gen || tunnelProcess) return;
          startNamedTunnel();
        }, 2000);
      } else if (code !== 0 && code !== null) {
        tunnelStatus = 'error';
        tunnelError = formatTunnelExitError(code, tail);
        logger.error('Named tunnel exited', { code, output: tail });
      }
    });

    armTunnelStartDeadline('Named tunnel');

    return { ok: true };
  } catch (err) {
    tunnelStatus = 'error';
    tunnelError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: tunnelError };
  }
}

export function stopTunnel(): void {
  // Invalidates any delayed restart, even when a crash already nulled the child handle.
  intentionalStopGeneration++;
  if (tunnelProcess) {
    const proc = tunnelProcess;
    try {
      proc.kill('SIGTERM');
      // Force kill after 5s on THIS child, captured by value: the module handle is cleared below and a
      // replacement tunnel must not be SIGKILLed by this timer.
      const t = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000);
      t.unref?.();
      proc.once('exit', () => clearTimeout(t));
    } catch { /* ignore */ }
    tunnelProcess = null;
  }
  removeTunnelPidfile();
  tunnelStatus = 'inactive';
  tunnelUrl = null;
  tunnelError = null;
  tunnelStartedAt = null;
  logger.info('Tunnel stopped');
}

/**
 * Synchronous best-effort kill for the crash path: the uncaughtException handler exits within ~100ms
 * without awaiting, so stopTunnel's timed SIGKILL escalation cannot run. Must never throw.
 */
export function killTunnelSync(): void {
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGKILL'); } catch { /* ignore */ }
    tunnelProcess = null;
  }
  removeTunnelPidfile();
}

export function enableTunnel(mode: TunnelMode, port?: number): { ok: boolean; error?: string } {
  setConfigValue('tunnel_enabled', 'true');
  setConfigValue('tunnel_mode', mode);
  return startTunnel(mode, port);
}

export function disableTunnel(): void {
  setConfigValue('tunnel_enabled', 'false');
  stopTunnel();
}

export function setTunnelToken(token: string): void {
  setProviderCredential('cloudflare_tunnel', token, 'api_key');
}

// ── Auto-start on boot ──

export function autoStartTunnel(port?: number): void {
  const config = getConfig();
  if (!config.enabled || !isCloudflaredInstalled()) return;

  // Reclaim a cloudflared orphaned by a hard-killed previous boot; the in-process guard cannot see it.
  reclaimStaleTunnel();

  // After a Cloudflare throttle on the quick pool, auto-start skips an exponential window. Only auto-start
  // backs off; a manual start bypasses it. Named tunnels do not use the throttled pool.
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
