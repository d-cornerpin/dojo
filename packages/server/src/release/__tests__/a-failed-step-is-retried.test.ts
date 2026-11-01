// The once-per-update repair steps must not record the update as finished while one of them failed:
// the marker decides which steps are owed next boot, so a failed step has to stay owed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

const reconcile = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../tracker/version-gap-reconcile.js', () => ({ runVersionGapReconcile: reconcile.run }));

import { runReleaseSteps, RELEASE_STEPS, RELEASE_STEPS_VERSION_KEY, type ReleaseStep } from '../release-steps.js';

const marker = () => (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?')
  .get(RELEASE_STEPS_VERSION_KEY) as { value: string } | undefined)?.value;
const goodResult = { projectsExamined: 1, tasksExamined: 1, findings: [], repaired: 0 };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  reconcile.run.mockReset();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a failed release step is retried', () => {
  it('a step that throws leaves the marker unwritten', async () => {
    reconcile.run.mockRejectedValue(new Error('boom'));
    const report = await runReleaseSteps({ currentVersion: '9.9.9' });
    expect(report.failed).toHaveLength(1);
    expect(marker()).toBeUndefined();
  });

  it('every step succeeding records the version', async () => {
    reconcile.run.mockResolvedValue(goodResult);
    await runReleaseSteps({ currentVersion: '9.9.9' });
    expect(marker()).toBe('9.9.9');
  });

  it('one step failing while another ran does not record the version', async () => {
    const extra: ReleaseStep = { id: 'extra-ok', sinceVersion: '0.0.0', pays: 'test', run: () => ({ examined: 1, flagged: 0, repaired: 0 }) };
    (RELEASE_STEPS as ReleaseStep[]).push(extra);
    try {
      reconcile.run.mockRejectedValue(new Error('boom'));
      const report = await runReleaseSteps({ currentVersion: '9.9.9' });
      // Every declared step that did not fail ran (proof-fix-f added `orphaned-ask-backlog`); the failed one did not.
      expect(report.ran.map((r) => r.id)).toContain('extra-ok');
      expect(report.ran.map((r) => r.id)).not.toContain('version-gap-reconcile');
      expect(report.failed).toHaveLength(1);
      expect(marker(), 'the failed step would never be tried again').toBeUndefined();
    } finally {
      (RELEASE_STEPS as ReleaseStep[]).splice((RELEASE_STEPS as ReleaseStep[]).indexOf(extra), 1);
    }
  });
});
