// ════════════════════════════════════════
// Post-Migration Checks — verify dependencies, auth, models
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import type { ExportManifest } from './manifest.js';
import { readDependencyManifest, type DependencyManifest } from '../techniques/dependencies.js';
import { classifyManualSteps } from './step-classify.js';
import type { PostMigrationCheck } from '@dojo/shared';

const logger = createLogger('migration-checks');

// Re-export so existing './checks.js' imports keep resolving the type.
export type { PostMigrationCheck } from '@dojo/shared';

// In-memory check state (survives page refreshes via polling)
let currentChecks: PostMigrationCheck[] = [];
let migrationDismissed = false;

// The manifest from the most recent import. Cached so the dependency installer
// and the wizard's "re-check" can re-run checks without re-reading the zip.
let lastManifest: ExportManifest | null = null;
export function setLastManifest(manifest: ExportManifest): void { lastManifest = manifest; }
export function getLastManifest(): ExportManifest | null { return lastManifest; }

export function getChecks(): PostMigrationCheck[] {
  return currentChecks;
}

export function isMigrationDismissed(): boolean {
  return migrationDismissed;
}

export function dismissMigration(): void {
  migrationDismissed = true;
  currentChecks = [];
  // Also store in DB so it persists across restarts
  try {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_dismissed', 'true')").run();
  } catch { /* ignore */ }
}

export function loadDismissState(): void {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'migration_dismissed'").get() as { value: string } | undefined;
    migrationDismissed = row?.value === 'true';
  } catch { /* ignore */ }
}

function broadcastChecks(): void {
  broadcast({
    type: 'migration:checks',
    data: { checks: currentChecks, dismissed: migrationDismissed },
  } as any);
}

// ── Technique dependency check ──

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function formatTechniqueDeps(m: DependencyManifest): { commands: string[]; manual: string[] } {
  const commands: string[] = [];
  for (const p of m.system_packages) {
    commands.push(`${p.manager} install ${p.package}${p.version ? ` (${p.version})` : ''}`);
  }
  for (const p of m.language_packages) {
    commands.push(`${p.manager} install ${p.package}${p.version ? `@${p.version}` : ''}`);
  }
  for (const r of m.repos) {
    commands.push(`git clone ${r.url}${r.ref ? ` (${r.ref})` : ''}`);
  }
  for (const a of m.models_or_assets) {
    commands.push(`download ${a.url} -> ${a.destination}`);
  }
  return { commands, manual: m.manual_steps };
}

// Each migrated technique can declare external dependencies (brew/npm/pip
// packages, git repos, downloads, manual steps) in its dependencies.json. The
// technique files migrate, but those external installs do NOT — so surface what
// each technique needs so the user can set it up on the new machine. Only
// techniques that actually declare something get a row.
function checkTechniqueDependencies(): void {
  let techs: Array<{ name: string; directory_path: string | null }> = [];
  try {
    const db = getDb();
    techs = db
      .prepare('SELECT name, directory_path FROM techniques WHERE directory_path IS NOT NULL')
      .all() as Array<{ name: string; directory_path: string | null }>;
  } catch {
    return; // techniques table absent on legacy dbs
  }
  for (const t of techs) {
    if (!t.directory_path) continue;
    const dir = expandHome(t.directory_path);
    if (!fs.existsSync(dir)) continue;
    let manifest: DependencyManifest;
    try {
      manifest = readDependencyManifest(dir);
    } catch {
      continue;
    }
    const { commands, manual } = formatTechniqueDeps(manifest);
    if (commands.length === 0 && manual.length === 0) continue;
    const slug = t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    // Classify the free-text manual steps: do the doable, verify what's
    // checkable, drop pure info, and keep only genuine human actions. Install
    // commands (brew/pip/git/…) are run by the combined installer → automated.
    const classified = classifyManualSteps(manual);
    const actionSteps = classified.filter((c) => c.bucket === 'action');
    const autoSteps = classified.filter((c) => c.bucket === 'automated');

    // Automated summary (lands in "What migrated automatically"): the installed
    // deps + everything the classifier handled/verified.
    const autoItems = [
      ...commands.map((text) => ({ text: `Installed: ${text}`, kind: 'install' as const })),
      ...autoSteps.map((c) => ({ text: c.detail ? `${c.detail}` : c.text, kind: 'install' as const })),
    ];
    if (autoItems.length) {
      currentChecks.push({
        id: `technique-auto-${slug}`,
        label: `${t.name}: set up automatically`,
        status: 'ok',
        category: 'automated',
        detailItems: autoItems,
      });
    }

    // Only genuine human actions become a "needs you" technique card. A
    // technique whose every step was automated/info shows no card at all.
    if (actionSteps.length) {
      currentChecks.push({
        id: `technique-deps-${slug}`,
        label: t.name,
        status: 'action_needed',
        category: 'technique',
        action: 'A few things only you can set up for this technique',
        detailItems: actionSteps.map((c) => ({
          text: c.detail ? `${c.text} — ${c.detail}` : c.text,
          kind: 'manual' as const,
        })),
      });
    }
  }
}

// ── Run All Checks ──

export async function runPostMigrationChecks(manifest: ExportManifest): Promise<PostMigrationCheck[]> {
  migrationDismissed = false;
  currentChecks = [];

  // Database restored (always ok if we got here)
  currentChecks.push({ id: 'database', label: 'Database restored', status: 'ok', category: 'automated' });

  // Agents restored
  currentChecks.push({
    id: 'agents',
    label: `Agents restored (${manifest.contents.agents_count})`,
    status: 'ok',
    category: 'automated',
  });

  // Techniques restored
  if (manifest.contents.techniques_count > 0) {
    currentChecks.push({
      id: 'techniques',
      label: `Techniques restored (${manifest.contents.techniques_count})`,
      status: 'ok',
      category: 'automated',
    });
  }

  // Technique external dependencies (brew/npm/pip/git/manual) — the files come
  // over, but the installs don't. Flag each technique that declares any.
  checkTechniqueDependencies();

  // Vault restored
  if (manifest.contents.vault_entries_count > 0) {
    currentChecks.push({
      id: 'vault',
      label: `Vault restored (${manifest.contents.vault_entries_count} entries)`,
      status: 'ok',
      category: 'automated',
    });
  }

  // Ollama installed? Auto-installed by the dependency step; if it's still
  // missing the user can re-run the installer.
  const ollamaInstalled = checkCommandExists('ollama');
  currentChecks.push({
    id: 'ollama',
    label: ollamaInstalled ? 'Ollama installed' : 'Ollama not installed yet',
    status: ollamaInstalled ? 'ok' : 'action_needed',
    category: 'automated',
    cta: ollamaInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
  });

  // Ollama models
  if (ollamaInstalled && manifest.contents.ollama_models.length > 0) {
    const localModels = getLocalOllamaModels();
    for (const model of manifest.contents.ollama_models) {
      const isLocal = localModels.includes(model);
      const checkId = `ollama-model-${model}`;
      currentChecks.push({
        id: checkId,
        label: model,
        status: isLocal ? 'ok' : 'action_needed',
        category: 'automated',
        // The wizard recognizes the `ollama-model-` id prefix and drives the
        // download itself — streaming progress + real errors + retry, mirroring
        // OOBE — instead of a fire-and-forget spawn that swallowed errors.
        detail: isLocal ? 'Downloaded' : 'Needs download',
      });
    }
  }

  // Provider API keys — restored with the vault/secrets, so most verify clean.
  // Only surface the ones whose restored key fails (needs re-entry).
  for (const providerName of manifest.contents.providers) {
    const checkId = `provider-${providerName}`;
    // The internal "System" provider is an engine sentinel with no user API key
    // (seeded '__system__'); it migrated fine and must never be flagged for
    // re-entry. This was the bogus "System API key needs re-entry" item.
    if (providerName === 'System' || providerName.toLowerCase() === '__system__') {
      continue;
    }
    if (providerName.toLowerCase().includes('ollama')) {
      // Ollama doesn't need API key verification
      currentChecks.push({ id: checkId, label: `${providerName} configured`, status: ollamaInstalled ? 'ok' : 'action_needed', category: 'automated' });
      continue;
    }
    const hasKey = await checkProviderKey(providerName);
    currentChecks.push({
      id: checkId,
      label: hasKey ? `${providerName} API key verified` : `${providerName} API key needs re-entry`,
      status: hasKey ? 'ok' : 'action_needed',
      category: 'action',
      cta: hasKey ? undefined : { type: 'link', label: 'Open provider settings', target: '/settings?tab=providers' },
    });
  }

  // Google accounts — a dojo can have MANY (up to 5 agent + 5 user). OAuth
  // tokens are machine-specific, so EACH connected account gets its own
  // reconnect card that re-auths that specific account by id.
  const googleAccounts = listConnectedAccounts('google_accounts');
  if (googleAccounts.length > 0) {
    const gwsInstalled = checkCommandExists('gws');
    currentChecks.push({
      id: 'gws-cli',
      label: gwsInstalled ? 'gws CLI installed' : 'gws CLI not installed yet',
      status: gwsInstalled ? 'ok' : 'action_needed',
      category: 'automated',
      cta: gwsInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
    });
    for (const acc of googleAccounts) {
      currentChecks.push({
        id: `google-account-${acc.id}`,
        label: `Reconnect Google — ${acc.email ?? `${acc.kind} account`}`,
        status: 'action_needed',
        category: 'action',
        detail: 'Sign-in tokens are machine-specific. Reconnect signs this account in here (localhost redirect).',
        cta: { type: 'reconnect_oauth', label: 'Reconnect', target: `google:${acc.id}` },
      });
    }
  } else if (manifest.contents.google_workspace_connected || checkDbGoogleConnected()) {
    // Legacy DB without the accounts table — one generic reconnect.
    currentChecks.push({
      id: 'google-auth',
      label: 'Reconnect Google',
      status: 'action_needed',
      category: 'action',
      detail: 'Sign-in tokens are machine-specific. Reconnect signs in here (localhost redirect).',
      cta: { type: 'reconnect_oauth', label: 'Reconnect Google', target: 'google' },
    });
  }

  // Microsoft accounts — covers M365 work accounts AND personal Microsoft
  // accounts (all live in microsoft_accounts). One reconnect card per connected
  // account; tokens are always machine-specific.
  const microsoftAccounts = listConnectedAccounts('microsoft_accounts');
  if (microsoftAccounts.length > 0) {
    for (const acc of microsoftAccounts) {
      currentChecks.push({
        id: `microsoft-account-${acc.id}`,
        label: `Reconnect Microsoft — ${acc.email ?? `${acc.kind} account`}`,
        status: 'action_needed',
        category: 'action',
        detail: 'Microsoft sign-in tokens are machine-specific. Reconnect signs this account in here.',
        cta: { type: 'reconnect_oauth', label: 'Reconnect', target: `microsoft:${acc.id}` },
      });
    }
  } else if (manifest.contents.microsoft_connected || checkDbMicrosoftConnected()) {
    currentChecks.push({
      id: 'microsoft-auth',
      label: 'Reconnect Microsoft',
      status: 'action_needed',
      category: 'action',
      detail: 'Microsoft sign-in tokens are machine-specific. Reconnect signs in here.',
      cta: { type: 'reconnect_oauth', label: 'Reconnect Microsoft', target: 'microsoft' },
    });
  }

  // iMessage — Full Disk Access is a macOS permission that does NOT transfer
  // between machines. DOJO reads Messages as a Node process, so FDA is granted
  // to "node" (this is what OOBE does too — not Terminal/the DOJO app).
  if (manifest.contents.imessage_configured) {
    // Actually DETECT whether Full Disk Access is granted by opening the Messages
    // DB from THIS (the dojo server / node) process — the same process that
    // reads iMessage at runtime. If it opens, FDA is on for the right node and
    // we're done; if it throws (EPERM under macOS TCC), it's still needed. This
    // is why Re-check works now: it re-runs this real probe instead of a
    // hardcoded "needs you".
    const chatDb = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
    let fdaGranted = false;
    try { fs.closeSync(fs.openSync(chatDb, 'r')); fdaGranted = true; } catch { /* TCC-denied or missing */ }
    currentChecks.push({
      id: 'imessage-fda',
      label: fdaGranted ? 'Full Disk Access granted (iMessage)' : 'Grant Full Disk Access for iMessage',
      status: fdaGranted ? 'ok' : 'action_needed',
      category: fdaGranted ? 'automated' : 'action',
      detail: fdaGranted
        ? 'The dojo can read Messages — iMessage is ready.'
        : 'Open Settings, then enable Full Disk Access for "node" (DOJO runs as a Node process — that\'s the right entry, not Terminal or DOJO). If "node" isn\'t listed, click + and add the path from `which node`. Then hit Re-check.',
      cta: fdaGranted ? undefined : { type: 'open_system_settings', label: 'Open System Settings', target: 'full-disk-access' },
    });
  }

  // cloudflared — auto-installed by the dependency step.
  const cfInstalled = checkCommandExists('cloudflared');
  currentChecks.push({
    id: 'cloudflared',
    label: cfInstalled ? 'cloudflared installed' : 'cloudflared not installed yet',
    status: cfInstalled ? 'ok' : 'action_needed',
    category: 'automated',
    cta: cfInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
  });

  // Cloudflare tunnel — the full named-tunnel setup migrates with the export:
  // the connector token (secrets.yaml), the ~/.cloudflared cert + credentials
  // key, and the tunnel_* settings (DB). Surface it so the user can see remote
  // access carried over; it auto-starts on boot once cloudflared is installed.
  if (checkDbConfigFlag('tunnel_enabled')) {
    let namedUrl: string | null = null;
    let isNamed = false;
    try {
      const row = getDb().prepare("SELECT value FROM config WHERE key = 'tunnel_named_url'").get() as { value: string } | undefined;
      namedUrl = row?.value?.trim() || null;
      const mode = getDb().prepare("SELECT value FROM config WHERE key = 'tunnel_mode'").get() as { value: string } | undefined;
      isNamed = mode?.value === 'named';
    } catch { /* ignore */ }
    // A named tunnel can only run on one machine. Flag it for the user to make
    // sure the OLD dojo's tunnel is off, or the two will fight over the name/key.
    const conflictNote = isNamed
      ? ' IMPORTANT: a named tunnel runs on one machine only — make sure the old dojo has its tunnel turned OFF, or neither will connect.'
      : '';
    currentChecks.push({
      id: 'cloudflare-tunnel',
      label: isNamed ? 'Cloudflare named tunnel restored — disable it on the old dojo' : 'Cloudflare tunnel configuration restored',
      status: cfInstalled ? 'ok' : 'action_needed',
      category: isNamed ? 'action' : 'automated',
      cta: cfInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
      detail: (namedUrl
        ? `Remote access for ${namedUrl} migrated (token + credentials). Auto-starts on boot.`
        : 'Remote access settings migrated (token + credentials). Auto-starts on boot.') + conflictNote,
    });
  }

  // Twilio — config + numbers live in the DB (migrated) and the auth token is
  // encrypted with the credential master key (also migrated), so it decrypts
  // here. Surface it so the user knows to update webhook URLs if their public
  // URL changed.
  try {
    const tw = getDb().prepare('SELECT account_sid FROM twilio_config WHERE id = 1').get() as { account_sid: string | null } | undefined;
    if (tw?.account_sid) {
      currentChecks.push({
        id: 'twilio',
        label: 'Twilio configuration restored',
        status: 'ok',
        category: 'automated',
        detail: 'Account, numbers, and auth token migrated. If your public URL changed, update the webhook URLs in the Twilio console.',
      });
    }
  } catch { /* twilio table may not exist on legacy dbs */ }

  broadcastChecks();

  // Store checks in DB for persistence
  try {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_checks', ?)").run(JSON.stringify(currentChecks));
    db.prepare("DELETE FROM config WHERE key = 'migration_dismissed'").run();
  } catch { /* ignore */ }

  logger.info('Post-migration checks complete', {
    total: currentChecks.length,
    ok: currentChecks.filter(c => c.status === 'ok').length,
    actionNeeded: currentChecks.filter(c => c.status === 'action_needed').length,
    inProgress: currentChecks.filter(c => c.status === 'in_progress').length,
  });

  return currentChecks;
}

// Load checks from DB (on server restart after import)
export function loadSavedChecks(): void {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'migration_checks'").get() as { value: string } | undefined;
    if (row?.value) {
      currentChecks = JSON.parse(row.value);
    }
    loadDismissState();
  } catch { /* ignore */ }
}

// ── Helpers ──

// All connected accounts of a kind-table (google_accounts / microsoft_accounts).
// Used to emit one reconnect card per account. Table name is a fixed literal,
// not user input.
function listConnectedAccounts(
  table: 'google_accounts' | 'microsoft_accounts',
): Array<{ id: string; email: string | null; kind: string }> {
  try {
    return getDb()
      .prepare(`SELECT id, email, kind FROM ${table} WHERE connected = 1 ORDER BY kind, position`)
      .all() as Array<{ id: string; email: string | null; kind: string }>;
  } catch {
    return [];
  }
}

function checkDbConfigFlag(key: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
}

/** Google connection now lives in google_accounts (Path B); the legacy
 *  gws_connected key is frozen. Check the table, falling back to the legacy
 *  flag for DBs restored from a pre-migration export. */
function checkDbGoogleConnected(): boolean {
  try {
    const row = getDb().prepare('SELECT 1 FROM google_accounts WHERE connected = 1 LIMIT 1').get();
    if (row) return true;
  } catch { /* table may not exist on legacy dbs */ }
  return checkDbConfigFlag('gws_connected');
}

/** Microsoft connection now lives in microsoft_accounts (Path B). */
function checkDbMicrosoftConnected(): boolean {
  try {
    const row = getDb().prepare('SELECT 1 FROM microsoft_accounts WHERE connected = 1 LIMIT 1').get();
    if (row) return true;
  } catch { /* table may not exist on legacy dbs */ }
  return checkDbConfigFlag('ms_connected');
}

function checkCommandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function getLocalOllamaModels(): string[] {
  try {
    const output = execSync('ollama list', { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n').slice(1);
    return lines.map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

async function checkProviderKey(providerName: string): Promise<boolean> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT id FROM providers WHERE name = ?').get(providerName) as { id: string } | undefined;
    if (!row) return false;
    const credential = getProviderCredential(row.id);
    return credential !== null && credential.length > 0;
  } catch {
    return false;
  }
}
