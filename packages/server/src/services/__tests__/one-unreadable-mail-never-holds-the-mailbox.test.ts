// A mail that can never be read stops a poll and shows as a failure, and after three polls in a row it is passed,
// so the mail behind it still arrives.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from './mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('./mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('./mail-world.js')).runtimeModule());
vi.mock('../../google/client.js', async () => (await import('./mail-world.js')).googleClientModule());
vi.mock('../../microsoft/client.js', async () => (await import('./mail-world.js')).graphClientModule());

// Loaded at file level, so no case pays for the load.
import '../../db/migrations.js';
import '../gmail-watcher.js';
import '../outlook-watcher.js';
import { getGmailWatcherStatus } from '../gmail-watcher.js';

beforeEach(() => w.freshWorld());

describe('one unreadable mail never holds the mailbox', () => {
  it('gmail: 10 mails, the fourth always "not found": after 3 polls the other 9 are stored once each', async () => {
    await w.addMailbox('gmail', 'agent', 'agent.box@example.com', 'agent', 3600_000);
    const base = Date.now() - 30 * 60_000;
    w.inboxHolds('gmail', Array.from({ length: 10 }, (_, i) => ({ id: `u-${i}`, from: 'Pat <pat@example.com>', subject: `Note ${i}`, snippet: 'hi', to: 'agent.box@example.com', at: base + i * 60_000, unreadable: i === 3 })));
    const health: Array<boolean | null> = [];
    await w.poll('gmail', 3, () => health.push(getGmailWatcherStatus().lastPollOk));
    expect(health.slice(0, 2)).toEqual([false, false]);
    const stored = w.rows(`SELECT external_message_id AS id, COUNT(*) AS n FROM messages WHERE external_message_id LIKE 'u-%' GROUP BY 1 ORDER BY 1`);
    expect(stored.map((r) => r.id)).toEqual(['u-0', 'u-1', 'u-2', 'u-4', 'u-5', 'u-6', 'u-7', 'u-8', 'u-9']);
    expect(stored.every((r) => r.n === 1)).toBe(true);
    expect(String(w.rows(`SELECT value FROM config WHERE key = 'gmail_notified_ids'`)[0].value)).toContain('"u-3"');
  });
});
