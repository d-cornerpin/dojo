// A mailbox connected after the Dojo started is polled on the running timer: its first poll sets the baseline,
// and mail that arrives after it is announced. Both providers.
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

describe('a mailbox connected after boot is watched', () => {
  it.each(['gmail', 'outlook'] as const)('%s: mail after the connect is announced without a restart', async (p) => {
    const watcher = await w.watcher(p);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'] });
    try {
      watcher.start();
      await vi.advanceTimersByTimeAsync(10_001);
      await w.addMailbox(p, 'agent', 'agent.box@example.com', 'acct-late', null);
      await vi.advanceTimersByTimeAsync(300_000);
      w.inboxHolds(p, [{ id: 'late-1', from: 'Pat <pat@example.com>', subject: 'Hello', snippet: 'hi', to: 'agent.box@example.com' }]);
      await vi.advanceTimersByTimeAsync(300_000);
    } finally {
      watcher.stop();
      vi.useRealTimers();
    }
    expect(w.rows('SELECT id FROM messages WHERE external_message_id = ?', 'late-1')).toHaveLength(1);
    expect(w.wake).toHaveBeenCalledTimes(1);
  });
});
