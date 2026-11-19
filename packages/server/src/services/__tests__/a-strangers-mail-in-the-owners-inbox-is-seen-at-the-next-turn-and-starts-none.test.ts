// Mail in the owner's inbox from someone neither he nor his approved list names starts no paid turn: it is stored
// as an unauthorized row (shown in the EVENTS lane at the agent's next turn), which owes no reply and drives no turn.
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

import { getPendingEngineEvent, getWaitingHumanConversations } from '../../agent/v2/counterparty.js';
import { assembleContext } from '../../memory/assembler.js';

beforeEach(() => w.freshWorld());

describe("a stranger's mail in the owner's inbox is seen at the next turn and starts none", () => {
  it.each(['gmail', 'outlook'] as const)('%s', async (p) => {
    await w.addMailbox(p, 'user', 'owner.inbox@example.com', 'acct-owner');
    w.inboxHolds(p, [{ id: 's-1', from: 'Promo <promo@example.com>', subject: 'Sale', snippet: 'Big sale', to: 'owner.inbox@example.com' }]);
    await w.poll(p);
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.rows('SELECT lane, authorized FROM messages WHERE external_message_id = ?', 's-1')).toEqual([{ lane: 'owner', authorized: 0 }]);
    expect(getWaitingHumanConversations('primary')).toEqual([]);
    expect(getPendingEngineEvent('primary')).toBeNull();
    // The next turn's assembled context, through the real assembler, carries the notice.
    expect(JSON.stringify((await assembleContext('primary', 'm')).messages)).toContain('promo@example.com');
  });
});
