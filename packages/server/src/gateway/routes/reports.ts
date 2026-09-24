// ════════════════════════════════════════════════════════════════════════════════════════
// THE PREVIEW CARD IS THE ONLY DOOR (DOJO-REPORT T6).
//
// Owner ruling D4 is absolute: *"The user sees the exact text before anything posts. No preview,
// no post."* This file is that ruling's only entrance, and every shape below is the ruling
// rather than bookkeeping.
//
//  1. `POST /:id/approve` IS THE ONE PLACE `approveOnce` IS CALLED, IN THE WHOLE TREE. Two
//     guards hold that from different directions: `__tests__/only-the-card-can-post-a-report
//     .test.ts` walks the source and asserts the CALL-SITE set is exactly this file;
//     `agent/tools/__tests__/the-report-tool-reaches-no-new-door.test.ts` walks the IMPORT graph
//     and requires every module BINDING a consent door to be named on ALLOWED_CONSENT_CALLERS —
//     and this file's one-line addition to that list IS the review that grants posting rights.
//
//  2. THE EDIT DOOR IS NARROW, AND IT IS `editBrief` — NEVER `attachDraft` (contract C2).
//     `attachDraft` is the AGENT's write door, legal only from `drafting`; a route that reached
//     it could swap the brief a human is looking at, which is exactly what D4 forbids. The name
//     does not appear in this file and a clause reads this file's text to keep it that way.
//     T66b's rule in its own words: *"each door owns its own columns, the user sees one button,
//     and a field the user did not touch is never mentioned in any request."* So the five brief
//     fields are all this door accepts, and the columns other doors own are refused BY NAME with
//     a sentence pointing at the right door — `.strict()`'s "unrecognized key" is true and
//     useless to the person reading it.
//
//  3. SAVING IS NEVER APPROVING. A successful PATCH answers the row and nothing else: the card
//     returns to the preview, the owner re-reads, and the owner presses Post.
//
//  4. `editBrief` CAN THROW, NOT ONLY ANSWER NULL (contract C8) — it is the one door with a
//     transaction, and under concurrent writers SQLite raises SQLITE_BUSY_SNAPSHOT. Both
//     branches exist below and they say DIFFERENT things: null is "somebody already decided
//     this", a throw is "the save did not happen, try again".
//
//  5. `approveOnce` ANSWERING NULL IS "ALREADY DECIDED", NEVER 404 (contract C4). The row is
//     there; it is simply no longer awaiting a decision, and the sentence says so.
//
// ── WHERE THE REQUEST SCHEMA LIVES, AND WHY IT IS NOT IN `config/schema.ts` ──
// The plan names `config/schema.ts`. Measured at this HEAD it is 240 lines, its growth baseline
// is 240, and the growth detector's crossing line for an unpinned file is exactly 240 (60% of
// the 400-line cap) — so ANY addition to it, including a comment, fails a blocking gate.
// Splitting is the plan's own instruction for that case, and the seam it leaves is the better
// one: this door's ACCEPT list and its REFUSE list are one decision, and they are now adjacent.
// ════════════════════════════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { githubStatus } from '../../github/status.js';
import { exportReport } from '../../report/export.js';
import {
  approveOnce, cancelReport, editBrief, getReport, listOpenReports, markExported,
  type ReportStatus,
} from '../../report/store.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { routeFailure } from './route-failure.js';

const logger = createLogger('report-routes');

export const reportsRouter = new Hono<AppEnv>();

/** The five brief fields, each optional, nothing else. `.strict()` is the floor, not the wall. */
export const EditReportSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  whatHappened: z.string().min(1).max(8000).optional(),
  whatShouldHaveHappened: z.string().min(1).max(8000).optional(),
  whyItWentWrong: z.string().min(1).max(8000).optional(),
  fixIdeas: z.string().min(1).max(8000).optional(),
}).strict()
  .refine(b => Object.keys(b).length > 0, {
    message: 'Body must name at least one of `title`, `whatHappened`, `whatShouldHaveHappened`, '
      + '`whyItWentWrong` or `fixIdeas`',
  });

/**
 * The columns this door does NOT own, each named with the door that does. Refused ahead of the
 * schema, because a person reading "Unrecognized key: status" learns nothing about where a status
 * actually changes — and every field here would, if it landed, change something the owner has
 * already read and approved.
 */
const OTHER_DOORS: Readonly<Record<string, string>> = {
  status: 'A report moves with POST /api/reports/:id/approve or /cancel, never with an edit.',
  signature: 'The signature is derived from the failure shape when the agent drafts the report.',
  telemetry: 'The attachment is built by the platform from a fixed whitelist and takes no input.',
  issueUrl: 'The issue link is recorded by the poster, after the owner approves.',
  issueNumber: 'The issue number is recorded by the poster, after the owner approves.',
  exportPath: 'The file path is recorded by the export, after the owner approves.',
  lane: 'The failure lane is chosen by the agent at draft time.',
  bundlePath: 'The raw evidence bundle stays on this box and is not addressable over HTTP.',
  agentId: 'A report belongs to the agent that filed it.',
};

const NOT_FOUND = 'No such report. It may have been cancelled, or this box may have been reset.';

/** Why an edit is refused. Each status gets its own sentence; "failed" is not one of them. */
function editRefusal(status: ReportStatus): string {
  if (status === 'approved' || status === 'posted') {
    return 'This report was already approved — the text is frozen. What you read is what was '
      + 'delivered. Nothing to retry.';
  }
  if (status === 'cancelled') return 'This report was cancelled. Nothing more happens to it.';
  return 'This report has not been submitted for your decision yet, so there is nothing to edit.';
}

// ── the two reads the card lives on ─────────────────────────────────────────────────────
// `listOpenReports` is `awaiting_approval` ONLY (contract C1): a drafting row has no brief to
// show and a decided one is already decided. A card with no decision in it is how a gate
// becomes a habit.
reportsRouter.get('/', (c) => {
  return c.json({ ok: true, data: listOpenReports() });
});

reportsRouter.get('/:id', (c) => {
  const row = getReport(c.req.param('id'));
  if (!row) return c.json({ ok: false, error: NOT_FOUND }, 404);
  return c.json({ ok: true, data: row });
});

// ── the owner's own edit ────────────────────────────────────────────────────────────────

reportsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as unknown;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ ok: false, error: 'Body must be a JSON object naming one or more of the '
      + 'five brief fields.' }, 400);
  }
  for (const [field, owner] of Object.entries(OTHER_DOORS)) {
    if (field in (body as Record<string, unknown>)) {
      return c.json({ ok: false, error: `\`${field}\` is not the edit door's to change. ${owner}` }, 400);
    }
  }
  const parsed = EditReportSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  const existing = getReport(id);
  if (!existing) return c.json({ ok: false, error: NOT_FOUND }, 404);
  if (existing.status !== 'awaiting_approval') {
    return c.json({ ok: false, error: editRefusal(existing.status) }, 409);
  }

  try {
    const row = editBrief(id, parsed.data);
    // C4's shape, one door over: null is a VERDICT ("the row moved out from under this edit"),
    // and the row's current status is the honest sentence for it.
    if (!row) return c.json({ ok: false, error: editRefusal(getReport(id)?.status ?? 'cancelled') }, 409);
    return c.json({ ok: true, data: row });
  } catch (err) {
    // C8. A transaction that lost a write race is not a broken server and not a frozen report:
    // it is a save that did not happen, and the only honest instruction is to save again.
    return routeFailure(c, logger, err, {
      status: 500, level: 'warn',
      message: 'That edit did not save — the report was being written by something else at the '
        + 'same moment. Your text is still here; press Save again.',
    });
  }
});

// ── THE ONE DOOR ────────────────────────────────────────────────────────────────────────

reportsRouter.post('/:id/approve', (c) => {
  const id = c.req.param('id');
  const existing = getReport(id);
  if (!existing) return c.json({ ok: false, error: NOT_FOUND }, 404);

  // ⚠ THE T7 SEAM, AHEAD OF `approveOnce` ON PURPOSE. When a token is here the sender is T7's
  // `postApprovedReport(id)`. Until that exists a connected box is told plainly and the owner's
  // approval IS NOT SPENT — the report is still `awaiting_approval`, still on the card, still
  // theirs to decide. Burning the one approval to discover there is nobody to deliver it is the
  // shape D4 exists to prevent. T7 replaces this block and keeps the order: consume, then send.
  if (githubStatus().connected) {
    return c.json({ ok: false, error: 'Posting to GitHub is not wired up in this build yet. Your '
      + 'report is untouched and still waiting for you.' }, 503);
  }

  const approved = approveOnce(id);
  // C4: the row exists. It is simply no longer awaiting a decision.
  if (!approved) {
    return c.json({ ok: false, error: 'This report was already decided — it is '
      + `${existing.status}. One approval, one delivery.` }, 409);
  }

  const exported = exportReport(id);
  if (!exported) {
    return routeFailure(c, logger, new Error(`report ${id} had no brief to export`),
      { status: 500, message: 'The report could not be written to a file. Nothing was sent.' });
  }
  // `markExported` CONSUMES the approval, exactly as `markPosted` does (C3): D4 binds the export
  // door too, so one approval is one delivery whichever way the report leaves.
  const delivered = markExported(id, exported.filePath);
  if (!delivered) {
    return c.json({ ok: false, error: 'This report was already delivered.' }, 409);
  }
  broadcast({ type: 'report:resolved', data: { id, status: 'posted' } });
  return c.json({ ok: true, data: {
    status: delivered.status,
    issueUrl: delivered.issueUrl,
    issueNumber: delivered.issueNumber,
    exportPath: delivered.exportPath,
    // Beyond the plan's four, and needed by the card rather than nice to have: without these the
    // owner is told a file was written and given no way to post it, which is half of D2.
    newIssueUrl: exported.newIssueUrl,
    bodyWasTrimmed: exported.bodyWasTrimmed,
  } });
});

// ── the safe direction ──────────────────────────────────────────────────────────────────

reportsRouter.post('/:id/cancel', (c) => {
  const id = c.req.param('id');
  const existing = getReport(id);
  if (!existing) return c.json({ ok: false, error: NOT_FOUND }, 404);
  const row = cancelReport(id);
  if (!row) {
    return c.json({ ok: false, error: `This report is ${existing.status} and cannot be cancelled.` }, 409);
  }
  broadcast({ type: 'report:resolved', data: { id, status: 'cancelled' } });
  return c.json({ ok: true, data: { status: 'cancelled' } });
});
