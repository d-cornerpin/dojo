// ════════════════════════════════════════════════════════════════════════════
// DOJO REPORT: gather, draft, submit. No phase here can send; that is the feature.
// LAW 1: this module cannot publish by construction; `the-report-tool-cannot-post` asserts the import list.
// LAW 2: agent strings reach the brief only; the telemetry builder has no parameter for one.
// LAW 3: draft re-reads against the window gather resolved; a lost ask REFUSES, never defaults.
// LAW 4: nothing throws; every arm returns `{ content, isError }` with the door's own reason.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolHandlerMap } from '../handler.js';
import { broadcast } from '../../../gateway/ws.js';
import { gatherEvidence } from '../../../report/gather.js';
import { buildTelemetry } from '../../../report/telemetry-build.js';
import { writeBundle } from '../../../report/bundle.js';
import { attachDraft, createReport, getReport, submitForApproval, type ReportBrief } from '../../../report/store.js';
import { deriveReportSignature, isFailureLane, FAILURE_LANES } from '../../../report/signature.js';
import { ATTACHMENT_ECHO_CHARS, boundDocumentArrays } from '../../../report/bounds.js';
import { draftHead, gatherHead, renderBrief, submitHead } from './report-prose.js';
import { coerceNumberArg } from '../pagination.js';
import type { WindowRequest } from '../../../report/window.js';

/** Remembered ASK, not the resolved window: the answer would freeze `sinceIso`. Bounded, oldest-first. */
const ASKED_WINDOW = new Map<string, WindowRequest>();
const MAX_REMEMBERED_ASKS = 32;

function rememberAsk(reportId: string, req: WindowRequest): void {
  if (ASKED_WINDOW.size >= MAX_REMEMBERED_ASKS) {
    const oldest = ASKED_WINDOW.keys().next().value;
    if (oldest !== undefined) ASKED_WINDOW.delete(oldest);
  }
  ASKED_WINDOW.set(reportId, req);
}

const ok = (content: string): { content: string; isError: boolean } => ({ content, isError: false });
const bad = (content: string): { content: string; isError: boolean } => ({ content, isError: true });

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => coerceNumberArg(v);

/** The five brief fields on the wire. Named once; the schema and this list are the pair. */
const BRIEF_ARGS = [
  'title', 'what_happened', 'what_should_have_happened', 'why_it_went_wrong', 'fix_ideas',
] as const;

export const reportHandlers: ToolHandlerMap = {
  async dojo_report({ agentId, args }) {
    const phase = text(args.phase);
    // JUDGE THE PHASE FIRST: an id check ahead would answer `phase: "post"` with
    // "report_id is required", teaching a retry of a phase that does not exist.
    if (phase !== 'gather' && phase !== 'draft' && phase !== 'submit') {
      return bad(`phase must be one of [gather, draft, submit]. You sent ${JSON.stringify(args.phase)}. `
        + 'There is no phase that sends anything: only the user can publish a report, from the preview card.');
    }

    // ── GATHER ──────────────────────────────────────────────────────────────
    // GATHER: the row needs a signature at INSERT; `'other'` + provisional now, `draft` re-derives.
    if (phase === 'gather') {
      const asked: WindowRequest = { turns: num(args.turns), minutes: num(args.minutes) };
      const ev = gatherEvidence(agentId, asked);
      const signature = deriveReportSignature('other', ev.dominant);
      const row = createReport(agentId, 'other', signature);
      rememberAsk(row.id, asked);
      return ok([
        ...gatherHead(row.id, ev.window),
        '',
        'EVIDENCE (local only — this raw material never leaves this machine; a separate machine-built '
        + 'attachment carries the timings and tool names onto the issue):',
        JSON.stringify(ev.bundle, null, 2),
      ].join('\n'));
    }

    const reportId = text(args.report_id);
    if (reportId === '') return bad('report_id is required for draft and submit. Call phase="gather" first; it returns the id.');
    const existing = getReport(reportId);
    if (!existing) return bad(`No report ${reportId}. Call phase="gather" first — it opens the report and returns its id.`);
    if (existing.agentId !== agentId) return bad(`Report ${reportId} belongs to another agent. Open your own with phase="gather".`);

    // ── DRAFT ───────────────────────────────────────────────────────────────
    if (phase === 'draft') {
      const lane = text(args.lane);
      if (!isFailureLane(lane)) {
        return bad(`lane must be one of [${FAILURE_LANES.join(', ')}]. You sent ${JSON.stringify(args.lane)}.`);
      }
      const missing = BRIEF_ARGS.filter(k => text(args[k]) === '');
      if (missing.length > 0) return bad(`These parts of the brief are empty: ${missing.join(', ')}. All five are required.`);

      const asked = ASKED_WINDOW.get(reportId);
      if (!asked) {
        return bad(`The window \`gather\` resolved for ${reportId} is no longer held (the server `
          + 'restarted, or too many reports were opened after it). Call phase="gather" again and draft '
          + 'against the id it returns — drafting now would attach a window nobody asked for.');
      }
      const ev = gatherEvidence(agentId, asked);
      const signature = deriveReportSignature(lane, ev.dominant);
      const brief: ReportBrief = {
        title: text(args.title), whatHappened: text(args.what_happened),
        whatShouldHaveHappened: text(args.what_should_have_happened),
        whyItWentWrong: text(args.why_it_went_wrong), fixIdeas: text(args.fix_ideas),
      };
      const telemetry = buildTelemetry({
        ...ev.sources, reportId, createdAt: existing.createdAt, signature, lane,
      });
      const written = writeBundle(reportId, agentId, ev.bundle);
      // Lane and signature travel with the brief: gather's provisional 'other' pair would contradict it.
      const row = attachDraft(reportId, {
        lane, signature, brief, telemetry, bundlePath: written.path,
      });
      if (!row) {
        return bad(`Report ${reportId} is ${existing.status}, not drafting — a brief may only be attached `
          + 'before anyone has seen it. Open a new report with phase="gather".');
      }
      // The hand-off leads: a cut `submit` line strands the row in `drafting`. Only this echo copy
      // is bounded; `attachDraft` already stored the telemetry whole.
      const echo = boundDocumentArrays(telemetry, ATTACHMENT_ECHO_CHARS);
      return ok([
        ...draftHead(reportId, lane, signature),
        '',
        'THIS IS THE EXACT TEXT THE USER WILL SEE. Re-read it now: if it quotes the conversation,',
        'names anyone, or carries a file path or file contents, call draft again with it fixed.',
        '', renderBrief(brief), '',
        'MACHINE-BUILT ATTACHMENT (you did not write this and cannot add to it). Trimmed copy for reading:',
        JSON.stringify({ echoBounds: echo.notes, ...echo.doc }, null, 2),
      ].join('\n'));
    }

    // ── SUBMIT ──────────────────────────────────────────────────────────────
    const row = submitForApproval(reportId);
    if (!row) {
      return bad(`Report ${reportId} is ${existing.status} and has no brief to submit, or has already `
        + 'been submitted. Only a drafting report with a brief can be put in front of the user.');
    }
    const title = row.brief?.title ?? 'Problem report';
    // The report is the owner's now; nothing this tool can do reaches it again.
    ASKED_WINDOW.delete(reportId);
    broadcast({ type: 'report:pending', data: { id: row.id, title } });
    return ok(submitHead(row.id));
  },
};
