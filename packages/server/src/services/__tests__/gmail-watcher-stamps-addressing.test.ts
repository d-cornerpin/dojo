// ════════════════════════════════════════════════════════════════════════════════════════
// P44 — THE WATCHER STAMPS MAIL ADDRESSING ON THE INBOUND META (lane t280, design step 2).
//
// The Gmail watcher must COLLECT and STORE, on each inbound message's structured
// `inbound_meta`, who the mail went to (To/Cc) and where the watched mailbox sits
// (to / cc / neither), plus the provider's own Authentication-Results. Only the
// meta changes here — the notice text the model reads is a separate task.
//
// The door is the REAL one: the email arrives through the REAL Gmail watcher poll
// (only Google's HTTP is scripted), the row is written through the REAL insert and
// `recordInboundMeta`, and the notice is built by the REAL `mailNoticeContent`.
// Idiom copied from `src/memory/__tests__/t141-every-item-labelled.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
// `vi.mock` factories hoist above the const declarations, so the spy the ws seam returns
// must be hoisted itself or the factory reads it while still in the temporal dead zone.
const { broadcastSpy } = vi.hoisted(() => ({ broadcastSpy: vi.fn() }));
const googleReadMock = vi.fn();
const googleViews = { current: [] as Array<Record<string, unknown>> };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'gmail-stamps', 'dojo.db'),
  };
});
// The broadcast seam is what the watcher writes each inbound row to; the test collects the
// frames so a case can assert the SAME meta rode the wire as landed in the DB row.
vi.mock('../../gateway/ws.js', () => ({ broadcast: broadcastSpy, stampPersistedRow: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../config/platform.js', () => ({
  clearPlatformConfigCache: vi.fn(), getSudoPolicyRaw: () => null, getPlatformName: () => 'Dojo',
  getOwnerName: () => 'Test Owner', getPrimaryAgentId: () => 'primary', getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm', getPMAgentName: () => 'PM', isPMEnabled: () => false,
  getTrainerAgentId: () => 'trainer', getTrainerAgentName: () => 'Trainer', isTrainerEnabled: () => false,
  getImaginerAgentId: () => 'imaginer', getImaginerAgentName: () => 'Imaginer', isImaginerEnabled: () => false,
  isSetupCompleted: () => true, setPlatformConfig: vi.fn(), getAllPlatformConfig: () => ({}),
  isPrimaryAgent: (id: string) => id === 'primary', isPMAgent: (id: string) => id === 'pm',
  isTrainerAgent: (id: string) => id === 'trainer', isImaginerAgent: (id: string) => id === 'imaginer',
  getHealerAgentId: () => 'healer', getHealerAgentName: () => 'Healer', isHealerAgent: (id: string) => id === 'healer',
  getDreamerAgentId: () => 'dreamer', getDreamerAgentName: () => 'Dreamer', isDreamerAgent: (id: string) => id === 'dreamer',
  HOUSEHOLD_AGENT_IDS_KEY: 'household_agent_ids', getHouseholdAgentIds: () => [],
  isPermanentAgent: (id: string) => id === 'primary' || id === 'dreamer', isSystemServiceAgent: () => false,
  getSystemServiceAgentIds: () => [], getDashboardHiddenAgentIds: () => new Set<string>(), isDashboardHiddenAgent: () => false,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
// The ONLY scripted half of the mail door: Google's HTTP answers. The watcher's own poll,
// framing, conversation resolution and insert all run for real.
vi.mock('../../google/client.js', () => ({ googleRead: (...a: unknown[]) => googleReadMock(...a) }));
vi.mock('../../google/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../google/auth.js')>('../../google/auth.js');
  return { ...actual, listGoogleAccountViews: () => googleViews.current };
});
// The safe-sender list is read for real (the watcher decides "direct to the agent" from it);
// only the parse is restated, in the stored JSON shape the settings page writes. `addressesMatch`
// and `sendAlert` are the two the watcher/status chain import.
vi.mock('../../services/imessage-bridge.js', () => ({
  isAwaitingIMResponse: () => false, clearIMResponseFlag: vi.fn(), sendResponseViaIMessage: vi.fn(),
  getPendingIMSenderRaw: () => null, stripSystemTags: (s: string) => s,
  parseSafeSenders: (raw: string | null) => (raw ? (JSON.parse(raw) as Array<{ address: string }>) : []),
  sendIMessageWithAttachment: vi.fn(), addressesMatch: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
  getInboundSenderFor: () => null, sendAlert: vi.fn(),
  getTurnScopedImRecipient: () => null, getDefaultSender: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { startGmailWatcher, stopGmailWatcher } from '../../services/gmail-watcher.js';
import { mailNoticeContent } from '../../tools/inbound-fences.js';
import { unfenceExternal } from '../../tools/external-content.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  return db;
}

/** The watched mailbox the poll will see. */
function setMailbox(kind: 'user' | 'agent', email: string): void {
  googleViews.current = [{
    id: kind, kind, position: 1, email, enabled: true, connected: true,
    services: { gmail: true, calendar: false, drive: false, docs: false, sheets: false, contacts: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

/** One full message the poll will fetch. `headers` are what Gmail's metadata answer returns. */
interface Mail {
  id: string;
  threadId: string;
  snippet: string;
  headers: Array<{ name: string; value: string }>;
}

/** One poll of the REAL watcher, with Google answering `mail`. Fake timers only around the
 *  poll itself; the insert/record run on the real clock. */
async function mailArrives(mail: Mail[]): Promise<void> {
  googleReadMock.mockImplementation(async (url: string) => {
    if (url.includes('/messages?')) return { ok: true, data: { messages: mail.map((m) => ({ id: m.id, threadId: m.threadId })) } };
    const m = mail.find((x) => url.includes(`/messages/${x.id}`));
    if (!m) return { ok: false, error: 'no such message' };
    return {
      ok: true,
      data: { id: m.id, threadId: m.threadId, snippet: m.snippet, labelIds: ['INBOX'], payload: { headers: m.headers } },
    };
  });
  // A cursor already exists (the watcher has been running), so this poll notifies.
  const key = googleViews.current[0].id === 'agent' ? 'gmail_last_checked_at' : `gmail_last_checked_at_${googleViews.current[0].id}`;
  mockDb.current!.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, new Date(Date.now() - 60_000).toISOString());
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  try {
    startGmailWatcher();
    await vi.advanceTimersByTimeAsync(10_001);
  } finally {
    stopGmailWatcher();
    vi.useRealTimers();
  }
}

/** The stored row for one external message id: parsed inbound_meta and the notice text. */
function storedRow(msgId: string): { meta: Record<string, unknown>; content: string } {
  const row = mockDb.current!.prepare(`SELECT inbound_meta, content FROM messages WHERE external_message_id = ?`).get(msgId);
  return { meta: JSON.parse(row!.inbound_meta as string) as Record<string, unknown>, content: row!.content };
}

/** The detail request URL the watcher sent for `/messages/g1`. */
function detailUrl(msgId: string): string {
  const call = googleReadMock.mock.calls.find((c) => String(c[0]).includes(`/messages/${msgId}`));
  return call ? String(call[0]) : '';
}

// The fixture: Bob emails the agent's own mailbox, with the agent in To, another name in To,
// one in Cc, and the provider's own Authentication-Results header.
const G1: Mail = {
  id: 'g1', threadId: 'th-1', snippet: 'hello',
  headers: [
    { name: 'From', value: 'Bob <bob@y.test>' },
    { name: 'Subject', value: 'Plan' },
    { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
    { name: 'To', value: 'Agent <agent@x.com>, carol@z.test' },
    { name: 'Cc', value: 'dave@w.test' },
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=y.test' },
  ],
};

beforeEach(() => {
  const db = freshDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  broadcastSpy.mockReset();
  googleReadMock.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('P44 — the Gmail watcher stamps mail addressing on the inbound meta', () => {
  it('case 1: the detail request asks Gmail for To, Cc and Authentication-Results headers', async () => {
    setMailbox('agent', 'agent@x.com');
    await mailArrives([G1]);
    const url = detailUrl('g1');
    expect(url, 'the detail URL must ask for the addressing headers').toContain('metadataHeaders=To');
    expect(url).toContain('metadataHeaders=Cc');
    expect(url).toContain('metadataHeaders=Authentication-Results');
    expect(url).toContain('metadataHeaders=From');
    expect(url).toContain('metadataHeaders=Subject');
    expect(url).toContain('metadataHeaders=Date');
  });

  it('case 2: the stored inbound_meta carries mailAddressing (to/cc/placement/auth-results)', async () => {
    setMailbox('agent', 'agent@x.com');
    await mailArrives([G1]);
    const { meta } = storedRow('g1');
    expect(meta.mailAddressing).toEqual({
      to: [{ address: 'agent@x.com', display: 'Agent' }, { address: 'carol@z.test', display: null }],
      cc: [{ address: 'dave@w.test', display: null }],
      placement: 'to',
      authenticationResults: ['mx.google.com; dmarc=pass header.from=y.test'],
    });
  });

  it('case 3: the agent in Cc alone → cc; the agent nowhere (a mailing list) → neither', async () => {
    setMailbox('agent', 'agent@x.com');
    await mailArrives([{ ...G1, id: 'g3a', headers: [
      { name: 'From', value: 'Bob <bob@y.test>' },
      { name: 'Subject', value: 'Plan' },
      { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
      { name: 'To', value: 'carol@z.test' },
      { name: 'Cc', value: 'Agent <agent@x.com>' },
    ] }]);
    expect(storedRow('g3a').meta.mailAddressing).toMatchObject({ placement: 'cc' });
    await mailArrives([{ ...G1, id: 'g3b', headers: [
      { name: 'From', value: 'Bob <bob@y.test>' },
      { name: 'Subject', value: 'Plan' },
      { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
      { name: 'To', value: 'carol@z.test' },
      { name: 'Cc', value: 'dave@w.test' },
    ] }]);
    expect(storedRow('g3b').meta.mailAddressing).toMatchObject({ placement: 'neither' });
  });

  it('case 4: a user mailbox counts only its own address — the agent in To is not its "to"', async () => {
    setMailbox('user', 'owner@x.com');
    await mailArrives([{ ...G1, id: 'g4', headers: [
      { name: 'From', value: 'Bob <bob@y.test>' },
      { name: 'Subject', value: 'Plan' },
      { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
      { name: 'To', value: 'agent@x.com' },
      { name: 'Cc', value: 'owner@x.com' },
    ] }]);
    expect(storedRow('g4').meta.mailAddressing).toMatchObject({ placement: 'cc' });
  });

  it('case 5: nothing else moved — the rest of the meta and the notice text are unchanged', async () => {
    setMailbox('agent', 'agent@x.com');
    await mailArrives([G1]);
    const { meta, content } = storedRow('g1');
    expect(meta).toMatchObject({
      channel: 'email',
      accountKind: 'agent',
      authorized: false,
      sender: 'bob@y.test',
      emailMessageId: 'g1',
      emailService: 'gmail',
      emailSubject: 'Plan',
    });
    // The fence's own code is a fresh CSPRNG random per fencing, so the notice text is compared
    // with the fence stripped (the ONLY difference between the two calls is that random code).
    expect(unfenceExternal(content)).toBe(unfenceExternal(mailNoticeContent({
      provider: 'GMAIL', accountSuffix: "agent's Google account", account: 'agent@x.com',
      ownerName: 'Test Owner', kind: 'agent', fromAddr: 'bob@y.test', from: 'Bob <bob@y.test>',
      subject: 'Plan', date: 'Mon, 12 Oct 2026 10:00:00 +0000', snippet: 'hello',
      messageId: 'g1', directToAgent: false, toolHint: 'gmail_read',
    })));
  });

  it('case 6: a mail with no To/Cc/Authentication-Results headers still arrives with empty facts', async () => {
    setMailbox('agent', 'agent@x.com');
    await mailArrives([{ ...G1, id: 'g6', headers: [
      { name: 'From', value: 'Bob <bob@y.test>' },
      { name: 'Subject', value: 'Plan' },
      { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
    ] }]);
    expect(storedRow('g6').meta.mailAddressing).toEqual({
      to: [], cc: [], placement: 'neither', authenticationResults: [],
    });
  });
});
