// ════════════════════════════════════════════════════════════════════════════════════════
// THE ISSUE BODY CARRIES THE SIGNATURE, AND NOTHING THE OWNER DID NOT READ (DOJO-REPORT T7).
//
// ── THE FOUR PROPERTIES, EACH SEPARABLE ──
//
//   1. THE BODY IS THE PINNED TEMPLATE. Four headings, in order, once each, then the
//      attachment, then the three trailers. The `dojo-sig:` line is what a triager's search
//      finds and what `findIssueBySignature` matches, so its SHAPE is pinned by a regex rather
//      than by eye — a trailer that drifts is a dedupe that silently stops working and files a
//      second issue for a failure already being worked on.
//
//   2. THE BUNDLE IS NOT IN IT. D1: *"the raw bundle NEVER leaves the box in v1 by any
//      automatic path."* The export door is held by its own clause in
//      `an-unconnected-box-still-gets-its-report-out.test.ts`; this is the same property at the
//      OTHER door, and it is the door that publishes. The bundle is seeded with a marker and
//      the rendered body is searched for it, so the claim is measured, not asserted.
//
//   3. THE OWNER'S BYTES SURVIVE. A brief holding `<script>`, backticks and a fence is rendered
//      VERBATIM. We do not sanitize the approved text: the owner read it (D4), and a renderer
//      that "helped" would publish something they never approved. The one thing that must NOT
//      survive is a SECOND renderer — `renderIssueBody` is the file's renderer too, so the
//      pasted file and the posted issue cannot drift.
//
//   4. THE TARGET REPOSITORY IS ONE VALUE, AND A DEV BOX CANNOT FILE ON THE REAL TRACKER.
//      `DOJO_DEV_BOX=1` is the flag the owner's own box carries. The refusal it drives is
//      LATCHED rather than re-read, so no env write — including the ones these clauses make
//      themselves — can unlock posting to `d-cornerpin/dojo` once the flag has been seen.
// ════════════════════════════════════════════════════════════════════════════════════════
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t7-issue-body', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { createReport, attachDraft, getReport, type ReportBrief, type ReportRow } from '../store.js';
import { writeBundle } from '../bundle.js';
import { exportReport } from '../export.js';
import {
  renderIssueBody, renderIssueTitle, issueLabelsFor, REPORT_ISSUE_LABELS,
} from '../issue-body.js';
import { reportRepo, reportRepoIsDefault, assertPostableRepo, DOJO_REPORT_REPO_DEFAULT } from '../repo.js';

const BRIEF: ReportBrief = {
  title: 'work_open refused a task the engine had just demanded',
  whatHappened: 'The tool door refused the call and the turn ended.',
  whatShouldHaveHappened: 'The call should have opened a task.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Add the label to the creation default.',
};
const TELEMETRY = {
  report: { schema: 'dojo-telemetry-1', signature: 'ds1-abcdef123456', lane: 'tool-error' },
  platform: { version: '3.1.28', os: 'darwin', node_major: 22 },
  settings: { behaves_like: '<absent>', context_receipt_mode: '<unrecognised>' },
};
const BUNDLE_MARKER = 'BUNDLE_ONLY_MARKER';
const SIGNATURE = 'ds1-abcdef123456';

/** A row exactly as the poster receives it, with a real bundle on disk beside it. */
function seeded(brief: ReportBrief = BRIEF, telemetry: Record<string, unknown> = TELEMETRY): ReportRow {
  const r = createReport('agent-1', 'tool-error', SIGNATURE);
  const bundlePath = writeBundle(r.id, 'agent-1', { evidence: BUNDLE_MARKER }).path;
  attachDraft(r.id, brief, telemetry, bundlePath);
  return getReport(r.id)!;
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
  delete process.env.DOJO_DEV_BOX;
});

// ── 1. THE PINNED TEMPLATE ──────────────────────────────────────────────────────────────

describe('the issue body is the pinned template, and it says where it came from', () => {
  const HEADINGS = [
    '## What happened',
    '## What should have happened',
    '## Why the agent thinks it went wrong',
    '## Fix ideas',
    '## Technical attachment',
  ];

  it('carries each heading exactly once, in the pinned order', () => {
    const body = renderIssueBody(seeded());
    let cursor = -1;
    for (const heading of HEADINGS) {
      const occurrences = body.split('\n').filter(l => l === heading).length;
      expect(occurrences, `\`${heading}\` appears ${occurrences} times, not once`).toBe(1);
      const at = body.indexOf(heading);
      expect(at, `\`${heading}\` is out of the pinned order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('names the platform, the lane and the report id on its first line', () => {
    const row = seeded();
    const first = renderIssueBody(row).split('\n')[0];
    expect(first).toContain('Agent Dojo v3.1.28');
    expect(first).toContain('tool-error');
    expect(first).toContain(row.id);
  });

  it('says a human read and approved the text — the consent claim travels with the issue', () => {
    const body = renderIssueBody(seeded());
    expect(body).toContain('read and approved this exact text');
  });

  it('carries the `dojo-sig:` trailer in the shape the duplicate search matches', () => {
    const body = renderIssueBody(seeded());
    expect(body, 'the trailer a triager and findIssueBySignature both read is missing or drifted')
      .toMatch(/^dojo-sig: ds1-[0-9a-f]{12}$/m);
    expect(body).toMatch(/^dojo-report-id: [0-9a-f-]{36}$/m);
    expect(body).toMatch(/^dojo-version: 3\.1\.28$/m);
  });

  it('puts the telemetry in a fenced json block inside a collapsed details element', () => {
    const body = renderIssueBody(seeded());
    const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));
    expect(details.length, 'there is no <details> block at all').toBeGreaterThan(10);
    expect(details).toContain('<summary>telemetry</summary>');
    expect(details).toContain('```json');
    expect(details, 'the attachment is outside the details block, or missing')
      .toContain('"schema": "dojo-telemetry-1"');
    // The two sentinels are DIFFERENT facts (T1 §9) and the publisher must not collapse them.
    expect(details).toContain('<absent>');
    expect(details).toContain('<unrecognised>');
  });

  it('tells the reader what the attachment is, and what it is not', () => {
    const body = renderIssueBody(seeded());
    expect(body).toContain('fixed field whitelist');
    expect(body).toContain('No conversation content');
  });

  it('renders an unknown version honestly rather than printing a sentinel as a version', () => {
    // A hand-edited row, a restored backup: the telemetry is there but its version is not a
    // version. Printing `v<absent>` on a public page is the platform quoting its own plumbing.
    const row = seeded(BRIEF, { platform: { version: '<absent>' } });
    const body = renderIssueBody(row);
    expect(body.split('\n')[0], 'a whitelist sentinel was printed as a version number')
      .not.toContain('<absent>');
    expect(body.split('\n')[0]).toContain('version unknown');
    expect(body).toMatch(/^dojo-version: unknown$/m);
    expect(issueLabelsFor('<absent>'), 'a sentinel became a GitHub label')
      .toEqual([...REPORT_ISSUE_LABELS]);
  });

  it('answers an empty string for a row with no brief — there is nothing to publish', () => {
    const r = createReport('agent-1', 'other', 'ds1-000000000000');
    expect(renderIssueBody(getReport(r.id)!)).toBe('');
  });
});

// ── 2. THE BUNDLE STAYS HOME ────────────────────────────────────────────────────────────

describe('the raw bundle never reaches the issue body', () => {
  it('does not contain the bundle, which is sitting on disk with a marker in it', () => {
    const row = seeded();
    // NON-VACUITY FIRST (T3's lesson): a "does not contain" clause over a bundle that was
    // never written is the most confident kind of nothing.
    expect(row.bundlePath, 'no bundle was recorded — this clause would prove nothing').toBeTruthy();
    expect(fs.readFileSync(row.bundlePath!, 'utf8'), 'the seeded bundle holds no marker')
      .toContain(BUNDLE_MARKER);
    expect(renderIssueBody(row), 'the RAW BUNDLE reached a public issue body (D1)')
      .not.toContain(BUNDLE_MARKER);
  });

  it('names neither the bundle column nor the bundle reader in its own source', () => {
    // Comment lines dropped first: the module's header names both while explaining why it
    // touches neither, and a census that counts its own documentation teaches the next author
    // to delete the explanation.
    const src = fs.readFileSync(new URL('../issue-body.ts', import.meta.url), 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(src.length, 'the comment stripper ate the whole file — this census is broken')
      .toBeGreaterThan(400);
    expect(src, '`bundle_path` is a RECORDED STRING, not a resolvable path (C6)')
      .not.toContain('bundlePath');
    expect(src).not.toContain('readBundle');
  });
});

// ── 3. THE OWNER'S BYTES SURVIVE, AND ONE RENDERER SERVES BOTH DOORS ────────────────────

describe('the approved text is published exactly as the owner read it', () => {
  const HOSTILE: ReportBrief = {
    title: '*work_open* refused #14 — <b>the grant floor</b>',
    whatHappened: 'The tool answered:\n```\nnot granted\n```\nand the turn ended.  ',
    whatShouldHaveHappened: '# It should have opened a task\n\n- one\n- two',
    whyItWentWrong: 'The floor omitted `Work Tracker`, and _nothing_ re-checked it.',
    fixIdeas: 'Add the label. <script>alert(1)</script> 100% of the time.',
  };

  it('renders markdown-hostile text verbatim — we do not sanitize what the owner approved', () => {
    const body = renderIssueBody(seeded(HOSTILE));
    for (const [key, value] of Object.entries(HOSTILE)) {
      if (key === 'title') continue;   // the title rides in the issue's title field
      expect(body, `\`${key}\` was transformed on its way to the issue`).toContain(value);
    }
  });

  it('the exported file and the issue body are the SAME bytes, from one renderer', () => {
    const row = seeded(HOSTILE);
    const written = fs.readFileSync(exportReport(row.id)!.filePath, 'utf8');
    expect(written, 'the file the owner pastes and the issue the poster sends have drifted')
      .toBe(renderIssueBody(row));
  });
});

describe('the issue title is short, prefixed, and made of one line', () => {
  it('always starts with the tag and folds whitespace into single spaces', () => {
    expect(renderIssueTitle({ ...BRIEF, title: '  a\n\ttitle   over   lines  ' }))
      .toBe('[dojo-report] a title over lines');
  });

  it('caps at 80 characters INCLUDING the ellipsis', () => {
    const long = renderIssueTitle({ ...BRIEF, title: 'x'.repeat(200) });
    expect(long.startsWith('[dojo-report] ')).toBe(true);
    expect(long.slice('[dojo-report] '.length).length).toBe(80);
    expect(long.endsWith('...')).toBe(true);
  });

  it('leaves an 80-character title alone', () => {
    const exact = 'y'.repeat(80);
    expect(renderIssueTitle({ ...BRIEF, title: exact })).toBe(`[dojo-report] ${exact}`);
  });

  it('labels the issue with the tag and the version', () => {
    expect(issueLabelsFor('3.1.28')).toEqual(['dojo-report', 'v3.1.28']);
    expect(issueLabelsFor('3.1.29-rc.1')).toEqual(['dojo-report', 'v3.1.29-rc.1']);
  });
});

// ── 4. WHERE IT GOES, AND THE BOX THAT MAY NOT SEND ─────────────────────────────────────

describe('the target repository is one value, and a dev box may not file on the real one', () => {
  it('defaults to the Dojo\'s own tracker and says that it is the default', () => {
    expect(reportRepo()).toBe(DOJO_REPORT_REPO_DEFAULT);
    expect(reportRepoIsDefault()).toBe(true);
    process.env.DOJO_REPORT_REPO = 'someone/elses-fork';
    expect(reportRepo()).toBe('someone/elses-fork');
    expect(reportRepoIsDefault()).toBe(false);
  });

  it('a box with no dev flag may post to the real tracker', () => {
    expect(assertPostableRepo(reportRepo())).toEqual({ ok: true });
  });

  it('refuses a repository that is not an owner/name pair, wherever it came from', () => {
    for (const bad of ['', '   ', 'no-slash', 'a/b/c', 'own er/name', 'a/b?x=1', '../../etc']) {
      const verdict = assertPostableRepo(bad);
      expect(verdict.ok, `\`${bad}\` was accepted as a repository`).toBe(false);
    }
  });

  it('REFUSES the real tracker on a dev box, and no env write can unlock it', async () => {
    // The flag is read at module load, so the module has to be loaded with it set. This is the
    // only clause that needs a fresh module registry, and it is what makes the latch testable.
    process.env.DOJO_DEV_BOX = '1';
    vi.resetModules();
    const repo = await import('../repo.js');

    expect(repo.assertPostableRepo(repo.DOJO_REPORT_REPO_DEFAULT).ok,
      'a dev box was allowed to file an issue on the real tracker').toBe(false);

    // Every env manipulation a test — or a stray helper restoring a saved environment — can
    // drive, one at a time. The latch only ever closes.
    delete process.env.DOJO_DEV_BOX;
    expect(repo.assertPostableRepo(repo.DOJO_REPORT_REPO_DEFAULT).ok,
      'deleting DOJO_DEV_BOX at call time unlocked the real tracker').toBe(false);
    process.env.DOJO_DEV_BOX = '0';
    expect(repo.assertPostableRepo(repo.DOJO_REPORT_REPO_DEFAULT).ok).toBe(false);
    process.env.DOJO_REPORT_REPO = repo.DOJO_REPORT_REPO_DEFAULT;
    expect(repo.assertPostableRepo(repo.reportRepo()).ok,
      'naming the default repo through the override walked past the refusal').toBe(false);
    process.env.DOJO_REPORT_REPO = ' D-CornerPin/DOJO ';
    expect(repo.assertPostableRepo(repo.reportRepo()).ok,
      'a case or whitespace variant of the default walked past the refusal').toBe(false);
    process.env.DOJO_REPORT_REPO = 'not a repo at all';
    expect(repo.assertPostableRepo(repo.reportRepo()).ok,
      'an invalid override falls back to the default — which a dev box may not post to').toBe(false);

    // ...and the refusal says which flag to clear and what the escape hatch is.
    const verdict = repo.assertPostableRepo(repo.DOJO_REPORT_REPO_DEFAULT);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain('DOJO_DEV_BOX');
      expect(verdict.error).toContain('DOJO_REPORT_REPO');
    }
  });

  it('a dev box CAN post to a scratch repository of its own', async () => {
    process.env.DOJO_DEV_BOX = '1';
    process.env.DOJO_REPORT_REPO = 'd-cornerpin/dojo-scratch';
    vi.resetModules();
    const repo = await import('../repo.js');
    expect(repo.reportRepo()).toBe('d-cornerpin/dojo-scratch');
    expect(repo.assertPostableRepo(repo.reportRepo())).toEqual({ ok: true });
  });
});
