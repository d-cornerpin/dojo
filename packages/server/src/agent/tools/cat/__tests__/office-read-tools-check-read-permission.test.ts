// An agent that may READ a folder but not write to it must still be able to read a Word or
// Excel file there: the office body asks no write permission of the three read-only tools.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const permCalls = vi.hoisted(() => [] as Array<{ type: string; path?: string }>);

vi.mock('../../../permissions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../permissions.js')>()),
  checkPermission: (_agentId: string, req: { type: string; path?: string }) => {
    permCalls.push(req);
    return req.type === 'file_read'
      ? { allowed: true }
      : { allowed: false, reason: 'writes to this folder are not granted' };
  },
}));
vi.mock('../../../../microsoft/tools-office.js', () => ({ executeOfficeTool: async () => 'ok' }));
vi.mock('../../../../microsoft/auth.js', () => ({ isMicrosoftConnected: () => false }));
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ name: 'a' }) }) }),
}));
vi.mock('../../util.js', async () => {
  const actual = await vi.importActual<typeof import('../../util.js')>('../../util.js');
  return {
    ...actual,
    auditLog: () => { /* no-op */ },
    openFileInCanvas: () => ({ opened: false }),
    localOfficePathFromResult: () => null,
  };
});

import { officeHandlers } from '../office.js';

const run = (name: string) =>
  officeHandlers[name]!({ agentId: 'a1', name, args: { path: '/tmp/x.docx' } } as never);

beforeEach(() => { permCalls.length = 0; });

describe('office tools and the local-file permission check', () => {
  for (const name of ['office_read_word_document', 'office_get_word_document_outline', 'office_get_spreadsheet_range']) {
    it(`${name} is not refused for lack of write permission`, async () => {
      const r = await run(name);
      expect(r.isError).toBeFalsy();
      expect(r.content).toBe('ok');
      expect(permCalls.some((c) => c.type === 'file_write')).toBe(false);
    });
  }
});
