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

function ensurePlatformDir(): void {
  if (!fs.existsSync(PLATFORM_DIR)) {
    fs.mkdirSync(PLATFORM_DIR, { recursive: true });
  }
}

export function loadSecrets(): SecretsData {
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
    const content = fs.readFileSync(SECRETS_PATH, 'utf-8');
    const parsed = yaml.parse(content) ?? {};
    // YAML parses empty values as null — convert nulls to undefined for Zod
    for (const key of Object.keys(parsed)) {
      if (parsed[key] === null) delete parsed[key];
    }
    const validated = SecretsSchema.parse(parsed);
    cachedSecrets = validated;
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
}
