// ════════════════════════════════════════
// Google Workspace CLI (gws) Client Wrapper
// All gws calls go through here for logging and error handling
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { logGoogleActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('gws-client');

const GWS_TIMEOUT_MS = 30_000;

// Extended PATH so gws is found regardless of install method
const EXTENDED_PATH = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
].join(':');

export interface GwsResult {
  ok: boolean;
  data: unknown;
  error?: string;
  command: string;
}

/**
 * Run a raw gws CLI command and return parsed JSON output.
 */
export function runGws(command: string): GwsResult {
  const fullCommand = `gws ${command}`;
  try {
    const result = execSync(fullCommand, {
      encoding: 'utf-8',
      timeout: GWS_TIMEOUT_MS,
      env: { ...process.env, PATH: EXTENDED_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.trim());
    } catch {
      // Some gws commands return plain text
      parsed = result.trim();
    }

    logger.debug('gws command succeeded', { command: fullCommand, outputLength: result.length });
    return { ok: true, data: parsed, command: fullCommand };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Extract stderr if available
    const stderr = (err as { stderr?: string })?.stderr?.trim() ?? '';
    const errorDetail = stderr || message;

    logger.error('gws command failed', { command: fullCommand, error: errorDetail });
    return { ok: false, data: null, error: errorDetail, command: fullCommand };
  }
}

/**
 * Run a gws read command and log the activity.
 */
export function runGwsRead(
  agentId: string,
  agentName: string,
  action: string,
  command: string,
  details: Record<string, unknown>,
): GwsResult {
  const result = runGws(command);

  logGoogleActivity({
    agentId,
    agentName,
    action,
    actionType: 'read',
    details: JSON.stringify(details),
    gwsCommand: result.command,
    success: result.ok,
    error: result.error,
  });

  return result;
}

/**
 * Run a gws write command, log the activity, and broadcast a WebSocket event.
 */
export function runGwsWrite(
  agentId: string,
  agentName: string,
  action: string,
  command: string,
  details: Record<string, unknown>,
): GwsResult {
  const result = runGws(command);

  logGoogleActivity({
    agentId,
    agentName,
    action,
    actionType: 'write',
    details: JSON.stringify(details),
    gwsCommand: result.command,
    success: result.ok,
    error: result.error,
  });

  // Write actions broadcast to the dashboard in real time
  broadcast({
    type: 'google:activity',
    data: { agentId, agentName, action, actionType: 'write', details },
  } as never);

  return result;
}

/**
 * Check if the gws CLI is installed and accessible.
 */
export function isGwsInstalled(): boolean {
  try {
    execSync('which gws', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: EXTENDED_PATH } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the installed gws version.
 */
export function getGwsVersion(): string | null {
  try {
    const result = execSync('gws --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: EXTENDED_PATH } });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Escape a string for safe use in gws CLI JSON params.
 */
export function escapeForJson(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
