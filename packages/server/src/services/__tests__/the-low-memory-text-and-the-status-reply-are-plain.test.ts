// The owner's low-memory text says what is wrong and what he can do in plain words, and his "status"
// reply carries no Heap line. Real migrated database; only the transport and the notice door are mocked.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
const noticeMock = vi.hoisted(() => vi.fn());
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: noticeMock }));

const tellOwnerMock = vi.hoisted(() => vi.fn());
vi.mock('../../healer/owner-notices.js', async (orig) => ({ ...(await orig<typeof import('../../healer/owner-notices.js')>()), tellOwner: tellOwnerMock }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { noteCriticalMemory } from '../memory-low-notice.js';
import { handleIMCommand } from '../imessage-commands.js';

const OWNER = '+15550100198';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});
beforeEach(() => { runMock.mockClear(); noticeMock.mockClear(); tellOwnerMock.mockClear(); });

describe('owner texts in plain words', () => {
  it('the low-memory notice says what is wrong in plain words', () => {
    noteCriticalMemory(100);
    expect(tellOwnerMock).toHaveBeenCalledWith('memory-low', 'Your Mac has less than 512 MB of memory free, so the Dojo may slow down or stop. Quitting apps you are not using frees memory.');
  });

  it('the status reply has no Heap line', async () => {
    const reply = await handleIMCommand('status', OWNER);
    expect(typeof reply).toBe('string');
    expect(reply).toContain('Memory: ');
    expect(reply).not.toContain('Heap');
  });
});
