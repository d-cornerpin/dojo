// A Twilio text or call is logged by the kind of person it was for, never by the phone number.
// No Twilio account is set up here, so both fail at the door and log the failure line.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const logged: string[] = [];
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const line = (message: string, fields?: unknown): void => { logged.push(`${message} ${JSON.stringify(fields ?? {})}`); };
  return { ...actual, createLogger: () => ({ debug: () => {}, info: line, warn: line, error: line }) };
});

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { sendSms, placeCall } from '../client.js';

const OWNER = '+15550100198';
const FRIEND = '+15550100777';
const DOJO_NUMBER = '+15550100001';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify([
    { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' },
    { address: FRIEND, name: 'Friend', is_primary: false, sharing_level: 'dont_overshare' },
  ]));
});

describe('the Twilio send logs', () => {
  it('a text to the owner is logged as to the owner, never his number', async () => {
    expect((await sendSms(OWNER, 'hello', DOJO_NUMBER)).ok).toBe(false);
    expect(logged.some((l) => l.startsWith('Twilio SMS send failed') && l.includes('the owner'))).toBe(true);
    expect(logged.join('\n')).not.toContain(OWNER);
  });
  it('a call to an approved sender is logged by kind, never the number', async () => {
    expect((await placeCall(FRIEND, DOJO_NUMBER, 'https://example.com/voice')).ok).toBe(false);
    expect(logged.some((l) => l.startsWith('Twilio call failed to place') && l.includes('an approved sender'))).toBe(true);
    expect(logged.join('\n')).not.toContain(FRIEND);
  });
});
