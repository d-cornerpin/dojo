// ════════════════════════════════════════════════════════════════════════════════════════
// t193 — OUTLOOK EMAIL THREADS GROUP BY CONVERSATION
//
// The Gmail watcher asks Graph for `threadId` and keys each inbound email's conversation off
// it, so replies on one thread land in one conversation. The Outlook watcher must do the same
// with `conversationId`. The defect: the poll's `$select` omits `conversationId` (outlook-
// watcher.ts), so Graph never returns it and the `?? msg.id` fallback always wins — every
// Outlook email resolves to its own conversation and replies on one thread are never grouped.
//
// The only scripted half is Microsoft's HTTP answer. The watcher's own poll, framing,
// conversation resolution and insert all run for real against the in-memory DB, and the
// scripted answer BEHAVES like Graph: it returns only the fields the request's `$select`
// names, so `conversationId` appears exactly when the watcher asks for it.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const msGraphReadMock = vi.fn();
const msViews = { current: [] as Array<Record<string, unknown>> };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 't193-outlook', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => undefined }),
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getOwnerName: () => 'Test Owner',
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// The ONLY scripted half of the mail door: Microsoft's HTTP answers.
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: (...a: unknown[]) => msGraphReadMock(...a) }));
vi.mock('../../microsoft/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../microsoft/auth.js')>('../../microsoft/auth.js');
  return { ...actual, listMicrosoftAccountViews: () => msViews.current };
});

import { runMigrations } from '../../db/migrations.js';
import { startOutlookWatcher, stopOutlookWatcher } from '../../services/outlook-watcher.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  return db;
}

/** One scripted Outlook inbox message. `conversationId` is optional — a message that truly
 *  has no conversation is scripted without it, exactly the case Graph can answer. */
interface Mail {
  id: string;
  conversationId?: string | null;
  from: { emailAddress: { name: string; address: string } };
  subject: string;
  receivedDateTime: string;
  bodyPreview: string;
}

function setMailbox(kind: 'agent' | 'user', email: string): void {
  msViews.current = [{
    id: kind, kind, position: 1, email, accountType: 'msa', enabled: true, connected: true,
    services: { outlook: true, calendar: false, onedrive: false, teams: false, contacts: false, onenote: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}

/** The `$select` the watcher asked Graph for — captured from the poll URL. */
let lastSelect: string | null = null;

/** Answer like Graph does: return only the fields the request's `$select` names, and return
 *  a message's `conversationId` only when it was asked for AND the message actually has one. */
function installGraphAnswer(mail: Mail[]): void {
  lastSelect = null;
  msGraphReadMock.mockImplementation(async (endpoint: string) => {
    const selectParam = endpoint.split('&').find(p => p.startsWith('$select=')) ?? '';
    lastSelect = selectParam.slice('$select='.length);
    const selected = new Set(lastSelect.split(','));
    const value = mail.map(m => {
      const out: Record<string, unknown> = { id: m.id };
      if (selected.has('from')) out.from = m.from;
      if (selected.has('subject')) out.subject = m.subject;
      if (selected.has('receivedDateTime')) out.receivedDateTime = m.receivedDateTime;
      if (selected.has('bodyPreview')) out.bodyPreview = m.bodyPreview;
      if (selected.has('conversationId') && m.conversationId) out.conversationId = m.conversationId;
      return out;
    });
    return { ok: true, data: { value }, apiEndpoint: endpoint };
  });
}

/** One poll of the REAL watcher, with Microsoft answering `mail`. A cursor already exists
 *  (the watcher has been running), so this poll notifies. */
async function poll(mail: Mail[]): Promise<void> {
  installGraphAnswer(mail);
  const key = msViews.current[0].id === 'agent' ? 'outlook_last_checked_at' : `outlook_last_checked_at_${msViews.current[0].id}`;
  mockDb.current!.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, new Date(Date.now() - 60_000).toISOString());
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  try {
    startOutlookWatcher();
    await vi.advanceTimersByTimeAsync(10_001);
  } finally {
    stopOutlookWatcher();
    vi.useRealTimers();
  }
}

/** The conversation_id the row for external_message_id `id` landed in. */
function conversationIdOf(id: string): string | null {
  const row = mockDb.current!.prepare(
    'SELECT conversation_id FROM messages WHERE external_message_id = ?',
  ).get(id) as { conversation_id: string | null } | undefined;
  return row?.conversation_id ?? null;
}

function rowCountFor(id: string): number {
  const row = mockDb.current!.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE external_message_id = ?',
  ).get(id) as { n: number };
  return row.n;
}

beforeEach(() => {
  const db = freshDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  msGraphReadMock.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

// ── the cases ─────────────────────────────────────────────────────────────────────────────

const BOB = { name: 'Bob', address: 'bob@y.org' };
const MAIL = (id: string, conversationId: string | null, subject: string): Mail => ({
  id, conversationId,
  from: { emailAddress: BOB },
  subject,
  receivedDateTime: new Date(Date.now() - 60_000).toISOString(),
  bodyPreview: `body of ${id}`,
});

describe('outlook watcher threads by conversation', () => {
  it('asks Graph for conversationId in the $select', async () => {
    setMailbox('agent', 'agent@x.com');
    await poll([MAIL('o1', 'convA', 'thread A')]);
    expect(lastSelect).toContain('conversationId');
  });

  it('groups replies on one thread into one conversation and splits threads apart', async () => {
    setMailbox('agent', 'agent@x.com');
    await poll([
      MAIL('o1', 'convA', 'thread A first'),
      MAIL('o2', 'convA', 'thread A reply'),
      MAIL('o3', 'convB', 'thread B'),
    ]);
    const o1 = conversationIdOf('o1');
    const o2 = conversationIdOf('o2');
    const o3 = conversationIdOf('o3');
    expect(o1).not.toBeNull();
    expect(o2).toBe(o1);
    expect(o3).not.toBe(o1);
  });

  it('a message with no conversationId still arrives with its own conversation', async () => {
    setMailbox('agent', 'agent@x.com');
    await poll([MAIL('solo', null, 'no thread')]);
    expect(rowCountFor('solo')).toBe(1);
    expect(conversationIdOf('solo')).not.toBeNull();
  });
});
