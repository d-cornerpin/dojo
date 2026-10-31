// P44 review R1: until a REAL delivered Exchange Authentication-Results header has been checked on the dev box, Outlook owner
// confirmation fails closed (`services/outlook-owner-gate.ts`). This file uses the REAL gate (no mock): today an Outlook email
// from an owner address with a perfect-looking pass is unconfirmed and costs no extra Graph read. When the gate is opened on purpose,
// this file is the one that must change.
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

describe('P44 R1 — Outlook never confirms the owner today', () => {
  it('the gate is closed', () => { expect(outlookOwnerConfirmationOpen()).toBe(false); });

  it('a perfect-looking Exchange pass from an owner address is unconfirmed, with no extra Graph read', async () => {
    graph.mockResolvedValue({ ok: true, data: { internetMessageHeaders: [{ name: 'From', value: 'owner@home.test' }, { name: 'Authentication-Results', value: 'BN1PR01CA0001.namprd01.prod.outlook.com; dmarc=pass header.from=home.test' }], uniqueBody: { contentType: 'text', content: 'close it' } } });
    expect(await judgeOutlookOwnerEmail({ kind: 'agent', placement: 'to', fromAddress: 'owner@home.test', messageId: 'm1', accountId: 'agent' })).toEqual({ state: 'unconfirmed' });
    expect(graph).not.toHaveBeenCalled();
  });

  it('a stranger is still just "none"', async () => {
    expect(await judgeOutlookOwnerEmail({ kind: 'agent', placement: 'to', fromAddress: 'stranger@y.test', messageId: 'm2', accountId: 'agent' })).toEqual({ state: 'none' });
  });
});
