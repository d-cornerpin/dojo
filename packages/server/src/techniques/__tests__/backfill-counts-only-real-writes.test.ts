// The backfill count must cover only snapshots that really reached disk.
// writeDiskVersionSnapshot is best-effort, so a failed write (read-only
// folder, full disk) used to be counted too, and the caller told the agent
// that files existed which did not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// getVersions() reads the technique_versions table; this fake serves the same
// rows back whatever SQL is prepared, so no DB is needed.
const mockDb = {
  rows: [] as Array<Record<string, unknown>>,
};
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => mockDb.rows }) }),
}));
vi.mock('../store.js', () => ({ getTechnique: () => null }));

import { backfillDiskVersionsFromDb } from '../versioning.js';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-'));
  mockDb.rows = [1, 2].map(n => ({
    id: `fake-v-id-${n}`,
    technique_id: 'fake-tech',
    version_number: n,
    technique_md: `# fake v${n}`,
    changed_by: 'tester',
    change_summary: null,
    files_snapshot: '[]',
    created_at: `2026-01-0${n}T00:00:00.000Z`,
  }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('backfillDiskVersionsFromDb', () => {
  it('returns 2 when both DB versions get written with no versions folder yet', () => {
    expect(backfillDiskVersionsFromDb('fake-tech', tmp)).toBe(2);
  });

  it('returns 0 when a plain file named versions blocks every write', () => {
    fs.writeFileSync(path.join(tmp, 'versions'), 'a file, not a folder');
    expect(backfillDiskVersionsFromDb('fake-tech', tmp)).toBe(0);
  });
});
