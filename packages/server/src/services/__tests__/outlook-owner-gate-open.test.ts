// Outlook owner confirmation is OPEN (live check C3, 2026-10-31: Exchange's real topmost Authentication-Results carries the
// authserv-id mx.microsoft.com, with the same shape for external Gmail, external Microsoft 365 and self-sent mail). This file uses
// the REAL gate (no mock). Same-tenant internal mail was not covered by that check: with no Microsoft-stamped topmost header it
// stays unconfirmed (fail closed).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
const graph = vi.fn();
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: (...a: unknown[]) => graph(...a) }));
vi.mock('../../google/client.js', () => ({ googleRead: vi.fn() }));
import { runMigrations } from '../../db/migrations.js';
import { judgeOutlookOwnerEmail } from '../mail-owner-intake.js';
import { outlookOwnerConfirmationOpen } from '../outlook-owner-gate.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations(); graph.mockReset();
  mockDb.current.prepare("INSERT INTO microsoft_accounts (id, kind, position, email, connected) VALUES ('m-user', 'user', 0, 'owner@home.test', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const REAL = 'mx.microsoft.com 1; spf=pass smtp.mailfrom=home.test; dkim=pass header.d=home.test; dmarc=pass action=none header.from=home.test;compauth=pass reason=100';
const arrives = (auth: string[]) => {
  graph.mockResolvedValue({ ok: true, data: { internetMessageHeaders: [{ name: 'From', value: 'owner@home.test' }, ...auth.map((value) => ({ name: 'Authentication-Results', value })), { name: 'Message-ID', value: '<abc@home.test>' }], uniqueBody: { contentType: 'text', content: 'close it' } } });
  return judgeOutlookOwnerEmail({ kind: 'agent', placement: 'to', fromAddress: 'owner@home.test', messageId: 'm1', accountId: 'agent' });
};

describe('Outlook owner confirmation is open (C3, 2026-10-31)', () => {
  it('the gate is open', () => { expect(outlookOwnerConfirmationOpen()).toBe(true); });

  it('the real Exchange header shape (version token after mx.microsoft.com, compauth clause) confirms the owner', async () => {
    expect(await arrives([REAL])).toEqual({ state: 'confirmed', words: 'close it' });
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('the authserv-id without a version token confirms too', async () => {
    expect(await arrives([REAL.replace('mx.microsoft.com 1', 'mx.microsoft.com')])).toMatchObject({ state: 'confirmed' });
  });

  it('same-tenant internal mail with no Microsoft-stamped topmost header stays unconfirmed (fail closed)', async () => {
    expect(await arrives(['dkim=none (message not signed); dmarc=none action=none header.from=home.test'])).toEqual({ state: 'unconfirmed' });
    // a lower Microsoft-looking header is never looked for
    expect(await arrives(['spf=none; dmarc=pass header.from=home.test', REAL])).toEqual({ state: 'unconfirmed' });
    expect(await arrives([])).toEqual({ state: 'unconfirmed' });
  });

  it('a failing dmarc under the real shape is unconfirmed', async () => {
    expect(await arrives([REAL.replace('dmarc=pass', 'dmarc=fail')])).toEqual({ state: 'unconfirmed' });
  });

  it('a stranger is still just "none"', async () => {
    expect(await judgeOutlookOwnerEmail({ kind: 'agent', placement: 'to', fromAddress: 'stranger@y.test', messageId: 'm2', accountId: 'agent' })).toEqual({ state: 'none' });
  });
});
