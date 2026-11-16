// Post-migration checks: verify dependencies, auth and models after an import.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import type { ExportManifest } from './manifest.js';
import { readDependencyManifest, type DependencyManifest } from '../techniques/dependencies.js';
import { classifyManualSteps } from './step-classify.js';
import { getValidAccessTokenForAccount as getValidGoogleToken } from '../google/auth.js';
import { getValidAccessTokenForAccount as getValidMsToken } from '../microsoft/auth.js';
import { listOllamaModelNames } from '../services/ollama.js';
import type { PostMigrationCheck } from '@dojo/shared';
import { homeDir } from '../home.js';

const logger = createLogger('migration-checks');

// Re-export so existing './checks.js' imports keep resolving the type.
export type { PostMigrationCheck } from '@dojo/shared';

// In-memory check state (survives page refreshes via polling)
let currentChecks: PostMigrationCheck[] = [];
let migrationDismissed = false;

// What the checks read of the most recent import's manifest, kept in the database so the dependency installer
// and the wizard's "re-check" still have it after the restart. The old Mac's names and folders are not kept.
type CheckedManifest = Pick<ExportManifest, 'contents'>;
export function setLastManifest(manifest: CheckedManifest): void {
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_manifest', ?)").run(JSON.stringify({ contents: manifest.contents }));
}
export function getLastManifest(): CheckedManifest | null {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'migration_manifest'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as CheckedManifest : null;
}

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


function expandHome(p: string): string {
  if (p === '~') return homeDir();
  if (p.startsWith('~/')) return path.join(homeDir(), p.slice(2));
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

// Surface the external installs (brew/npm/pip, repos, downloads, manual steps) a technique declares in
// dependencies.json: the files migrate but the installs do not. Only declaring techniques get a row.
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

    // Classify manual steps: do the doable, verify the checkable, drop pure info, keep genuine human
    // actions. Install commands are run by the combined installer, so they count as automated.
    const classified = classifyManualSteps(manual);
    const actionSteps = classified.filter((c) => c.bucket === 'action');
    const autoSteps = classified.filter((c) => c.bucket === 'automated');

    // Automated summary ("What migrated automatically"): installed deps plus what the classifier handled.
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

    // Only genuine human actions become a card; a technique whose steps were all automated shows none.
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


export async function runPostMigrationChecks(manifest: CheckedManifest): Promise<PostMigrationCheck[]> {
  migrationDismissed = false;
  currentChecks = [];

  currentChecks.push({ id: 'database', label: 'Database restored', status: 'ok', category: 'automated' });

  currentChecks.push({
    id: 'agents',
    label: `Agents restored (${manifest.contents.agents_count})`,
    status: 'ok',
    category: 'automated',
  });

  if (manifest.contents.techniques_count > 0) {
    currentChecks.push({
      id: 'techniques',
      label: `Techniques restored (${manifest.contents.techniques_count})`,
      status: 'ok',
      category: 'automated',
    });
  }

  // Technique external dependencies: the files come over, the installs do not.
  checkTechniqueDependencies();

  if (manifest.contents.vault_entries_count > 0) {
    currentChecks.push({
      id: 'vault',
      label: `Vault restored (${manifest.contents.vault_entries_count} entries)`,
      status: 'ok',
      category: 'automated',
    });
  }

  // Ollama installed? Auto-installed by the dependency step; if missing the user can re-run it.
  const ollamaInstalled = checkCommandExists('ollama');
  currentChecks.push({
    id: 'ollama',
    label: ollamaInstalled ? 'Ollama installed' : 'Ollama not installed yet',
    status: ollamaInstalled ? 'ok' : 'action_needed',
    category: 'automated',
    cta: ollamaInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
  });

  // Ollama models. Read over HTTP, never `ollama list`: the CLI auto-launches Ollama.app when the
  // daemon is down, so the probe could start what it only meant to ask about (see listOllamaModelNames).
  // checkCommandExists above stays a PATH lookup: it names the binary, never runs it.
  if (ollamaInstalled && manifest.contents.ollama_models.length > 0) {
    const localModels = await listOllamaModelNames();
    for (const model of manifest.contents.ollama_models) {
      const isLocal = localModels.includes(model);
      const checkId = `ollama-model-${model}`;
      currentChecks.push({
        id: checkId,
        label: model,
        status: isLocal ? 'ok' : 'action_needed',
        category: 'automated',
        // The wizard recognizes the `ollama-model-` id prefix and drives the download itself, with
        // streaming progress, real errors and retry.
        detail: isLocal ? 'Downloaded' : 'Needs download',
      });
    }
  }

  // Provider API keys restore with the vault, so most verify clean; surface only keys that fail.
  for (const providerName of manifest.contents.providers) {
    const checkId = `provider-${providerName}`;
    // The internal "System" provider is an engine sentinel with no user API key (seeded '__system__'),
    // so it is never flagged for re-entry.
    if (providerName === 'System' || providerName.toLowerCase() === '__system__') {
      continue;
    }
    if (providerName.toLowerCase().includes('ollama')) {
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

  // Google accounts (up to 5 agent + 5 user): validate each migrated token by refreshing it. A valid
  // one needs no action; a failing one gets a reconnect card that clears on Re-check after reauth.
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
      const valid = await accountTokenValid('google', acc.id);
      currentChecks.push({
        id: `google-account-${acc.id}`,
        label: valid ? `Google connected — ${acc.email ?? `${acc.kind} account`}` : `Reconnect Google — ${acc.email ?? `${acc.kind} account`}`,
        status: valid ? 'ok' : 'action_needed',
        category: valid ? 'automated' : 'action',
        detail: valid
          ? 'Signed in and working on this machine.'
          : "This account's sign-in needs refreshing here. Reconnect signs it in (localhost redirect), then it clears on Re-check.",
        cta: valid ? undefined : { type: 'reconnect_oauth', label: 'Reconnect', target: `google:${acc.id}` },
      });
    }
  } else if (manifest.contents.google_workspace_connected || checkDbGoogleConnected()) {
    // Legacy DB without the accounts table, one generic reconnect.
    currentChecks.push({
      id: 'google-auth',
      label: 'Reconnect Google',
      status: 'action_needed',
      category: 'action',
      detail: "Couldn't confirm this account's sign-in on this machine. Reconnect signs in here (localhost redirect), then it clears on Re-check.",
      cta: { type: 'reconnect_oauth', label: 'Reconnect Google', target: 'google' },
    });
  }

  // Microsoft accounts (M365 work and personal, all in microsoft_accounts): each token is validated;
  // only one that fails to refresh gets a reconnect card.
  const microsoftAccounts = listConnectedAccounts('microsoft_accounts');
  if (microsoftAccounts.length > 0) {
    for (const acc of microsoftAccounts) {
      const valid = await accountTokenValid('microsoft', acc.id);
      currentChecks.push({
        id: `microsoft-account-${acc.id}`,
        label: valid ? `Microsoft connected — ${acc.email ?? `${acc.kind} account`}` : `Reconnect Microsoft — ${acc.email ?? `${acc.kind} account`}`,
        status: valid ? 'ok' : 'action_needed',
        category: valid ? 'automated' : 'action',
        detail: valid
          ? 'Signed in and working on this machine.'
          : "This account's sign-in needs refreshing here. Reconnect signs it in, then it clears on Re-check.",
        cta: valid ? undefined : { type: 'reconnect_oauth', label: 'Reconnect', target: `microsoft:${acc.id}` },
      });
    }
  } else if (manifest.contents.microsoft_connected || checkDbMicrosoftConnected()) {
    currentChecks.push({
      id: 'microsoft-auth',
      label: 'Reconnect Microsoft',
      status: 'action_needed',
      category: 'action',
      detail: "Couldn't confirm this account's sign-in on this machine. Reconnect signs in here, then it clears on Re-check.",
      cta: { type: 'reconnect_oauth', label: 'Reconnect Microsoft', target: 'microsoft' },
    });
  }

  // iMessage: Full Disk Access does not transfer between machines and is granted to "node", the
  // process that reads Messages.
  if (manifest.contents.imessage_configured) {
    // Detect FDA by opening the Messages DB from this (server) process, the one that reads iMessage at
    // runtime: it opens when granted and throws EPERM under macOS TCC when not. Re-check re-runs the probe.
    const chatDb = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
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

  const cfInstalled = checkCommandExists('cloudflared');
  currentChecks.push({
    id: 'cloudflared',
    label: cfInstalled ? 'cloudflared installed' : 'cloudflared not installed yet',
    status: cfInstalled ? 'ok' : 'action_needed',
    category: 'automated',
    cta: cfInstalled ? undefined : { type: 'run_installer', label: 'Re-run installer' },
  });

  // Cloudflare tunnel: token (secrets.yaml), ~/.cloudflared cert and key, and tunnel_* settings migrate;
  // surface it so the user sees remote access carried over (auto-starts once cloudflared is installed).
  if (checkDbConfigFlag('tunnel_enabled')) {
    let namedUrl: string | null = null;
    let isNamed = false;
    try {
      const row = getDb().prepare("SELECT value FROM config WHERE key = 'tunnel_named_url'").get() as { value: string } | undefined;
      namedUrl = row?.value?.trim() || null;
      const mode = getDb().prepare("SELECT value FROM config WHERE key = 'tunnel_mode'").get() as { value: string } | undefined;
      isNamed = mode?.value === 'named';
    } catch { /* ignore */ }
    // A named tunnel runs on one machine only: the old dojo's tunnel must be off or the two fight over it.
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

  // Twilio: config and numbers live in the DB and the auth token is encrypted with the migrated master
  // key. Surface it so the user updates webhook URLs if their public URL changed.
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


// All connected accounts of a kind-table, to emit one reconnect card each. The table name is a fixed
// literal, not user input.
function listConnectedAccounts(
  table: 'google_accounts' | 'microsoft_accounts',
): Array<{ id: string; email: string | null; kind: string }> {
  try {
    // Enumerate by refresh_token presence, not connected=1: validating a token flips connected to 0 on a
    // failed refresh, so that filter would make a just-failed account vanish on the next check.
    return getDb()
      .prepare(`SELECT id, email, kind FROM ${table} WHERE refresh_token IS NOT NULL AND refresh_token != '' ORDER BY kind, position`)
      .all() as Array<{ id: string; email: string | null; kind: string }>;
  } catch {
    return [];
  }
}

// Validate an account's migrated token by getting a usable access token (refreshes via the stored
// refresh token). False on any failure, so a broken account shows a reconnect card until reauthed.
async function accountTokenValid(provider: 'google' | 'microsoft', accountId: string): Promise<boolean> {
  try {
    const token = provider === 'google'
      ? await getValidGoogleToken(accountId)
      : await getValidMsToken(accountId);
    return !!token;
  } catch {
    return false;
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

/** Google connection lives in google_accounts; the legacy gws_connected key is frozen and is only
 *  the fallback for DBs restored from an older export. */
function checkDbGoogleConnected(): boolean {
  try {
    const row = getDb().prepare('SELECT 1 FROM google_accounts WHERE connected = 1 LIMIT 1').get();
    if (row) return true;
  } catch { /* table may not exist on legacy dbs */ }
  return checkDbConfigFlag('gws_connected');
}

/** Microsoft connection lives in microsoft_accounts. */
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
