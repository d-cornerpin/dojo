// A backlog larger than one page (the Mac was off for a day) is read page by page, so every mail is announced.
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

describe('eighty mails while the Mac was off are all announced', () => {
  it.each(['gmail', 'outlook'] as const)('%s', async (p) => {
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'agent');
    const mail = Array.from({ length: 80 }, (_, i) => ({ id: `m-${i}`, from: 'Pat <pat@example.com>', subject: `Note ${i}`, snippet: 'hi', to: 'agent.box@example.com' }));
    w.inboxHolds(p, mail);
    await w.poll(p);
    expect(w.rows(`SELECT id FROM messages WHERE external_message_id LIKE 'm-%'`)).toHaveLength(80);
    expect(w.wake).toHaveBeenCalledTimes(1);
  });
});
