// "kill <the main agent's name>" stops its work and never ends the agent; another live agent's name still ends it;
// a name nobody has is ordinary chat.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const calls = vi.hoisted(() => ({ stopByOwner: vi.fn(), terminateAgent: vi.fn() }));
vi.mock('../../agent/runtime.js', async (orig) => ({ ...(await orig<typeof import('../../agent/runtime.js')>()), stopByOwner: calls.stopByOwner }));
vi.mock('../../agent/spawner.js', async (orig) => ({ ...(await orig<typeof import('../../agent/spawner.js')>()), terminateAgent: calls.terminateAgent }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { handleIMCommand } from '../imessage-commands.js';

const OWNER = '+15550100198';
const HELPER = randomUUID();
const seed = (id: string, name: string, classification: string): void => {
  getDb().prepare(`INSERT OR REPLACE INTO agents (id, name, status, classification, created_at, updated_at)
    VALUES (?, ?, 'idle', ?, datetime('now'), datetime('now'))`).run(id, name, classification);
};

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  seed(getPrimaryAgentId(), 'Prime', 'sensei');
  seed(HELPER, 'Scout', 'apprentice');
});
beforeEach(() => { calls.stopByOwner.mockReset(); calls.terminateAgent.mockClear(); });

describe('the owner texts "kill <name>"', () => {
  it('the main agent\'s name stops its work and the agent stays', async () => {
    calls.stopByOwner.mockReturnValue({ ended: 1, repliesNotSent: 0 });
    expect(await handleIMCommand('kill prime', OWNER)).toBe('Dojo: Stopped Prime\'s work. Prime is still here.');
    expect(calls.stopByOwner).toHaveBeenCalledWith(getPrimaryAgentId());
    expect(calls.terminateAgent).not.toHaveBeenCalled();
  });

  it('another live agent\'s name still ends that agent', async () => {
    expect(await handleIMCommand('kill scout', OWNER)).toBe(`Dojo: Terminated agent "Scout" (${HELPER}).`);
    expect(calls.terminateAgent).toHaveBeenCalledWith(HELPER, 'Killed via iMessage command');
    expect(calls.stopByOwner).not.toHaveBeenCalled();
  });

  it('a sentence that names no live agent is ordinary chat', async () => {
    expect(await handleIMCommand('kill the lights', OWNER)).toBeNull();
    expect(calls.terminateAgent).not.toHaveBeenCalled();
    expect(calls.stopByOwner).not.toHaveBeenCalled();
  });
});
