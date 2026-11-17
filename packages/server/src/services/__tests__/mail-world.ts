// A scratch world for the mail watchers: a migrated in-memory database with real account rows, the provider HTTP
// scripted, and the main agent's wake and the dashboard's live frames recorded. Test files point their mocks here.
import Database from 'better-sqlite3';
import { vi } from 'vitest';

export type Provider = 'gmail' | 'outlook';
/** `at`: when the mailbox received it (ms); by default a minute ago. `headers` and `body` add to a Gmail mail, and an
 *  `unreadable` Gmail mail is listed but its read always fails. */
export interface Mail { id: string; from: string; subject: string; snippet: string; to: string; at?: number; headers?: Array<{ name: string; value: string }>; body?: string; unreadable?: boolean }

export const world = { db: null as Database.Database | null };
export const wake = vi.fn(async (_agentId: string, _text: string) => undefined);
export const frames = vi.fn();
export const googleRead = vi.fn();
export const msGraphRead = vi.fn();

export const dbModule = () => ({
  getDb: () => { if (!world.db) throw new Error('test DB not initialized'); return world.db; },
  closeDb: () => {},
  getDbPath: () => ':memory:',
});
export const wsModule = () => ({ broadcast: frames, stampPersistedRow: () => {} });
export const runtimeModule = () => ({ getAgentRuntime: () => ({ handleMessage: wake }) });
export const googleClientModule = () => ({ googleRead: (...a: unknown[]) => googleRead(...a) });
export const graphClientModule = () => ({ msGraphRead: (...a: unknown[]) => msGraphRead(...a) });

export async function freshWorld(): Promise<void> {
  world.db = new Database(':memory:');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  world.db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  world.db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
                    VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  world.db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
                    VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  for (const f of [wake, frames, googleRead, msGraphRead]) f.mockReset();
}

function setConfig(key: string, value: string): void {
  world.db!.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** A connected mailbox, watched unless `watch` is false. With a `cursorAgoMs`, the watcher has been running that
 *  long, so the next poll announces mail received since. */
export async function addMailbox(p: Provider, kind: 'agent' | 'user', email: string, id: string, cursorAgoMs: number | null = 60_000, watch = true): Promise<void> {
  const row = { id, kind, email, connected: true, watchEmail: watch, sendEmail: false, enabledServices: JSON.stringify({ [p]: true }) };
  if (p === 'gmail') (await import('../../google/accounts.js')).insertGoogleAccount(row);
  else (await import('../../microsoft/accounts.js')).insertMicrosoftAccount(row);
  if (cursorAgoMs !== null) setConfig(id === 'agent' ? `${p}_last_checked_at` : `${p}_last_checked_at_${id}`, new Date(Date.now() - cursorAgoMs).toISOString());
}

/** The list the Settings page saves for one mailbox. */
export function approve(p: Provider, accountId: string, address: string): void {
  setConfig(`${p}_approved_senders_${accountId}`, JSON.stringify([{ address, name: 'Approved Person' }]));
}

const addr = (from: string): string => from.match(/<([^>]+)>/)?.[1] ?? from;

/** The provider's inbox holds `mail` (oldest first), served `pageSize` to a page, newest first for Gmail as Gmail
 *  does; each listing returns only mail received after the time the watcher asks from. */
export function inboxHolds(p: Provider, mail: Mail[], pageSize = 50): void {
  const minuteAgo = Date.now() - 60_000;
  const at = (m: Mail): number => m.at ?? minuteAgo;
  const after = (since: number): Mail[] => mail.filter((m) => at(m) > since);
  const page = (list: Mail[], n: number) => ({ items: list.slice(n * pageSize, (n + 1) * pageSize), more: (n + 1) * pageSize < list.length });
  if (p === 'gmail') {
    googleRead.mockImplementation(async (url: string) => {
      if (url.includes('/messages?')) {
        const since = Number(decodeURIComponent(url).match(/after:(\d+)/)?.[1] ?? 0) * 1000;
        const n = Number(url.match(/pageToken=(\d+)/)?.[1] ?? 0);
        const { items, more } = page([...after(since)].reverse(), n);
        return { ok: true, data: { messages: items.map((m) => ({ id: m.id, threadId: `th-${m.id}` })), ...(more ? { nextPageToken: String(n + 1) } : {}) } };
      }
      const m = mail.find((x) => url.includes(`/messages/${x.id}?`));
      if (!m || m.unreadable) return { ok: false, error: 'no such message' };
      if (url.includes('format=full')) {
        return { ok: true, data: { id: m.id, payload: { mimeType: 'text/plain', body: { data: Buffer.from(m.body ?? '').toString('base64url') } } } };
      }
      const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: 'Mon, 12 Oct 2026 10:00:00 +0000' }, { name: 'To', value: m.to }, ...(m.headers ?? [])];
      return { ok: true, data: { id: m.id, threadId: `th-${m.id}`, snippet: m.snippet, internalDate: String(at(m)), labelIds: ['INBOX'], payload: { headers } } };
    });
  } else {
    msGraphRead.mockImplementation(async (url: string) => {
      const next = url.match(/^https:\/\/graph\.example\.com\/next\?since=(\d+)&page=(\d+)/);
      if (!next && !url.includes('mailFolders/inbox/messages')) return { ok: false, error: 'no such message' };
      const since = next ? Number(next[1]) : Date.parse(decodeURIComponent(url).match(/receivedDateTime gt (\S+?)&/)?.[1] ?? '1970-01-01T00:00:00Z');
      const n = next ? Number(next[2]) : 0;
      const { items, more } = page(after(since), n);
      const value = items.map((m) => ({
        id: m.id, subject: m.subject, bodyPreview: m.snippet, conversationId: `cv-${m.id}`, receivedDateTime: new Date(at(m)).toISOString(),
        from: { emailAddress: { name: 'Sender', address: addr(m.from) } }, toRecipients: [{ emailAddress: { address: addr(m.to) } }],
      }));
      return { ok: true, data: { value, ...(more ? { '@odata.nextLink': `https://graph.example.com/next?since=${since}&page=${n + 1}` } : {}) } };
    });
  }
}

export async function watcher(p: Provider): Promise<{ start: () => void; stop: () => void }> {
  if (p === 'gmail') {
    const m = await import('../gmail-watcher.js');
    return { start: m.startGmailWatcher, stop: m.stopGmailWatcher };
  }
  const m = await import('../outlook-watcher.js');
  return { start: m.startOutlookWatcher, stop: m.stopOutlookWatcher };
}

/** `count` polls of the real watcher, on fake timers: its first, ten seconds after start, then one each five minutes.
 *  `between` runs after each poll. */
export async function poll(p: Provider, count = 1, between: () => void = () => {}): Promise<void> {
  const w = await watcher(p);
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
  try {
    w.start();
    await vi.advanceTimersByTimeAsync(10_001);
    between();
    for (let i = 1; i < count; i++) {
      await vi.advanceTimersByTimeAsync(300_000);
      between();
    }
  } finally {
    w.stop();
    vi.useRealTimers();
  }
}

export function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return world.db!.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}
