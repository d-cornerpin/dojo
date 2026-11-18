// A Teams message from a stranger is stored and shown, but it starts no paid turn: like a stranger's mail in the
// owner's inbox, the agent reads it at its next turn through the EVENTS lane.
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
import { assembleContext } from '../../memory/assembler.js';
const setConfig = (key: string, value: string) => w.world.db!.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
const soon = () => new Date(Date.now() + 1000).toISOString();
async function onePoll(): Promise<void> { startTeamsWatcher(); await vi.advanceTimersByTimeAsync(16_000); stopTeamsWatcher(); }
beforeEach(async () => { await w.freshWorld(); serveTeams(); vi.useFakeTimers(); });
afterEach(() => { stopTeamsWatcher(); vi.useRealTimers(); });

describe("a stranger's Teams message", () => {
  it('starts no turn and is seen at the next one', async () => {
    chat.messages = [{ id: 'tm-9', email: 'stranger@example.com', text: 'Buy now', at: soon() }];
    await onePoll();
    expect(w.wake).not.toHaveBeenCalled();
    const row = w.world.db!.prepare('SELECT authorized, content FROM messages WHERE external_message_id = ?').get('tm-9') as { authorized: number; content: string };
    expect(row.authorized).toBe(0);
    expect(row.content).not.toContain('To reply');
    // The next turn's assembled context, through the real assembler, carries the notice.
    vi.useRealTimers();
    expect(JSON.stringify((await assembleContext('primary', 'm')).messages)).toContain('stranger@example.com');
  });
});
