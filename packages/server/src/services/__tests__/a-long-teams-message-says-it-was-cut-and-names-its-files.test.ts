// A Teams message longer than the watcher's limit says it was cut, and its attached files are named, so the agent
// knows what it has not seen.
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

describe('a long Teams message with a file', () => {
  it('says it was cut and names its files', async () => {
    chat.messages = [{ id: 'tm-long', email: 'colleague@example.com', text: 'x'.repeat(5000), at: soon(), files: ['plan.pdf'] }];
    await onePoll();
    const { content } = w.world.db!.prepare('SELECT content FROM messages WHERE external_message_id = ?').get('tm-long') as { content: string };
    expect(content).toContain('[The message is longer than 4,000 characters and was cut here.]');
    expect(content).toContain('[Attached files: plan.pdf]');
    expect(content).toContain('x'.repeat(4000));
  });
});
