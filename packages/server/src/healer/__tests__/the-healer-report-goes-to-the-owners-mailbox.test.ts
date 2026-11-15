// The Send Healer Report route emails the report from the agent's mailbox to the owner's own connected mailbox,
// and says so in a stable code when either mailbox is missing, sending nothing. The mail tool is a recorder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const { HOME } = vi.hoisted(() => ({
  HOME: `${(process.env.DOJO_TEST_HOME_ROOT || require('node:os').tmpdir())}/dojo-healer-report-${process.pid}`,
}));
vi.mock('../../home.js', () => ({ homeDir: (): string => HOME, dojoDir: (...s: string[]): string => `${HOME}/.dojo/${s.join('/')}` }));

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const sent = vi.hoisted(() => ({ calls: [] as Array<{ tool: string; to: unknown }> }));
vi.mock('../../google/tools-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../google/tools-write.js')>()),
  executeGoogleWriteTool: async (tool: string, args: { to: unknown }) => { sent.calls.push({ tool, to: args.to }); return 'Sent.'; },
}));

import { runMigrations } from '../../db/migrations.js';
import { insertGoogleAccount } from '../../google/accounts.js';
import { healerRouter } from '../../gateway/routes/healer.js';

const send = async () => {
  const res = await healerRouter.request('/report/send', { method: 'POST' });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
};
const logPath = `${HOME}/.dojo/logs/healer-report.log`;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(`${HOME}/.dojo/logs`, { recursive: true });
  fs.writeFileSync(logPath, 'Everything checked out.');
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  sent.calls = [];
});
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

describe('Send Healer Report', () => {
  it('emails the owner mailbox from the agent mailbox and archives the log', async () => {
    insertGoogleAccount({ kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true });
    insertGoogleAccount({ kind: 'user', email: 'Owner@Example.com', connected: true });
    expect(await send()).toEqual({ status: 200, body: { ok: true, data: { message: 'Report sent and archived' } } });
    expect(sent.calls).toEqual([{ tool: 'gmail_send', to: 'owner@example.com' }]);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('sends nothing and says so when the owner has no connected mailbox', async () => {
    insertGoogleAccount({ kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true });
    expect(await send()).toEqual({ status: 400, body: { ok: false, error: 'NO_OWNER_MAILBOX' } });
    expect(sent.calls).toEqual([]);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('sends nothing and says so when the agent has no mailbox to send from', async () => {
    insertGoogleAccount({ kind: 'user', email: 'owner@example.com', connected: true });
    expect(await send()).toEqual({ status: 400, body: { ok: false, error: 'NO_EMAIL_CONFIGURED' } });
    expect(sent.calls).toEqual([]);
  });
});
