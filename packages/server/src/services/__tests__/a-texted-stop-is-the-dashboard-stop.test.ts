// The owner's texted "stop" is the dashboard Stop button: the same engine call and the same follow-ups.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ stopByOwner: vi.fn() }));
vi.mock('../../agent/runtime.js', async (orig) => ({ ...(await orig<typeof import('../../agent/runtime.js')>()), stopByOwner: calls.stopByOwner }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { handleIMCommand } from '../imessage-commands.js';

const OWNER = '+15550100198';
const GUEST = '+15550100199';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify([
    { address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' },
    { address: GUEST, name: 'Guest', is_primary: false, sharing_level: 'cautious' },
  ]));
});
beforeEach(() => { calls.stopByOwner.mockReset(); });

describe('a texted stop does what the Stop button does', () => {
  it('makes the one Stop call for the main agent and says how many requests ended', async () => {
    calls.stopByOwner.mockReturnValue({ ended: 2, repliesNotSent: 0 });
    expect(await handleIMCommand('stop', OWNER)).toBe('Dojo: Stopped. 2 requests ended.');
    expect(calls.stopByOwner).toHaveBeenCalledWith(getPrimaryAgentId());
  });

  it('says so when nothing was running', async () => {
    calls.stopByOwner.mockReturnValue({ ended: 0, repliesNotSent: 0, nothingRunning: true });
    expect(await handleIMCommand('stop', OWNER)).toBe('Dojo: Nothing was running.');
  });

  it('says only "Stopped." when a run was cut but no request ended', async () => {
    calls.stopByOwner.mockReturnValue({ ended: 0, repliesNotSent: 0 });
    expect(await handleIMCommand('stop', OWNER)).toBe('Dojo: Stopped.');
  });

  it('names the queued replies the stop kept from going, one or many', async () => {
    calls.stopByOwner.mockReturnValue({ ended: 1, repliesNotSent: 1 });
    expect(await handleIMCommand('stop', OWNER)).toBe('Dojo: Stopped. 1 request ended. A queued reply was not sent.');
    calls.stopByOwner.mockReturnValue({ ended: 1, repliesNotSent: 2 });
    expect(await handleIMCommand('stop', OWNER)).toBe('Dojo: Stopped. 1 request ended. 2 queued replies were not sent.');
  });

  it('a guest\'s "stop" is ordinary chat: not a command, nothing stopped', async () => {
    expect(await handleIMCommand('stop', GUEST)).toBeNull();
    expect(calls.stopByOwner).not.toHaveBeenCalled();
  });
});
