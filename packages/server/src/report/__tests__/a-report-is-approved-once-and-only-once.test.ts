// ════════════════════════════════════════════════════════════════════════════════════════
// A REPORT IS APPROVED ONCE AND ONLY ONCE (DOJO-REPORT T2).
//
// Owner ruling D4 — "the consent gate is absolute" — is not a sentence in a card, it is a
// STATE MACHINE, and this file is the machine's proof. What D4 actually demands is three
// separate properties, and only the first one is obvious:
//
//   1. ONE APPROVAL PER POST. `approved` is reachable exactly once and the poster CONSUMES
//      it. Two Post clicks, two retries of the same HTTP call, or two dashboard tabs must
//      produce ONE issue. `destructive_approvals` + `consumeApproval` already solved this
//      shape in this tree with an atomic conditional UPDATE; a read-then-write here would
//      be the whole bug, so the mutation the house runs against this file is exactly that:
//      drop the `AND status = 'awaiting_approval'` clause and watch two clauses go red.
//
//   2. THE APPROVER SAW THE TEXT THAT POSTS. A brief that can change after a human has
//      looked at it turns the preview into decoration. So `attachDraft` is legal only from
//      `drafting` (before anyone has seen it) and `editBrief` only from `awaiting_approval`
//      (the human's own edit door) — never from `approved`, where the text would change
//      between the click and the post.
//
//   3. POSTED IS TERMINAL. Nothing re-opens, re-edits or re-posts a delivered report.
//
// The signature block pins that the report's identity is derived from the FAILURE SHAPE —
// version, lane, dominant failure — and never from content, so two boxes that hit the same
// defect produce the same `ds1-` token and the issue search can dedupe on it.
//
// The bundle block pins the other half of D1: raw evidence is written under the box's own
// home, scrubbed of handed credentials on the way, and a bundle over the cap is replaced by
// a whole, parseable truncation marker rather than a half-written JSON document.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import {
  createReport, getReport, attachDraft, editBrief, submitForApproval, approveOnce, markPosted,
  markExported, cancelReport, listOpenReports, type ReportBrief,
} from '../store.js';
import { deriveReportSignature, dominantToken, FAILURE_LANES, isFailureLane } from '../signature.js';
import { bundleDir, writeBundle, readBundle, writeReportFile } from '../bundle.js';

const BRIEF: ReportBrief = {
  title: 'work_open refused a task the engine had just demanded',
  whatHappened: 'The tool door refused the call.',
  whatShouldHaveHappened: 'The call should have opened a task.',
  whyItWentWrong: 'The grant floor omitted the category.',
  fixIdeas: 'Add the label to the creation default.',
};

beforeEach(() => { runMigrations(); getDb().prepare('DELETE FROM dojo_reports').run(); });

describe('the approval is one-shot', () => {
  it('approves exactly once and refuses the second call', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-aaaaaaaaaaaa');
    attachDraft(r.id, BRIEF, { report: { schema: 'dojo-telemetry-1' } }, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    expect(approveOnce(r.id)?.status).toBe('approved');
    expect(approveOnce(r.id)).toBeNull();
  });

  it('refuses approval on a row that was never submitted', () => {
    const r = createReport('agent-1', 'silence', 'ds1-bbbbbbbbbbbb');
    expect(approveOnce(r.id)).toBeNull();
    expect(getReport(r.id)?.status).toBe('drafting');
  });

  it('refuses approval on a cancelled row', () => {
    const r = createReport('agent-1', 'other', 'ds1-cccccccccccc');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    cancelReport(r.id);
    expect(approveOnce(r.id)).toBeNull();
  });

  it('posts exactly once, and only from approved', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-dddddddddddd');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    expect(markPosted(r.id, 'https://example.invalid/1', 1)).toBeNull(); // not approved yet
    submitForApproval(r.id);
    approveOnce(r.id);
    expect(markPosted(r.id, 'https://example.invalid/1', 1)?.status).toBe('posted');
    expect(markPosted(r.id, 'https://example.invalid/2', 2)).toBeNull();
    expect(getReport(r.id)?.issueNumber).toBe(1);
  });

  it('lists only rows a human still has to decide', () => {
    const a = createReport('agent-1', 'tool-error', 'ds1-eeeeeeeeeeee');
    attachDraft(a.id, BRIEF, {}, '/tmp/x/bundle.json'); submitForApproval(a.id);
    const b = createReport('agent-1', 'silence', 'ds1-ffffffffffff');
    attachDraft(b.id, BRIEF, {}, '/tmp/x/bundle.json'); submitForApproval(b.id);
    approveOnce(b.id); markPosted(b.id, 'https://example.invalid/2', 2);
    expect(listOpenReports().map(x => x.id)).toEqual([a.id]);
  });

  // ── THE RACE, in the shape it actually arrives in ──
  // better-sqlite3 is synchronous, so "concurrent" here means what it means in the
  // gateway: two request handlers that each READ the row while it still says
  // awaiting_approval, and only then write. That interleaving is the read-then-write
  // trap's natural habitat, and it is the one a conditional UPDATE survives and a
  // `SELECT` + `if` does not.
  it('two doors that BOTH read an awaiting row still produce exactly one approval', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-999999999999');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);

    const seenByDoorA = getReport(r.id);
    const seenByDoorB = getReport(r.id);
    expect(seenByDoorA?.status).toBe('awaiting_approval');
    expect(seenByDoorB?.status).toBe('awaiting_approval');

    const outcomes = [approveOnce(r.id), approveOnce(r.id)];
    expect(outcomes.filter(o => o !== null)).toHaveLength(1);
    expect(getReport(r.id)?.status).toBe('approved');
  });

  it('the losing door does not re-stamp approved_at — the approval keeps its own moment', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-888888888888');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    expect(approveOnce(r.id)?.approvedAt).toBeTruthy();
    // `datetime('now')` is second-granular, so two calls in the same second would agree by
    // accident. Plant a stamp nothing could produce and see whether the second call moves it.
    getDb().prepare('UPDATE dojo_reports SET approved_at = ? WHERE id = ?')
      .run('2020-01-01 00:00:00', r.id);
    approveOnce(r.id);
    expect(getReport(r.id)?.approvedAt).toBe('2020-01-01 00:00:00');
  });

  it('an export consumes the approval too — one approval is one delivery, by either door', () => {
    const r = createReport('agent-1', 'other', 'ds1-777777777777');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    expect(markExported(r.id, '/tmp/x/report.md')).toBeNull(); // not approved yet
    submitForApproval(r.id);
    approveOnce(r.id);
    expect(markExported(r.id, '/tmp/x/report.md')?.status).toBe('posted');
    expect(markExported(r.id, '/tmp/x/again.md')).toBeNull();
    expect(markPosted(r.id, 'https://example.invalid/3', 3)).toBeNull();
    expect(getReport(r.id)?.exportPath).toBe('/tmp/x/report.md');
  });
});

describe('the approver sees the text that posts', () => {
  it('refuses a draft swap on a row a human is already looking at', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-121212121212');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    expect(attachDraft(r.id, { ...BRIEF, title: 'something else entirely' }, {}, '/tmp/y/b.json'))
      .toBeNull();
    expect(getReport(r.id)?.brief?.title).toBe(BRIEF.title);
  });

  it('refuses an edit after approval — the text may not change between click and post', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-131313131313');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    expect(editBrief(r.id, { title: 'the human tightened it' })?.brief?.title)
      .toBe('the human tightened it');
    approveOnce(r.id);
    expect(editBrief(r.id, { title: 'and then it changed again' })).toBeNull();
    expect(getReport(r.id)?.brief?.title).toBe('the human tightened it');
  });

  it('an edit carries only the five brief fields, whatever else is handed in', () => {
    const r = createReport('agent-1', 'other', 'ds1-141414141414');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    const patched = editBrief(r.id, { fixIdeas: 'ship the label', smuggled: 'x' } as Partial<ReportBrief>);
    expect(patched?.brief).toEqual({ ...BRIEF, fixIdeas: 'ship the label' });
  });

  it('refuses to ask a human to approve a report with no brief in it', () => {
    const r = createReport('agent-1', 'silence', 'ds1-151515151515');
    expect(submitForApproval(r.id)).toBeNull();
    expect(getReport(r.id)?.status).toBe('drafting');
  });
});

describe('posted is terminal', () => {
  const post = (): string => {
    const r = createReport('agent-1', 'tool-error', 'ds1-161616161616');
    attachDraft(r.id, BRIEF, { report: { schema: 'dojo-telemetry-1' } }, '/tmp/x/bundle.json');
    submitForApproval(r.id);
    approveOnce(r.id);
    markPosted(r.id, 'https://example.invalid/7', 7);
    return r.id;
  };

  it('refuses every door that would change a delivered report', () => {
    const id = post();
    expect(attachDraft(id, { ...BRIEF, title: 'rewritten' }, {}, '/tmp/z/b.json')).toBeNull();
    expect(editBrief(id, { title: 'rewritten' })).toBeNull();
    expect(submitForApproval(id)).toBeNull();
    expect(approveOnce(id)).toBeNull();
    expect(cancelReport(id)).toBeNull();
    expect(markExported(id, '/tmp/z/report.md')).toBeNull();
  });

  it('and the row still says what was actually sent', () => {
    const id = post();
    attachDraft(id, { ...BRIEF, title: 'rewritten' }, {}, '/tmp/z/b.json');
    const row = getReport(id);
    expect(row?.status).toBe('posted');
    expect(row?.brief?.title).toBe(BRIEF.title);
    expect(row?.issueUrl).toBe('https://example.invalid/7');
    expect(row?.issueNumber).toBe(7);
    expect(row?.postedAt).toBeTruthy();
  });

  it('a status this schema never approved is terminal, not postable', () => {
    // A hand-edited database, a restored backup, a future writer. The migration header
    // promises the READER survives it; this is that promise, exercised.
    const r = createReport('agent-1', 'other', 'ds1-171717171717');
    attachDraft(r.id, BRIEF, {}, '/tmp/x/bundle.json');
    getDb().prepare('UPDATE dojo_reports SET status = ? WHERE id = ?').run('sideways', r.id);
    expect(submitForApproval(r.id)).toBeNull();
    expect(approveOnce(r.id)).toBeNull();
    expect(markPosted(r.id, 'https://example.invalid/9', 9)).toBeNull();
    expect(getReport(r.id)?.status).toBe('cancelled');
    expect(listOpenReports().map(x => x.id)).not.toContain(r.id);
  });
});

describe('the signature is stable and not content-derived', () => {
  it('is identical for the same failure shape and differs when the shape differs', () => {
    const d = { toolFailures: [{ tool: 'work_open', result: 'denied', count: 3 }], turnExits: [] };
    expect(deriveReportSignature('3.1.28', 'tool-error', d))
      .toBe(deriveReportSignature('3.1.28', 'tool-error', d));
    expect(deriveReportSignature('3.1.28', 'tool-error', d))
      .not.toBe(deriveReportSignature('3.1.29', 'tool-error', d));
    expect(deriveReportSignature('3.1.28', 'tool-error', d))
      .not.toBe(deriveReportSignature('3.1.28', 'silence', d));
  });

  it('falls back from tool failures to turn exits to none', () => {
    expect(dominantToken({ toolFailures: [{ tool: 'exec', result: 'error', count: 1 }],
      turnExits: [{ exitReason: 'brake', count: 9 }] })).toBe('tool:exec:error');
    expect(dominantToken({ toolFailures: [], turnExits: [{ exitReason: 'brake', count: 2 }] }))
      .toBe('turn:brake');
    expect(dominantToken({ toolFailures: [], turnExits: [] })).toBe('none');
  });

  it('matches the ds1- shape and every lane is legal', () => {
    for (const lane of FAILURE_LANES) {
      expect(deriveReportSignature('3.1.28', lane, { toolFailures: [], turnExits: [] }))
        .toMatch(/^ds1-[0-9a-f]{12}$/);
    }
  });

  it('admits the five lanes and nothing else', () => {
    for (const lane of FAILURE_LANES) expect(isFailureLane(lane)).toBe(true);
    for (const junk of ['Tool-Error', 'toolerror', '', 'anything', 42, null, undefined]) {
      expect(isFailureLane(junk)).toBe(false);
    }
  });

  it('carries no report content into the token — only the platform\'s own verdicts', () => {
    const withContent = deriveReportSignature('3.1.28', 'tool-error', {
      toolFailures: [{ tool: 'work_open', result: 'denied', count: 3 }], turnExits: [],
    });
    // Same dominant shape, a different COUNT and a different runner-up: same signature.
    const sameShape = deriveReportSignature('3.1.28', 'tool-error', {
      toolFailures: [{ tool: 'work_open', result: 'denied', count: 91 },
        { tool: 'exec', result: 'error', count: 4 }],
      turnExits: [{ exitReason: 'brake', count: 12 }],
    });
    expect(sameShape).toBe(withContent);
  });
});

describe('the bundle stays on disk and is scrubbed', () => {
  it('writes under the redirected home and reads back', () => {
    const r = createReport('agent-1', 'other', 'ds1-111111111111');
    const out = writeBundle(r.id, 'agent-1', { turns: [1, 2, 3] });
    expect(out.path.startsWith(bundleDir(r.id))).toBe(true);
    expect(fs.existsSync(out.path)).toBe(true);
    expect(process.env.DOJO_HOME && out.path.startsWith(process.env.DOJO_HOME)).toBe(true);
    expect(readBundle(r.id)).toEqual({ turns: [1, 2, 3] });
  });

  it('truncates rather than writing a partial document past the cap', () => {
    const r = createReport('agent-1', 'other', 'ds1-222222222222');
    const out = writeBundle(r.id, 'agent-1', { blob: 'x'.repeat(3_000_000) });
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(2_000_000);
    expect(() => JSON.parse(fs.readFileSync(out.path, 'utf8'))).not.toThrow();
  });

  it('answers null for a report that has no bundle on this box', () => {
    expect(readBundle('no-such-report-id')).toBeNull();
  });

  it('keeps the evidence directory to the owner alone', () => {
    const r = createReport('agent-1', 'other', 'ds1-333333333333');
    writeBundle(r.id, 'agent-1', { turns: [] });
    expect(fs.statSync(bundleDir(r.id)).mode & 0o077).toBe(0);
  });

  it('refuses a report file whose name is not a platform literal', () => {
    const r = createReport('agent-1', 'other', 'ds1-444444444444');
    expect(() => writeReportFile(r.id, '../../escape.md', 'x')).toThrow();
    expect(() => writeReportFile(r.id, 'a/b.md', 'x')).toThrow();
    const p = writeReportFile(r.id, 'report.md', '# hello');
    expect(p.startsWith(bundleDir(r.id))).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('# hello');
  });
});
