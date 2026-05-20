// ════════════════════════════════════════
// System-dependency installer (runtime)
// ════════════════════════════════════════
//
// Runs the bundled ensure-system-deps.sh script at server startup. The
// script is the single source of truth for required brew packages —
// adding a new dep is one line in its REQUIRED_BREW_PACKAGES array.
//
// Why this runs at startup (not in the update flow): launchd restarts
// the server after every self-update, which means the NEW version's
// startup code runs regardless of which OLD version's update.ts shipped
// the files. So any brew dep added in a release reaches every user on
// their next reboot, whatever version they're updating from.
//
// User-facing feedback: the script emits "INSTALLED:<pkg>" / "FAILED:<pkg>"
// markers. We parse them and broadcast `system:dep_installed` so the
// dashboard pops a toast — users see exactly which deps just got
// installed without having to read server logs.

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

// In dev, __dirname is .../packages/server/src/services; script lives at
// .../packages/server/scripts/ensure-system-deps.sh
// In prod, __dirname is .../packages/server/dist/services; script lives at
// .../packages/server/scripts/ensure-system-deps.sh
// Either way the script is at ../../scripts from this file.
function resolveScriptPath(): string | null {
  const candidate = path.join(__dirname, '..', '..', 'scripts', 'ensure-system-deps.sh');
  return fs.existsSync(candidate) ? candidate : null;
}

// launchd starts processes with a minimal PATH — brew lives in /opt/homebrew
// (Apple Silicon) or /usr/local (Intel) and won't be discoverable otherwise.
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
      timeout: 300_000, // 5 min — brew can be slow on first run / cold cache
      env: { ...process.env, PATH: EXTENDED_PATH },
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // execFile rejects on non-zero exit, but our script always exits 0.
    // If we land here it's a more serious failure (missing bash, timeout).
    logger.warn('System-deps script failed to run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (stdout.trim()) logger.info('System-deps script output', { output: stdout.trim() });
  if (stderr.trim()) logger.warn('System-deps script stderr', { output: stderr.trim() });

  // Toast each freshly-installed (or failed) package so the user sees
  // what changed. Broadcast emits to anyone currently connected; later
  // tab opens won't see it, which is fine — this fires once per boot.
  const { installed, failed } = parseMarkers(stdout);
  for (const pkg of installed) {
    broadcast({ type: 'system:dep_installed', data: { pkg, status: 'installed' } });
  }
  for (const pkg of failed) {
    broadcast({ type: 'system:dep_installed', data: { pkg, status: 'failed' } });
  }
}
