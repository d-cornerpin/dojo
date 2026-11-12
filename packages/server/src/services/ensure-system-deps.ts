// Runs the bundled ensure-system-deps.sh at server startup; the script is the single source of truth for required
// brew packages. It runs at startup rather than in the update flow because launchd restarts the server after every
// update, so the new version's code always runs. Its INSTALLED:/FAILED: markers are broadcast as
// `system:dep_installed` for a dashboard toast.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('ensure-system-deps');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The script is at ../../scripts from this file, in dev (src/services) and prod (dist/services).
function resolveScriptPath(): string | null {
  const candidate = path.join(__dirname, '..', '..', 'scripts', 'ensure-system-deps.sh');
  return fs.existsSync(candidate) ? candidate : null;
}

// launchd starts processes with a minimal PATH; brew lives in /opt/homebrew or /usr/local.
const EXTENDED_PATH = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
].join(':');

function parseMarkers(output: string): { installed: string[]; failed: string[] } {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('INSTALLED:')) installed.push(trimmed.slice('INSTALLED:'.length).trim());
    else if (trimmed.startsWith('FAILED:')) failed.push(trimmed.slice('FAILED:'.length).trim());
  }
  return { installed, failed };
}

export async function ensureSystemDeps(): Promise<void> {
  // Escape hatch for non-production boots (e.g. the release-gate smoke boot): never touch Homebrew or the network.
  if (process.env.DOJO_SKIP_SYSTEM_DEPS === '1') {
    logger.info('DOJO_SKIP_SYSTEM_DEPS=1 — skipping system-dependency check');
    return;
  }

  const scriptPath = resolveScriptPath();
  if (!scriptPath) {
    logger.warn('ensure-system-deps.sh not found — skipping dep check');
    return;
  }

  logger.info('Running system-dependency check', { script: scriptPath });

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('bash', [scriptPath], {
      timeout: 300_000, // 5 min: brew can be slow on first run / cold cache
      env: { ...process.env, PATH: EXTENDED_PATH },
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // The script always exits 0, so a rejection is a worse failure (missing bash, timeout).
    logger.warn('System-deps script failed to run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (stdout.trim()) logger.info('System-deps script output', { output: stdout.trim() });
  if (stderr.trim()) logger.warn('System-deps script stderr', { output: stderr.trim() });

  // Toast each package installed or failed; broadcast reaches only connected tabs, which is fine since
  // this fires once per boot.
  const { installed, failed } = parseMarkers(stdout);
  for (const pkg of installed) {
    broadcast({ type: 'system:dep_installed', data: { pkg, status: 'installed' } });
  }
  for (const pkg of failed) {
    broadcast({ type: 'system:dep_installed', data: { pkg, status: 'failed' } });
  }
}
