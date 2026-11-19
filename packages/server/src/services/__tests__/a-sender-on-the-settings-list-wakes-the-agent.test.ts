// The approved list the Settings page saves for a mailbox (keyed by its account id) is the one the engine reads:
// on the agent's mailbox the sender is a known contact, and on the owner's inbox the mail wakes the agent.
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

const FRIEND = { id: 'f-1', from: 'Friend <friend@example.com>', subject: 'Lunch', snippet: 'Lunch on Friday?', to: 'box@example.com' };

describe('a sender on the Settings list wakes the agent', () => {
  it.each(['gmail', 'outlook'] as const)('%s: the agent mailbox treats the sender as a known contact', async (p) => {
    await w.addMailbox(p, 'agent', 'box@example.com', 'acct-7f3a');
    w.approve(p, 'acct-7f3a', 'friend@example.com');
    w.inboxHolds(p, [FRIEND]);
    await w.poll(p);
    const [row] = w.rows('SELECT authorized, content FROM messages WHERE external_message_id = ?', 'f-1');
    expect(row.authorized).toBe(1);
    expect(row.content).toContain('[EMAIL FROM A KNOWN CONTACT]');
    expect(w.wake).toHaveBeenCalledTimes(1);
  });

  it.each(['gmail', 'outlook'] as const)('%s: the owner inbox wakes the agent for an approved sender', async (p) => {
    await w.addMailbox(p, 'user', 'box@example.com', 'acct-9c1d');
    w.approve(p, 'acct-9c1d', 'friend@example.com');
    w.inboxHolds(p, [FRIEND]);
    await w.poll(p);
    expect(w.rows('SELECT lane FROM messages WHERE external_message_id = ?', 'f-1')).toEqual([{ lane: 'owner' }]);
    expect(w.wake).toHaveBeenCalledTimes(1);
  });
});
