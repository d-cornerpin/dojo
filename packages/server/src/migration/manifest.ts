// ════════════════════════════════════════
// Migration Manifest — generation & parsing
// ════════════════════════════════════════

import os from 'node:os';
import { execSync } from 'node:child_process';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-manifest');

export interface ExportManifest {
  version: '1.0';
  platform_version: string;
  exported_at: string;
  exported_from: {
    hostname: string;
    username: string;
    home_directory: string;
    os_version: string;
    node_version: string;
  };
  contents: {
    database: boolean;
    database_size_bytes: number;
    prompts: string[];
    techniques_count: number;
    techniques: string[];
    vault_entries_count: number;
    agents_count: number;
    agents: Array<{ name: string; classification: string; model: string | null }>;
    google_workspace_connected: boolean;
    google_workspace_email: string | null;
    microsoft_connected: boolean;
    ollama_models: string[];
    providers: string[];
    uploads_size_bytes: number;
  };
  encryption: 'aes-256-cbc';
  checksum: string; // filled after encryption
}

function getOsVersion(): string {
  try {
    return execSync('sw_vers -productVersion', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getOllamaModels(): string[] {
  try {
    const output = execSync('ollama list', { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n').slice(1); // skip header
    return lines.map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

function getPlatformVersion(): string {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'platform_version'").get() as { value: string } | undefined;
    return row?.value ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function generateManifest(dbSizeBytes: number, prompts: string[], techniques: string[], uploadsSize: number): ExportManifest {
  const db = getDb();

  // Agents
  const agents = db.prepare('SELECT name, classification, model_id FROM agents WHERE agent_type != ?').all('archived') as Array<{ name: string; classification: string; model_id: string | null }>;

  // Vault entries count
  const vaultRow = db.prepare('SELECT COUNT(*) as cnt FROM vault_entries').get() as { cnt: number } | undefined;
  const vaultCount = vaultRow?.cnt ?? 0;

  // Providers
  const providerRows = db.prepare('SELECT name FROM providers').all() as Array<{ name: string }>;
  const providers = providerRows.map(p => p.name);

  // Google workspace
  let googleConnected = false;
  let googleEmail: string | null = null;
  try {
    const gwRow = db.prepare("SELECT value FROM config WHERE key = 'gws_connected'").get() as { value: string } | undefined;
    googleConnected = gwRow?.value === 'true';
    if (googleConnected) {
      const emailRow = db.prepare("SELECT value FROM config WHERE key = 'gws_account_email'").get() as { value: string } | undefined;
      googleEmail = emailRow?.value ?? null;
    }
  } catch { /* table may not exist */ }

  // Microsoft
  let msConnected = false;
  try {
    const msRow = db.prepare("SELECT value FROM config WHERE key = 'ms_connected'").get() as { value: string } | undefined;
    msConnected = msRow?.value === 'true';
  } catch { /* table may not exist */ }

  const manifest: ExportManifest = {
    version: '1.0',
    platform_version: getPlatformVersion(),
    exported_at: new Date().toISOString(),
    exported_from: {
      hostname: os.hostname(),
      username: os.userInfo().username,
      home_directory: os.homedir(),
      os_version: `macOS ${getOsVersion()}`,
      node_version: process.version,
    },
    contents: {
      database: true,
      database_size_bytes: dbSizeBytes,
      prompts,
      techniques_count: techniques.length,
      techniques,
      vault_entries_count: vaultCount,
      agents_count: agents.length,
      agents: agents.map(a => ({ name: a.name, classification: a.classification, model: a.model_id })),
      google_workspace_connected: googleConnected,
      google_workspace_email: googleEmail,
      microsoft_connected: msConnected,
      ollama_models: getOllamaModels(),
      providers,
      uploads_size_bytes: uploadsSize,
    },
    encryption: 'aes-256-cbc',
    checksum: '', // filled after archive is created
  };

  logger.info('Manifest generated', {
    agents: manifest.contents.agents_count,
    techniques: manifest.contents.techniques_count,
    vaultEntries: manifest.contents.vault_entries_count,
  });

  return manifest;
}
