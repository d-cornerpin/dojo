// The Teams watcher reads a chat's messages only when that chat's newest message is newer than what it handled.
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
const messageReads = () => w.msGraphRead.mock.calls.filter(([url]) => String(url).startsWith('chats/chat-1/messages')).length;

describe('a quiet Teams chat', () => {
  it('is not read again until something new arrives', async () => {
    chat.messages = [{ id: 'tm-q', email: 'colleague@example.com', text: 'Hello', at: soon() }];
    startTeamsWatcher();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(messageReads()).toBe(1);
    expect(stored('tm-q')).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(messageReads()).toBe(1);
    chat.messages.push({ id: 'tm-q2', email: 'colleague@example.com', text: 'One more thing', at: new Date(Date.now() + 1000).toISOString() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(messageReads()).toBe(2);
    expect(stored('tm-q2')).toBe(1);
    stopTeamsWatcher();
  });
});
