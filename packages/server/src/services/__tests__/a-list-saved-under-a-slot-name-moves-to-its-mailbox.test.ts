// An approved list saved under a slot name moves, at start, to that slot's first mailbox when its id is random;
// a mailbox whose id is the slot name already owns that key and is left as it is.
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
import { moveSlotListsToMailboxes } from '../channel-safe-senders.js';

beforeEach(() => w.freshWorld());

describe('a list saved under a slot name moves to its mailbox', () => {
  it('a random-id owner inbox: the senders wake after start and the old key is gone', async () => {
    await w.addMailbox('gmail', 'user', 'owner.inbox@example.com', 'acct-5e2b');
    w.approve('gmail', 'user', 'friend@example.com');
    moveSlotListsToMailboxes();
    expect(w.rows(`SELECT key FROM config WHERE key = 'gmail_approved_senders_user'`)).toEqual([]);
    w.inboxHolds('gmail', [{ id: 'f-1', from: 'Friend <friend@example.com>', subject: 'Hi', snippet: 'hi', to: 'owner.inbox@example.com' }]);
    await w.poll('gmail');
    expect(w.wake).toHaveBeenCalledTimes(1);
  });

  it('a mailbox whose id is the slot name is untouched', async () => {
    await w.addMailbox('outlook', 'user', 'owner.inbox@example.com', 'user');
    w.approve('outlook', 'user', 'friend@example.com');
    moveSlotListsToMailboxes();
    expect(w.rows(`SELECT key FROM config WHERE key LIKE 'outlook_approved_senders_%'`)).toEqual([{ key: 'outlook_approved_senders_user' }]);
  });
});
