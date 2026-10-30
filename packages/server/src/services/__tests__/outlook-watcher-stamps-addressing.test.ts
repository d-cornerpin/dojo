// ════════════════════════════════════════════════════════════════════════════════════════
// 197 — OUTLOOK WATCHER STAMPS EMAIL ADDRESSING
//
// The Outlook watcher must collect the email's To/Cc addressing facts and store them on the
// inbound message's structured meta. The notice text the model reads must NOT change, nothing
// consumes the field yet, and `authenticationResults` stays [] for Outlook. This drives the
// REAL watcher poll (only the Microsoft Graph HTTP call is scripted) and reads the stored
// `inbound_meta` + `content` back off the DB row — never an inner function.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const msGraphMock = vi.fn();
const outlookViews = { current: [] as Array<Record<string, unknown>> };
let pollEndpoints: string[] = [];

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'outlook-addressing', 'dojo.db'),
  };
});
// The ONLY scripted half of the door: Microsoft Graph's HTTP answer. The watcher's own poll,
// framing, conversation resolution, insert and meta stamp all run for real.
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: (...a: unknown[]) => msGraphMock(...a) }));
vi.mock('../../microsoft/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../microsoft/auth.js')>('../../microsoft/auth.js');
  return { ...actual, listMicrosoftAccountViews: () => outlookViews.current };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary', getOwnerName: () => 'Test Owner',
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
// The real `fenceExternal` stamps a fresh random nonce per call (`newFenceCode`), so two separate
// `mailNoticeContent` runs could never be byte-identical. Test 5 compares the watcher's notice to
// a direct call with the same arguments, so the fence is made deterministic here; the other cases
// check the stored meta, not the fence bytes.
vi.mock('../../tools/external-content.js', () => ({
  fenceExternal: (kind: string, origin: string, text: string) => `[FENCED ${kind} ${origin}]\n${text}`,
}));

import { runMigrations } from '../../db/migrations.js';
import { startOutlookWatcher, stopOutlookWatcher } from '../../services/outlook-watcher.js';
import { mailNoticeContent } from '../../tools/inbound-fences.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  return db;
}

function setMailbox(kind: 'user' | 'agent', email: string): void {
  outlookViews.current = [{
    id: kind, kind, position: 1, email, accountType: null,
    enabled: true, connected: true,
    services: { outlook: true, calendar: false, onedrive: false, teams: false, contacts: false, onenote: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

/** One poll of the REAL watcher, with Graph answering `fixture`. Fake timers only around
 *  the poll. A cursor already exists, so the poll notifies instead of baseline-seeding. */
async function outlookPoll(fixture: Array<Record<string, unknown>>): Promise<void> {
  pollEndpoints = [];
  msGraphMock.mockImplementation(async (endpoint: string) => {
    pollEndpoints.push(endpoint);
    return { ok: true, data: { value: fixture } };
  });
  const id = (outlookViews.current[0] as { id?: string } | undefined)?.id ?? 'agent';
  const key = id === 'agent' ? 'outlook_last_checked_at' : `outlook_last_checked_at_${id}`;
  mockDb.current!.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, new Date(Date.now() - 60_000).toISOString());
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  try {
    startOutlookWatcher();
    await vi.advanceTimersByTimeAsync(10_001);
  } finally {
    stopOutlookWatcher();
    vi.useRealTimers();
  }
}

function readStored(id: string): { meta: Record<string, unknown>; content: string } {
  const row = mockDb.current!.prepare('SELECT inbound_meta, content FROM messages WHERE external_message_id = ?').get(id) as { inbound_meta: string; content: string } | undefined;
  if (!row) throw new Error(`message row ${id} not stored`);
  return { meta: JSON.parse(row.inbound_meta) as Record<string, unknown>, content: row.content };
}

const MAIL: Record<string, unknown> = {
  id: 'o1',
  from: { emailAddress: { name: 'Bob', address: 'bob@y.org' } },
  subject: 'Plan',
  bodyPreview: 'hello',
  toRecipients: [
    { emailAddress: { name: 'Agent', address: 'Agent@X.com' } },
    { emailAddress: { address: 'carol@z.net' } },
  ],
  ccRecipients: [{ emailAddress: { name: 'Dave', address: 'dave@w.io' } }],
};

function msg(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from: MAIL.from, subject: 'Plan', bodyPreview: 'hello', ...extra };
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  pollEndpoints = [];
  msGraphMock.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('outlook watcher stamps email addressing', () => {
  it('1. the poll asks for toRecipients and ccRecipients alongside the base select set', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([MAIL]);
    expect(pollEndpoints[0]).toContain('$select=id,from,subject,receivedDateTime,bodyPreview,isRead,conversationId,toRecipients,ccRecipients');
  });

  it('2. stored inbound meta carries the addressing facts (agent is on To)', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([MAIL]);
    expect(readStored('o1').meta.mailAddressing).toEqual({
      to: [{ address: 'agent@x.com', display: 'Agent' }, { address: 'carol@z.net', display: null }],
      cc: [{ address: 'dave@w.io', display: 'Dave' }],
      placement: 'to',
      authenticationResults: [],
    });
  });

  it('3a. agent address only in ccRecipients → placement cc', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([msg('o3a', {
      toRecipients: [{ emailAddress: { address: 'carol@z.net' } }],
      ccRecipients: [{ emailAddress: { address: 'Agent@X.com' } }],
    })]);
    expect(readStored('o3a').meta.mailAddressing).toMatchObject({ placement: 'cc' });
  });

  it('3b. agent address nowhere → placement neither', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([msg('o3b', {
      toRecipients: [{ emailAddress: { address: 'carol@z.net' } }],
      ccRecipients: [{ emailAddress: { address: 'dave@w.io' } }],
    })]);
    expect(readStored('o3b').meta.mailAddressing).toMatchObject({ placement: 'neither' });
  });

  it('4. a user-kind mailbox: agent on To and owner on Cc → placement cc', async () => {
    setMailbox('user', 'owner@x.com');
    await outlookPoll([msg('o4', {
      toRecipients: [{ emailAddress: { address: 'agent@x.com' } }],
      ccRecipients: [{ emailAddress: { address: 'owner@x.com' } }],
    })]);
    expect(readStored('o4').meta.mailAddressing).toMatchObject({ placement: 'cc' });
  });

  it('5. the notice text and the rest of the meta are unchanged', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([MAIL]);
    const { meta, content } = readStored('o1');
    expect(meta.channel).toBe('email');
    expect(meta.accountKind).toBe('agent');
    expect(meta.authorized).toBe(false);
    expect(meta.sender).toBe('bob@y.org');
    expect(meta.emailMessageId).toBe('o1');
    expect(meta.emailService).toBe('outlook');
    expect(meta.emailSubject).toBe('Plan');
    expect(content).toBe(mailNoticeContent({
      provider: 'OUTLOOK', accountSuffix: "agent's Microsoft account", account: 'agent@x.com',
      ownerName: 'Test Owner', kind: 'agent', fromAddr: 'bob@y.org', from: 'Bob <bob@y.org>',
      subject: 'Plan', date: '', snippet: 'hello', messageId: 'o1', directToAgent: false, toolHint: 'outlook_read',
    }));
  });

  it('6. a message with no recipient lists still arrives with empty addressing facts', async () => {
    setMailbox('agent', 'agent@x.com');
    await outlookPoll([msg('o6')]);
    expect(readStored('o6').meta.mailAddressing).toEqual({
      to: [], cc: [], placement: 'neither', authenticationResults: [],
    });
  });
});
