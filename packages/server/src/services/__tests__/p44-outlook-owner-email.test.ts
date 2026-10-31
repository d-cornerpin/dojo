// ════════════════════════════════════════════════════════════════════════════════════════
// P44 (lane t280) — THE OUTLOOK WATCHER: WHO THE OWNER IS, FROM AN EMAIL.
//
// The same requirements as the Gmail file (`p44-gmail-owner-email.test.ts`), for Exchange:
//  R1  The owner's email counts only when Exchange's own Authentication-Results (read from the
//      message's internet headers, never the body) shows dmarc=pass aligned with the From domain
//      AND the single From address is exactly one of the owner's connected user-account addresses.
//  R2  A failure, no header, an unaligned pass, a look-alike address, a failed header read, a
//      disconnected or agent-kind account: not the owner; the notice says it was not confirmed.
//  R3  Only the owner's NEW words count (uniqueBody; quoted thread cut).
//  R4  The owner's own inbox is untouched. A non-owner sender costs no extra Graph read.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
const msGraphMock = vi.fn();
const outlookViews = { current: [] as Array<Record<string, unknown>> };
let pollEndpoints: string[] = [];
const details = new Map<string, unknown>();

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
import { runMigrations } from '../../db/migrations.js';
import { startOutlookWatcher, stopOutlookWatcher } from '../../services/outlook-watcher.js';
import { fenceRanges } from '../../tools/external-content.js';

// ── the world ────────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  return db;
}
function setMailbox(kind: 'user' | 'agent', email: string): void {
  outlookViews.current = [{
    id: kind, kind, position: 1, email, accountType: null, enabled: true, connected: true,
    services: { outlook: true, calendar: false, onedrive: false, teams: false, contacts: false, onenote: false, tasks: false },
    watchEmail: true, sendEmail: false, lastVerified: null,
  }];
}
function ownerAccount(email: string, connected = 1, kind = 'user'): void {
  mockDb.current!.prepare('INSERT INTO microsoft_accounts (id, kind, position, email, connected) VALUES (?, ?, 5, ?, ?)').run(`owner-${email}`, kind, email, connected);
}
function safeSender(address: string): void {
  mockDb.current!.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('outlook_approved_senders_agent', ?, datetime('now'))`)
    .run(JSON.stringify([{ address, name: 'Friend' }]));
}

async function outlookPoll(fixture: Array<Record<string, unknown>>): Promise<void> {
  pollEndpoints = [];
  msGraphMock.mockImplementation(async (endpoint: string) => {
    pollEndpoints.push(endpoint);
    if (endpoint.includes('internetMessageHeaders')) {
      const id = decodeURIComponent(endpoint.split('/messages/')[1].split('?')[0]);
      return details.has(id) ? { ok: true, data: details.get(id) } : { ok: false, error: 'headers unavailable' };
    }
    return { ok: true, data: { value: fixture } };
  });
  const id = (outlookViews.current[0] as { id?: string }).id ?? 'agent';
  mockDb.current!.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(id === 'agent' ? 'outlook_last_checked_at' : `outlook_last_checked_at_${id}`, new Date(Date.now() - 60_000).toISOString());
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

const MS = 'BN1PR01CA0001.namprd01.prod.outlook.com';
const PASS = (domain: string): string => `${MS}; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass action=none header.from=${domain}`;
/** One poll row from `address`, and what the single detail read returns for it. */
function arrives(id: string, address: string, auth: string[] | null | 'unavailable', html = '<div>Yes, close it.</div>'): Array<Record<string, unknown>> {
  if (auth !== 'unavailable') {
    details.set(id, {
      internetMessageHeaders: [{ name: 'Received', value: 'from x' }, { name: 'From', value: address }, ...(auth ?? []).map((value) => ({ name: 'Authentication-Results', value }))],
      uniqueBody: { contentType: 'html', content: html },
    });
  }
  return [{
    id, from: { emailAddress: { name: 'The Owner', address } }, subject: 'Re: verdict', bodyPreview: 'Yes, close it. On Mon, Agent wrote: I will close the task now.',
    toRecipients: [{ emailAddress: { name: 'Agent', address: 'agent@x.com' } }], ccRecipients: [{ emailAddress: { address: 'carol@z.test' } }],
  }];
}

beforeEach(() => {
  const db = freshDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  pollEndpoints = [];
  details.clear();
  msGraphMock.mockReset();
  setMailbox('agent', 'agent@x.com');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const NOT_OWNER = (id: string): void => {
  const { meta, content } = readStored(id);
  expect(meta.relation, 'no owner stamp').toBeUndefined();
  expect(meta.ownerWords, 'no owner words').toBeUndefined();
  expect(meta.authorized).toBe(false);
  expect(content).not.toContain('[OWNER EMAIL]');
};

describe('P44 Outlook — a known contact\'s email in the agent\'s own mailbox', () => {
  it('shows To/Cc, says "possibly", and costs no extra Graph read', async () => {
    safeSender('friend@y.test');
    await outlookPoll(arrives('s1', 'friend@y.test', [PASS('y.test')]));
    const { meta, content } = readStored('s1');
    expect(meta.authorized).toBe(true);
    expect(meta.relation).toBeUndefined();
    const inside = fenceRanges(content).map((r) => content.slice(r.bodyStart, r.bodyEnd)).join('\n');
    expect(inside).toContain('To: Agent <agent@x.com>');
    expect(inside).toContain('Cc: carol@z.test');
    expect(content).toMatch(/possibly/);
    expect(content).toMatch(/outlook_reply[^.]*reply_all/);
    expect(content).not.toMatch(/addressed to YOU/);
    expect(pollEndpoints.some((e) => e.includes('internetMessageHeaders'))).toBe(false);
  });
});

describe('P44 Outlook R1 — the owner\'s confirmed email is the owner speaking', () => {
  it('dmarc=pass aligned from a connected owner address: stamped owner, authorized, new words only, unfenced', async () => {
    ownerAccount('owner@home.test');
    await outlookPoll(arrives('o1', 'Owner@Home.test', [PASS('home.test')]));
    const { meta, content } = readStored('o1');
    expect(meta.relation).toBe('owner');
    expect(meta.authorized).toBe(true);
    expect(meta.ownerWords).toBe('Yes, close it.');
    expect(content).toContain('[OWNER EMAIL]');
    expect(fenceRanges(content)).toEqual([]);
    expect(content, 'the quoted older text in the preview is not in the owner\'s words').not.toContain('I will close the task now');
  });

  it('R3: the owner\'s words are cut at the quoted thread even when Exchange left it in the unique body', async () => {
    ownerAccount('owner@home.test');
    await outlookPoll(arrives('o2', 'owner@home.test', [PASS('home.test')], '<div>Yes, close it.</div><div>On Mon, 12 Oct 2026, Agent wrote:</div><div>&gt; I will close the task now.</div>'));
    expect(readStored('o2').meta.ownerWords).toBe('Yes, close it.');
  });
});

describe('P44 Outlook R2 — nothing but the confirmed owner address is the owner', () => {
  const cases: Array<[string, string, string[] | null | 'unavailable', () => void]> = [
    ['dmarc=fail', 'owner@home.test', [`${MS}; spf=pass; dmarc=fail action=none header.from=home.test`], () => ownerAccount('owner@home.test')],
    ['no Authentication-Results header', 'owner@home.test', null, () => ownerAccount('owner@home.test')],
    ['a pass not aligned with the From domain', 'owner@home.test', [PASS('elsewhere.test')], () => ownerAccount('owner@home.test')],
    ['a look-alike address', 'own-er@home.test', [PASS('home.test')], () => ownerAccount('owner@home.test')],
    ['a forged pass BELOW Exchange\'s real failure', 'owner@home.test', [`${MS}; dmarc=fail header.from=home.test`, `${MS}; dmarc=pass header.from=home.test`], () => ownerAccount('owner@home.test')],
    ['a pass planted inside a comment ahead of the real failure', 'owner@home.test', [`${MS}; spf=pass (;dmarc=pass header.from=home.test); dmarc=fail header.from=home.test`], () => ownerAccount('owner@home.test')],
    ['a pass with no Exchange authserv-id', 'owner@home.test', ['dmarc=pass action=none header.from=home.test'], () => ownerAccount('owner@home.test')],
    ['the headers could not be read', 'owner@home.test', 'unavailable', () => ownerAccount('owner@home.test')],
    ['a disconnected owner account', 'owner@home.test', [PASS('home.test')], () => ownerAccount('owner@home.test', 0)],
    ['an agent-kind account\'s address', 'second@home.test', [PASS('home.test')], () => ownerAccount('second@home.test', 1, 'agent')],
    ['no owner address saved', 'owner@home.test', [PASS('home.test')], () => undefined],
  ];
  for (const [name, from, auth, setup] of cases) {
    it(`${name}: not the owner`, async () => {
      setup();
      await outlookPoll(arrives('f1', from, auth));
      NOT_OWNER('f1');
    });
  }

  it('an unconfirmed owner address says so, and a stranger costs no extra read', async () => {
    ownerAccount('owner@home.test');
    await outlookPoll(arrives('f2', 'owner@home.test', [`${MS}; dmarc=fail header.from=home.test`]));
    expect(readStored('f2').content).toMatch(/could not confirm/);
    pollEndpoints = [];
    await outlookPoll(arrives('f3', 'stranger@y.test', [PASS('y.test')]));
    expect(pollEndpoints.some((e) => e.includes('internetMessageHeaders'))).toBe(false);
    NOT_OWNER('f3');
  });
});

describe('P44 Outlook I2 — the raw From header is checked, not only Graph\'s parsed field', () => {
  it('Graph says the owner but the raw headers carry a second From: not the owner', async () => {
    ownerAccount('owner@home.test');
    const rows = arrives('t1', 'owner@home.test', [PASS('home.test')]);
    (details.get('t1') as { internetMessageHeaders: Array<{ name: string; value: string }> }).internetMessageHeaders.push({ name: 'from', value: 'someone@else.test' });
    await outlookPoll(rows);
    NOT_OWNER('t1');
  });
  it('the raw From names a different address than Graph\'s parsed field: not the owner', async () => {
    ownerAccount('owner@home.test');
    const rows = arrives('t2', 'owner@home.test', [PASS('home.test')]);
    (details.get('t2') as { internetMessageHeaders: Array<{ name: string; value: string }> }).internetMessageHeaders.find((x) => x.name === 'From')!.value = 'someone@else.test';
    await outlookPoll(rows);
    NOT_OWNER('t2');
  });
});

describe('P44 Outlook R4 — the owner\'s own inbox is untouched', () => {
  it('a user-slot mailbox never stamps the owner and never reads headers', async () => {
    setMailbox('user', 'inbox@home.test');
    ownerAccount('owner@home.test');
    await outlookPoll(arrives('u1', 'owner@home.test', [PASS('home.test')]));
    const { meta, content } = readStored('u1');
    expect(meta.relation).toBeUndefined();
    expect(meta.ownerWords).toBeUndefined();
    expect(content).toContain('[MAILBOX EVENT]');
    expect(pollEndpoints.some((e) => e.includes('internetMessageHeaders'))).toBe(false);
  });
});
