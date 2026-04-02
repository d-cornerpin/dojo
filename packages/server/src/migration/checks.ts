// ════════════════════════════════════════
// Post-Migration Checks — verify dependencies, auth, models
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import type { ExportManifest } from './manifest.js';

const logger = createLogger('migration-checks');

export interface PostMigrationCheck {
  id: string;
  label: string;
  status: 'ok' | 'action_needed' | 'in_progress';
  action?: string;
  detail?: string;
}

// In-memory check state (survives page refreshes via polling)
let currentChecks: PostMigrationCheck[] = [];
let migrationDismissed = false;

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

function updateCheck(id: string, updates: Partial<PostMigrationCheck>): void {
  const check = currentChecks.find(c => c.id === id);
  if (check) {
    Object.assign(check, updates);
    broadcastChecks();
  }
}

function broadcastChecks(): void {
  broadcast({
    type: 'migration:checks',
    data: { checks: currentChecks, dismissed: migrationDismissed },
  } as any);
}

// ── Run All Checks ──

export async function runPostMigrationChecks(manifest: ExportManifest): Promise<PostMigrationCheck[]> {
  migrationDismissed = false;
  currentChecks = [];

  // Database restored (always ok if we got here)
  currentChecks.push({ id: 'database', label: 'Database restored', status: 'ok' });

  // Agents restored
  currentChecks.push({
    id: 'agents',
    label: `Agents restored (${manifest.contents.agents_count})`,
    status: 'ok',
  });

  // Techniques restored
  if (manifest.contents.techniques_count > 0) {
    currentChecks.push({
      id: 'techniques',
      label: `Techniques restored (${manifest.contents.techniques_count})`,
      status: 'ok',
    });
  }

  // Vault restored
  if (manifest.contents.vault_entries_count > 0) {
    currentChecks.push({
      id: 'vault',
      label: `Vault restored (${manifest.contents.vault_entries_count} entries)`,
      status: 'ok',
    });
  }

  // Ollama installed?
  const ollamaInstalled = checkCommandExists('ollama');
  currentChecks.push({
    id: 'ollama',
    label: 'Ollama installed',
    status: ollamaInstalled ? 'ok' : 'action_needed',
    action: ollamaInstalled ? undefined : 'Install Ollama: brew install --cask ollama',
  });

  // Ollama models
  if (ollamaInstalled && manifest.contents.ollama_models.length > 0) {
    const localModels = getLocalOllamaModels();
    for (const model of manifest.contents.ollama_models) {
      const isLocal = localModels.includes(model);
      const checkId = `ollama-model-${model}`;
      currentChecks.push({
        id: checkId,
        label: isLocal ? `${model} downloaded` : `Downloading ${model}...`,
        status: isLocal ? 'ok' : 'in_progress',
      });

      if (!isLocal) {
        // Auto-pull in background
        pullOllamaModel(model, checkId);
      }
    }
  }

  // Provider API keys
  for (const providerName of manifest.contents.providers) {
    const checkId = `provider-${providerName}`;
    if (providerName.toLowerCase().includes('ollama')) {
      // Ollama doesn't need API key verification
      currentChecks.push({ id: checkId, label: `${providerName} configured`, status: ollamaInstalled ? 'ok' : 'action_needed' });
      continue;
    }
    const hasKey = await checkProviderKey(providerName);
    currentChecks.push({
      id: checkId,
      label: `${providerName} API key verified`,
      status: hasKey ? 'ok' : 'action_needed',
      action: hasKey ? undefined : `Re-enter API key in Settings > Providers`,
    });
  }

  // Google Workspace — check manifest OR the restored DB directly
  const googleWasConnected = manifest.contents.google_workspace_connected || checkDbConfigFlag('gws_connected');
  if (googleWasConnected) {
    const gwsInstalled = checkCommandExists('gws');
    currentChecks.push({
      id: 'gws-cli',
      label: 'gws CLI installed',
      status: gwsInstalled ? 'ok' : 'action_needed',
      action: gwsInstalled ? undefined : 'Install via Settings > Google',
    });

    const googleAuthValid = await checkGoogleAuth();
    currentChecks.push({
      id: 'google-auth',
      label: 'Google Workspace needs re-authentication',
      status: googleAuthValid ? 'ok' : 'action_needed',
      action: googleAuthValid ? undefined : 'Re-connect in Settings > Google',
    });
  }

  // Microsoft — check manifest OR the restored DB directly
  // Microsoft OAuth tokens are always machine-specific, so always flag for re-auth
  const msWasConnected = manifest.contents.microsoft_connected || checkDbConfigFlag('ms_connected');
  if (msWasConnected) {
    currentChecks.push({
      id: 'microsoft-auth',
      label: 'Microsoft 365 needs re-authentication',
      status: 'action_needed',
      action: 'Re-authenticate in Settings > Microsoft (tokens are machine-specific)',
    });
  }

  // cloudflared
  const cfInstalled = checkCommandExists('cloudflared');
  currentChecks.push({
    id: 'cloudflared',
    label: 'cloudflared installed',
    status: cfInstalled ? 'ok' : 'action_needed',
    action: cfInstalled ? undefined : 'brew install cloudflared',
  });

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

function checkDbConfigFlag(key: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
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

function pullOllamaModel(model: string, checkId: string): void {
  logger.info('Auto-pulling Ollama model', { model });
  const proc = spawn('ollama', ['pull', model], { stdio: 'pipe' });

  proc.on('close', (code) => {
    if (code === 0) {
      updateCheck(checkId, { label: `${model} downloaded`, status: 'ok' });
      logger.info('Ollama model pulled', { model });
    } else {
      updateCheck(checkId, { label: `${model} download failed`, status: 'action_needed', action: `Run: ollama pull ${model}` });
      logger.error('Ollama model pull failed', { model, code });
    }

    // Update saved checks in DB
    try {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_checks', ?)").run(JSON.stringify(currentChecks));
    } catch { /* ignore */ }
  });
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

async function checkGoogleAuth(): Promise<boolean> {
  try {
    const result = execSync('gws auth status', { encoding: 'utf-8', timeout: 5000 });
    return result.toLowerCase().includes('authenticated') || result.toLowerCase().includes('logged in');
  } catch {
    return false;
  }
}
