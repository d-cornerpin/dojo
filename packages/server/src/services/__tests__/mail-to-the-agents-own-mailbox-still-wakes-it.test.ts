// Mail to the agent's own mailbox wakes it whoever wrote, approved or not (the agent's mailbox is its own channel).
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

describe("mail to the agent's own mailbox still wakes it", () => {
  it.each(['gmail', 'outlook'] as const)('%s', async (p) => {
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'acct-agent');
    w.inboxHolds(p, [{ id: 'a-1', from: 'Someone <someone@example.com>', subject: 'Question', snippet: 'Are you there?', to: 'agent.box@example.com' }]);
    await w.poll(p);
    expect(w.rows('SELECT lane FROM messages WHERE external_message_id = ?', 'a-1')).toEqual([{ lane: 'owner' }]);
    expect(w.wake).toHaveBeenCalledTimes(1);
  });
});
