import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { SecretsSchema, type SecretsData } from './schema.js';
import { createLogger } from '../logger.js';
import { homeDir } from '../home.js';

const logger = createLogger('config');
const PLATFORM_DIR = path.join(homeDir(), '.dojo');
const SECRETS_PATH = path.join(PLATFORM_DIR, 'secrets.yaml');

let cachedSecrets: SecretsData | null = null;
// The file's mtime at the last read or write; a newer mtime means an out-of-band edit and drops the cache.
let cachedSecretsMtimeMs: number | null = null;

function ensurePlatformDir(): void {
  if (!fs.existsSync(PLATFORM_DIR)) {
    fs.mkdirSync(PLATFORM_DIR, { recursive: true });
  }
}

/** Owner-only. The mode `agent/brokers/deny.ts`'s `dojo-secrets-store` row
 *  names as one of this file's two protections. */
const SECRETS_MODE = 0o600;

// Re-asserts owner-only mode: writeFileSync's mode applies only when it creates the file, so a rewrite
// keeps whatever mode the file carried. Best-effort (a volume without chmod must not stop boot) and
// tighten-only (a stricter mode is left alone).
function enforceSecretsMode(): void {
  try {
    const current = fs.statSync(SECRETS_PATH).mode & 0o777;
    if ((current & ~SECRETS_MODE) === 0) return; // already owner-only or tighter
    fs.chmodSync(SECRETS_PATH, SECRETS_MODE);
    logger.warn('secrets.yaml was more permissive than owner-only — tightened', {
      from: current.toString(8), to: SECRETS_MODE.toString(8),
    });
  } catch {
    /* unreadable, missing, or a filesystem without chmod; never fatal */
  }
}

/** Drops the cache when secrets.yaml was edited on disk since the last read; one stat per access. */
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
      // Also clear the model-client cache so the next call uses the fresh credential.
      try {
        // Dynamic to avoid an import cycle (config → model → config).
        import('../agent/model.js').then((m) => {
          if (typeof m.clearClientCache === 'function') m.clearClientCache();
        }).catch(() => { /* */ });
      } catch { /* */ }
    }
  } catch { /* file missing or unreadable: the loader handles it */ }
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
    // YAML parses empty values as null; Zod wants them absent.
    for (const key of Object.keys(parsed)) {
      if (parsed[key] === null) delete parsed[key];
    }
    const validated = SecretsSchema.parse(parsed);
    cachedSecrets = validated;
    cachedSecretsMtimeMs = stat.mtimeMs;
    // Runs on first load and every invalidation, so an open file does not stay open until its next write.
    enforceSecretsMode();
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
  fs.writeFileSync(SECRETS_PATH, content, { mode: SECRETS_MODE });
  // The mode argument above only bites when this call CREATED the file.
  enforceSecretsMode();
  cachedSecrets = data;
  // Record the post-write mtime so our own write does not read as an out-of-band edit.
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

// Master key for agent_credentials AES-256-GCM encryption, generated on first use (32 random bytes, hex).
// Rotating it in secrets.yaml makes every stored credential fail to decrypt.
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

// The one meaning of "no password": an absent, empty or blank hash is null. Login, the first-run gate,
// /api/setup/* and import all test this result, so a blank hash cannot make them disagree.
export function getDashboardPasswordHash(): string | null {
  const secrets = loadSecrets();
  const hash = secrets.dashboard_password_hash;
  return typeof hash === 'string' && hash.trim() !== '' ? hash : null;
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
