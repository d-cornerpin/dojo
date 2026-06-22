// ════════════════════════════════════════
// Screen Share Manager
// Detects / enables / disables macOS Screen Sharing (the built-in VNC server)
// for the remote-screen feature. Disabled by default; the Settings panel drives
// this. Enabling needs root, so it runs via osascript with admin privileges,
// which prompts on the Mac itself (the user's one-time approval).
//
// The dojo stores NO password. macOS authenticates each connection with the
// user's own Mac login, which the user types in the viewer (the second factor).
//
// No-clobber rule: if Screen Sharing was already on before us, we never turn it
// off and never change its config. We only manage the service when WE enabled
// it (screen_share_managed_by_dojo).
// ════════════════════════════════════════

import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('screen-share');

const VNC_PORT = 5900;
const KICKSTART = '/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart';

export type ScreenShareState = 'ready' | 'error';

export interface ScreenShareStatus {
  enabled: boolean;          // the dojo feature flag
  managedByDojo: boolean;    // did WE enable Screen Sharing
  running: boolean;          // is Screen Sharing actually listening now
}

export interface ActionResult {
  state: ScreenShareState;
  status: ScreenShareStatus;
  error?: string;
}

// ── Config flags (config table) ──

function getFlag(key: string): boolean {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
}

function setFlag(key: string, value: boolean): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value ? 'true' : 'false');
}

// ── Detection ──

export function isScreenSharingRunning(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(VNC_PORT, '127.0.0.1');
  });
}

async function waitForRunning(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isScreenSharingRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Status ──

export async function getStatus(): Promise<ScreenShareStatus> {
  return {
    enabled: getFlag('screen_share_enabled'),
    managedByDojo: getFlag('screen_share_managed_by_dojo'),
    running: await isScreenSharingRunning(),
  };
}

export function isScreenShareEnabled(): boolean {
  return getFlag('screen_share_enabled');
}

// ── Privileged execution ──

// Run a shell command as root via the native macOS admin prompt (appears on the
// Mac). Throws on cancel/failure. The command is a fixed path + fixed flags
// (no interpolated/user data), so there is nothing to escape.
function runPrivileged(shellCommand: string): void {
  const appleScript = `do shell script "${shellCommand}" with administrator privileges`;
  execFileSync('osascript', ['-e', appleScript], { timeout: 180_000, encoding: 'utf-8' });
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/User canceled|-128/.test(msg)) return 'Approval was cancelled on the Mac. Try Enable again and approve the prompt.';
  if (/timed out|ETIMEDOUT/i.test(msg)) return 'Timed out waiting for approval on the Mac.';
  return `Could not change Screen Sharing: ${msg.slice(0, 200)}`;
}

// Turn on Screen Sharing with access for all local accounts. No VNC password is
// set — users authenticate with their own Mac login.
function enableCommand(): string {
  return `${KICKSTART} -activate -configure -access -on -allowAccessFor -allUsers -privs -all -restart -agent`;
}

function disableCommand(): string {
  return `${KICKSTART} -deactivate -configure -access -off`;
}

// ── Actions ──

// Enable the feature. If Screen Sharing is already running we use it and change
// nothing (managed=false). Otherwise we turn it on (managed=true) via the admin
// prompt on the Mac. Either way, no password is stored — the user authenticates
// with their Mac login in the viewer.
export async function enable(): Promise<ActionResult> {
  if (await isScreenSharingRunning()) {
    setFlag('screen_share_managed_by_dojo', false);
    setFlag('screen_share_enabled', true);
    logger.info('Using existing Screen Sharing (not dojo-managed)');
    return { state: 'ready', status: await getStatus() };
  }

  try {
    runPrivileged(enableCommand());
  } catch (err) {
    logger.warn('Managed enable failed', { error: err instanceof Error ? err.message : String(err) });
    return { state: 'error', status: await getStatus(), error: friendlyError(err) };
  }
  setFlag('screen_share_managed_by_dojo', true);

  if (!(await waitForRunning(10_000))) {
    return { state: 'error', status: await getStatus(), error: 'Screen Sharing was enabled but did not start listening. It may need a Privacy approval in System Settings.' };
  }
  setFlag('screen_share_enabled', true);
  logger.info('Screen Sharing enabled (dojo-managed)');
  return { state: 'ready', status: await getStatus() };
}

// Disable the feature. Only reverts the macOS service if WE enabled it.
export async function disable(): Promise<{ ok: boolean; error?: string; status: ScreenShareStatus }> {
  const managed = getFlag('screen_share_managed_by_dojo');
  if (managed) {
    try {
      runPrivileged(disableCommand());
    } catch (err) {
      return { ok: false, error: friendlyError(err), status: await getStatus() };
    }
    setFlag('screen_share_managed_by_dojo', false);
    logger.info('Screen Sharing disabled (dojo-managed teardown)');
  } else {
    logger.info('Disabling feature without touching user-owned Screen Sharing');
  }
  setFlag('screen_share_enabled', false);
  return { ok: true, status: await getStatus() };
}
