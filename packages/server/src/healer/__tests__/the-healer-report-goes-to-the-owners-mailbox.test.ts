// The Send Healer Report route emails the report from the agent's mailbox to the owner's own connected mailbox,
// and says so in a stable code when either mailbox is missing, sending nothing. The mail tool is a recorder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const { HOME } = vi.hoisted(() => ({
  HOME: `${(process.env.DOJO_TEST_HOME_ROOT || require('node:os').tmpdir())}/dojo-healer-report-${process.pid}`,
}));
vi.mock('../../home.js', () => ({ homeDir: (): string => HOME, dojoDir: (...s: string[]): string => `${HOME}/.dojo/${s.join('/')}` }));

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const sent = vi.hoisted(() => ({ calls: [] as Array<{ tool: string; to: unknown; account?: unknown }>, reply: 'Sent.' }));
vi.mock('../../google/tools-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../google/tools-write.js')>()),
  executeGoogleWriteTool: async (tool: string, args: { to: unknown; account?: unknown }) => { sent.calls.push({ tool, to: args.to, account: args.account }); return sent.reply; },
}));
vi.mock('../../microsoft/tools-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../microsoft/tools-write.js')>()),
  executeMicrosoftWriteTool: async (tool: string, args: { to: unknown; account?: unknown }) => { sent.calls.push({ tool, to: args.to, account: args.account }); return sent.reply; },
}));

import { runMigrations } from '../../db/migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { insertGoogleAccount } from '../../google/accounts.js';
import { insertMicrosoftAccount } from '../../microsoft/accounts.js';
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
  freshDoneDb();
  runMigrations();
  sent.calls = []; sent.reply = 'Sent.';
});
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

describe('Send Healer Report', () => {
  it('emails the owner mailbox from the agent mailbox and archives the log', async () => {
    insertGoogleAccount({ kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true });
    insertGoogleAccount({ kind: 'user', email: 'Owner@Example.com', connected: true });
    expect(await send()).toEqual({ status: 200, body: { ok: true, data: { message: 'Report sent and archived' } } });
    expect(sent.calls).toEqual([{ tool: 'gmail_send', to: 'owner@example.com', account: 'agent@example.com' }]);
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
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('sends from the first agent account whose sending switch is on', async () => {
    insertGoogleAccount({ kind: 'agent', email: 'g@example.com', connected: true, sendEmail: false });
    insertMicrosoftAccount({ kind: 'agent', email: 'm@example.com', connected: true, sendEmail: true });
    insertGoogleAccount({ kind: 'user', email: 'owner@example.com', connected: true });
    await send();
    expect(sent.calls).toEqual([{ tool: 'outlook_send', to: 'owner@example.com', account: 'm@example.com' }]);
  });

  it('says in plain words which account to reconnect when the sign-in is refused', async () => {
    insertGoogleAccount({ kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true });
    insertGoogleAccount({ kind: 'user', email: 'owner@example.com', connected: true });
    sent.reply = 'Error sending email: Request had invalid authentication credentials.';
    const { body } = await send();
    expect(body.error).toBe("The sign-in for the agent's Google account (agent@example.com) was refused or has expired. Reconnect it in Settings → Channels.");
  });
});
