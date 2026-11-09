// Owner ruling (exact-call approvals): the owner's approval of a held Healer call, given at POST /api/healer/proposals/:id,
// lets that exact call run once and no other call that shares its lossy signature.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { healerRouter } from '../healer.js';
import { consumeApproval } from '../../../agent/destructive-gate.js';

const SIG = 'exec:{"command":"rm -rf /tmp/build-XXXX"}';
const HELD = '{"command":"rm -rf /tmp/build-1234"}';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare(`INSERT INTO healer_proposals (id, category, severity, title, description, proposed_fix, status, agent_id,
      approval_token, approval_signature, approval_args_json)
    VALUES ('p-1', 'destructive', 'high', 'Delete the build folder', 'd', 'rm -rf /tmp/build-1234', 'pending', 'healer', 'tok-1', ?, ?)`).run(SIG, HELD);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an approved held call runs only as approved', () => {
  it('approving the proposal lets the exact call run once, and not a colliding one', async () => {
    const res = await healerRouter.request('/proposals/p-1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(200);
    expect(consumeApproval('healer', SIG, '{"command":"rm -rf /tmp/build-9999"}')).toBe(false);
    expect(consumeApproval('healer', SIG, HELD)).toBe(true);
    expect(consumeApproval('healer', SIG, HELD)).toBe(false);
  });
});
