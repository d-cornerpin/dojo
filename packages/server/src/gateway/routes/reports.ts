// The preview card is the only door: the user sees the exact text before anything posts.
// 1. `POST /:id/approve` is the one place `approveOnce` is called in the whole tree.
// 2. The edit door is `editBrief`, never the agent's `attachDraft` (legal only from `drafting`): a
//    route reaching it could swap the brief the owner is reading. Only the five brief fields are accepted.
// 3. Saving is never approving: a successful PATCH answers the row and the owner presses Post.
// 4. `editBrief` can throw (SQLite busy snapshot) as well as answer null: null is "already
//    decided", a throw is "the save did not happen, try again". `approveOnce` null is likewise
//    "already decided", never 404.
// 5. The approval is consumed before the send; when nothing is delivered it is handed back with
//    `releaseApproval` so a report never strands in `approved`.

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { githubStatus } from '../../github/status.js';
import { exportReport } from '../../report/export.js';
import {
  approveOnce, cancelReport, editBrief, getReport, listOpenReports, markExported, releaseApproval,
  type ReportStatus,
} from '../../report/store.js';
import { DUPLICATE_ANSWER_HELP, parsePostChoice, postApprovedReport } from '../../report/post.js';
import { reportRepo } from '../../report/repo.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { routeFailure } from './route-failure.js';

const logger = createLogger('report-routes');

export const reportsRouter = new Hono<AppEnv>();

/** The five brief fields, each optional; kept here so the accept and refuse lists sit together. */
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

/** Columns this door does not own, refused ahead of the schema with the door that does own them. */
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

function editRefusal(status: ReportStatus): string {
  if (status === 'approved' || status === 'posted') {
    return 'This report was already approved — the text is frozen. What you read is what was '
      + 'delivered. Nothing to retry.';
  }
  if (status === 'cancelled') return 'This report was cancelled. Nothing more happens to it.';
  return 'This report has not been submitted for your decision yet, so there is nothing to edit.';
}

// `listOpenReports` is awaiting_approval only. `destinationRepo` comes from `reportRepo()`, which the
// poster and export also call, so the card cannot name a destination delivery would not use.
reportsRouter.get('/', (c) => {
  return c.json({ ok: true, data: listOpenReports(), destinationRepo: reportRepo() });
});


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
    if (!row) return c.json({ ok: false, error: editRefusal(getReport(id)?.status ?? 'cancelled') }, 409);
    return c.json({ ok: true, data: row });
  } catch (err) {
    // A lost write race is a save that did not happen, not a broken server: tell the owner to save again.
    return routeFailure(c, logger, err, {
      status: 500, level: 'warn',
      message: 'That edit did not save — the report was being written by something else at the '
        + 'same moment. Your text is still here; press Save again.',
    });
  }
});


reportsRouter.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const existing = getReport(id);
  if (!existing) return c.json({ ok: false, error: NOT_FOUND }, 404);

  // Optional body: only the owner's answer to a duplicate already shown; unreadable counts as none.
  const choice = parsePostChoice(await c.req.json().catch(() => null));
  if (choice === 'invalid') return c.json({ ok: false, error: DUPLICATE_ANSWER_HELP }, 400);

  // Consume the approval, then send, so nothing is delivered that was not approved; when nothing
  // is delivered the decision is handed back below.
  const approved = approveOnce(id);
  if (!approved) {
    return c.json({ ok: false, error: 'This report was already decided, it is '
      + `${existing.status}. One approval, one delivery.` }, 409);
  }

  if (githubStatus().connected) {
    const outcome = await postApprovedReport(id, choice);
    if (outcome.kind === 'created' || outcome.kind === 'commented') {
      broadcast({ type: 'report:resolved', data: { id, status: 'posted' } });
      // `labelsDropped` rides the success answer: the issue landed unlabelled and only the owner can label it.
      return c.json({ ok: true, data: { status: 'posted', exportPath: null,
        issueUrl: outcome.issueUrl, issueNumber: outcome.issueNumber,
        labelsDropped: outcome.kind === 'created' ? outcome.labelsDropped : null } });
    }
    // Nothing left the box, so return the approval: the row goes back on the card, decidable.
    // Leaving it `approved` would strand it off the list the card reads.
    releaseApproval(id);
    if (outcome.kind === 'duplicate-found') {
      return c.json({ ok: true, data: { status: 'awaiting_approval', issueUrl: null,
        issueNumber: null, exportPath: null, duplicate: outcome.match } });
    }
    return routeFailure(c, logger, new Error(outcome.error),
      { status: 502, level: 'warn', message: outcome.error });
  }

  const exported = exportReport(id);
  if (!exported) {
    return routeFailure(c, logger, new Error(`report ${id} had no brief to export`),
      { status: 500, message: 'The report could not be written to a file. Nothing was sent.' });
  }
  // `markExported` consumes the approval like `markPosted`: one approval is one delivery either way.
  const delivered = markExported(id, exported.filePath);
  // Unreachable through this route (`approveOnce` already won the row); kept as defensive depth.
  if (!delivered) return c.json({ ok: false, error: 'This report was already delivered.' }, 409);
  broadcast({ type: 'report:resolved', data: { id, status: 'posted' } });
  return c.json({ ok: true, data: {
    status: delivered.status, issueUrl: delivered.issueUrl, issueNumber: delivered.issueNumber,
    exportPath: delivered.exportPath, newIssueUrl: exported.newIssueUrl,
    bodyWasTrimmed: exported.bodyWasTrimmed, reportText: exported.reportText,
  } });
});


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
