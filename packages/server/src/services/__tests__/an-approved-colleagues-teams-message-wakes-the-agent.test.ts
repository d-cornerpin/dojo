// A Teams message from a colleague on the approved list wakes the main agent with the neutral notice line, and in a
// group chat (where the engine does not answer by itself) the stored row tells the agent how to reply.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as w from './mail-world.js';
import { chat, serveTeams } from './teams-world.js';
vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());
vi.mock('../../gateway/ws.js', async () => (await import('./mail-world.js')).wsModule());
vi.mock('../../agent/runtime.js', async () => (await import('./mail-world.js')).runtimeModule());
vi.mock('../../microsoft/client.js', async () => (await import('./mail-world.js')).graphClientModule());
vi.mock('../../microsoft/accounts.js', async (orig) => ({ ...(await orig<typeof import('../../microsoft/accounts.js')>()), getPrimaryMicrosoftAccount: () => ({ id: 'acct-1' }) }));
vi.mock('../../microsoft/auth.js', async (orig) => ({ ...(await orig<typeof import('../../microsoft/auth.js')>()), isMicrosoftEnabled: () => true, isMicrosoftConnected: () => true, getEnabledMsServices: () => ({ teams: true }) }));
import '../../db/migrations.js';
import { startTeamsWatcher, stopTeamsWatcher } from '../teams-watcher.js';
const setConfig = (key: string, value: string) => w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
const soon = () => new Date(Date.now() + 1000).toISOString();
async function onePoll(): Promise<void> { startTeamsWatcher(); await vi.advanceTimersByTimeAsync(16_000); stopTeamsWatcher(); }
beforeEach(async () => { await w.freshWorld(); serveTeams(); vi.useFakeTimers(); });
afterEach(() => { stopTeamsWatcher(); vi.useRealTimers(); });

describe("an approved colleague's Teams message", () => {
  beforeEach(() => {
    setConfig('teams_approved_senders', JSON.stringify([{ address: 'colleague@example.com', name: 'Colleague' }]));
  });

  it('wakes the agent once with a neutral line', async () => {
    chat.messages = [{ id: 'tm-1', email: 'colleague@example.com', text: 'Can you send the plan?', at: soon() }];
    await onePoll();
    expect(w.wake).toHaveBeenCalledTimes(1);
    expect(w.wake.mock.calls[0][0]).toBe('primary');
    expect(w.wake.mock.calls[0][1]).toContain('[SOURCE: TEAMS MESSAGE]');
    expect(w.wake.mock.calls[0][1]).not.toContain('teams_send_message');
  });

  it('in a group chat it is told how to reply', async () => {
    chat.type = 'group';
    chat.messages = [{ id: 'tm-2', email: 'colleague@example.com', text: 'Can you send the plan?', at: soon() }];
    await onePoll();
    expect(w.wake).toHaveBeenCalledTimes(1);
    const row = w.world.db!.prepare('SELECT content FROM messages WHERE external_message_id = ?').get('tm-2') as { content: string };
    expect(row.content).toContain('To reply in this group chat, call teams_send_message');
  });
});
