// The Teams watcher keeps its places in one saved row, so a message sent while the Dojo restarts is read after it.
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
beforeEach(async () => { await w.freshWorld(); serveTeams(); vi.useFakeTimers(); });
afterEach(() => { stopTeamsWatcher(); vi.useRealTimers(); });
const stored = (id: string) => (w.world.db!.prepare('SELECT COUNT(*) AS n FROM messages WHERE external_message_id = ?').get(id) as { n: number }).n;

describe('a Teams message sent during a restart', () => {
  it('is read after it', async () => {
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000); // a first poll, no messages
    stopTeamsWatcher();
    await vi.advanceTimersByTimeAsync(60_000);
    chat.messages = [{ id: 'tm-r', email: 'colleague@example.com', text: 'Are you there?', at: new Date().toISOString() }];
    await vi.advanceTimersByTimeAsync(5_000);
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000);
    stopTeamsWatcher();
    expect(stored('tm-r')).toBe(1);
  });
});
