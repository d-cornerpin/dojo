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
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import {
  createReport, getReport, attachDraft, editBrief, submitForApproval, approveOnce, markPosted,
  markExported, cancelReport, listOpenReports, releaseApproval, type ReportBrief,
} from '../store.js';
import { deriveReportSignature, dominantToken, FAILURE_LANES, isFailureLane } from '../signature.js';
import {
  bundleDir, writeBundle, readBundle, writeReportFile,
  MAX_REPORT_DIRS, REPORT_BUNDLE_MAX_BYTES,
} from '../bundle.js';
import {
  noteHandedCredentialValues, redactedPlaceholderFor, forgetHandedCredentialValues,
} from '../../credentials/secret-values.js';

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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: { report: { schema: 'dojo-telemetry-1' } }, bundlePath: '/tmp/x/bundle.json' });
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    submitForApproval(r.id);
    cancelReport(r.id);
    expect(approveOnce(r.id)).toBeNull();
  });

  it('posts exactly once, and only from approved', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-dddddddddddd');
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    expect(markPosted(r.id, 'https://example.invalid/1', 1)).toBeNull(); // not approved yet
    submitForApproval(r.id);
    approveOnce(r.id);
    expect(markPosted(r.id, 'https://example.invalid/1', 1)?.status).toBe('posted');
    expect(markPosted(r.id, 'https://example.invalid/2', 2)).toBeNull();
    expect(getReport(r.id)?.issueNumber).toBe(1);
  });

  it('lists only rows a human still has to decide', () => {
    const a = createReport('agent-1', 'tool-error', 'ds1-eeeeeeeeeeee');
    attachDraft(a.id, { lane: a.lane, signature: a.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' }); submitForApproval(a.id);
    const b = createReport('agent-1', 'silence', 'ds1-ffffffffffff');
    attachDraft(b.id, { lane: b.lane, signature: b.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' }); submitForApproval(b.id);
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    expect(markExported(r.id, '/tmp/x/report.md')).toBeNull(); // not approved yet
    submitForApproval(r.id);
    approveOnce(r.id);
    expect(markExported(r.id, '/tmp/x/report.md')?.status).toBe('posted');
    expect(markExported(r.id, '/tmp/x/again.md')).toBeNull();
    expect(markPosted(r.id, 'https://example.invalid/3', 3)).toBeNull();
    expect(getReport(r.id)?.exportPath).toBe('/tmp/x/report.md');
  });
});

// ── the one transition that runs backwards (T7) ─────────────────────────────────────────
// The route mints the approval BEFORE it sends (C3's consume-then-send, so nothing can be
// delivered that was not approved). An approval that buys no delivery therefore has to be
// given back, or the row sits in `approved` forever: off `listOpenReports` (C1) and refused by
// `approveOnce`. Everything below is about that door being narrow enough to be safe.

describe('an approval that bought no delivery is handed back', () => {
  const ready = (signature: string): string => {
    const r = createReport('agent-1', 'tool-error', signature);
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    submitForApproval(r.id);
    return r.id;
  };

  it('puts the row back on the card and un-stamps a decision nobody got the benefit of', () => {
    const id = ready('ds1-a1a1a1a1a1a1');
    approveOnce(id);
    expect(listOpenReports().map(r => r.id)).not.toContain(id);

    expect(releaseApproval(id)?.status).toBe('awaiting_approval');
    expect(getReport(id)?.approvedAt, 'a decision was left recorded that bought nothing').toBeNull();
    expect(getReport(id)?.postedAt).toBeNull();
    expect(listOpenReports().map(r => r.id), 'the report never came back to the card').toContain(id);
  });

  it('REFUSES a delivered row — a posted report can never be un-posted', () => {
    const id = ready('ds1-b2b2b2b2b2b2');
    approveOnce(id);
    markPosted(id, 'https://example.invalid/5', 5);
    expect(releaseApproval(id), 'a delivered report was handed back to the card').toBeNull();
    expect(getReport(id)?.status).toBe('posted');
    expect(getReport(id)?.issueNumber).toBe(5);

    const exported = ready('ds1-c3c3c3c3c3c3');
    approveOnce(exported);
    markExported(exported, '/tmp/x/report.md');
    expect(releaseApproval(exported)).toBeNull();
    expect(getReport(exported)?.exportPath).toBe('/tmp/x/report.md');
  });

  it('refuses every status but `approved`, so it can only ever give back an approval', () => {
    const drafting = createReport('agent-1', 'other', 'ds1-d4d4d4d4d4d4');
    expect(releaseApproval(drafting.id)).toBeNull();
    const submitted = ready('ds1-e5e5e5e5e5e5');
    expect(releaseApproval(submitted)).toBeNull();
    cancelReport(submitted);
    expect(releaseApproval(submitted)).toBeNull();
    expect(releaseApproval('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('one approval is still one delivery after a round trip through the card', () => {
    const id = ready('ds1-f6f6f6f6f6f6');
    approveOnce(id);
    releaseApproval(id);
    // The owner may edit again — the text is no longer frozen, because nothing was published.
    expect(editBrief(id, { title: 'the owner tightened it' })?.brief?.title)
      .toBe('the owner tightened it');
    expect(approveOnce(id)?.status).toBe('approved');
    expect(markPosted(id, 'https://example.invalid/6', 6)?.status).toBe('posted');
    expect(markExported(id, '/tmp/x/report.md'), 'a second delivery followed one approval').toBeNull();
    expect(releaseApproval(id)).toBeNull();
  });
});

describe('the approver sees the text that posts', () => {
  it('refuses a draft swap on a row a human is already looking at', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-121212121212');
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    submitForApproval(r.id);
    expect(attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: { ...BRIEF, title: 'something else entirely' }, telemetry: {}, bundlePath: '/tmp/y/b.json' }))
      .toBeNull();
    expect(getReport(r.id)?.brief?.title).toBe(BRIEF.title);
  });

  it('refuses an edit after approval — the text may not change between click and post', () => {
    const r = createReport('agent-1', 'tool-error', 'ds1-131313131313');
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
    submitForApproval(r.id);
    expect(editBrief(r.id, { title: 'the human tightened it' })?.brief?.title)
      .toBe('the human tightened it');
    approveOnce(r.id);
    expect(editBrief(r.id, { title: 'and then it changed again' })).toBeNull();
    expect(getReport(r.id)?.brief?.title).toBe('the human tightened it');
  });

  it('an edit carries only the five brief fields, whatever else is handed in', () => {
    const r = createReport('agent-1', 'other', 'ds1-141414141414');
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: { report: { schema: 'dojo-telemetry-1' } }, bundlePath: '/tmp/x/bundle.json' });
    submitForApproval(r.id);
    approveOnce(r.id);
    markPosted(r.id, 'https://example.invalid/7', 7);
    return r.id;
  };

  it('refuses every door that would change a delivered report', () => {
    const id = post();
    expect(attachDraft(id, { lane: 'tool-error', signature: 'ds1-161616161616', brief: { ...BRIEF, title: 'rewritten' }, telemetry: {}, bundlePath: '/tmp/z/b.json' })).toBeNull();
    expect(editBrief(id, { title: 'rewritten' })).toBeNull();
    expect(submitForApproval(id)).toBeNull();
    expect(approveOnce(id)).toBeNull();
    expect(cancelReport(id)).toBeNull();
    expect(markExported(id, '/tmp/z/report.md')).toBeNull();
  });

  it('and the row still says what was actually sent', () => {
    const id = post();
    attachDraft(id, { lane: 'tool-error', signature: 'ds1-161616161616', brief: { ...BRIEF, title: 'rewritten' }, telemetry: {}, bundlePath: '/tmp/z/b.json' });
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
    attachDraft(r.id, { lane: r.lane, signature: r.signature, brief: BRIEF, telemetry: {}, bundlePath: '/tmp/x/bundle.json' });
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

  // ── THE CAP BINDS THE FINAL BYTES, MARKER INCLUDED ──
  // The one shape that breaches a cap by announcing it: the marker names the keys it
  // dropped, and a key NAME is unbounded. Measured before the fix: 100 keys of 40,000
  // characters wrote 4,001,111 bytes against a 2,000,000 cap while honestly reporting
  // `truncated: true`. A cap that holds only for well-behaved callers is not a cap.
  it('caps the truncation marker itself — a bundle with enormous KEY NAMES', () => {
    const r = createReport('agent-1', 'other', 'ds1-aaaabbbbcccc');
    const bundle: Record<string, number> = {};
    for (let i = 0; i < 100; i++) bundle[String(i).padStart(3, '0') + 'k'.repeat(39_997)] = 1;
    const out = writeBundle(r.id, 'agent-1', bundle);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(REPORT_BUNDLE_MAX_BYTES);
    expect(fs.statSync(out.path).size).toBeLessThanOrEqual(REPORT_BUNDLE_MAX_BYTES);
    const doc = JSON.parse(fs.readFileSync(out.path, 'utf8')) as { truncated: boolean; keptKeys: string[] };
    expect(doc.truncated).toBe(true);
    // The keys are what made it enormous, so they are what goes — not the marker.
    expect(doc.keptKeys).toEqual([]);
  });

  it('still names the keys it dropped when naming them fits', () => {
    const r = createReport('agent-1', 'other', 'ds1-ddddeeeeffff');
    const out = writeBundle(r.id, 'agent-1', { turns: 'x'.repeat(3_000_000), calls: 1 });
    const doc = JSON.parse(fs.readFileSync(out.path, 'utf8')) as { keptKeys: string[] };
    expect(doc.keptKeys).toEqual(['turns', 'calls']);
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

  // ── THE SCRUB, held by a clause rather than by the describe block's title ──
  // `redactHandedCredentials` is per-AGENT, so the second half is the control: the same
  // bytes written under a different agent id keep the value. Without it this clause would
  // also pass if the scrub matched nothing at all.
  it('scrubs a credential THIS agent handled out of the bytes it writes', () => {
    const SECRET = 'sk-live-9f2c1a0b4d77e3';
    noteHandedCredentialValues('agent-holder', [SECRET]);
    try {
      const mine = createReport('agent-holder', 'other', 'ds1-555555555555');
      const out = writeBundle(mine.id, 'agent-holder', {
        toolCalls: [{ header: `Authorization: Bearer ${SECRET}` }],
      });
      const onDisk = fs.readFileSync(out.path, 'utf8');
      expect(onDisk).not.toContain(SECRET);
      expect(onDisk).toContain(redactedPlaceholderFor('agent-holder', SECRET));

      // CONTROL: another agent never handled it, so nothing is rewritten for them.
      const theirs = createReport('agent-other', 'other', 'ds1-666666666666');
      const out2 = writeBundle(theirs.id, 'agent-other', {
        toolCalls: [{ header: `Authorization: Bearer ${SECRET}` }],
      });
      expect(fs.readFileSync(out2.path, 'utf8')).toContain(SECRET);
    } finally {
      forgetHandedCredentialValues('agent-holder');
    }
  });
});

// ── THE PATH BOUNDARY ──
// This block exists because of what rests on it OUTSIDE this file. `report/bundle.ts`
// holds a `node:fs` import that `deploy/checks/effect-import-exclusions.mjs` admits and
// the argued `no-restricted-imports` 82→83 raise pays for, and BOTH argue the same
// sentence: the path segments cannot express `..` or a separator, so no agent can steer
// the destination. An argued exception to a security gate may not rest on an untested
// regex — these clauses are that sentence, driven.
describe('nothing can be steered out of the reports directory', () => {
  const HOSTILE = ['../../x', '..', '../etc', 'a/b', '/abs', 'x\0y', '.hidden', 'a'.repeat(200), ''];
  const reportsRoot = (): string => path.dirname(bundleDir('probe'));

  it('refuses a traversal REPORT ID at every door that takes one', () => {
    for (const id of HOSTILE) {
      const where = JSON.stringify(id);
      expect(() => bundleDir(id), `bundleDir(${where})`).toThrow();
      expect(() => writeBundle(id, 'agent-1', { x: 1 }), `writeBundle(${where})`).toThrow();
      expect(() => writeReportFile(id, 'report.md', 'x'), `writeReportFile(${where})`).toThrow();
      // The reader refuses too, but as a reader: a malformed id is "no bundle here".
      expect(readBundle(id), `readBundle(${where})`).toBeNull();
    }
  });

  it('and the ids the platform actually mints all land inside that directory', () => {
    // The generator side of the same claim: the door is only safe if what the platform
    // puts through it always passes. 50 real ids, every one contained.
    const root = path.resolve(reportsRoot());
    for (let i = 0; i < 50; i++) {
      const r = createReport('agent-1', 'other', 'ds1-777777777777');
      expect(() => bundleDir(r.id)).not.toThrow();
      expect(path.resolve(bundleDir(r.id)).startsWith(root + path.sep)).toBe(true);
    }
  });

  it('keeps the newest MAX_REPORT_DIRS report directories and sweeps the rest', () => {
    for (let i = 0; i < MAX_REPORT_DIRS + 5; i++) {
      const r = createReport('agent-1', 'other', 'ds1-888888888888');
      writeBundle(r.id, 'agent-1', { i });
    }
    expect(fs.readdirSync(reportsRoot()).length).toBeLessThanOrEqual(MAX_REPORT_DIRS);
  });
});
