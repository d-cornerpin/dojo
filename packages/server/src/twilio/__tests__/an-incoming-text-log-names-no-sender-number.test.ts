// An incoming text that is dropped (texting is switched off in Settings) is logged without the sender's number.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const logged: string[] = [];
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const line = (message: string, fields?: unknown): void => { logged.push(`${message} ${JSON.stringify(fields ?? {})}`); };
  return { ...actual, createLogger: () => ({ debug: () => {}, info: line, warn: line, error: line }) };
});

import { runMigrations } from '../../db/migrations.js';
import { ingestInboundSms } from '../sms-inbound.js';

const SENDER = '+15550100777';
const DOJO_NUMBER = '+15550100001';

beforeAll(() => { runMigrations(); });

describe('an incoming text log names no sender number', () => {
  it('a text dropped because texting is off is logged without the sender number', async () => {
    const ingested = await ingestInboundSms({ messageSid: 'SM-test-1', fromNumber: SENDER, toNumber: DOJO_NUMBER, body: 'hello', numMedia: 0, mediaUrls: [] });
    expect(ingested).toBe(false);
    expect(logged.some((l) => l.startsWith('Inbound SMS dropped: SMS disabled in Settings'))).toBe(true);
    expect(logged.join('\n')).not.toContain(SENDER);
  });
});
