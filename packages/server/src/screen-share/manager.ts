// Detects, enables and disables macOS Screen Sharing (the built-in VNC server), never Remote Management. Enabling
// needs root, so it runs via osascript with admin privileges (a prompt on the Mac), off the server thread. A VNC
// password is kept only when the viewer chooses to save one (below).
// No-clobber: if Screen Sharing was already on, never turn it off or change its config; only manage the
// service when we enabled it (screen_share_managed_by_dojo).

import net from 'node:net';
import { execFile } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import {
  addCredential,
  updateCredential,
  getCredentialByService,
  deleteCredentialByService,
} from '../credentials/store.js';

const logger = createLogger('screen-share');

const VNC_PORT = 5900;
const SCREEN_SHARING_PLIST = '/System/Library/LaunchDaemons/com.apple.screensharing.plist';

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

// Opt-in saved VNC password: after a successful connect the viewer posts it and it is kept (AES-256-GCM)
// in the vault credential store. A wrong or stale saved password is forgotten so it cannot lock the user out.

const VNC_CRED_SERVICE = 'screen_share_vnc';

export function saveVncPassword(password: string): void {
  const value = { password };
  if (getCredentialByService(VNC_CRED_SERVICE, null)) {
    // overwrite: this is the engine re-saving its own private slot after the user's password connected.
    updateCredential(VNC_CRED_SERVICE, value, undefined, null, { overwrite: true });
  } else {
    addCredential(VNC_CRED_SERVICE, value, 'Screen sharing VNC password', null);
  }
}

export function getSavedVncPassword(): string | null {
  try {
    const cred = getCredentialByService(VNC_CRED_SERVICE, null);
    const pw = cred?.credentials?.password;
    return typeof pw === 'string' && pw.length > 0 ? pw : null;
  } catch {
    // Undecryptable (e.g. master key rotated): treat as not saved.
    return null;
  }
}

export function clearSavedVncPassword(): void {
  try {
    // confirm: the engine forgets its own saved password after it failed to authenticate.
    deleteCredentialByService(VNC_CRED_SERVICE, null, { confirm: true });
  } catch { /* nothing saved */ }
}

// ── Privileged execution ──

// Run a shell command as root via the native macOS admin prompt, without blocking the server while the prompt
// waits. Rejects on cancel or failure. The command is a fixed path plus fixed flags, so there is nothing to escape.
function runPrivileged(shellCommand: string): Promise<void> {
  const appleScript = `do shell script "${shellCommand}" with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', appleScript], { timeout: 180_000, encoding: 'utf-8' }, (err) => (err ? reject(err) : resolve()));
  });
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/User canceled|-128/.test(msg)) return 'Approval was cancelled on the Mac. Try Enable again and approve the prompt.';
  if (/timed out|ETIMEDOUT/i.test(msg)) return 'Timed out waiting for approval on the Mac.';
  return `Could not change Screen Sharing: ${msg.slice(0, 200)}`;
}

// Plain Screen Sharing only: the system service, switched on and off with launchctl.
function enableCommand(): string {
  return `/bin/launchctl load -w ${SCREEN_SHARING_PLIST}`;
}

function disableCommand(): string {
  return `/bin/launchctl unload -w ${SCREEN_SHARING_PLIST}`;
}

// ── Actions ──

// Enable the feature. If Screen Sharing is already running, use it and change nothing (managed=false);
// otherwise turn it on (managed=true) via the admin prompt on the Mac.
export async function enable(): Promise<ActionResult> {
  if (await isScreenSharingRunning()) {
    setFlag('screen_share_managed_by_dojo', false);
    setFlag('screen_share_enabled', true);
    logger.info('Using existing Screen Sharing (not dojo-managed)');
    return { state: 'ready', status: await getStatus() };
  }

  try {
    await runPrivileged(enableCommand());
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
      await runPrivileged(disableCommand());
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
