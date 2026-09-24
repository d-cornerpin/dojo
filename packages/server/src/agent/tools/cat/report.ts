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
//  3. EVIDENCE IS RE-READ AT DRAFT, NOT CARRIED. `gatherEvidence` is a pure
//     bounded read, so `draft` simply runs it again rather than parking a
//     megabyte of rows in module state between two tool calls. That also makes a
//     server restart between the phases a non-event: there is no cache to miss,
//     and the second read is strictly fresher than the first. The cost is six
//     more indexed queries on a call the user is already waiting on deliberately.
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

const ok = (content: string): { content: string; isError: boolean } => ({ content, isError: false });
const bad = (content: string): { content: string; isError: boolean } => ({ content, isError: true });

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The sentence a truncated window gets. Plain words, never a silent trim. */
function windowNote(w: { turns: number; minutes: number; truncated: boolean; askedFor: string }): string {
  return w.truncated
    ? `You asked for ${w.askedFor}. The window is capped, so this is the last ${w.turns} turns `
      + `within the last ${w.minutes} minutes — the cap is deliberate and cannot be raised from a tool call.`
    : `Window: the last ${w.turns} turns within the last ${w.minutes} minutes.`;
}

/** The five fields, rendered the way the owner will read them on the card. */
function renderBrief(b: ReportBrief): string {
  return [
    `TITLE: ${b.title}`, '', `WHAT HAPPENED\n${b.whatHappened}`, '',
    `WHAT SHOULD HAVE HAPPENED\n${b.whatShouldHaveHappened}`, '',
    `WHY IT WENT WRONG\n${b.whyItWentWrong}`, '', `FIX IDEAS\n${b.fixIdeas}`,
  ].join('\n');
}

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
      const ev = gatherEvidence(agentId, { turns: num(args.turns), minutes: num(args.minutes) });
      const signature = deriveReportSignature(getCurrentVersion(), 'other', ev.dominant);
      const row = createReport(agentId, 'other', signature);
      return ok([
        `Report ${row.id} opened. ${windowNote(ev.window)}`,
        '',
        'EVIDENCE (local only — this raw material never leaves this machine; a separate',
        'machine-built attachment carries the timings and tool names onto the issue):',
        JSON.stringify(ev.bundle, null, 2),
        '',
        `Next: call dojo_report with phase="draft", report_id="${row.id}", a lane from `
        + `[${FAILURE_LANES.join(', ')}], and your five-part write-up. Describe the SHAPE of the `
        + 'failure — no quotes from the conversation, no file paths, no names, no file contents.',
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

      const ev = gatherEvidence(agentId, {});
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
      const row = attachDraft(reportId, brief, telemetry, written.path);
      if (!row) {
        return bad(`Report ${reportId} is ${existing.status}, not drafting — a brief may only be attached `
          + 'before anyone has seen it. Open a new report with phase="gather".');
      }
      return ok([
        `Draft saved on ${reportId} (lane ${lane}, signature ${signature}).`,
        'THIS IS THE EXACT TEXT THE USER WILL SEE. Re-read it now: if it quotes the conversation,',
        'names anyone, or carries a file path or file contents, call draft again with it fixed.',
        '', renderBrief(brief), '',
        'MACHINE-BUILT ATTACHMENT (you did not write this and cannot add to it):',
        JSON.stringify(telemetry, null, 2),
        '', `Next: phase="submit", report_id="${reportId}".`,
      ].join('\n'));
    }

    // ── SUBMIT ──────────────────────────────────────────────────────────────
    const row = submitForApproval(reportId);
    if (!row) {
      return bad(`Report ${reportId} is ${existing.status} and has no brief to submit, or has already `
        + 'been submitted. Only a drafting report with a brief can be put in front of the user.');
    }
    const title = row.brief?.title ?? 'Problem report';
    broadcast({ type: 'report:pending', data: { id: row.id, title } });
    return ok(`Filed as \`${row.id}\`. A preview card is now on the dashboard showing your brief and the `
      + 'telemetry attachment. Nothing is sent until the user presses Post on that card. You cannot press it.');
  },
};
