import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as w from './mail-world.js';

vi.mock('../../db/connection.js', async () => (await import('./mail-world.js')).dbModule());

import { msGraphRead } from '../../microsoft/client.js';
import { googleRead } from '../../google/client.js';

beforeEach(() => w.freshWorld());
const count = (table: string, agentId: string): number =>
  (w.world.db!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id = ?`).get(agentId) as { n: number }).n;

describe('an account poll writes no activity row', () => {
  it('a Microsoft watcher poll is not logged', async () => {
    await msGraphRead('me?$select=id', 'system', 'Teams Watcher', 'teams_watcher_me', {});
    expect(count('microsoft_activity', 'system')).toBe(0);
  });
  it('a Microsoft read for an agent is still logged', async () => {
    await msGraphRead('me/messages', 'primary', 'Primary', 'outlook_inbox', {});
    expect(count('microsoft_activity', 'primary')).toBe(1);
  });
  it('a Google watcher poll is not logged', async () => {
    await googleRead('https://gmail.googleapis.com/gmail/v1/users/me/messages', 'system', 'Gmail Watcher', 'gmail_inbox_poll', {});
    expect(count('google_activity', 'system')).toBe(0);
  });
  it('a Google read for an agent is still logged', async () => {
    await googleRead('https://gmail.googleapis.com/gmail/v1/users/me/messages', 'primary', 'Primary', 'gmail_inbox', {});
    expect(count('google_activity', 'primary')).toBe(1);
  });
});
