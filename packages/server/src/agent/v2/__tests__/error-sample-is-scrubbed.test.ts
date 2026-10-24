// K37 — what the ledger STORES and the Healer PRINTS carries nothing identifying: the sample is
// run through the handed-credential redactor and the same masks the fingerprint uses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({}) }));
vi.mock('../../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../../db/migrations.js';
import { noteToolError } from '../tool-error-ledger.js';
import { noteHandedCredentialValues, forgetHandedCredentialValues } from '../../../credentials/secret-values.js';
import { compileDiagnosticReport } from '../../../healer/diagnostic.js';

const SECRET = 'plainsecret';
const TEXT =
  'Failed for someone.else@example.org reading /Users/sample/Documents/plan.pdf (message 3f2b8c1e-9d4a-4c7e-8a11-0b5d6e7f8a90) ' +
  `with token ghp_Ab12Cd34Ef56Gh78Ij90Kl and key ${SECRET}\nsecond line`;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  noteHandedCredentialValues('agent-a', [SECRET]);
});
afterEach(() => { forgetHandedCredentialValues(); mockDb.current?.close(); mockDb.current = null; });

describe('the stored sample and the Healer line carry nothing identifying', () => {
  it('no email, home path, uuid, token or handed credential survives in the row, the key, or the report', () => {
    noteToolError('agent-a', 'some_tool', TEXT);
    noteToolError('agent-a', 'some_tool', TEXT);
    const row = mockDb.current!.prepare('SELECT fingerprint, sample FROM tool_error_signatures').get() as { fingerprint: string; sample: string };
    const section = (compileDiagnosticReport() as { items: Array<{ code: string; detail: string }> }).items.find((i) => i.code === 'RECURRING_TOOL_ERRORS')!;
    for (const text of [row.sample, row.fingerprint, section.detail]) {
      for (const leak of ['someone.else', 'example.org', '/Users/', 'sample/Documents', '3f2b8c1e', 'ghp_Ab12', SECRET]) {
        expect(text, `"${leak}" survived`).not.toContain(leak);
      }
    }
    expect(row.sample).not.toContain('\n');
    expect(row.sample).toContain('Failed for');   // still readable, not lowercased into mush
  });
});
