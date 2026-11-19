// An iMessage send is logged by the kind of person it went to, never by the address.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logged: string[] = [];
vi.mock('../../logger.js', async (orig) => {
  const actual = await orig<typeof import('../../logger.js')>();
  const line = (message: string, fields?: unknown): void => { logged.push(`${message} ${JSON.stringify(fields ?? {})}`); };
  return { ...actual, createLogger: () => ({ debug: () => {}, info: line, warn: line, error: line }) };
});

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { homeDir } from '../../home.js';
import { sendIMessage } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const FRIEND = '+15550100777';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-log-'));

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify([
    { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' },
    { address: FRIEND, name: 'Friend', is_primary: false, sharing_level: 'dont_overshare' },
  ]));
  const bin = path.join(homeDir(), '.dojo', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'imsg'), '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nexit 0\n', { mode: 0o755 });
});
afterAll(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

describe('the iMessage send log', () => {
  it('names the owner by kind and never writes his number', async () => {
    expect(await sendIMessage(OWNER, 'hello')).toBe(true);
    expect(logged.some((l) => l.startsWith('iMessage sent') && l.includes('the owner'))).toBe(true);
    expect(logged.join('\n')).not.toContain(OWNER);
  });
  it('names another approved sender by kind and never writes the number', async () => {
    expect(await sendIMessage(FRIEND, 'hello')).toBe(true);
    expect(logged.some((l) => l.startsWith('iMessage sent') && l.includes('an approved sender'))).toBe(true);
    expect(logged.join('\n')).not.toContain(FRIEND);
  });
});
