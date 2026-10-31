// ════════════════════════════════════════════════════════════════════════════════════════
// 801 — A MAIL RE-READ SENDS THE DASHBOARD NO SECOND LIVE FRAME
//
// Both mail watchers insert with `insertInboundMessageIfAbsent`, whose `null` return is the
// designed signal "this external id was stored before". A message whose row landed but whose
// processed-list save did not (a poll stopped in between) is read again: the insert no-ops,
// yet the watcher used to stamp inbound meta for a FRESH msg id that no row holds and still
// broadcast a `chat:message` frame carrying it — the dashboard showed the same card twice
// until refresh. The live frame must go out on a first sighting only.
//
// Both watchers are driven through their REAL polls (only the provider HTTP is scripted), the
// idiom copied from `gmail-watcher-stamps-addressing.test.ts` and
// `outlook-watcher-stamps-addressing.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
// `vi.mock` factories hoist above the const declarations, so the spies must be hoisted too.
const { broadcastSpy, recordMetaSpy } = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  recordMetaSpy: vi.fn(),
}));
const googleReadMock = vi.fn();
const msGraphMock = vi.fn();
const googleViews = { current: [] as Array<Record<string, unknown>> };
const outlookViews = { current: [] as Array<Record<string, unknown>> };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'mail-reread', 'dojo.db'),
  };
});
// The broadcast seam is what sends the dashboard its live card; the test collects the frames.
vi.mock('../../gateway/ws.js', () => ({ broadcast: broadcastSpy, stampPersistedRow: vi.fn() }));
// The meta stamp runs for real (so a first sighting still lands its meta); the spy counts
// calls so a case can assert the re-read stamps no meta for a msg id that was never stored.
vi.mock('../../agent/v2/inbound-channel.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/v2/inbound-channel.js')>('../../agent/v2/inbound-channel.js');
  return {
    ...actual,
    recordInboundMeta: (...a: Parameters<typeof actual.recordInboundMeta>) => {
      recordMetaSpy(...a);
      actual.recordInboundMeta(...a);
    },
  };
});
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
// The ONLY scripted halves of the mail doors: the provider HTTP answers. The watchers' own
// polls, framing, conversation resolution, inserts and meta stamps all run for real.
vi.mock('../../google/client.js', () => ({ googleRead: (...a: unknown[]) => googleReadMock(...a) }));
vi.mock('../../google/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../google/auth.js')>('../../google/auth.js');
  return { ...actual, listGoogleAccountViews: () => googleViews.current };
});
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: (...a: unknown[]) => msGraphMock(...a) }));
vi.mock('../../microsoft/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../microsoft/auth.js')>('../../microsoft/auth.js');
  return { ...actual, listMicrosoftAccountViews: () => outlookViews.current };
});
// Restated from `gmail-watcher-stamps-addressing.test.ts` — the parse and the matchers the
// watcher chain imports; nothing here reaches a real mailbox.
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
import { startOutlookWatcher, stopOutlookWatcher } from '../../services/outlook-watcher.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  return db;
}

function setGmailMailbox(kind: 'user' | 'agent', email: string): void {
  googleViews.current = [{
    id: kind, kind, position: 1, email, enabled: true, connected: true,
    services: { gmail: true, calendar: false, drive: false, docs: false, sheets: false, contacts: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

function setOutlookMailbox(kind: 'user' | 'agent', email: string): void {
  outlookViews.current = [{
    id: kind, kind, position: 1, email, accountType: null,
    enabled: true, connected: true,
    services: { outlook: true, calendar: false, onedrive: false, teams: false, contacts: false, onenote: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

/** One poll of the REAL Gmail watcher, with Google answering `mail`. A cursor already exists,
 *  so the poll notifies instead of baseline-seeding. The frames are NOT reset between polls —
 *  a case counts what the whole run accumulated. */
interface Mail {
  id: string;
  threadId: string;
  snippet: string;
  headers: Array<{ name: string; value: string }>;
}

async function gmailPoll(mail: Mail[]): Promise<void> {
  googleReadMock.mockImplementation(async (url: string) => {
    if (url.includes('/messages?')) return { ok: true, data: { messages: mail.map((m) => ({ id: m.id, threadId: m.threadId })) } };
    const m = mail.find((x) => url.includes(`/messages/${x.id}`));
    if (!m) return { ok: false, error: 'no such message' };
    return {
      ok: true,
      data: { id: m.id, threadId: m.threadId, snippet: m.snippet, labelIds: ['INBOX'], payload: { headers: m.headers } },
    };
  });
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

/** One poll of the REAL Outlook watcher, with Graph answering `fixture`. */
async function outlookPoll(fixture: Array<Record<string, unknown>>): Promise<void> {
  msGraphMock.mockImplementation(async () => ({ ok: true, data: { value: fixture } }));
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

/** The processed-ids list the watcher would otherwise skip the re-read with — deleted so the
 *  next poll reads the message again (its stored row stays, so the insert returns null). */
function clearNotifiedIds(provider: 'gmail' | 'outlook'): void {
  mockDb.current!.prepare('DELETE FROM config WHERE key = ?').run(`${provider}_notified_ids`);
}

function chatFrames(): Array<Record<string, unknown>> {
  return broadcastSpy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((f) => f.type === 'chat:message');
}

function storedMessageCount(externalId: string): number {
  return (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages WHERE external_message_id = ?').get(externalId) as { n: number }).n;
}

// Fixtures: Bob emails the agent's own mailbox. Gmail needs the metadata headers the poll
// reads; Outlook's list answer already carries from/toRecipients.
const G1: Mail = {
  id: 'g1', threadId: 'th-1', snippet: 'hello',
  headers: [
    { name: 'From', value: 'Bob <bob@y.test>' },
    { name: 'Subject', value: 'Plan' },
    { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' },
    { name: 'To', value: 'Agent <agent@x.com>' },
  ],
};

const O1: Record<string, unknown> = {
  id: 'o1',
  from: { emailAddress: { name: 'Bob', address: 'bob@y.test' } },
  subject: 'Plan',
  bodyPreview: 'hello',
  toRecipients: [{ emailAddress: { name: 'Agent', address: 'Agent@X.com' } }],
};

beforeEach(() => {
  const db = freshDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  broadcastSpy.mockReset();
  recordMetaSpy.mockReset();
  googleReadMock.mockReset();
  msGraphMock.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('801 — a mail re-read sends the dashboard no second live frame', () => {
  it('gmail case 1: a first sighting broadcasts exactly one live frame, for the id the row holds', async () => {
    setGmailMailbox('agent', 'agent@x.com');
    await gmailPoll([G1]);
    const frames = chatFrames();
    expect(frames, 'the first sighting must still produce its live card').toHaveLength(1);
    const frameId = (frames[0].message as { id: string }).id;
    const row = mockDb.current!.prepare('SELECT id FROM messages WHERE external_message_id = ?').get('g1') as { id: string } | undefined;
    expect(row?.id, 'the live frame carries the id the stored row holds').toBe(frameId);
    expect(recordMetaSpy).toHaveBeenCalledTimes(1);
  });

  it('gmail case 2: the same message re-read sends no second frame and stamps no meta', async () => {
    setGmailMailbox('agent', 'agent@x.com');
    await gmailPoll([G1]);
    // The row landed on the first poll but the processed-list save did not — the re-read's
    // insert is the designed no-op (`null`).
    clearNotifiedIds('gmail');
    await gmailPoll([G1]);
    expect(chatFrames(), 'the re-read of an already-stored message must not send the dashboard the same card again').toHaveLength(1);
    expect(recordMetaSpy, 'the re-read must not stamp inbound meta for a msg id no row holds').toHaveBeenCalledTimes(1);
    expect(storedMessageCount('g1'), 'the insert still no-ops — one row per email').toBe(1);
  });

  it('outlook case 1: a first sighting broadcasts exactly one live frame, for the id the row holds', async () => {
    setOutlookMailbox('agent', 'agent@x.com');
    await outlookPoll([O1]);
    const frames = chatFrames();
    expect(frames, 'the first sighting must still produce its live card').toHaveLength(1);
    const frameId = (frames[0].message as { id: string }).id;
    const row = mockDb.current!.prepare('SELECT id FROM messages WHERE external_message_id = ?').get('o1') as { id: string } | undefined;
    expect(row?.id, 'the live frame carries the id the stored row holds').toBe(frameId);
    expect(recordMetaSpy).toHaveBeenCalledTimes(1);
  });

  it('outlook case 2: the same message re-read sends no second frame and stamps no meta', async () => {
    setOutlookMailbox('agent', 'agent@x.com');
    await outlookPoll([O1]);
    clearNotifiedIds('outlook');
    await outlookPoll([O1]);
    expect(chatFrames(), 'the re-read of an already-stored message must not send the dashboard the same card again').toHaveLength(1);
    expect(recordMetaSpy, 'the re-read must not stamp inbound meta for a msg id no row holds').toHaveBeenCalledTimes(1);
    expect(storedMessageCount('o1'), 'the insert still no-ops — one row per email').toBe(1);
  });
});
