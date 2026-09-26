// ════════════════════════════════════════════════════════════════════════════
// DOJO REPORT — THREE PHASES, AND THE THIRD ONE CANNOT SEND (DOJO-REPORT T3)
//
// The agent-facing half of in-product problem reporting. `gather` hands the agent
// the evidence for a bounded recent window; `draft` takes its write-up, builds the
// telemetry mechanically and files the row; `submit` puts a card in front of the
// owner. There is no fourth phase, and the absence is the feature.
//
//  1. THIS MODULE CANNOT PUBLISH ANYTHING, AND NOT BECAUSE IT CHOOSES NOT TO.
//     It imports no network module, names no host, and touches neither of the two
//     one-shot doors in `report/store.ts` that consume an owner's approval. The
//     only writes it can reach are a row in `dojo_reports` and a file under
//     `~/.dojo/reports`. `__tests__/the-report-tool-cannot-post.test.ts` reads
//     this file's own import list and asserts exactly that.
//
//  2. THE AGENT'S WORDS GO TO THE BRIEF AND NOWHERE ELSE. `draft` is the one
//     translation point between the model-facing snake_case schema and the
//     internal camelCase `ReportBrief`, and the five strings it maps are handed
//     to `attachDraft` alone. `buildTelemetry` takes a `TelemetrySources` record
//     of platform facts and HAS NO PARAMETER an agent string could occupy — the
//     separation is structural, and the behavioural proof is next door in
//     `the-agents-words-never-reach-the-telemetry.test.ts`.
//
//  3. EVIDENCE IS RE-READ AT DRAFT — AGAINST THE WINDOW `gather` RESOLVED, NEVER
//     A FRESH DEFAULT. The first cut re-gathered with `{}`, and review caught what
//     that meant: `resolveWindow({})` can never set `truncated`, so
//     `window.truncated` was a CONSTANT `false` on every attachment this feature
//     could produce. An agent that asked for a week was told the truth in prose
//     and the public page was told `false` — a live wrong value on the artifact.
//     So the agent's ASK is remembered per report (a `{turns, minutes}` pair, not
//     the megabyte of rows), and `draft` resolves the same ask again. Rows stay
//     re-read, which keeps the evidence fresh and keeps module state tiny; only
//     the WINDOW is carried, because the window is the one thing `draft` cannot
//     re-derive. A miss REFUSES rather than falling back to the standing window —
//     a silent default is the defect, so it must not be the fallback.
//
//  4. NOTHING THROWS TO THE LOOP. Every arm returns `{ content, isError }`; a
//     refused transition returns the reason the door gives, never an exception —
//     an agent that cannot tell "the report is gone" from "the engine broke"
//     retries the wrong thing.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolHandlerMap } from '../handler.js';
import { broadcast } from '../../../gateway/ws.js';
import { getCurrentVersion } from '../../../gateway/routes/update.js';
import { gatherEvidence } from '../../../report/gather.js';
import { buildTelemetry } from '../../../report/telemetry-build.js';
import { writeBundle } from '../../../report/bundle.js';
import { attachDraft, createReport, getReport, submitForApproval, type ReportBrief } from '../../../report/store.js';
import { deriveReportSignature, isFailureLane, FAILURE_LANES } from '../../../report/signature.js';
import { ATTACHMENT_ECHO_CHARS, boundDocumentArrays } from '../../../report/bounds.js';
import { draftHead, gatherHead, renderBrief } from './report-prose.js';
import type { WindowRequest } from '../../../report/window.js';

/**
 * THE AGENT'S ASK, REMEMBERED PER REPORT — the whole of the cross-phase state, and it is
 * deliberately the ASK rather than the ANSWER. Storing the resolved `GatherWindow` would
 * freeze `sinceIso` at gather time, so a draft five minutes later would describe a window
 * that ended before the report was written; storing the ask re-resolves it against the
 * clock while keeping `truncated` honest about what the agent actually requested.
 *
 * Bounded, and evicted oldest-first: a Map keyed by report id with no ceiling is a leak
 * that only shows up on a box that never restarts, which is the box this runs on.
 */
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
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The five brief fields on the wire. Named once; the schema and this list are the pair. */
const BRIEF_ARGS = [
  'title', 'what_happened', 'what_should_have_happened', 'why_it_went_wrong', 'fix_ideas',
] as const;

export const reportHandlers: ToolHandlerMap = {
  async dojo_report({ agentId, args }) {
    const phase = text(args.phase);
    // THE PHASE IS JUDGED FIRST, and that ordering is the fix for a real defect: with the
    // id check ahead of it, `phase: "post"` was answered "report_id is required" — the tool
    // diagnosing a missing argument for a step that does not exist, which teaches the model
    // to supply an id and try the non-existent phase again. There are three phases and the
    // refusal has to say so.
    if (phase !== 'gather' && phase !== 'draft' && phase !== 'submit') {
      return bad(`phase must be one of [gather, draft, submit]. You sent ${JSON.stringify(args.phase)}. `
        + 'There is no phase that sends anything: only the user can publish a report, from the preview card.');
    }

    // ── GATHER ──────────────────────────────────────────────────────────────
    // A provisional signature on the `'other'` lane: the row needs one at INSERT
    // and the agent has not chosen a lane yet. `draft` re-derives it for real.
    if (phase === 'gather') {
      const asked: WindowRequest = { turns: num(args.turns), minutes: num(args.minutes) };
      const ev = gatherEvidence(agentId, asked);
      const signature = deriveReportSignature(getCurrentVersion(), 'other', ev.dominant);
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
      // Every empty field named at once — five round-trips to learn five things is not help.
      const missing = BRIEF_ARGS.filter(k => text(args[k]) === '');
      if (missing.length > 0) return bad(`These parts of the brief are empty: ${missing.join(', ')}. All five are required.`);

      // THE SAME ASK `gather` RESOLVED. A miss means the process restarted or 32 newer
      // reports pushed this one out; either way the honest answer is "gather again", not a
      // standing window nobody asked for silently stamped onto the public attachment.
      const asked = ASKED_WINDOW.get(reportId);
      if (!asked) {
        return bad(`The window \`gather\` resolved for ${reportId} is no longer held (the server `
          + 'restarted, or too many reports were opened after it). Call phase="gather" again and draft '
          + 'against the id it returns — drafting now would attach a window nobody asked for.');
      }
      const ev = gatherEvidence(agentId, asked);
      const signature = deriveReportSignature(getCurrentVersion(), lane, ev.dominant);
      const brief: ReportBrief = {
        title: text(args.title), whatHappened: text(args.what_happened),
        whatShouldHaveHappened: text(args.what_should_have_happened),
        whyItWentWrong: text(args.why_it_went_wrong), fixIdeas: text(args.fix_ideas),
      };
      // The sources are platform facts only; the four identity fields are the platform's
      // too. Not one of the five strings above is in scope at this call.
      const telemetry = buildTelemetry({
        ...ev.sources, reportId, createdAt: existing.createdAt, signature, lane,
      });
      const written = writeBundle(reportId, agentId, ev.bundle);
      // THE LANE AND THE SIGNATURE GO WITH THE BRIEF. Both were derived above from the agent's
      // chosen lane, and the telemetry in this same call already carries them; a row left on
      // gather's provisional `'other'` pair would publish an issue that contradicts its own
      // attachment and would drop the lane out of the poster's dedupe key.
      const row = attachDraft(reportId, {
        lane, signature, brief, telemetry, bundlePath: written.path,
      });
      if (!row) {
        return bad(`Report ${reportId} is ${existing.status}, not drafting — a brief may only be attached `
          + 'before anyone has seen it. Open a new report with phase="gather".');
      }
      // THE SAME TWO LAWS AS `gather`, ONE PHASE LATER (round-1 review F2). ORDER: the hand-off
      // is at the head, because a draft whose `submit` line was truncated away is a brief nobody
      // ever sees on a row that reads `drafting` for ever. SIZE: the echo below is bounded, because
      // it is the attachment and the attachment grows with the window — measured at 88,098 chars ≈
      // 22,025 tokens on a maximal one, 1.8× over the cap. ⚠ THE ECHO IS A COPY AND ONLY THE COPY
      // IS TRIMMED: `attachDraft` above already stored `telemetry` whole, so nothing published is
      // bounded here, and `draftHead` says exactly that in words the model can act on.
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
    return ok(`Filed as \`${row.id}\`. A preview card is now on the dashboard showing your brief and the `
      + 'telemetry attachment. Nothing is sent until the user presses Post on that card. You cannot press it.');
  },
};
