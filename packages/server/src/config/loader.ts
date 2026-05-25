import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { SecretsSchema, type SecretsData } from './schema.js';
import { createLogger } from '../logger.js';

const logger = createLogger('config');
const PLATFORM_DIR = path.join(os.homedir(), '.dojo');
const SECRETS_PATH = path.join(PLATFORM_DIR, 'secrets.yaml');

let cachedSecrets: SecretsData | null = null;
// v2.3.19 — also track the mtime of the secrets file so we can detect
// out-of-band edits (user opens secrets.yaml in a text editor and saves)
// and invalidate the cache automatically. Pre-spec, the cache stayed
// stale until a full server restart, which meant agents kept failing
// 401 with the OLD api key even after the user fixed it.
let cachedSecretsMtimeMs: number | null = null;

function ensurePlatformDir(): void {
  if (!fs.existsSync(PLATFORM_DIR)) {
    fs.mkdirSync(PLATFORM_DIR, { recursive: true });
  }
}

/**
 * v2.3.19 — invalidate the cache if secrets.yaml has been edited
 * out-of-band since we last read it. Cheap stat call on every access.
 */
function invalidateIfStale(): void {
  if (!cachedSecrets || cachedSecretsMtimeMs === null) return;
  try {
    const stat = fs.statSync(SECRETS_PATH);
    if (stat.mtimeMs > cachedSecretsMtimeMs) {
      logger.info('secrets.yaml changed on disk — invalidating in-memory cache', {
        prevMtimeMs: cachedSecretsMtimeMs,
        newMtimeMs: stat.mtimeMs,
      });
      cachedSecrets = null;
      cachedSecretsMtimeMs = null;
      // Also clear the model-client cache so the next call rebuilds with
      // the fresh credential. Avoids the "stale 401 after key fix" loop.
      try {
        // Dynamic to avoid an import cycle (config → model → config).
        import('../agent/model.js').then((m) => {
          if (typeof m.clearClientCache === 'function') m.clearClientCache();
        }).catch(() => { /* */ });
      } catch { /* */ }
    }
  } catch { /* file missing or unreadable — let the loader handle it */ }
}

export function loadSecrets(): SecretsData {
  invalidateIfStale();
  if (cachedSecrets) return cachedSecrets;

  ensurePlatformDir();

  if (!fs.existsSync(SECRETS_PATH)) {
    const defaultSecrets: SecretsData = {
      jwt_secret: crypto.randomBytes(32).toString('hex'),
      providers: {},
    };
    saveSecrets(defaultSecrets);
    cachedSecrets = defaultSecrets;
    logger.info('Created new secrets.yaml with generated JWT secret');
    return cachedSecrets;
  }

  try {
    const stat = fs.statSync(SECRETS_PATH);
    const content = fs.readFileSync(SECRETS_PATH, 'utf-8');
    const parsed = yaml.parse(content) ?? {};
    // YAML parses empty values as null — convert nulls to undefined for Zod
    for (const key of Object.keys(parsed)) {
      if (parsed[key] === null) delete parsed[key];
    }
    const validated = SecretsSchema.parse(parsed);
    cachedSecrets = validated;
    cachedSecretsMtimeMs = stat.mtimeMs;
    return cachedSecrets;
  } catch (err) {
    logger.error('Failed to load secrets.yaml', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error('Failed to load secrets.yaml: ' + (err instanceof Error ? err.message : String(err)));
  }
}

export function saveSecrets(data: SecretsData): void {
  ensurePlatformDir();
  const content = yaml.stringify(data);
  fs.writeFileSync(SECRETS_PATH, content, { mode: 0o600 });
  cachedSecrets = data;
  // Record post-write mtime so the staleness check doesn't trigger on
  // our own write.
  try { cachedSecretsMtimeMs = fs.statSync(SECRETS_PATH).mtimeMs; } catch { /* */ }
}

export function getProviderCredential(providerId: string): string | null {
  const secrets = loadSecrets();
  const providerSecrets = secrets.providers?.[providerId];
  if (!providerSecrets) return null;
  return providerSecrets.api_key ?? providerSecrets.oauth_token ?? null;
}

export function setProviderCredential(providerId: string, credential: string, authType: 'api_key' | 'oauth' = 'api_key'): void {
  const secrets = loadSecrets();
  if (!secrets.providers) {
    secrets.providers = {};
  }
  secrets.providers[providerId] = authType === 'api_key'
    ? { api_key: credential }
    : { oauth_token: credential };
  saveSecrets(secrets);
  logger.info('Provider credential stored', { providerId });
}

export function getJwtSecret(): string {
  const secrets = loadSecrets();
  if (!secrets.jwt_secret) {
    const newSecret = crypto.randomBytes(32).toString('hex');
    secrets.jwt_secret = newSecret;
    saveSecrets(secrets);
    logger.info('Generated new JWT secret');
  }
  return secrets.jwt_secret;
}

// v2.7.21 - master key for agent_credentials AES-256-GCM encryption.
// Auto-generates on first call if missing. 32 random bytes hex-encoded.
// Rotating this in secrets.yaml will invalidate every stored credential
// (decryption will fail with auth-tag mismatch on every read).
export function getCredentialMasterKey(): Buffer {
  const secrets = loadSecrets();
  if (!secrets.credential_master_key) {
    const newKey = crypto.randomBytes(32).toString('hex');
    secrets.credential_master_key = newKey;
    saveSecrets(secrets);
    logger.info('Generated new credential master key');
  }
  return Buffer.from(secrets.credential_master_key, 'hex');
}

export function getDashboardPasswordHash(): string | null {
  const secrets = loadSecrets();
  return secrets.dashboard_password_hash ?? null;
}

export function setDashboardPassword(hash: string): void {
  const secrets = loadSecrets();
  secrets.dashboard_password_hash = hash;
  saveSecrets(secrets);
  logger.info('Dashboard password updated');
}

export function getSearchApiKey(): string | null {
  const secrets = loadSecrets();
  return secrets.search?.api_key ?? null;
}

export function setSearchConfig(provider: string, apiKey: string): void {
  const secrets = loadSecrets();
  secrets.search = { provider, api_key: apiKey };
  saveSecrets(secrets);
  logger.info('Search config stored', { provider });
}

export function getSearchProvider(): string | null {
  const secrets = loadSecrets();
  return secrets.search?.provider ?? null;
}

export function clearSecretsCache(): void {
  cachedSecrets = null;
  cachedSecretsMtimeMs = null;
}
