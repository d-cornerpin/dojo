// A mail already stored (its processed-list save was lost, so the next poll reads it again) wakes no second turn.
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

describe('a repeat poll does not wake the agent for a stored mail', () => {
  it.each(['gmail', 'outlook'] as const)('%s', async (p) => {
    await w.addMailbox(p, 'agent', 'agent.box@example.com', 'agent');
    w.inboxHolds(p, [{ id: 'r-1', from: 'Pat <pat@example.com>', subject: 'Plan', snippet: 'hello', to: 'agent.box@example.com' }]);
    await w.poll(p);
    w.rows(`DELETE FROM config WHERE key = ? RETURNING key`, `${p}_notified_ids`);
    await w.poll(p);
    expect(w.rows('SELECT id FROM messages WHERE external_message_id = ?', 'r-1')).toHaveLength(1);
    expect(w.wake).toHaveBeenCalledTimes(1);
  });
});
