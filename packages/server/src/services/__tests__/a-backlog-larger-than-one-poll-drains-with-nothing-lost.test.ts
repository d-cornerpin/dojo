// A backlog larger than one poll's bound drains over several polls, oldest first: every mail is stored, once.
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

beforeEach(() => w.freshWorld());

describe('a backlog larger than one poll drains with nothing lost', () => {
  it.each(['gmail', 'outlook'] as const)('%s: 600 waiting mails are all stored after two polls, each once', async (p) => {
    const base = Date.now() - 11 * 3600_000;
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'agent', 11 * 3600_000 + 60_000);
    w.inboxHolds(p, Array.from({ length: 600 }, (_, i) => ({ id: `b-${i}`, from: 'Pat <pat@example.com>', subject: `Note ${i}`, snippet: 'hi', to: 'agent.box@example.com', at: base + i * 60_000 })));
    await w.poll(p);
    expect(w.rows(`SELECT id FROM messages WHERE external_message_id LIKE 'b-%'`)).toHaveLength(500);
    await w.poll(p);
    const stored = w.rows(`SELECT external_message_id AS id, COUNT(*) AS n FROM messages WHERE external_message_id LIKE 'b-%' GROUP BY 1`);
    expect(stored).toHaveLength(600);
    expect(stored.every((r) => r.n === 1)).toBe(true);
  });
});
