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

export function getTunnelStatus(): TunnelStatus {
  const config = getConfig();
  return {
    enabled: config.enabled,
    mode: config.mode,
    status: tunnelStatus,
    url: tunnelUrl,
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

    // Parse stdout/stderr for the URL
    // cloudflared prints the URL to stderr
    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      // Look for the trycloudflare.com URL
      const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !tunnelUrl) {
        tunnelUrl = urlMatch[0];
        tunnelStatus = 'active';
        tunnelStartedAt = Date.now();
        logger.info('Quick tunnel active', { url: tunnelUrl });
        broadcastStatus();

        // Send the new URL via iMessage so the owner always has it
        try {
          sendAlert(`Dojo is online at ${tunnelUrl}`, 'info');
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
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;

      if (wasActive && !restartAttempted && code !== 0) {
        // Attempt one restart
        restartAttempted = true;
        logger.warn('Tunnel crashed, attempting restart', { exitCode: code });
        setTimeout(() => startQuickTunnel(port), 2000);
      } else if (code !== 0 && code !== null) {
        tunnelStatus = 'error';
        tunnelError = `cloudflared exited with code ${code}`;
        logger.error('Tunnel exited', { code });
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

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      // Named tunnels log "Connection registered" when active
      if (text.includes('Registered tunnel connection') || text.includes('Connection') && text.includes('registered')) {
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
      tunnelStatus = 'inactive';
      tunnelUrl = null;
      tunnelProcess = null;
      tunnelStartedAt = null;

      if (wasActive && !restartAttempted && code !== 0) {
        restartAttempted = true;
        logger.warn('Named tunnel crashed, attempting restart', { exitCode: code });
        setTimeout(() => startNamedTunnel(), 2000);
      } else if (code !== 0 && code !== null) {
        tunnelStatus = 'error';
        tunnelError = `cloudflared exited with code ${code}`;
        logger.error('Named tunnel exited', { code });
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
