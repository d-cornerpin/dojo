// P7: exact-call destructive approvals (owner ruling: the approval covers
// precisely the command the approver saw, once).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { consumeApproval, grantApprovalForSignature } from '../destructive-gate.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE destructive_approvals (
      token TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT,
      signature TEXT NOT NULL,
      request_text TEXT,
      args_json TEXT,
      root_kind TEXT, root_id TEXT, task_id TEXT, turn_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      wake_delivered INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  mockDb.current = db;
});

const SIG = 'exec:{"command":"rm -rf /tmp/build-XXXX"}';

describe('exact-call approval consumption (P7)', () => {
  it('the exact approved call consumes once; a second identical attempt does not', () => {
    grantApprovalForSignature({ agentId: 'a1', signature: SIG, requestText: 'r', decidedBy: 'owner', argsJson: '{"command":"rm -rf /tmp/build-1234"}' });
    expect(consumeApproval('a1', SIG, '{"command":"rm -rf /tmp/build-1234"}')).toBe(true);
    expect(consumeApproval('a1', SIG, '{"command":"rm -rf /tmp/build-1234"}')).toBe(false);
  });

  it('a COLLIDING call (same lossy signature, different full args) cannot consume the approval', () => {
    // The canonical signature masks digit runs, so build-1234 and build-9999
    // collide; the full-args check is what keeps the grant exact.
    grantApprovalForSignature({ agentId: 'a1', signature: SIG, requestText: 'r', decidedBy: 'owner', argsJson: '{"command":"rm -rf /tmp/build-1234"}' });
    expect(consumeApproval('a1', SIG, '{"command":"rm -rf /tmp/build-9999"}')).toBe(false);
    // The real approved command still works after the failed collision.
    expect(consumeApproval('a1', SIG, '{"command":"rm -rf /tmp/build-1234"}')).toBe(true);
  });

  it('legacy rows (NULL args_json, pre-117) consume by signature alone, one release', () => {
    grantApprovalForSignature({ agentId: 'a1', signature: SIG, requestText: 'r', decidedBy: 'owner' });
    expect(consumeApproval('a1', SIG, '{"command":"rm -rf /tmp/build-9999"}')).toBe(true);
  });
});

// ── P7b: the Healer approval arm is on the same exact-call contract ──
// The healer proposal flow can't be unit-driven here without dragging in the
// healing cycle, so these are source-conformance locks on the three links of
// the chain: the executor files the FULL args with the hold, the proposal row
// stores them, and owner approval mints the grant WITH them. Breaking any link
// reverts the Healer to lossy-signature approvals (the collision class the
// owner ruled out).
describe('healer approval arm carries full args (P7b conformance)', () => {
  const read = async (rel: string) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return fs.readFileSync(path.join(srcRoot, rel), 'utf8');
  };

  it('the loop hold passes argsJson into fileHealerApprovalProposal', async () => {
    const loop = await read('agent/v2/loop.ts');
    const holdCall = loop.slice(loop.indexOf('fileHealerApprovalProposal({'));
    expect(holdCall.slice(0, 600)).toMatch(/argsJson:\s*JSON\.stringify\(tc\.arguments/);
  });

  it('the proposal INSERT persists approval_args_json', async () => {
    const routing = await read('healer/approval-routing.ts');
    expect(routing).toMatch(/INSERT INTO healer_proposals[\s\S]{0,400}approval_args_json/);
  });

  it('owner approval mints the grant with the stored args', async () => {
    const route = await read('gateway/routes/healer.ts');
    const grantCall = route.slice(route.indexOf('grantApprovalForSignature({'));
    expect(grantCall.slice(0, 600)).toMatch(/argsJson:\s*\(proposal\.approval_args_json/);
  });
});
