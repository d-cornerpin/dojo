// ════════════════════════════════════════
// Twilio config + auth (v2.9.18)
// Singleton config record + encrypted auth_token + multi-number
// roster. Personal Twilio accounts only - no A2P/10DLC registration
// handling, no recording.
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';
import { getCredentialMasterKey } from '../config/loader.js';
import { createLogger } from '../logger.js';

const logger = createLogger('twilio');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export interface TwilioConfig {
  configured: boolean;
  enabled: boolean;
  smsEnabled: boolean;
  voiceEnabled: boolean;
  accountSid: string | null;
  defaultFromNumber: string | null;
  voiceMaxMinutesPerCall: number;
  voiceUnknownCallerAction: 'reject' | 'voicemail' | 'agent';
  voiceVoicemailGreeting: string;
  numbers: TwilioNumber[];
}

export interface TwilioNumber {
  number: string;
  label: string | null;
  isDefault: boolean;
  smsEnabled: boolean;
  voiceEnabled: boolean;
}

interface ConfigRow {
  account_sid: string | null;
  auth_token_ciphertext: Buffer | null;
  auth_token_iv: Buffer | null;
  auth_token_tag: Buffer | null;
  default_from_number: string | null;
  enabled: number;
  sms_enabled: number;
  voice_enabled: number;
  voice_max_minutes_per_call: number;
  voice_unknown_caller_action: 'reject' | 'voicemail' | 'agent';
  voice_voicemail_greeting: string;
}

interface NumberRow {
  number: string;
  label: string | null;
  is_default: number;
  sms_enabled: number;
  voice_enabled: number;
}

// ── Crypto helpers (same shape as credentials/store.ts) ──

function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const key = getCredentialMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = getCredentialMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ── Reads ──

function getRawConfig(): ConfigRow | null {
  const row = getDb().prepare('SELECT * FROM twilio_config WHERE id = 1').get() as ConfigRow | undefined;
  return row ?? null;
}

export function getTwilioConfig(): TwilioConfig {
  const row = getRawConfig();
  const numbers = listTwilioNumbers();
  if (!row) {
    return {
      configured: false,
      enabled: false,
      smsEnabled: false,
      voiceEnabled: false,
      accountSid: null,
      defaultFromNumber: null,
      voiceMaxMinutesPerCall: 30,
      voiceUnknownCallerAction: 'voicemail',
      voiceVoicemailGreeting: 'Hi, you have reached the dojo voicemail. Please leave a brief message after the tone and we will get back to you.',
      numbers,
    };
  }
  return {
    configured: Boolean(row.account_sid && row.auth_token_ciphertext),
    enabled: row.enabled === 1,
    smsEnabled: row.sms_enabled === 1,
    voiceEnabled: row.voice_enabled === 1,
    accountSid: row.account_sid,
    defaultFromNumber: row.default_from_number,
    voiceMaxMinutesPerCall: row.voice_max_minutes_per_call,
    voiceUnknownCallerAction: row.voice_unknown_caller_action,
    voiceVoicemailGreeting: row.voice_voicemail_greeting,
    numbers,
  };
}

export function isTwilioConfigured(): boolean {
  const row = getRawConfig();
  return Boolean(row?.account_sid && row?.auth_token_ciphertext);
}

export function isSmsEnabled(): boolean {
  const c = getTwilioConfig();
  return c.configured && c.enabled && c.smsEnabled;
}

export function isVoiceEnabled(): boolean {
  const c = getTwilioConfig();
  return c.configured && c.enabled && c.voiceEnabled;
}

/**
 * Returns the decrypted Twilio auth token, or null if not configured.
 * Cached in process memory after first read since this is called on
 * every outbound API request and the underlying crypto is cheap but
 * non-zero.
 */
let cachedAuthToken: { sid: string; token: string } | null = null;
export function getTwilioCreds(): { sid: string; token: string } | null {
  const row = getRawConfig();
  if (!row?.account_sid || !row.auth_token_ciphertext || !row.auth_token_iv || !row.auth_token_tag) {
    return null;
  }
  if (cachedAuthToken && cachedAuthToken.sid === row.account_sid) {
    return cachedAuthToken;
  }
  try {
    const token = decrypt(row.auth_token_ciphertext, row.auth_token_iv, row.auth_token_tag);
    cachedAuthToken = { sid: row.account_sid, token };
    return cachedAuthToken;
  } catch (err) {
    logger.error('Twilio auth_token decrypt failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function listTwilioNumbers(): TwilioNumber[] {
  const rows = getDb()
    .prepare('SELECT * FROM twilio_numbers ORDER BY is_default DESC, number ASC')
    .all() as NumberRow[];
  return rows.map(rowToNumber);
}

function rowToNumber(row: NumberRow): TwilioNumber {
  return {
    number: row.number,
    label: row.label,
    isDefault: row.is_default === 1,
    smsEnabled: row.sms_enabled === 1,
    voiceEnabled: row.voice_enabled === 1,
  };
}

export function getDefaultFromNumber(): string | null {
  const cfg = getTwilioConfig();
  if (cfg.defaultFromNumber) return cfg.defaultFromNumber;
  const def = cfg.numbers.find(n => n.isDefault);
  return def?.number ?? cfg.numbers[0]?.number ?? null;
}

export function getNumber(number: string): TwilioNumber | null {
  const row = getDb()
    .prepare('SELECT * FROM twilio_numbers WHERE number = ?')
    .get(number) as NumberRow | undefined;
  return row ? rowToNumber(row) : null;
}

// ── Writes ──

function ensureConfigRow(): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO twilio_config (id) VALUES (1)
  `).run();
}

export function setTwilioCredentials(accountSid: string, authToken: string): void {
  ensureConfigRow();
  const enc = encrypt(authToken);
  getDb().prepare(`
    UPDATE twilio_config
    SET account_sid = ?,
        auth_token_ciphertext = ?,
        auth_token_iv = ?,
        auth_token_tag = ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(accountSid, enc.ciphertext, enc.iv, enc.authTag);
  cachedAuthToken = null;
  logger.info('Twilio credentials updated', { accountSid });
}

export function clearTwilioCredentials(): void {
  ensureConfigRow();
  getDb().prepare(`
    UPDATE twilio_config
    SET account_sid = NULL,
        auth_token_ciphertext = NULL,
        auth_token_iv = NULL,
        auth_token_tag = NULL,
        enabled = 0,
        sms_enabled = 0,
        voice_enabled = 0,
        updated_at = datetime('now')
    WHERE id = 1
  `).run();
  cachedAuthToken = null;
  logger.info('Twilio credentials cleared');
}

export interface TwilioSettingsPatch {
  enabled?: boolean;
  smsEnabled?: boolean;
  voiceEnabled?: boolean;
  defaultFromNumber?: string | null;
  voiceMaxMinutesPerCall?: number;
  voiceUnknownCallerAction?: 'reject' | 'voicemail' | 'agent';
  voiceVoicemailGreeting?: string;
}

export function updateTwilioSettings(patch: TwilioSettingsPatch): void {
  ensureConfigRow();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.smsEnabled !== undefined) { sets.push('sms_enabled = ?'); params.push(patch.smsEnabled ? 1 : 0); }
  if (patch.voiceEnabled !== undefined) { sets.push('voice_enabled = ?'); params.push(patch.voiceEnabled ? 1 : 0); }
  if (patch.defaultFromNumber !== undefined) { sets.push('default_from_number = ?'); params.push(patch.defaultFromNumber); }
  if (patch.voiceMaxMinutesPerCall !== undefined) {
    const clamped = Math.max(1, Math.min(120, Math.floor(patch.voiceMaxMinutesPerCall)));
    sets.push('voice_max_minutes_per_call = ?'); params.push(clamped);
  }
  if (patch.voiceUnknownCallerAction !== undefined) {
    sets.push('voice_unknown_caller_action = ?'); params.push(patch.voiceUnknownCallerAction);
  }
  if (patch.voiceVoicemailGreeting !== undefined) {
    sets.push('voice_voicemail_greeting = ?'); params.push(patch.voiceVoicemailGreeting);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE twilio_config SET ${sets.join(', ')} WHERE id = 1`).run(...params);
}

export function upsertTwilioNumber(number: string, patch: { label?: string | null; isDefault?: boolean; smsEnabled?: boolean; voiceEnabled?: boolean } = {}): void {
  const db = getDb();
  if (patch.isDefault) {
    // Only one default at a time.
    db.prepare('UPDATE twilio_numbers SET is_default = 0').run();
  }
  const existing = getNumber(number);
  if (!existing) {
    db.prepare(`
      INSERT INTO twilio_numbers (number, label, is_default, sms_enabled, voice_enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      number,
      patch.label ?? null,
      patch.isDefault ? 1 : 0,
      patch.smsEnabled === false ? 0 : 1,
      patch.voiceEnabled === false ? 0 : 1,
    );
    logger.info('Twilio number added', { number, isDefault: patch.isDefault === true });
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.label !== undefined) { sets.push('label = ?'); params.push(patch.label); }
  if (patch.isDefault !== undefined) { sets.push('is_default = ?'); params.push(patch.isDefault ? 1 : 0); }
  if (patch.smsEnabled !== undefined) { sets.push('sms_enabled = ?'); params.push(patch.smsEnabled ? 1 : 0); }
  if (patch.voiceEnabled !== undefined) { sets.push('voice_enabled = ?'); params.push(patch.voiceEnabled ? 1 : 0); }
  if (sets.length === 0) return;
  params.push(number);
  db.prepare(`UPDATE twilio_numbers SET ${sets.join(', ')} WHERE number = ?`).run(...params);
}

export function removeTwilioNumber(number: string): void {
  getDb().prepare('DELETE FROM twilio_numbers WHERE number = ?').run(number);
  logger.info('Twilio number removed', { number });
}
