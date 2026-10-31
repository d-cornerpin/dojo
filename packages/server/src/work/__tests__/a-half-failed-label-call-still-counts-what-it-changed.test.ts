// v3.5 DONE IS MEASURED — a gmail_label call whose batch PARTLY applied is an Error result
// (`isError = content.startsWith('Error')`, agent/tools/index.ts), so the ledger used to record
// NOTHING for it: a call that labelled 1,000 of 1,250 messages left the task's touched count
// unchanged, the turn showed no new items, and a continued job read as stalled. The ids the
// text says WERE applied must still reach the ledger.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../google/client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../../google/accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import { recordCallsTouched, ledgerTotals } from '../ledger-store.js';
import { appliedKeysOf } from '../../google/gmail-label.js';
import { googleWrite } from '../../google/client.js';
import { executeGoogleWriteTool } from '../../google/tools-write.js';

const TASK = 'task-half-1';

// The exact partial-apply shapes executeBatch writes when one chunk failed.
const PARTIAL =
  'Error modifying labels: HTTP 500\n' +
  'The change WAS applied to 2 messages (ids m1, m2) and 1 conversation (thread ids t1).\n' +
  'It was NOT changed on 1 message (ids m3); retry those.';
// …and the same for a messages-only call, as the ledger cases below name only `message_ids`.
const PARTIAL_MSG =
  'Error modifying labels: HTTP 500\n' +
  'The change WAS applied to 2 messages (ids m1, m2).\n' +
  'It was NOT changed on 1 message (ids m3); retry those.';

const ok = (data: unknown = {}) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);
const rowKeys = () =>
  mockDb.current!.prepare('SELECT item_key FROM work_ledger WHERE work_id = ? ORDER BY first_at, item_key').all(TASK)
    .map((r) => (r as { item_key: string }).item_key);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  createWorkTable(mockDb.current);
  seedTrackerTask(mockDb.current, { id: TASK, agentId: 'agent-l', status: 'in_progress' });
  vi.mocked(googleWrite).mockReset();
});

describe('appliedKeysOf reads what the partial text says was applied', () => {
  it('reads the message ids and the thread ids of a partial apply; null when nothing was', () => {
    expect(appliedKeysOf(PARTIAL)).toEqual(['gmail:msg:m1', 'gmail:msg:m2', 'gmail:thread:t1']);
    expect(appliedKeysOf('Error modifying labels: HTTP 500\nIt was NOT changed on 1 message (ids m3); retry those.')).toBeNull();
    expect(appliedKeysOf('Labels updated on 2 messages (ids m1, m2).')).toBeNull();
  });
});

describe('a failed label call that changed something still counts what it changed', () => {
  it('records the applied ids only — the failed one stays off the ledger', () => {
    recordCallsTouched(
      TASK,
      [{ id: 'c1', name: 'gmail_label', arguments: { message_ids: ['m1', 'm2', 'm3'], add_labels: ['X'] } }],
      [{ toolCallId: 'c1', isError: true, content: PARTIAL_MSG }],
    );
    expect(ledgerTotals(TASK).touched).toBe(2);
    expect(rowKeys()).toEqual(['gmail:msg:m1', 'gmail:msg:m2']);
  });

  it('a failed call that changed NOTHING records nothing', () => {
    recordCallsTouched(
      TASK,
      [{ id: 'c1', name: 'gmail_label', arguments: { message_ids: ['m1', 'm2', 'm3'], add_labels: ['X'] } }],
      [{ toolCallId: 'c1', isError: true, content: 'Error modifying labels: HTTP 500\nIt was NOT changed on 3 messages (ids m1, m2, m3); retry those.' }],
    );
    expect(ledgerTotals(TASK).touched).toBe(0);
  });

  it('the success path is untouched: a fully successful call still records all its ids', () => {
    recordCallsTouched(
      TASK,
      [{ id: 'c1', name: 'gmail_label', arguments: { message_ids: ['m1', 'm2', 'm3'], add_labels: ['X'] } }],
      [{ toolCallId: 'c1', isError: false, content: 'Labels updated on 3 messages (ids m1, m2, m3).' }],
    );
    expect(ledgerTotals(TASK).touched).toBe(3);
  });

  it('a real round trip: 1,250 ids, first chunk ok, second HTTP 500 — the text yields the 1,000 applied keys', async () => {
    vi.mocked(googleWrite)
      .mockResolvedValueOnce(ok() as never)
      .mockResolvedValueOnce({ ok: false, data: null, error: 'HTTP 500', apiEndpoint: 'x' } as never);
    const out = await executeGoogleWriteTool('gmail_label', { message_ids: ids(1250), add_labels: ['X'] }, 'agent-1', 'A Worker');
    expect(appliedKeysOf(out)).toEqual(ids(1000).map((id) => `gmail:msg:${id}`));
  });
});
