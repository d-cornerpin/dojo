// ════════════════════════════════════════════════════════════════════════════
// T198 / E2 — AN UNCONNECTED BOX GETS ITS REPORT OUT WITHOUT FILE HUNTING (GitHub #11 / #15).
//
//   1. The prefilled link's pointer body names NO local path. A path on the reporter's machine
//      is useless to a maintainer and puts a home directory on a public thread.
//   2. The export answer carries the full report text, byte-identical to the file and to the
//      issue body the poster would send, so the dashboard's Copy button copies exactly that.
//   3. The approve route hands that text to the card on an unconnected box.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});
vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => {}, stampPersistedRow: (e: unknown) => e,
}));

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t198-export', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { createReport, attachDraft, submitForApproval, getReport, type ReportBrief } from '../store.js';
import { exportReport, PREFILL_MAX_BODY_CHARS } from '../export.js';
import { renderIssueBody } from '../issue-body.js';
import { reportsRouter } from '../../gateway/routes/reports.js';
import { disconnectGithub } from '../../github/account.js';

const BRIEF: ReportBrief = {
  title: 'a tool refused a call it should have allowed',
  whatHappened: 'The call was refused.', whatShouldHaveHappened: 'It should have run.',
  whyItWentWrong: 'A grant was missing.', fixIdeas: 'Add the grant.',
};
const LONG: ReportBrief = { ...BRIEF, whatHappened: 'x'.repeat(PREFILL_MAX_BODY_CHARS + 500) };

function seeded(brief: ReportBrief): string {
  const r = createReport('agent-1', 'tool-error', 'ds2-aaaaaaaaaaaa');
  attachDraft(r.id, {
    lane: r.lane, signature: r.signature, brief,
    telemetry: { report: { schema: 'dojo-telemetry-1' } }, bundlePath: '/tmp/never-opened/bundle.json',
  });
  submitForApproval(r.id);
  return r.id;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  disconnectGithub();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the link a long report falls back to names nothing local', () => {
  it('the pointer body carries no file path, no home directory and no "on the reporter\'s Mac"', () => {
    const result = exportReport(seeded(LONG))!;
    expect(result.bodyWasTrimmed, 'the fixture is not over the cap, so this clause proves nothing').toBe(true);
    const body = new URL(result.newIssueUrl).searchParams.get('body') ?? '';
    expect(body.length, 'the pointer body is empty — the clause is blind').toBeGreaterThan(20);
    expect(body).not.toContain(result.filePath);
    expect(body).not.toMatch(/\/Users\/|\/home\/|C:\\|report\.md|\.dojo/);
    expect(body.toLowerCase()).not.toContain('mac');
    expect(body, 'the signature triage searches for must still ride in the link').toContain('ds2-aaaaaaaaaaaa');
  });
});

describe('the export answer carries the exact text the Copy button copies', () => {
  it('reportText is byte-identical to the file and to the issue body the poster would send', () => {
    const id = seeded(LONG);
    const result = exportReport(id)!;
    expect(result.reportText, 'the export answer has no report text').toBeTypeOf('string');
    expect(result.reportText).toBe(fs.readFileSync(result.filePath, 'utf8'));
    expect(result.reportText).toBe(renderIssueBody(getReport(id)!));
    expect(result.reportText).toContain(LONG.whatHappened);
  });
});

describe('the approve route hands the card the text on an unconnected box', () => {
  it('answers with reportText equal to the issue body, so no file has to be found', async () => {
    const id = seeded(LONG);
    const res = await reportsRouter.request(`/${id}/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.data.bodyWasTrimmed).toBe(true);
    expect(body.data.reportText).toBe(renderIssueBody(getReport(id)!));
  });
});
