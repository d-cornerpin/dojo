// ════════════════════════════════════════
// Dojo Watchdog, Standalone Process
// Monitors platform health independently.
// ════════════════════════════════════════

import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  readMarker,
  writeMarker,
  decideAutoRollback,
  toRolledBack,
  toFailedPermanently,
  spawnRollbackDetached,
  ROLLBACK_SCRIPT,
  FAIL_WALL_CLOCK_MS,
} from './auto-rollback.js';

// ── Config ──

const PLATFORM_URL = process.env.DOJO_URL ?? 'http://localhost:3001';
const HEALTH_ENDPOINT = `${PLATFORM_URL}/api/health`;
const CHECK_INTERVAL_MS = 120_000; // 2 minutes
const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
const LOG_PATH = path.join(os.homedir(), '.dojo', 'logs', 'watchdog.log');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DOJO_DIR = path.join(os.homedir(), '.dojo');

// ── Watchdog-owned state store (FA-W5 / FA-W6) ──
// The watchdog used to write its heartbeat and last-alert INTO the platform DB
// read-write every cycle (config table), and kept its alert dedup/recovery
// ledger in process memory only. Both were wrong for an independent
// last-line-of-defense daemon: a transient platform-DB lock dropped a heartbeat
// and made the platform report a false "watchdog down" (FA-W5), and a KeepAlive
// restart wiped the ledger so still-active issues re-alerted and recoveries
// were lost (FA-W6). All of that now lives here, in a small JSON file the
// watchdog alone owns, so the watchdog keeps strict read-only discipline over
// the platform DB and its dedup/recovery contract survives a restart. The
// platform's /api/system/watchdog route READS this file for liveness.
const STATE_PATH = path.join(DOJO_DIR, 'watchdog-state.json');

// ── Last-known-good recipient cache (FA-W2) ──
// The approved-sender allowlist lives in the DB. If the DB is unreadable (missing,
// locked, or corrupted) the live resolution below yields NO recipient and every alert
// silently no-ops, including the DB-corruption alert itself, the exact moment the
// operator most needs to hear from us. So we remember the last SUCCESSFULLY RESOLVED
// approved recipient, in process memory and in a tiny watchdog-owned file, and fall back
// to it ONLY when a live read FAILS. A successful read that approves nobody CLEARS the
// cache, so a deliberate removal still wins on the next healthy cycle (120s). The cache
// is only ever populated by a validated resolution, so it can only ever hold an address
// the owner approved.
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

// Lazily loaded so the file cache earns its keep on the corrupted-at-boot case, where the
// first read of the process fails before any successful read has populated memory.
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
    // Best-effort.
  }
}

// W-B1 (comms-audit): the watchdog must never text an UNAPPROVED number. It runs
// out-of-band (even when the platform is down), so it can't go through the bridge's
// safe-sender gate, it validates here instead, against the same
// `imessage_approved_senders` config the bridge uses. The candidate (env override or
// the legacy default-sender) is used only if it matches an approved sender; otherwise
// we fall back to the approved PRIMARY (the owner). If nothing is approved, return ''
// (send nothing) rather than text an unvalidated recipient.
const normAddr = (s: string): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9@.]/g, '').replace(/^1(\d{10})$/, '$1');

type ApprovedSender = { address: string; is_primary?: boolean };
// Distinguish a live-read FAILURE (DB missing / locked / corrupted / query threw) from a
// SUCCESSFUL read that returned an empty allowlist (owner approves nobody). FA-W2 needs
// this split: only the failure path may fall back to the last-known-good cache; a
// successful-empty read is a deliberate removal and must clear it.
type ApprovedSendersRead = { ok: true; senders: ApprovedSender[] } | { ok: false };

function getApprovedSenders(): ApprovedSendersRead {
  // DB missing is a read FAILURE (not "approves nobody"): a moved or deleted DB must not
  // silently mute the watchdog when a last-known-good recipient is on file.
  if (!fs.existsSync(DB_PATH)) return { ok: false };
  let value: string | undefined;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    // FA-W5: read-only, plus a busy_timeout so a transient platform-DB lock is
    // WAITED OUT briefly instead of throwing immediately and dropping this
    // observation cycle. Applied to every remaining platform-DB open.
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
      .map((s: unknown) => (typeof s === 'string' ? { address: s } : (s as ApprovedSender)))
      .filter((s: { address?: string }) => !!s.address) as ApprovedSender[];
    return { ok: true, senders };
  } catch {
    return { ok: false }; // corrupted config value = treat as read FAILED
  }
}

// iMessage recipient, validated against the approved-sender allowlist (W-B1), with a
// last-known-good fallback when the DB is unreadable (FA-W2).
function getImessageRecipient(): string {
  const read = getApprovedSenders();

  // Live read FAILED (DB missing / locked / corrupted). Fall back to the last validated
  // recipient so a corrupted-DB alert can still reach the owner. If we never cached one,
  // there is nothing safe to send to.
  if (!read.ok) {
    const cached = getCachedRecipient();
    if (cached) {
      log('warn', 'recipient resolved from last-known-good cache, DB unreadable');
      return cached;
    }
    return '';
  }

  const approved = read.senders;
  // Successful read, empty allowlist = owner deliberately approves nobody. Send nothing
  // AND clear the cache so the removal wins over any prior last-known-good.
  if (approved.length === 0) {
    clearCachedRecipient();
    return '';
  }

  // W-B1 resolution (unchanged): honor the env / default-sender candidate only if it is
  // an approved sender, otherwise fall back to the approved primary (the owner), or the
  // first approved.
  const candidate = process.env.DOJO_IMESSAGE_RECIPIENT
    ?? (() => {
      try {
        if (!fs.existsSync(DB_PATH)) return '';
        const db = new Database(DB_PATH, { readonly: true });
        db.pragma('busy_timeout = 3000'); // FA-W5
        const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_default_sender'").get() as { value: string } | undefined;
        db.close();
        return row?.value ?? '';
      } catch { return ''; }
    })();
  const resolved = (candidate && approved.some((s) => normAddr(s.address) === normAddr(candidate)))
    ? candidate
    : (approved.find((s) => s.is_primary) ?? approved[0]).address;

  // Refresh the last-known-good cache on every successful resolution that yields a
  // recipient. The cache therefore only ever holds a validated, approved address.
  cacheRecipient(resolved);
  return resolved;
}

let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_ALERT = 3;
const MAX_FAILURES_BEFORE_RESTART = 5;

// FA-W3: truthful downtime accounting. `consecutiveFailures` above counts GENUINE
// consecutive failed health checks and now resets ONLY on recovery, so the DOWN alert's
// count reflects real downtime across restart cycles (it used to be zeroed by every
// restart, making the texted number meaningless). The restart CADENCE is driven by a
// SEPARATE `failuresSinceRestart` counter (the only thing a restart resets) so the
// existing "restart every 5 failed checks" behaviour is unchanged. `restartAttempts` /
// `lastRestartAt` track the current outage's restart cycles and gate the "restart did
// not fix it" alert.
let failuresSinceRestart = 0;
let restartAttempts = 0;
let lastRestartAt = 0;
// Grace window (in failed checks) after a restart before we conclude the restart did not
// help. 2 further failed checks ~= 4 min of continued downtime past the last restart.
const RESTART_GRACE_FAILURES = 2;

// FA-W4(a): per-provider consecutive-unreachable counters, so a provider must fail N
// straight cycles (a sustained outage, not a blip) before we alert. Reset on the first
// reachable cycle. In-memory only (FA-W6 accepted limitation: a watchdog process restart
// clears these, like the rest of alertState).
const PROVIDER_FAILURE_THRESHOLD = 3; // ~3 cycles = ~6 min at CHECK_INTERVAL_MS
const providerFailureCounts: Record<string, number> = {};

// ── Alert deduplication ──
// Tracks when each alert type was last sent to avoid spamming.
// First occurrence: send immediately. Same issue again: suppress for 2 hours.
// Issue resolved: send a recovery message.
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

type AlertLedger = Record<string, { lastSentAt: number; active: boolean }>;

interface WatchdogState {
  // Liveness the platform reads (FA-W5).
  lastHeartbeat: string | null;
  lastAlert: { message: string; at: string } | null;
  // Alert dedup/recovery ledger (FA-W6): persisted so send-once, the 2h
  // cooldown, and always-send-recovery hold ACROSS a KeepAlive restart.
  alertState: AlertLedger;
}

let state: WatchdogState = { lastHeartbeat: null, lastAlert: null, alertState: {} };

function loadState(): void {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Partial<WatchdogState>;
    const ledger: AlertLedger = {};
    if (parsed.alertState && typeof parsed.alertState === 'object') {
      for (const [key, val] of Object.entries(parsed.alertState)) {
        if (val && typeof (val as { lastSentAt?: unknown }).lastSentAt === 'number'
          && typeof (val as { active?: unknown }).active === 'boolean') {
          ledger[key] = { lastSentAt: (val as { lastSentAt: number }).lastSentAt, active: (val as { active: boolean }).active };
        }
      }
    }
    state = {
      lastHeartbeat: typeof parsed.lastHeartbeat === 'string' ? parsed.lastHeartbeat : null,
      lastAlert: parsed.lastAlert && typeof parsed.lastAlert.message === 'string' && typeof parsed.lastAlert.at === 'string'
        ? { message: parsed.lastAlert.message, at: parsed.lastAlert.at }
        : null,
      alertState: ledger,
    };
  } catch {
    // Corrupt/unreadable store: start clean rather than crash. Worst case is a
    // single restart's dedup/recovery slipping, i.e. the pre-fix behaviour.
  }
}

function saveState(): void {
  // Crash-safe atomic write: write a temp file then rename over the real one.
  // rename() is atomic on POSIX, so a crash mid-write can never leave a
  // half-written store, a reader sees either the old file or the new one.
  // (Chosen over a tiny sqlite: one small doc, no schema, no second DB to keep
  // read-only-safe, and the daemon already round-trips a JSON cache file.)
  // Best-effort: a failed persist must NEVER throw into the check cycle.
  try {
    if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    log('error', 'Failed to persist watchdog state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function shouldSendAlert(alertKey: string): boolean {
  const entry = state.alertState[alertKey];
  if (!entry || !entry.active) {
    // First time or was resolved, send it
    state.alertState[alertKey] = { lastSentAt: Date.now(), active: true };
    saveState();
    return true;
  }
  // Already sent and still active, only re-send after cooldown
  if (Date.now() - entry.lastSentAt > ALERT_COOLDOWN_MS) {
    state.alertState[alertKey] = { lastSentAt: Date.now(), active: true };
    saveState();
    return true;
  }
  return false;
}

function markAlertResolved(alertKey: string): boolean {
  const entry = state.alertState[alertKey];
  if (entry?.active) {
    state.alertState[alertKey] = { lastSentAt: entry.lastSentAt, active: false };
    saveState();
    return true; // Was active, now resolved, caller should send recovery
  }
  return false; // Was already resolved or never sent
}

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

    // Positional service selection, `1st service whose service type = iMessage`
    // throws AppleScript -10002 ("Invalid key form") on macOS 26/Sequoia.
    // Iterate services by element (no filtered "whose" reference), falling back
    // to `item 1 of services`.
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

// ── Smart alerts (best-effort) ──
// When the operator has selected a LOCAL (Ollama) model for the "system"
// router tier, the watchdog runs the raw alert facts through it to produce a
// clearer, more actionable text. STRICTLY best-effort: the watchdog is the
// last line of defense and must work when everything else is broken, so ANY
// failure (no local system model, Ollama down, timeout, junk output) falls
// straight back to the deterministic fixed-text alert, the smart version can
// never block the dumb one from going out. Local-only on purpose: during an
// incident the network/cloud may be down too, so the watchdog calls its own
// Ollama directly rather than the (possibly dead) platform. Cloud or unset
// system model → the watchdog stays fixed-text.
function getSystemLocalModel(): string | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000'); // FA-W5
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
      // Short, hard cap: a hung Ollama (likely on a wedged machine) must not
      // sit on the alert. On timeout we fall back to fixed text immediately.
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

// ── Heartbeat recording ──
// FA-W5: heartbeat and last-alert are recorded into the watchdog's OWN store
// (see STATE_PATH), never the platform DB. The watchdog no longer opens the
// platform DB read-write at all; the platform's /api/system/watchdog route
// reads this store for liveness.

function recordHeartbeat(): void {
  state.lastHeartbeat = new Date().toISOString();
  saveState();
}

function recordAlert(message: string): void {
  state.lastAlert = { message, at: new Date().toISOString() };
  saveState();
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

async function checkStalledAgents(): Promise<void> {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    // Read-only discipline: busy_timeout waits out a transient lock (FA-W5), but NEVER set
    // journal_mode here. A readonly connection cannot write the DB header, so
    // `journal_mode = WAL` THROWS "attempt to write a readonly database" on any non-WAL DB
    // (e.g. a freshly restored/imported box), which silently killed stall detection every
    // cycle. Journal mode is a property of the DB the platform owns, not something the
    // watchdog observer sets; match every other readonly open in this file.
    db.pragma('busy_timeout = 3000'); // FA-W5

    // (1) Agents stuck in 'working' with no progress for 30+ min (unchanged).
    const stalled = db.prepare(`
      SELECT id, name, status, updated_at FROM agents
      WHERE status = 'working'
        AND updated_at <= datetime('now', '-30 minutes')
    `).all() as Array<{ id: string; name: string; status: string; updated_at: string }>;

    // (2) FA-W4(b): an agent that is NOT working (idle/error/paused) yet has an
    // unanswered HUMAN message waiting 15+ min. This approximates the platform's
    // waiting-conversation shape (counterparty.ts getWaitingHumanConversations): a
    // role='user' row whose conv_key is still NULL was never picked up by a turn (i.e.
    // unanswered). We exclude the lanes that legitimately wait, engine events
    // (origin_kind='engine') and agent-to-agent traffic (source_agent_id / a2a_thread_id),
    // skip disposed rows (swept_at), and scope to the current session
    // (created_at >= session_started_at). Cheap approximation: the watchdog cannot run the
    // platform's authorized-sender gate, so an unauthorized third-party inbound could
    // count; the lane exclusions remove the large non-human cases.
    const backlog = db.prepare(`
      SELECT a.id AS id, a.name AS name, a.status AS status,
             COUNT(*) AS waiting, MIN(m.created_at) AS oldest
      FROM agents a
      JOIN messages m ON m.agent_id = a.id
      WHERE a.status IN ('idle', 'error', 'paused')
        AND m.role = 'user'
        AND m.conv_key IS NULL
        AND m.swept_at IS NULL
        AND (m.origin_kind IS NULL OR m.origin_kind != 'engine')
        AND m.source_agent_id IS NULL
        AND m.a2a_thread_id IS NULL
        AND m.created_at >= COALESCE(a.session_started_at, '1970-01-01')
        AND m.created_at <= datetime('now', '-15 minutes')
      GROUP BY a.id, a.name, a.status
    `).all() as Array<{ id: string; name: string; status: string; waiting: number; oldest: string }>;

    db.close();

    // Both feed the existing 'stalled_agents' alert path (shared cooldown + recovery),
    // with a distinct message per cause.
    const parts: string[] = [];
    if (stalled.length > 0) {
      const names = stalled.map(a => a.name).join(', ');
      log('warn', `Stalled agents detected: ${names}`, { count: stalled.length });
      parts.push(`${stalled.length} agent(s) stuck working with no progress for 30+ min: ${names}`);
    }
    if (backlog.length > 0) {
      const names = backlog.map(a => `${a.name} (${a.waiting} waiting, ${a.status})`).join(', ');
      log('warn', `Agents with unanswered human backlog: ${names}`, { count: backlog.length });
      parts.push(`${backlog.length} agent(s) not working but with a person's message waiting 15+ min unanswered: ${names}`);
    }

    if (parts.length > 0) {
      if (shouldSendAlert('stalled_agents')) {
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          await sendSmartAlert(imRecipient, `Watchdog: ${parts.join('. ')}. Will follow up when resolved.`);
          recordAlert(parts.join('. '));
        }
      }
    } else {
      if (markAlertResolved('stalled_agents')) {
        log('info', 'No more stalled agents or human backlog');
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          sendIMessage(imRecipient, 'Watchdog: Stalled agents resolved, all agents are responding.');
        }
      }
    }
  } catch (err) {
    log('error', 'Failed to check stalled agents', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// FA-W4(a) / D-G: the box's ENABLED model providers (read-only). "Enabled" = a provider
// (excluding the internal `__system__` auto sentinel) that has at least one model with
// is_enabled = 1. This is the same "enabled providers with enabled models" set the
// platform routes to; a provider with no enabled models is skipped.
type EnabledProvider = { id: string; name: string; type: string; base_url: string | null };

function getEnabledProviders(): EnabledProvider[] {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000'); // FA-W5
    const rows = db.prepare(`
      SELECT p.id AS id, p.name AS name, p.type AS type, p.base_url AS base_url
      FROM providers p
      WHERE p.id != '__system__'
        AND EXISTS (SELECT 1 FROM models m WHERE m.provider_id = p.id AND m.is_enabled = 1)
    `).all() as EnabledProvider[];
    db.close();
    return rows;
  } catch {
    // DB missing / locked / corrupted. Platform-down handling covers this case; provider
    // probing needs the DB to know what to probe, so we simply skip this cycle.
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

// Resolve a cheap reachability probe for a provider: no API key, no model call, no LLM.
// We only need to know the endpoint answers over the network. If a provider type has no
// probeable public endpoint we fall back to its configured base_url; if there is none,
// return null (unprobeable, skipped).
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

// Reachable = the host returned ANY HTTP response (even 401/403/404, i.e. up but
// unauthenticated). Only a network/DNS/timeout failure counts as down. Short, hard cap.
async function probeProviderReachable(url: string, method: 'GET' | 'HEAD'): Promise<boolean> {
  try {
    await fetch(url, { method, signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

// FA-W4(a) / D-G: alert the owner on a SUSTAINED outage of an ENABLED provider (not just
// platform-process-down). Cheap and independent: HTTP reachability only, no API key, no
// LLM. A provider must fail PROVIDER_FAILURE_THRESHOLD straight cycles before alerting;
// per-provider alert keys (`provider_down:<id>`) reuse the existing shouldSendAlert
// cooldown and markAlertResolved recovery. Local providers (e.g. Ollama) are probed like
// any other, the alert text just notes they run on this machine.
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
        log('info', 'Provider reachable again', { provider: p.name });
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          sendIMessage(imRecipient, `Watchdog: model provider ${p.name} is reachable again.`);
        }
      } else {
        log('debug', 'Provider reachable', { provider: p.name });
      }
      continue;
    }

    // Unreachable this cycle.
    const count = (providerFailureCounts[p.id] ?? 0) + 1;
    providerFailureCounts[p.id] = count;
    log('warn', 'Provider unreachable', { provider: p.name, type: p.type, url: probe.url, consecutive: count });

    if (count >= PROVIDER_FAILURE_THRESHOLD && shouldSendAlert(alertKey)) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        const localNote = probe.local
          ? ' This provider runs locally on this machine (it powers the router and any local models), so the machine or its local model server may need attention.'
          : '';
        await sendSmartAlert(imRecipient, `Watchdog: model provider ${p.name} has been unreachable for ${count} straight checks (about ${count * 2} min).${localNote} Will notify when it recovers.`);
        recordAlert(`Provider down: ${p.name}`);
      }
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

    if (shouldSendAlert('memory_low')) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        await sendSmartAlert(imRecipient, `Watchdog: System memory low, ${freeMb}MB free (${freePercent.toFixed(0)}%). Will follow up when resolved.`);
        recordAlert(`Memory low: ${freeMb}MB`);
      }
    }
  } else {
    // Memory is fine, send recovery if it was previously alerting
    if (markAlertResolved('memory_low')) {
      log('info', 'System memory recovered', { freeMb, freePercent: freePercent.toFixed(1) });
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, `Watchdog: Memory recovered, ${freeMb}MB free (${freePercent.toFixed(0)}%)`);
      }
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

    if (availableGb < 1) {
      log('warn', 'Disk space critically low', { availableGb: availableGb.toFixed(2) });
      if (shouldSendAlert('disk_low')) {
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          await sendSmartAlert(imRecipient, `Watchdog: Disk space low, ${availableGb.toFixed(1)}GB free. Will follow up when resolved.`);
          recordAlert(`Disk space low: ${availableGb.toFixed(1)}GB`);
        }
      }
    } else {
      if (markAlertResolved('disk_low')) {
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          sendIMessage(imRecipient, `Watchdog: Disk space recovered, ${availableGb.toFixed(1)}GB free.`);
        }
      }
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

async function checkDatabaseIntegrity(): Promise<void> {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000'); // FA-W5
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    db.close();

    const status = result[0]?.integrity_check ?? 'unknown';
    if (status !== 'ok') {
      log('error', 'Database integrity check FAILED', { status });
      if (shouldSendAlert('db_integrity')) {
        const imRecipient = getImessageRecipient();
        if (imRecipient) {
          await sendSmartAlert(imRecipient, `Watchdog: Database integrity check failed, ${status}`);
          recordAlert(`DB integrity: ${status}`);
        }
      }
    } else {
      markAlertResolved('db_integrity');
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

// Quiet health probe (no logging) used as the fallback restart's double-start
// guard. Separate from checkPlatformHealth so a pre-spawn check doesn't emit a
// misleading "Platform unreachable" line.
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

  // Primary path: ask launchd to restart the supervised job. Works whenever
  // launchd supervision is intact.
  try {
    execSync('launchctl kickstart -k gui/$(id -u)/com.dojo.platform', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    log('info', 'Restart command sent via launchctl');
    return;
  } catch {
    // launchctl failed, the job is likely unloaded, which is EXACTLY when a
    // fallback matters. Fall through to a direct spawn of the real entrypoint.
    log('warn', 'launchctl kickstart failed, falling back to a direct entrypoint spawn');
  }

  // FA-W7: the old fallback ran `npm run start` in the platform ROOT, which has
  // no start script, it always failed with "Missing script: start", so there
  // was no working second restart path. Run the server's real compiled
  // entrypoint directly and detached so an emergency restart works even with
  // launchd broken.
  try {
    const platformDir = path.join(DOJO_DIR, 'platform');
    const entrypoint = path.join(platformDir, 'packages', 'server', 'dist', 'index.js');
    if (!fs.existsSync(entrypoint)) {
      log('error', 'Fallback restart skipped, server entrypoint not found', { entrypoint });
      return;
    }
    // Double-start guard: a launchd KeepAlive revival may have already brought
    // the platform back between the failed kickstart and now (or it never truly
    // died). If it answers health, do NOT spawn a second copy racing it.
    if (await isPlatformResponding()) {
      log('info', 'Fallback restart skipped, platform is already responding');
      return;
    }
    const child = spawn(process.execPath, [entrypoint], {
      cwd: platformDir,
      env: { ...process.env, NODE_ENV: 'production' },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log('info', 'Restart attempted via direct entrypoint spawn', { pid: child.pid ?? null, entrypoint });
  } catch (err) {
    log('error', 'Restart failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── D-F auto-rollback ──
// When a health check fails, first ask whether the update-state marker PROVES a
// self-update is in flight and failing (booting-new/rolled-back AND the
// boot-attempt or wall-clock gate tripped). Only then does the watchdog act, and
// this is the update-recovery path, NOT the generic platform-down cascade:
//   - roll back once (code only) by spawning rollback.sh detached, OR
//   - escalate loudly to failed-permanently (a migration ran, or the one allowed
//     rollback was already spent) per the owner decision 2026-07-06.
// Returns true when it handled this cycle so runCheck skips the generic restart
// cascade, which would only kickstart the same bad build and race rollback.sh
// (that script unloads BOTH launchd jobs). Never acts on a generic outage.
async function maybeAutoRollback(): Promise<boolean> {
  const marker = readMarker();
  const decision = decideAutoRollback(marker, Date.now());
  if (!marker || decision.action === 'none') return false;

  const imRecipient = getImessageRecipient();

  if (decision.action === 'escalate') {
    // No rollback: record the terminal state (with the reason, so the platform's
    // confirmHealthy can later recover a migration escalation that finishes healthy
    // after the window), alert once (loud, plain language).
    writeMarker(toFailedPermanently(marker, decision.reason));
    log('error', 'D-F: escalating a failed self-update to failed-permanently (no auto-rollback)', {
      reason: decision.reason,
      targetVersion: marker.targetVersion,
      previousVersion: marker.previousVersion,
      rollbackCount: marker.rollbackCount,
    });
    if (shouldSendAlert('auto_rollback_failed')) {
      const because = decision.reason === 'migration'
        ? 'the update had already changed the database, so undoing just the app could make things worse'
        : 'putting the previous version back once did not fix it, and trying again is not safe';
      if (imRecipient) {
        await sendSmartAlert(
          imRecipient,
          `Watchdog: a Dojo update failed to start and I did NOT undo it automatically because ${because}. ` +
          `The box may keep restarting. Please open the Dojo dashboard and restore a previous version, or reach out for help. I will keep watching.`,
        );
        recordAlert('Auto-rollback escalated to failed-permanently');
      }
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
  // Record the rollback intent + open a fresh boot window for the restored build
  // BEFORE anything else: a restored build that also fails then escalates (never
  // a second rollback), and a duplicate cycle sees rollbackCount and won't spawn
  // twice. Alert the owner BEFORE spawning, because rollback.sh unloads this
  // watchdog's launchd job and could cut a slow send short.
  writeMarker(toRolledBack(marker));
  if (shouldSendAlert('auto_rollback') && imRecipient) {
    const toVer = marker.previousVersion ? ` (${marker.previousVersion})` : '';
    await sendSmartAlert(
      imRecipient,
      `Watchdog: a Dojo update did not start up correctly, so I am automatically putting the previous version${toVer} back. ` +
      `The box will restart on its own in a minute. I will let you know if anything still looks wrong.`,
    );
    recordAlert('Auto-rollback to previous build initiated');
  }
  const pid = spawnRollbackDetached();
  if (pid === null) {
    log('error', 'D-F: rollback.sh could not be spawned (missing script or exec error)', { script: ROLLBACK_SCRIPT });
  } else {
    log('info', 'D-F: rollback.sh spawned detached', { pid, script: ROLLBACK_SCRIPT });
  }
  return true;
}

// Patience gate for a self-update migration boot. A first jump to a marker-aware
// build can run a long ONE-TIME migration chain with health down the whole time
// (the platform only starts listening AFTER runMigrations). The generic restart
// cadence below (MAX_FAILURES_BEFORE_RESTART checks ~= 10 min) would otherwise
// kickstart the box mid-migration, BEFORE the 15-minute migration allowance the
// auto-rollback gate deliberately grants. Reading the SAME FAIL_WALL_CLOCK_MS
// constant guarantees the kickstart can never land before that window elapses.
// Only 'booting-new' (a build coming up for the first time, not yet confirmed
// healthy) qualifies; once the window passes, maybeAutoRollback owns the decision
// (escalate on a migration episode, roll back a code-only one), so a genuinely
// wedged box is never stranded.
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

// ── Main Loop ──

// FA-W8(a): a monotonic cycle counter so the integrity check runs on a
// GUARANTEED cadence (every 10th cycle) instead of the old probabilistic
// Math.random() < 0.1, which could skip it for a long stretch or fire twice
// back to back despite the comment claiming "every 10th cycle".
let cycleCount = 0;

async function runCheck(): Promise<void> {
  cycleCount++;
  log('info', 'Running watchdog check cycle');

  recordHeartbeat();

  // 1. Platform health
  const healthy = await checkPlatformHealth();

  // 1b. D-F: a PROVEN-failing self-update takes precedence over the generic
  // platform-down cascade. If the marker shows a self-update in flight and
  // failing, roll back (code only) or escalate loudly, then short-circuit this
  // cycle so we do not ALSO kickstart the same bad build and race rollback.sh.
  if (!healthy && await maybeAutoRollback()) return;

  if (!healthy) {
    // FA-W3(a): `consecutiveFailures` is the TRUTHFUL running count (resets only on
    // recovery, below). `failuresSinceRestart` is the cadence counter that drives the
    // every-5-failures restart and is the ONLY thing a restart resets, so the DOWN
    // alert's texted count stays honest across restart cycles.
    consecutiveFailures++;
    failuresSinceRestart++;
    log('warn', `Platform unhealthy (${consecutiveFailures} consecutive failures, ${restartAttempts} restart attempt(s) this outage)`, {
      consecutiveFailures, failuresSinceRestart, restartAttempts,
      lastRestartAt: lastRestartAt ? new Date(lastRestartAt).toISOString() : null,
    });

    // Restart cadence: fire a restart every MAX_FAILURES_BEFORE_RESTART failed
    // checks. Only the cadence counter resets here; the truthful count keeps
    // climbing. EXCEPTION: while a self-update migration boot is still inside the
    // shared 15-min allowance, hold the kickstart rather than kill the box
    // mid-migration (do NOT reset the cadence counter, so the moment the window
    // passes the very next cycle proceeds to restart / maybeAutoRollback handles it).
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

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT && shouldSendAlert('platform_down')) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        await sendSmartAlert(imRecipient, `Watchdog: Dojo platform is DOWN (${consecutiveFailures} checks failed). Will notify when it recovers.`);
        recordAlert(`Platform down: ${consecutiveFailures} checks failed`);
      }
    }

    // FA-W3(b): the auto-restart did NOT fix it. Once we have attempted at least one
    // restart AND the platform is STILL unhealthy beyond the grace window, tell the owner
    // in plain language that manual attention is needed. One text per cooldown via
    // shouldSendAlert; the restart cadence above is untouched.
    if (restartAttempts > 0 && failuresSinceRestart >= RESTART_GRACE_FAILURES && shouldSendAlert('platform_restart_failed')) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        await sendSmartAlert(imRecipient, `Watchdog: I automatically restarted the Dojo platform ${restartAttempts} time(s) but it is still down after ${consecutiveFailures} failed checks. It needs manual attention.`);
        recordAlert(`Auto-restart did not fix platform: ${consecutiveFailures} failed checks, ${restartAttempts} restart(s)`);
      }
    }
  } else {
    // Preserve the recovery log's original semantics: it fires whenever there were
    // prior failures, even minor ones below the alert threshold.
    if (consecutiveFailures > 0) {
      log('info', 'Platform recovered', { previousFailures: consecutiveFailures });
    }
    // Recovery message: send only if we previously alerted. markAlertResolved's
    // active-flag check already enforces that (it is a no-op when no alert is active),
    // so this must NOT be gated on consecutiveFailures. A successful restart resets the
    // counter to 0 before the next healthy cycle, and that reset must not suppress the
    // recovery notice (FA-W1).
    if (markAlertResolved('platform_down')) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, 'Watchdog: Dojo platform is back UP and healthy.');
      }
    }
    // FA-W3(b) recovery pairing: clear the restart-failed flag on recovery so a future
    // outage re-alerts cleanly. No separate text, the "back UP and healthy" message above
    // already tells the owner it recovered (respects the 2h anti-spam intent).
    markAlertResolved('platform_restart_failed');

    // FALSE-ESCALATION correction: if we escalated a failed self-update to the owner
    // (auto_rollback_failed) but the box then came up healthy after all, the platform
    // recovers the update-state marker (confirmHealthy clears a migration escalation)
    // and we send the owner the low-key "it finished after all" correction HERE, on the
    // SAME alert path the escalation went out on. markAlertResolved returns true only if
    // that alert was actually active (i.e. was sent), so the correction fires exactly
    // when an escalation preceded a recovery.
    if (markAlertResolved('auto_rollback_failed')) {
      const imRecipient = getImessageRecipient();
      if (imRecipient) {
        sendIMessage(imRecipient, 'Watchdog: the Dojo update finished starting up after all and the box is healthy. No action needed.');
      }
    }
    // Clear the "putting the previous version back" alert on recovery too, so a future
    // episode re-alerts cleanly. Silent: the "back UP and healthy" message above already
    // told the owner the box recovered.
    markAlertResolved('auto_rollback');
    // FA-W3(a): recovery is the ONLY place the truthful counter and restart bookkeeping
    // reset.
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

// ── Entry Point ──

// FA-W6: reload the persisted alert ledger (and last heartbeat/alert) BEFORE
// the first cycle so a KeepAlive restart during an active incident does not
// re-alert still-active issues or lose a recovery for one that resolved while
// we were down. send-once, the 2h cooldown, and always-send-recovery now hold
// across restarts.
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

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Watchdog shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Watchdog shutting down (SIGINT)');
  process.exit(0);
});
