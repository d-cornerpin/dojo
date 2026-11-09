// Dojo Watchdog: standalone process monitors platform health independently.

import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  readMarker,
  updateMarker,
  decideAutoRollback,
  toRolledBack,
  toFailedPermanently,
  spawnRollbackDetached,
  ROLLBACK_SCRIPT,
  FAIL_WALL_CLOCK_MS,
  type RollbackDecision,
  type UpdateMarker,
} from './auto-rollback.js';
import {
  emptyState,
  readState,
  persistState,
  claimAlert as claimAlertIn,
  integrityFailureFromError,
  markAlertResolved as markAlertResolvedIn,
  type WatchdogState, type AlertKey,
} from './alert-ledger.js';
import { diskFloorBytes, toGb } from './disk-floor.js';
import { decideSwapHeal, interruptedUpdateText, claimInterruptedNotice } from './swap-heal.js';
import { chooseOwnerRecipient, type ApprovedSender } from './owner-recipient.js';


const PLATFORM_URL = process.env.DOJO_URL ?? 'http://localhost:3001';
const HEALTH_ENDPOINT = `${PLATFORM_URL}/api/health`;
const CHECK_INTERVAL_MS = 120_000; // 2 minutes
const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
const LOG_PATH = path.join(os.homedir(), '.dojo', 'logs', 'watchdog.log');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DOJO_DIR = path.join(os.homedir(), '.dojo');

// Watchdog-owned state store: heartbeat, last alert, and the alert ledger live in a JSON file the
// watchdog alone owns, read-only on the platform DB; survives restart; the route reads it.
const STATE_PATH = path.join(DOJO_DIR, 'watchdog-state.json');

// Last-known-good recipient cache: fall back to the last validated approved recipient ONLY when a
// live read FAILS; a successful read that approves nobody clears the cache, so a deliberate removal wins.
const RECIPIENT_CACHE_PATH = path.join(DOJO_DIR, 'watchdog-recipient.json');

let cachedRecipient: string | null = null;
let recipientCacheLoaded = false;

function loadRecipientCache(): void {
  recipientCacheLoaded = true;
  try {
    if (!fs.existsSync(RECIPIENT_CACHE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(RECIPIENT_CACHE_PATH, 'utf-8')) as { address?: unknown };
    if (parsed && typeof parsed.address === 'string' && parsed.address) {
      cachedRecipient = parsed.address;
    }
  } catch {
    // Best-effort: a missing or corrupt cache file simply means no last-known-good.
  }
}

// Lazily loaded: the first read may fail before memory holds anything.
function getCachedRecipient(): string {
  if (!recipientCacheLoaded) loadRecipientCache();
  return cachedRecipient ?? '';
}

function cacheRecipient(address: string): void {
  if (!address) return;
  cachedRecipient = address;
  recipientCacheLoaded = true;
  // Best-effort file write: this must NEVER throw into the check cycle.
  try {
    if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
    fs.writeFileSync(RECIPIENT_CACHE_PATH, JSON.stringify({ address, writtenAt: new Date().toISOString() }));
  } catch {
    // Memory cache still holds for this process; the file is a bonus for cold starts.
  }
}

function clearCachedRecipient(): void {
  cachedRecipient = null;
  recipientCacheLoaded = true;
  try {
    if (fs.existsSync(RECIPIENT_CACHE_PATH)) fs.unlinkSync(RECIPIENT_CACHE_PATH);
  } catch {
  }
}

// Never text an UNAPPROVED number: this runs out-of-band, so it validates here against the same
// `imessage_approved_senders` config the bridge uses: candidate if approved, else primary, else ''.

// A read FAILURE (DB unreadable) is not a successful empty allowlist: only it may use last-known-good.
type ApprovedSendersRead = { ok: true; senders: ApprovedSender[] } | { ok: false };

function getApprovedSenders(): ApprovedSendersRead {
  // DB missing is a FAILURE (not "approves nobody"): never mute the watchdog when a fallback is on file.
  if (!fs.existsSync(DB_PATH)) return { ok: false };
  let value: string | undefined;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    // Read-only, plus busy_timeout so a transient platform-DB lock is waited out, not thrown.
    db.pragma('busy_timeout = 3000');
    const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    db.close();
    value = row?.value;
  } catch {
    return { ok: false }; // DB locked / corrupted / query threw = read FAILED
  }
  // Read succeeded from here down. No configured value = owner approves nobody.
  if (!value) return { ok: true, senders: [] };
  try {
    const parsed = JSON.parse(value);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.senders) ? parsed.senders : []);
    const senders = arr
      // A bare-address list: the first entry is the owner.
      .map((s: unknown, i: number) => (typeof s === 'string' ? { address: s, is_primary: i === 0 } : (s as ApprovedSender)))
      .filter((s: { address?: string }) => !!s.address) as ApprovedSender[];
    return { ok: true, senders };
  } catch {
    return { ok: false }; // corrupted config value = treat as read FAILED
  }
}

// iMessage recipient validated against the allowlist; last-known-good fallback if the DB read fails.
function getImessageRecipient(): string {
  const read = getApprovedSenders();

  // Live read FAILED: use the last validated recipient so a corrupted-DB alert still reaches the owner.
  if (!read.ok) {
    const cached = getCachedRecipient();
    if (cached) {
      log('warn', 'recipient resolved from last-known-good cache, DB unreadable');
      return cached;
    }
    return '';
  }

  const approved = read.senders;
  // Successful read, empty allowlist = the owner approves nobody: send nothing AND clear the cache.
  if (approved.length === 0) {
    clearCachedRecipient();
    return '';
  }

  // Honor the candidate only if it is approved; else the approved primary (the owner), else nothing.
  const candidate = process.env.DOJO_IMESSAGE_RECIPIENT
    ?? (() => {
      try {
        if (!fs.existsSync(DB_PATH)) return '';
        const db = new Database(DB_PATH, { readonly: true });
        db.pragma('busy_timeout = 3000');
        const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_default_sender'").get() as { value: string } | undefined;
        db.close();
        return row?.value ?? '';
      } catch { return ''; }
    })();
  const resolved = chooseOwnerRecipient(approved, candidate);
  if (!resolved) {
    // No starred owner (the owner removed it on purpose): text nobody, and keep no stale recipient.
    clearCachedRecipient();
    log('warn', 'no owner is starred on the iMessage list; the watchdog will not text anyone');
    return '';
  }

  // Refresh the cache on every successful resolution; it only ever holds a validated address.
  cacheRecipient(resolved);
  return resolved;
}

let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_ALERT = 3;
const MAX_FAILURES_BEFORE_RESTART = 5;

// Truthful downtime accounting: `consecutiveFailures` resets ONLY on recovery, so the DOWN alert
// counts real downtime across restarts; a separate `failuresSinceRestart` drives the restart cadence
// (the only thing a restart resets); `restartAttempts` / `lastRestartAt` gate the "restart failed" alert.
let failuresSinceRestart = 0;
let restartAttempts = 0;
let lastRestartAt = 0;
// Grace window (in failed checks) after a restart before we conclude it did not help (~4 min).
const RESTART_GRACE_FAILURES = 2;

// Per-provider consecutive-unreachable counters: alert only on a sustained outage (N straight
// cycles), not a blip. In-memory only: a watchdog restart clears these.
const PROVIDER_FAILURE_THRESHOLD = 3; // ~3 cycles = ~6 min at CHECK_INTERVAL_MS
const providerFailureCounts: Record<string, number> = {};

// The ledger lives in `alert-ledger.ts` so it can be unit-driven (this file starts a daemon at import).
// Rules: first sends, a still-active issue waits 2 hours, a resolution sends exactly one recovery.
let state: WatchdogState = emptyState();

function loadState(): void {
  state = readState(STATE_PATH);
}

function saveState(): void {
  if (!persistState(state, STATE_PATH)) {
    log('error', 'Failed to persist watchdog state', { path: STATE_PATH });
  }
}

function claimAlertFor(alertKey: AlertKey, recipient: string): boolean {
  const send = claimAlertIn(state, alertKey, recipient);
  if (send) saveState();
  return send;
}

function markAlertResolved(alertKey: string): boolean {
  const resolved = markAlertResolvedIn(state, alertKey);
  if (resolved) saveState();
  return resolved;
}

/** Retire an alert AND tell the owner it is over. The recipient is resolved FIRST and the alert is
 *  retired only with a place to send: an unreachable owner POSTPONES the recovery, not destroys it. */
function resolveAndTell(alertKey: AlertKey, text: string): boolean {
  const to = getImessageRecipient();
  if (!to) {
    if (state.alertState[alertKey]?.active) {
      log('warn', 'Recovery message HELD: no approved recipient could be resolved; the alert stays active and the next cycle retries', { alertKey });
    }
    return false;
  }
  if (!markAlertResolved(alertKey)) return false;
  sendIMessage(to, text);
  return true;
}


function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(level: string, message: string, meta?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'watchdog',
    message,
    ...(meta ? { meta } : {}),
  });
  // Best-effort like every watchdog write: a full disk or unwritable ~/.dojo must never kill the
  // daemon (every cycle starts with a log() call); console output still goes to launchd's log.
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, entry + '\n');
  } catch {
    // Unwritable log (disk full, permissions); keep watching anyway.
  }
  if (level === 'error' || level === 'warn') {
    console.error(`[${level}] ${message}`);
  } else {
    console.log(`[${level}] ${message}`);
  }
}


function sendIMessage(recipient: string, text: string): void {
  if (!recipient) {
    log('warn', 'No iMessage recipient configured');
    return;
  }

  try {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Positional `1st service whose service type = iMessage` throws AppleScript -10002 on recent
    // macOS; iterate services by element (no filtered "whose" reference), fall back to `item 1`.
    const script = `
      tell application "Messages"
        set targetService to missing value
        repeat with s in services
          try
            if (service type of s) is iMessage then
              set targetService to s
              exit repeat
            end if
          end try
        end repeat
        if targetService is missing value then set targetService to item 1 of services
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

// A LOCAL (Ollama) "system"-tier model, when configured, rewrites alert facts into clearer text.
// STRICTLY best-effort: ANY failure falls back to fixed text; local-only: the cloud may be down too.
function getSystemLocalModel(): string | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const row = db.prepare(`
      SELECT m.api_model_id AS apiModelId
      FROM router_tier_models tm
      JOIN models m ON m.id = tm.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE tm.tier_id = 'system' AND m.is_enabled = 1 AND p.type = 'ollama'
      ORDER BY tm.priority ASC
      LIMIT 1
    `).get() as { apiModelId: string } | undefined;
    db.close();
    return row?.apiModelId ?? null;
  } catch {
    return null;
  }
}

async function composeSmartAlert(fixedText: string): Promise<string> {
  const model = getSystemLocalModel();
  if (!model) return fixedText;
  try {
    const prompt =
      "You are the DOJO watchdog writing a short alert to the operator's phone. " +
      'Rewrite the status below as ONE or TWO short, calm, plain-text sentences ' +
      '(no markdown, no emoji, no greeting). State the problem and, if there is an ' +
      'obvious next step, add it. Do NOT invent any detail not present in the status. ' +
      'Keep it under 300 characters.\n\n' +
      `Status: ${fixedText}`;
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 120 },
      }),
      // Short hard cap: a hung Ollama must not sit on the alert; fall back immediately.
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return fixedText;
    const data = await response.json() as { response?: string };
    const composed = (data.response ?? '').trim();
    if (!composed || composed.length > 600) return fixedText;
    // Keep alerts identifiable no matter how the model phrased it.
    const body = composed.replace(/^watchdog:\s*/i, '').trim();
    return body ? `Watchdog: ${body}` : fixedText;
  } catch {
    return fixedText;
  }
}

async function sendSmartAlert(recipient: string, fixedText: string): Promise<void> {
  sendIMessage(recipient, await composeSmartAlert(fixedText));
}

// Heartbeat and last-alert go to the watchdog's OWN store, never the platform DB; the route reads it.

function recordHeartbeat(): void {
  state.lastHeartbeat = new Date().toISOString();
  saveState();
}

function recordAlert(message: string): void {
  state.lastAlert = { message, at: new Date().toISOString() };
  saveState();
}


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

async function checkStalledAgents(): Promise<void> {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    // Read-only discipline: busy_timeout waits out a transient lock; NEVER set journal_mode on the
    // readonly connection: it writes the header and THROWS on a non-WAL DB; the platform owns WAL.
    db.pragma('busy_timeout = 3000');

    // (1) Agents stuck in 'working' with no progress for 30+ min.
    const stalled = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'working'
        AND updated_at <= datetime('now', '-30 minutes')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    // (2) An agent NOT working (idle/error/paused) with an unanswered HUMAN ask waiting 15+ min.
    // The waiting set is `work(kind='ask', state='open')`, opened with the message,
    // so an unauthorized inbound never opens one and can never be counted here.
    // `lane='owner'` is the platform's waiting-set form; the A2A filters stay: a migrated
    // row can still hold `a2a_thread_id`.
    // `opened_at` is epoch-ms INTEGER and `session_started_at` is TEXT:
    // SQLite orders INTEGER before TEXT unconditionally, so the old compare was
    // constantly false; each compare now casts both sides via unixepoch.
    const backlog = db.prepare(`
      SELECT a.id AS id, a.name AS name, a.status AS status,
             COUNT(*) AS waiting, MIN(w.opened_at) AS oldest
      FROM agents a
      JOIN work w ON w.agent_id = a.id
      JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      WHERE a.status IN ('idle', 'error', 'paused')
        AND w.kind = 'ask'
        AND w.state = 'open'
        AND m.role = 'user'
        AND m.lane = 'owner'
        AND m.source_agent_id IS NULL
        AND m.a2a_thread_id IS NULL
        AND w.opened_at >= COALESCE(unixepoch(a.session_started_at) * 1000, 0)
        AND w.opened_at <= (unixepoch('now', '-15 minutes') * 1000)
      GROUP BY a.id, a.name, a.status
    `).all() as Array<{ id: string; name: string; status: string; waiting: number; oldest: number }>;

    db.close();

    // LOG-ONLY by owner decision: the phone voice is reserved for platform-down and update failures,
    // and this backlog query is an approximation that produced a false positive; it stays log-only.
    if (stalled.length > 0) {
      const names = stalled.map(a => a.name).join(', ');
      log('warn', `Stalled agents detected: ${names}`, { count: stalled.length });
    }
    if (backlog.length > 0) {
      const names = backlog.map(a => `${a.name} (${a.waiting} waiting, ${a.status})`).join(', ');
      log('warn', `Agents with unanswered human backlog: ${names}`, { count: backlog.length });
    }
    if (stalled.length === 0 && backlog.length === 0 && markAlertResolved('stalled_agents')) {
      // Clears any stalled-agents alert state an older watchdog may have left, silently.
      log('info', 'No more stalled agents or human backlog');
    }
  } catch (err) {
    log('error', 'Failed to check stalled agents', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// The box's ENABLED model providers (read-only). "Enabled" = a provider (excluding the internal
// `__system__` sentinel) with at least one enabled model: the same set the platform routes to.
type EnabledProvider = { id: string; name: string; type: string; base_url: string | null };

function getEnabledProviders(): EnabledProvider[] {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const rows = db.prepare(`
      SELECT p.id AS id, p.name AS name, p.type AS type, p.base_url AS base_url
      FROM providers p
      WHERE p.id != '__system__'
        AND EXISTS (SELECT 1 FROM models m WHERE m.provider_id = p.id AND m.is_enabled = 1)
    `).all() as EnabledProvider[];
    db.close();
    return rows;
  } catch {
    // DB unreadable: provider probing needs the DB, so skip this cycle (platform-down handling covers it).
    return [];
  }
}

function isLocalHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local');
  } catch {
    return false;
  }
}

// A cheap reachability probe: no API key, no model call, just whether the endpoint answers over the
// network. No probeable public endpoint for a type: use its configured base_url; none: null (skip).
function resolveProviderProbe(p: EnabledProvider): { url: string; method: 'GET' | 'HEAD'; local: boolean } | null {
  const base = (p.base_url ?? '').replace(/\/+$/, '');
  switch (p.type) {
    case 'ollama': {
      const root = base || OLLAMA_URL.replace(/\/+$/, '');
      return { url: `${root}/api/tags`, method: 'GET', local: isLocalHost(root) };
    }
    case 'anthropic': {
      const root = base || 'https://api.anthropic.com';
      return { url: root, method: 'HEAD', local: isLocalHost(root) };
    }
    case 'openai': {
      const root = base || 'https://api.openai.com';
      return { url: root, method: 'HEAD', local: isLocalHost(root) };
    }
    case 'openai-compatible':
      // No universal public endpoint; use the configured base_url when present.
      return base ? { url: base, method: 'HEAD', local: isLocalHost(base) } : null;
    default:
      return base ? { url: base, method: 'HEAD', local: isLocalHost(base) } : null;
  }
}

// Reachable = the host returned ANY HTTP response (even 401/403/404, i.e. up but unauthenticated).
// Only a network/DNS/timeout failure counts as down. Short, hard cap.
async function probeProviderReachable(url: string, method: 'GET' | 'HEAD'): Promise<boolean> {
  try {
    await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

// Probe ENABLED providers for cheap HTTP reachability (no API key, no model call); per-provider
// failure counts drive the sustained-unreachable line below.
async function checkProviders(): Promise<void> {
  const providers = getEnabledProviders();
  if (providers.length === 0) return; // DB unreadable or no enabled providers to probe.

  for (const p of providers) {
    const probe = resolveProviderProbe(p);
    if (!probe) {
      log('debug', 'Provider has no probeable endpoint, skipping', { provider: p.name, type: p.type });
      continue;
    }
    const alertKey = `provider_down:${p.id}`;
    const reachable = await probeProviderReachable(probe.url, probe.method);

    if (reachable) {
      providerFailureCounts[p.id] = 0;
      if (markAlertResolved(alertKey)) {
        // Clears alert state an older watchdog may have left, silently.
        log('info', 'Provider reachable again', { provider: p.name });
      } else {
        log('debug', 'Provider reachable', { provider: p.name });
      }
      continue;
    }

    // Unreachable this cycle.
    const count = (providerFailureCounts[p.id] ?? 0) + 1;
    providerFailureCounts[p.id] = count;
    log('warn', 'Provider unreachable', { provider: p.name, type: p.type, url: probe.url, consecutive: count });

    // LOG-ONLY by owner decision: a deliberately powered-off local provider flaps this probe (the
    // network can answer for a sleeping machine), so provider reachability stays in log lines only.
    if (count === PROVIDER_FAILURE_THRESHOLD) {
      log('warn', 'Provider has reached the sustained-unreachable threshold (log-only, no owner text)', {
        provider: p.name, consecutive: count });
    }
  }
}

function getMacAvailableMemoryMb(): { totalMb: number; freeMb: number; freePercent: number } {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  try {
    const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });
    const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;
    const parsePage = (label: string): number => {
      const match = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
      return match ? parseInt(match[1], 10) : 0;
    };
    const available = parsePage('Pages free') + parsePage('Pages inactive') + parsePage('Pages purgeable') + parsePage('Pages speculative');
    const freeMb = Math.round((available * pageSize) / (1024 * 1024));
    return { totalMb, freeMb: Math.max(0, freeMb), freePercent: (freeMb / totalMb) * 100 };
  } catch {
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    return { totalMb, freeMb, freePercent: (freeMb / totalMb) * 100 };
  }
}

async function checkSystemMemory(): Promise<void> {
  const { freeMb, freePercent } = getMacAvailableMemoryMb();

  if (freePercent < 10) {
    log('warn', 'System memory low', { freeMb, freePercent: freePercent.toFixed(1) });

    const imRecipient = getImessageRecipient();
    if (claimAlertFor('memory_low', imRecipient)) {
      await sendSmartAlert(imRecipient, `Watchdog: System memory low, ${freeMb}MB free (${freePercent.toFixed(0)}%). Will follow up when resolved.`);
      recordAlert(`Memory low: ${freeMb}MB`);
    }
  } else {
    // Memory is fine, send recovery if it was previously alerting
    if (resolveAndTell('memory_low', `Watchdog: Memory recovered, ${freeMb}MB free (${freePercent.toFixed(0)}%)`)) {
      log('info', 'System memory recovered', { freeMb, freePercent: freePercent.toFixed(1) });
    } else {
      log('debug', 'System memory OK', { freeMb, freePercent: freePercent.toFixed(1) });
    }
  }
}

async function checkDiskSpace(): Promise<void> {
  try {
    const result = execSync(`df -k "${DOJO_DIR}" | tail -1`, { encoding: 'utf-8', timeout: 5000 });
    const parts = result.trim().split(/\s+/);
    const availableKb = parseInt(parts[3] ?? '0', 10);
    const availableGb = availableKb / (1024 * 1024);

    // Ordered against the platform's own refusals: never below the point a
    // pre-migration backup, and so an update, is refused (disk-floor.ts).
    const floor = diskFloorBytes();
    const floorGb = toGb(floor.bytes);

    if (availableGb < floorGb) {
      log('warn', 'Disk space critically low', {
        availableGb: availableGb.toFixed(2), floorGb: floorGb.toFixed(2), binding: floor.binding,
      });
      const imRecipient = getImessageRecipient();
      if (claimAlertFor('disk_low', imRecipient)) {
        // The owner is told WHICH answer set the number: an unaccountable threshold gets ignored.
        const because = floor.binding === 'backup'
          ? ` This box needs about ${floorGb.toFixed(1)}GB free to keep making a database backup before it updates.`
          : '';
        await sendSmartAlert(imRecipient, `Watchdog: Disk space low, ${availableGb.toFixed(1)}GB free.${because} Will follow up when resolved.`);
        recordAlert(`Disk space low: ${availableGb.toFixed(1)}GB (floor ${floorGb.toFixed(1)}GB, ${floor.binding})`);
      }
    } else {
      resolveAndTell('disk_low', `Watchdog: Disk space recovered, ${availableGb.toFixed(1)}GB free.`);
      log('debug', 'Disk space OK', { availableGb: availableGb.toFixed(1), floorGb: floorGb.toFixed(2) });
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

// The database failing its integrity check is owner-told, like the platform-down and update alerts.
async function alertDbIntegrity(status: string): Promise<void> {
  log('error', 'Database integrity check FAILED', { status });
  // Recorded first, whether or not a text can go (the dashboard's health page and history read it).
  recordAlert(`DB integrity: ${status}`);
  const imRecipient = getImessageRecipient();
  if (claimAlertFor('db_integrity', imRecipient)) {
    await sendSmartAlert(imRecipient, `Watchdog: Database integrity check failed, ${status}`);
  }
}

async function checkDatabaseIntegrity(): Promise<void> {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    db.close();

    const status = result[0]?.integrity_check ?? 'unknown';
    if (status !== 'ok') {
      await alertDbIntegrity(status);
    } else {
      markAlertResolved('db_integrity');
      log('debug', 'Database integrity OK');
    }
  } catch (err) {
    log('error', 'Database integrity check error', {
      error: err instanceof Error ? err.message : String(err),
    });
    // A file too damaged for the check to run THROWS rather than answering; that is the worst
    // case and must reach the owner like any other integrity failure. Busy/locked stays quiet.
    const damaged = integrityFailureFromError(err);
    if (damaged) await alertDbIntegrity(damaged);
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

// Quiet health probe (no logging) used as the fallback restart's double-start guard. Separate from
// checkPlatformHealth so a pre-spawn check doesn't emit a misleading "Platform unreachable" line.
async function isPlatformResponding(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function attemptRestart(): Promise<void> {
  log('warn', 'Attempting to restart Dojo platform');

  // Primary path: launchd kickstart of the supervised job, works whenever supervision is intact.
  try {
    execSync('launchctl kickstart -k gui/$(id -u)/com.dojo.platform', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    log('info', 'Restart command sent via launchctl');
    return;
  } catch {
    // launchctl failed (job likely unloaded, when a fallback matters most): fall through to a direct spawn.
    log('warn', 'launchctl kickstart failed, falling back to a direct entrypoint spawn');
  }

  // Run the compiled entrypoint directly and detached: an emergency restart must work with launchd broken.
  try {
    const platformDir = path.join(DOJO_DIR, 'platform');
    const entrypoint = path.join(platformDir, 'packages', 'server', 'dist', 'index.js');
    if (!fs.existsSync(entrypoint)) {
      log('error', 'Fallback restart skipped, server entrypoint not found', { entrypoint });
      return;
    }
    // Double-start guard: a KeepAlive revival may have already brought the platform back
    // (or it never truly died); if it answers health, do NOT spawn a second copy.
    if (await isPlatformResponding()) {
      log('info', 'Fallback restart skipped, platform is already responding');
      return;
    }
    // The exec failure arrives ASYNCHRONOUSLY, outside this try/catch; an 'error' event with no
    // listener is rethrown and kills this daemon on the emergency path.
    const child = spawn(process.execPath, [entrypoint], {
      cwd: platformDir,
      env: { ...process.env, NODE_ENV: 'production' },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      log('error', 'Fallback restart spawn failed', {
        error: err instanceof Error ? err.message : String(err), entrypoint,
      });
    });
    child.unref();
    log('info', 'Restart attempted via direct entrypoint spawn', { pid: child.pid ?? null, entrypoint });
  } catch (err) {
    log('error', 'Restart failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Update-recovery path, NOT the generic platform-down cascade: act ONLY when the update-state marker
// PROVES a failing self-update episode (booting-new/rolled-back with its gate tripped): roll back
// once (code only) via rollback.sh, or escalate to failed-permanently. Returns true when handled, so
// runCheck skips the generic cascade that would kickstart the same bad build and race rollback.sh.
async function maybeAutoRollback(): Promise<boolean> {
  // THE DECISION IS MADE INSIDE THE LOCK: reading first and writing a transition built on that read
  // is a lost update against the platform's boot sentinel, and the flag it erases stops a code-only
  // rollback onto a migrated database (full argument: `auto-rollback.ts`, THE SERIALISED WRITE PATH).
  const seen: { marker: UpdateMarker | null; decision: RollbackDecision } = {
    marker: null,
    decision: { action: 'none' },
  };
  updateMarker((fresh) => {
    seen.marker = fresh;
    const d = decideAutoRollback(fresh, Date.now());
    seen.decision = d;
    if (!fresh || d.action === 'none') return null;
    return d.action === 'escalate' ? toFailedPermanently(fresh, d.reason) : toRolledBack(fresh);
  });
  const marker = seen.marker;
  const decision = seen.decision;
  if (!marker || decision.action === 'none') return false;

  const imRecipient = getImessageRecipient();

  if (decision.action === 'escalate') {
    // The terminal state was recorded inside the lock above (with the reason, so the platform's
    // confirmHealthy can recover a migration escalation that finishes healthy later). Alert once, loud.
    log('error', 'D-F: escalating a failed self-update to failed-permanently (no auto-rollback)', {
      reason: decision.reason,
      targetVersion: marker.targetVersion,
      previousVersion: marker.previousVersion,
      rollbackCount: marker.rollbackCount,
    });
    if (claimAlertFor('auto_rollback_failed', imRecipient)) {
      const because = decision.reason === 'migration'
        ? 'the update had already changed the database, so undoing just the app could make things worse'
        : 'putting the previous version back once did not fix it, and trying again is not safe';
      await sendSmartAlert(
        imRecipient,
        `Watchdog: a Dojo update failed to start and I did NOT undo it automatically because ${because}. ` +
        `The box may keep restarting. Please open the Dojo dashboard and restore a previous version, or reach out for help. I will keep watching.`,
      );
      recordAlert('Auto-rollback escalated to failed-permanently');
    }
    return true;
  }

  // decision.action === 'rollback'
  log('warn', 'D-F: self-update did not come up healthy, auto-rolling back to the previous build (code only)', {
    targetVersion: marker.targetVersion,
    previousVersion: marker.previousVersion,
    bootAttempts: marker.bootAttempts,
    firstBootAt: marker.firstBootAt,
  });
  // The rollback intent and the restored build's fresh boot window were recorded above, inside the
  // lock, BEFORE spawning: rollback.sh unloads this job and could cut a slow send short.
  if (claimAlertFor('auto_rollback', imRecipient)) {
    const toVer = marker.previousVersion ? ` (${marker.previousVersion})` : '';
    await sendSmartAlert(
      imRecipient,
      `Watchdog: a Dojo update did not start up correctly, so I am automatically putting the previous version${toVer} back. ` +
      `The box will restart on its own in a minute. I will let you know if anything still looks wrong.`,
    );
    recordAlert('Auto-rollback to previous build initiated');
  }
  const pid = spawnRollbackDetached(undefined, (err) => {
    log('error', 'D-F: rollback.sh could not be executed (async spawn error)', {
      error: err.message, script: ROLLBACK_SCRIPT,
    });
  });
  if (pid === null) {
    log('error', 'D-F: rollback.sh could not be spawned (missing script or exec error)', { script: ROLLBACK_SCRIPT });
  } else {
    log('info', 'D-F: rollback.sh spawned detached', { pid, script: ROLLBACK_SCRIPT });
  }
  return true;
}

// A missing platform folder is a swap cut off between its two renames; nothing inside the platform
// can repair that, so this daemon does (`rollback.sh --heal`). Returns true when it acted.
function logHealSpawnError(err: Error): void {
  log('error', 't197: rollback.sh --heal could not be executed', { error: err.message, script: ROLLBACK_SCRIPT });
}
async function maybeHealSwap(): Promise<boolean> {
  const marker = readMarker();
  const heal = decideSwapHeal(DOJO_DIR, marker);
  const to = getImessageRecipient();
  if (heal.action !== 'heal') {
    // Told once: the record goes quiet first, so overlapping cycles cannot both send.
    if (marker?.phase === 'interrupted' && to && claimInterruptedNotice(marker)) sendIMessage(to, interruptedUpdateText(marker));
    return false;
  }
  log('error', 't197: the platform folder is missing; repairing the cut-off swap', { finishes: heal.finishes });
  if (claimAlertFor('platform_missing', to)) { await sendSmartAlert(to, heal.text); recordAlert(`Platform folder missing: ${heal.finishes}`); }
  if (heal.finishes !== 'nothing-to-restore') spawnRollbackDetached(ROLLBACK_SCRIPT, logHealSpawnError, ['--heal']);
  return true;
}

// Patience gate: a migration boot can hold health down for a long one-time chain, so hold the
// generic kickstart inside the auto-rollback gate's FAIL_WALL_CLOCK_MS: never kill it mid-migration.
function isWithinMigrationBootWindow(): boolean {
  const marker = readMarker();
  if (!marker) return false;
  if (marker.phase !== 'booting-new') return false;
  if (marker.confirmedHealthyAt) return false;
  if (!marker.firstBootAt) return false;
  const firstBootMs = Date.parse(marker.firstBootAt);
  if (!Number.isFinite(firstBootMs)) return false;
  return (Date.now() - firstBootMs) < FAIL_WALL_CLOCK_MS;
}


// Monotonic cycle counter so the integrity check runs on a guaranteed cadence (every 10th cycle).
let cycleCount = 0;

async function runCheck(): Promise<void> {
  cycleCount++;
  log('info', 'Running watchdog check cycle');

  recordHeartbeat();

  // 0. A missing platform folder is repaired before health is judged.
  if (await maybeHealSwap()) return;

  // 1. Platform health
  const healthy = await checkPlatformHealth();

  // 1b. A PROVEN-failing self-update takes precedence over the generic cascade: roll back or
  // escalate, then short-circuit so we do not kickstart the same bad build and race rollback.sh.
  if (!healthy && await maybeAutoRollback()) return;

  if (!healthy) {
    // `consecutiveFailures` is the TRUTHFUL count (resets only on recovery); `failuresSinceRestart`
    // is the cadence counter and the only thing a restart resets, so the texted count stays honest.
    consecutiveFailures++;
    failuresSinceRestart++;
    log('warn', `Platform unhealthy (${consecutiveFailures} consecutive failures, ${restartAttempts} restart attempt(s) this outage)`, {
      consecutiveFailures, failuresSinceRestart, restartAttempts,
      lastRestartAt: lastRestartAt ? new Date(lastRestartAt).toISOString() : null,
    });

    // Restart every MAX_FAILURES_BEFORE_RESTART failed checks; only the cadence counter resets, the
    // truthful count keeps climbing. EXCEPTION: inside the migration-boot window hold the kickstart
    // (do NOT reset the cadence counter) so the next cycle proceeds once the window passes.
    if (failuresSinceRestart >= MAX_FAILURES_BEFORE_RESTART) {
      if (isWithinMigrationBootWindow()) {
        log('info', 'Holding platform restart: a self-update migration boot is in progress and still inside the allowed window; waiting rather than killing it mid-migration', {
          consecutiveFailures, failuresSinceRestart,
        });
      } else {
        await attemptRestart();
        restartAttempts++;
        lastRestartAt = Date.now();
        failuresSinceRestart = 0;
      }
    }

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT) {
      const imRecipient = getImessageRecipient();
      if (claimAlertFor('platform_down', imRecipient)) {
        await sendSmartAlert(imRecipient, `Watchdog: Dojo platform is DOWN (${consecutiveFailures} checks failed). Will notify when it recovers.`);
        recordAlert(`Platform down: ${consecutiveFailures} checks failed`);
      }
    }

    // The auto-restart did NOT fix it: after at least one restart and the grace window, tell the
    // owner in plain language. One text per cooldown via claimAlertFor.
    if (restartAttempts > 0 && failuresSinceRestart >= RESTART_GRACE_FAILURES) {
      const imRecipient = getImessageRecipient();
      if (claimAlertFor('platform_restart_failed', imRecipient)) {
        await sendSmartAlert(imRecipient, `Watchdog: I automatically restarted the Dojo platform ${restartAttempts} time(s) but it is still down after ${consecutiveFailures} failed checks. It needs manual attention.`);
        recordAlert(`Auto-restart did not fix platform: ${consecutiveFailures} failed checks, ${restartAttempts} restart(s)`);
      }
    }
  } else {
    // The recovery log fires whenever there were prior failures, even below the alert threshold.
    if (consecutiveFailures > 0) {
      log('info', 'Platform recovered', { previousFailures: consecutiveFailures });
    }
    // Recovery sends only if we previously alerted; markAlertResolved's active check enforces that,
    // so this must NOT be gated on `consecutiveFailures` (a restart's reset must not suppress it).
    resolveAndTell('platform_down', 'Watchdog: Dojo platform is back UP and healthy.');
    resolveAndTell('platform_missing', 'Watchdog: the repair worked. Dojo is back up and healthy.');
    // The restart-failed flag clears silently: the "back UP and healthy" text already told the owner.
    markAlertResolved('platform_restart_failed');

    // FALSE-ESCALATION: if we escalated but the box came up healthy after all, the platform recovers
    // the marker and this path (same alert key the escalation used) sends the "it finished after all" note.
    resolveAndTell('auto_rollback_failed', 'Watchdog: the Dojo update finished starting up after all and the box is healthy. No action needed.');
    // Clear the auto-rollback alert silently on recovery too; the message above already told the owner.
    markAlertResolved('auto_rollback');
    // Recovery is the ONLY place the truthful counter and restart bookkeeping reset.
    consecutiveFailures = 0;
    failuresSinceRestart = 0;
    restartAttempts = 0;
    lastRestartAt = 0;
  }

  // 2. Check stalled agents
  await checkStalledAgents();

  // 3. Check providers
  await checkProviders();

  // 4. Check system memory
  await checkSystemMemory();

  // 5. Check disk space
  await checkDiskSpace();

  // 6. Database integrity (run less frequently, every 10th cycle ~20 min)
  if (cycleCount % 10 === 0) {
    await checkDatabaseIntegrity();
  }

  // 7. Rotate watchdog log if needed
  rotateWatchdogLog();
}


// Reload the persisted ledger BEFORE the first cycle: a KeepAlive restart mid-incident must not
// re-alert still-active issues or lose a recovery that resolved while we were down.
loadState();

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

// THE LAST NET: Node's default for both handlers is print-and-exit. Staying up is deliberate: the
// alternative to a degraded watchdog is NO watchdog; everything durable is rewritten every cycle.
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception — the watchdog is staying up and continuing to watch', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled promise rejection — the watchdog is staying up and continuing to watch', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Watchdog shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Watchdog shutting down (SIGINT)');
  process.exit(0);
});
