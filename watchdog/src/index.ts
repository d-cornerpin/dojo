// ════════════════════════════════════════
// Dojo Watchdog — Standalone Process
// Monitors platform health independently.
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

// ── Config ──

const PLATFORM_URL = process.env.DOJO_URL ?? 'http://localhost:3001';
const HEALTH_ENDPOINT = `${PLATFORM_URL}/api/health`;
const CHECK_INTERVAL_MS = 120_000; // 2 minutes
const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
const LOG_PATH = path.join(os.homedir(), '.dojo', 'logs', 'watchdog.log');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DOJO_DIR = path.join(os.homedir(), '.dojo');

// iMessage recipient — try env var first, then read from platform DB
function getImessageRecipient(): string {
  const envRecipient = process.env.DOJO_IMESSAGE_RECIPIENT;
  if (envRecipient) return envRecipient;

  try {
    if (!fs.existsSync(DB_PATH)) return '';
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_default_sender'").get() as { value: string } | undefined;
    db.close();
    return row?.value ?? '';
  } catch {
    return '';
  }
}

let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_ALERT = 3;
const MAX_FAILURES_BEFORE_RESTART = 5;

// ── Logging ──

function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(level: string, message: string, meta?: Record<string, unknown>): void {
  ensureLogDir();
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'watchdog',
    message,
    ...(meta ? { meta } : {}),
  });
  fs.appendFileSync(LOG_PATH, entry + '\n');
  if (level === 'error' || level === 'warn') {
    console.error(`[${level}] ${message}`);
  } else {
    console.log(`[${level}] ${message}`);
  }
}

// ── iMessage sending ──

function sendIMessage(recipient: string, text: string): void {
  if (!recipient) {
    log('warn', 'No iMessage recipient configured');
    return;
  }

  try {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy "${escapedRecipient}" of targetService
        send "${escapedText}" to targetBuddy
      end tell
    `;

    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    });

    log('info', 'iMessage sent', { recipient, textLength: text.length });
  } catch (err) {
    log('error', 'Failed to send iMessage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Heartbeat recording ──

function recordHeartbeat(): void {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('watchdog_last_heartbeat', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(new Date().toISOString(), new Date().toISOString());

    db.close();
  } catch (err) {
    log('error', 'Failed to record heartbeat', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function recordAlert(message: string): void {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('watchdog_last_alert', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(message, message);

    db.close();
  } catch {
    // Silently fail — DB might be down
  }
}

// ── Health Checks ──

async function checkPlatformHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log('warn', 'Platform health check failed', { status: response.status });
      return false;
    }

    const data = await response.json() as { ok: boolean; data?: { db: string } };
    if (!data.ok || data.data?.db === 'error') {
      log('warn', 'Platform unhealthy', { data });
      return false;
    }

    return true;
  } catch (err) {
    log('error', 'Platform unreachable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function checkStalledAgents(): void {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    const stalled = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'working'
        AND updated_at <= datetime('now', '-30 minutes')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    db.close();

    if (stalled.length > 0) {
      const names = stalled.map(a => a.name).join(', ');
      log('warn', `Stalled agents detected: ${names}`, { count: stalled.length });

      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, `Watchdog: ${stalled.length} stalled agent(s): ${names}`);
        recordAlert(`Stalled agents: ${names}`);
      }
    }
  } catch (err) {
    log('error', 'Failed to check stalled agents', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkProviders(): Promise<void> {
  // Check Ollama
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      log('debug', 'Ollama healthy');
    } else {
      log('warn', 'Ollama unhealthy', { status: response.status });
    }
  } catch {
    log('debug', 'Ollama not available');
  }

  // Check Anthropic (just a connectivity test, no actual API call)
  try {
    const response = await fetch('https://api.anthropic.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    log('debug', 'Anthropic API reachable', { status: response.status });
  } catch {
    log('warn', 'Anthropic API unreachable');
  }
}

function checkSystemMemory(): void {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const freePercent = (freeMem / totalMem) * 100;
  const freeMb = Math.round(freeMem / (1024 * 1024));

  if (freePercent < 10) {
    log('warn', 'System memory critically low', {
      freeMb,
      freePercent: freePercent.toFixed(1),
    });

    const imRecipient = getImessageRecipient();
    if (imRecipient) {
      sendIMessage(imRecipient, `Watchdog: System memory critically low — ${freeMb}MB free (${freePercent.toFixed(1)}%)`);
      recordAlert(`Memory critically low: ${freeMb}MB`);
    }
  } else {
    log('debug', 'System memory OK', { freeMb, freePercent: freePercent.toFixed(1) });
  }
}

function checkDiskSpace(): void {
  try {
    const result = execSync(`df -k "${DOJO_DIR}" | tail -1`, { encoding: 'utf-8', timeout: 5000 });
    const parts = result.trim().split(/\s+/);
    const availableKb = parseInt(parts[3] ?? '0', 10);
    const availableGb = availableKb / (1024 * 1024);

    if (availableGb < 1) {
      log('warn', 'Disk space critically low', { availableGb: availableGb.toFixed(2) });
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, `Watchdog: Disk space critically low — ${availableGb.toFixed(1)}GB free`);
        recordAlert(`Disk space low: ${availableGb.toFixed(1)}GB`);
      }
    } else {
      log('debug', 'Disk space OK', { availableGb: availableGb.toFixed(1) });
    }

    // Also check ~/.dojo/ size
    const dojoSize = execSync(`du -sk "${DOJO_DIR}" 2>/dev/null | cut -f1`, { encoding: 'utf-8', timeout: 10000 }).trim();
    const dojoSizeMb = parseInt(dojoSize, 10) / 1024;
    if (dojoSizeMb > 5000) { // > 5GB
      log('warn', 'DOJO data directory is large', { sizeMb: Math.round(dojoSizeMb) });
    }
  } catch {
    log('debug', 'Could not check disk space');
  }
}

function checkDatabaseIntegrity(): void {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    db.close();

    const status = result[0]?.integrity_check ?? 'unknown';
    if (status !== 'ok') {
      log('error', 'Database integrity check FAILED', { status });
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, `Watchdog: Database integrity check failed — ${status}`);
        recordAlert(`DB integrity: ${status}`);
      }
    } else {
      log('debug', 'Database integrity OK');
    }
  } catch (err) {
    log('error', 'Database integrity check error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function rotateWatchdogLog(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > 5 * 1024 * 1024) { // > 5MB
      const rotated = LOG_PATH + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(LOG_PATH, rotated);
      log('info', 'Watchdog log rotated');
    }
  } catch { /* ignore */ }
}

function attemptRestart(): void {
  log('warn', 'Attempting to restart Dojo platform');

  try {
    // Try launchctl restart
    execSync('launchctl kickstart -k gui/$(id -u)/com.dojo.platform', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    log('info', 'Restart command sent via launchctl');
  } catch {
    try {
      // Fallback: try npm start
      const platformDir = path.join(os.homedir(), '.dojo', 'platform');
      if (fs.existsSync(platformDir)) {
        execSync(`cd "${platformDir}" && npm run start &`, {
          timeout: 10000,
          encoding: 'utf-8',
          shell: '/bin/zsh',
        });
        log('info', 'Restart attempted via npm run start');
      }
    } catch (err) {
      log('error', 'Restart failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Main Loop ──

async function runCheck(): Promise<void> {
  log('info', 'Running watchdog check cycle');

  recordHeartbeat();

  // 1. Platform health
  const healthy = await checkPlatformHealth();

  if (!healthy) {
    consecutiveFailures++;
    log('warn', `Platform unhealthy (${consecutiveFailures} consecutive failures)`);

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_RESTART) {
      attemptRestart();
      consecutiveFailures = 0; // Reset after restart attempt
    }

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, `Watchdog: Dojo platform is DOWN (${consecutiveFailures} checks failed)`);
        recordAlert(`Platform down: ${consecutiveFailures} checks failed`);
      }
    }
  } else {
    if (consecutiveFailures > 0) {
      log('info', 'Platform recovered', { previousFailures: consecutiveFailures });
      if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT) {
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          sendIMessage(imRecipient, 'Watchdog: Dojo platform is back UP');
        }
      }
    }
    consecutiveFailures = 0;
  }

  // 2. Check stalled agents
  checkStalledAgents();

  // 3. Check providers
  await checkProviders();

  // 4. Check system memory
  checkSystemMemory();

  // 5. Check disk space
  checkDiskSpace();

  // 6. Database integrity (run less frequently — every 10th cycle ~20 min)
  if (Math.random() < 0.1) {
    checkDatabaseIntegrity();
  }

  // 7. Rotate watchdog log if needed
  rotateWatchdogLog();
}

// ── Entry Point ──

log('info', 'Dojo Watchdog starting', {
  platformUrl: PLATFORM_URL,
  checkIntervalMs: CHECK_INTERVAL_MS,
  imessageRecipient: getImessageRecipient() ? '***' : 'not configured',
});

// Run immediately, then on interval
runCheck().catch(err => {
  log('error', 'Initial check failed', { error: err instanceof Error ? err.message : String(err) });
});

setInterval(() => {
  runCheck().catch(err => {
    log('error', 'Check cycle failed', { error: err instanceof Error ? err.message : String(err) });
  });
}, CHECK_INTERVAL_MS);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Watchdog shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Watchdog shutting down (SIGINT)');
  process.exit(0);
});
