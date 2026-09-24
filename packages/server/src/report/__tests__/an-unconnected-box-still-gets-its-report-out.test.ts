// ════════════════════════════════════════════════════════════════════════════════════════
// AN UNCONNECTED BOX STILL GETS ITS REPORT OUT (DOJO-REPORT T6).
//
// Owner ruling D2's second half: *"Not connected → the same brief as a local file plus a
// prefilled new-issue link for paste-and-post."* The load-bearing word is **same**. The export
// is not a lesser consolation path — it is the identical sanitized brief, delivered by hand
// instead of by token, and D4 binds it exactly as it binds the poster: one approval, one
// delivery, whichever way the report leaves (contract C3).
//
// ── THE THREE THINGS THIS FILE HOLDS THAT NOTHING ELSE CAN ──
//
//   1. THE BUNDLE STAYS HOME. D1: *"the raw bundle NEVER leaves the box in v1 by any automatic
//      path."* The export writes the BRIEF and the TELEMETRY. The bundle is seeded with a marker
//      string and the written file is searched for it, so the claim is measured rather than
//      asserted — and the same clause proves the export does not reach the bundle by accident
//      (C6: `bundle_path` is a recorded string, not a resolvable path, and nothing may
//      `fs.read` that column).
//
//   2. THE LINK IS USABLE, OR IT SAYS IT IS NOT. A prefilled `issues/new` URL is a GET, and a
//      long brief makes a URL no browser will follow. Over the cap the link carries a SHORT body
//      naming the file and the signature and the result says `bodyWasTrimmed`, so the card can
//      tell the owner to open the file and paste — rather than handing them a link that silently
//      truncates their own words on a public page.
//
//   3. THE BUNDLE'S ABSENCE IS NORMAL (C7). The sweep keeps the newest 50 report directories by
//      DIRECTORY mtime and runs on every write, with no regard for status, so a live
//      `awaiting_approval` row can outlive its bundle. The export must not care, and the clause
//      below drives that case rather than recording the sentence.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t6-export', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { createReport, attachDraft, submitForApproval, type ReportBrief } from '../store.js';
import { bundleDir, writeBundle } from '../bundle.js';
import { exportReport, PREFILL_MAX_BODY_CHARS } from '../export.js';
import { issueLabelsFor, renderIssueBody, renderIssueTitle } from '../issue-body.js';
import { reportRepo, DOJO_REPORT_REPO_DEFAULT } from '../repo.js';

const BRIEF: ReportBrief = {
  title: 'work_open refused a task the engine had just demanded',
  whatHappened: 'The tool door refused the call and the turn ended.',
  whatShouldHaveHappened: 'The call should have opened a task.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Add the label to the creation default.',
};
const TELEMETRY = {
  report: { schema: 'dojo-telemetry-1', signature: 'ds1-aaaaaaaaaaaa', lane: 'tool-error' },
  window: { minutes: 120, turns: 20, truncated: false },
  settings: { behaves_like: '<absent>', context_receipt_mode: '<unrecognised>' },
};
const BUNDLE_MARKER = 'BUNDLE_ONLY_MARKER';

function seeded(brief: ReportBrief = BRIEF, withBundle = true): string {
  const r = createReport('agent-1', 'tool-error', 'ds1-aaaaaaaaaaaa');
  let bundlePath = '/tmp/never-opened/bundle.json';
  if (withBundle) {
    bundlePath = writeBundle(r.id, 'agent-1', { evidence: BUNDLE_MARKER }).path;
  }
  attachDraft(r.id, brief, TELEMETRY, bundlePath);
  submitForApproval(r.id);
  return r.id;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  delete process.env.DOJO_REPORT_REPO;
});

describe('the export writes the brief to this box and nothing else leaves', () => {
  it('writes report.md inside the report\'s own directory under this box\'s home', () => {
    const id = seeded();
    const result = exportReport(id)!;
    expect(result).not.toBeNull();
    expect(result.filePath).toBe(path.join(bundleDir(id), 'report.md'));
    expect(fs.existsSync(result.filePath)).toBe(true);
    // Owner-only, like every other file this feature writes.
    expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
  });

  it('carries the brief and the telemetry, and NOT the raw bundle', () => {
    const id = seeded();
    const result = exportReport(id)!;
    const written = fs.readFileSync(result.filePath, 'utf8');
    // ⚠ FOUR FIELDS, NOT FIVE, SINCE T7 — and the fifth is checked one line down rather than
    // dropped. The file is now byte-identical to the ISSUE BODY, and an issue carries its title
    // in its own field, so the title rides in the prefilled link's `title=` instead.
    for (const [key, value] of Object.entries(BRIEF)) {
      if (key === 'title') continue;
      expect(written, `\`${key}\` is missing from the exported file`).toContain(value);
    }
    expect(new URL(result.newIssueUrl).searchParams.get('title'),
      'the owner\'s title reaches neither the file nor the link').toBe(renderIssueTitle(BRIEF));
    expect(written, 'the telemetry attachment is missing from the export').toContain('dojo-telemetry-1');
    expect(written, 'the RAW BUNDLE reached a file the owner is told to paste in public (D1)')
      .not.toContain(BUNDLE_MARKER);
  });

  it('keeps the two telemetry sentinels apart — `<absent>` is not `<unrecognised>`', () => {
    // T1 §9: "the platform recorded nothing" and "the platform recorded something the whitelist
    // does not admit" are DIFFERENT facts. The first renderer of this attachment is the one that
    // could collapse them to a dash; it must not.
    const id = seeded();
    const written = fs.readFileSync(exportReport(id)!.filePath, 'utf8');
    expect(written).toContain('<absent>');
    expect(written).toContain('<unrecognised>');
  });

  it('works when the bundle is already gone — a missing bundle is normal, not corruption (C7)', () => {
    const id = seeded(BRIEF, false);
    fs.rmSync(bundleDir(id), { recursive: true, force: true });
    const result = exportReport(id);
    expect(result, 'the export needed a bundle it is not allowed to publish anyway').not.toBeNull();
    expect(fs.existsSync(result!.filePath)).toBe(true);
  });

  it('never opens the recorded bundle_path column (C6)', () => {
    // Comment lines are dropped first: the module's header NAMES both of these while explaining
    // why it does not use them, and a census that counted its own documentation as a violation
    // would teach the next author to delete the explanation.
    const src = fs.readFileSync(path.join(__dirname, '..', 'export.ts'), 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(src.length, 'the comment stripper ate the whole file — this census is broken')
      .toBeGreaterThan(400);
    expect(src, '`bundle_path` is a RECORDED STRING, not a resolvable path — the only safe read '
      + 'is readBundle(reportId), and the export must not read the bundle at all')
      .not.toContain('bundlePath');
    expect(src).not.toContain('readBundle');
  });

  it('answers null for an id that is not there, rather than writing a stray file', () => {
    expect(exportReport('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('answers null for a report with no brief — there is nothing to paste', () => {
    const r = createReport('agent-1', 'other', 'ds1-bbbbbbbbbbbb');
    expect(exportReport(r.id)).toBeNull();
  });
});

describe('the prefilled link is usable, or it says it is not', () => {
  it('points at the Dojo\'s own issue tracker, labelled, with the title prefilled', () => {
    const id = seeded();
    const { newIssueUrl, bodyWasTrimmed } = exportReport(id)!;
    expect(newIssueUrl.startsWith('https://github.com/')).toBe(true);
    expect(newIssueUrl).toContain(`${DOJO_REPORT_REPO_DEFAULT}/issues/new`);
    expect(newIssueUrl).toContain(encodeURIComponent(BRIEF.title));
    expect(bodyWasTrimmed).toBe(false);
    // FR-6: the labels come from `issueLabelsFor`, never from a literal in this module. The
    // clause below used to read `toContain('labels=dojo-report')`, which is true of the label
    // SET and of the single label that was drifting away from it — it could not tell them apart.
    expect(new URL(newIssueUrl).searchParams.get('labels')?.split(','))
      .toEqual(issueLabelsFor(''));
  });

  it('a report that knows its version puts the version label on the link too', () => {
    // The divergence FR-6 found was invisible on a version-less fixture, which is the only
    // shape this file had. The poster-side half of the comparison — the same labels on the real
    // POST body for one row — is driven in
    // `github/__tests__/a-matching-issue-gets-a-comment-not-a-duplicate.test.ts`.
    const r = createReport('agent-1', 'tool-error', 'ds1-aaaaaaaaaaaa');
    attachDraft(r.id, BRIEF, { ...TELEMETRY, platform: { version: '3.1.28' } },
      writeBundle(r.id, 'agent-1', { evidence: BUNDLE_MARKER }).path);
    submitForApproval(r.id);
    const labels = new URL(exportReport(r.id)!.newIssueUrl).searchParams.get('labels')?.split(',');
    expect(labels, 'a version-filtered triage view will not show this hand-pasted report')
      .toEqual(['dojo-report', 'v3.1.28']);
    expect(labels).toEqual(issueLabelsFor('3.1.28'));
  });

  it('a long brief trims the LINK, never the file, and says so', () => {
    const long = { ...BRIEF, whatHappened: 'x'.repeat(PREFILL_MAX_BODY_CHARS + 500) };
    const id = seeded(long);
    const result = exportReport(id)!;
    expect(result.bodyWasTrimmed, 'a body over the cap was handed to a browser unannounced').toBe(true);
    // The short body names where the real text is, and the signature triage will search for.
    const body = new URL(result.newIssueUrl).searchParams.get('body') ?? '';
    expect(body).toContain(result.filePath);
    expect(body).toContain('ds1-aaaaaaaaaaaa');
    expect(body.length).toBeLessThanOrEqual(PREFILL_MAX_BODY_CHARS);
    // ...and the FILE is whole. The cap binds the URL only.
    expect(fs.readFileSync(result.filePath, 'utf8')).toContain(long.whatHappened);
  });

  it('the cap is measured on the ENCODED body, which is what a browser carries', () => {
    // A brief of characters that each encode to three bytes is under the cap when counted raw
    // and far over it once encoded. Counting the wrong string is how a "capped" URL still breaks.
    const each = '—';                       // an em dash: 1 char, `%E2%80%94` encoded
    const under = Math.floor(PREFILL_MAX_BODY_CHARS / 9) + 40;
    const id = seeded({ ...BRIEF, whatHappened: each.repeat(under) });
    const result = exportReport(id)!;
    expect(result.bodyWasTrimmed, 'the cap counted raw characters, not encoded ones').toBe(true);
  });
});

describe('the export body and the issue body are one renderer, not two', () => {
  it('renderIssueBody is what the file holds — the exporter adds nothing of its own', () => {
    // T6's clause, re-pointed rather than retired: the renderer moved to `issue-body.ts` (T7
    // took the plan's "replace it and re-point this module" option), so this now asserts the
    // exported file IS the issue body. The other half — that the bytes POSTED to GitHub are
    // these same bytes — is driven in
    // `github/__tests__/a-matching-issue-gets-a-comment-not-a-duplicate.test.ts`.
    const id = seeded();
    const result = exportReport(id)!;
    const rendered = renderIssueBody({
      id, brief: BRIEF, telemetry: TELEMETRY, signature: 'ds1-aaaaaaaaaaaa', lane: 'tool-error',
      createdAt: '', agentId: 'agent-1', status: 'approved', bundlePath: null, updatedAt: '',
      approvedAt: null, postedAt: null, issueUrl: null, issueNumber: null, exportPath: null,
    });
    // Non-vacuity before the comparison: two empty strings are also byte-identical.
    for (const [key, value] of Object.entries(BRIEF)) {
      if (key !== 'title') expect(rendered).toContain(value);
    }
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe(rendered);
  });
});

describe('the target repository is one value, declared once', () => {
  it('defaults to the Dojo\'s own repository', () => {
    expect(reportRepo()).toBe(DOJO_REPORT_REPO_DEFAULT);
    expect(DOJO_REPORT_REPO_DEFAULT).toBe('d-cornerpin/dojo');
  });

  it('a dev box may point it somewhere else', () => {
    process.env.DOJO_REPORT_REPO = 'someone/elses-fork';
    expect(reportRepo()).toBe('someone/elses-fork');
  });

  it('refuses a value that is not an `owner/name` pair, rather than building a broken URL', () => {
    for (const bad of ['', '   ', 'no-slash', 'a/b/c', 'a/', '/b', 'own er/name', 'a/b?x=1']) {
      process.env.DOJO_REPORT_REPO = bad;
      expect(reportRepo(), `\`${bad}\` was accepted as a repository`).toBe(DOJO_REPORT_REPO_DEFAULT);
    }
  });
});
