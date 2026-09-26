// ════════════════════════════════════════════════════════════════════════════
// WHAT THE REPORT TOOL SAYS, AND IN WHAT ORDER (ritual v3.2.0 round-1 fix)
//
// `report.ts` next door owns the three phases and the doors they may touch. This
// file owns the WORDS, and the order of the words is now a law with tests behind
// it, which is why they are worth their own file: the round-1 red was not a wrong
// computation, it was a correct result with its instruction in the wrong place.
//
//  · THE HEAD OF EVERY RESULT CARRIES THE STATE OF THE WORLD AND THE NEXT CALL.
//    `maxResultTokens: 12000` truncates from the END, so anything the agent must
//    still do goes FIRST, above the evidence, where no cut can reach it. On two of
//    round 1's three attempts the engine ate a tail-placed hand-off, the row
//    stranded in `drafting`, no card ever existed, and the model told the owner
//    "already filed — the draft is sitting on your dashboard waiting for you to hit
//    Post". That is what makes the tail unusable for an instruction: a severed
//    result does not read as broken, it reads as FINISHED, so the model invents the
//    only story that fits.
//
//  · AND IT SAYS THAT A TRIMMED PAYLOAD IS NOT A FAILURE. The engine's own trailer
//    advises "narrow your query, ask for less", which for this tool is advice to
//    re-gather or re-draft in a loop. Both heads contradict it in plain words.
//
// Split out of `report.ts` at the growth gate's 240-line line, on the seam that
// file's own fix report named in advance. `the-report-tool-cannot-post.test.ts`
// reads BOTH files for the forbidden references now, so moving prose out did not
// move it out of the census.
// ════════════════════════════════════════════════════════════════════════════

import { FAILURE_LANES } from '../../../report/signature.js';
import type { ReportBrief } from '../../../report/store.js';
import type { GatherWindow } from '../../../report/window.js';

/** The sentence a truncated window gets. Plain words, never a silent trim. */
export function windowNote(w: GatherWindow): string {
  return w.truncated
    ? `You asked for ${w.askedFor}. The window is capped, so this is the last ${w.turns} turns `
      + `within the last ${w.minutes} minutes — the cap is deliberate and cannot be raised from a tool call.`
    : `Window: the last ${w.turns} turns within the last ${w.minutes} minutes.`;
}

/** GATHER'S HEAD: the id, the state of the world, the whole next call, then the window. */
export function gatherHead(reportId: string, w: GatherWindow): string[] {
  return [
    `Report ${reportId} opened. NOTHING IS FILED AND NOTHING IS ON THE USER'S DASHBOARD YET: the draft is not `
    + 'written, there is no preview card, and the user cannot see any of this until you finish the two calls below. '
    + 'Do not tell them it is filed.',
    '',
    `NEXT — call dojo_report with phase="draft", report_id="${reportId}", a lane from [${FAILURE_LANES.join(', ')}], `
    + 'and your five-part write-up (title, what_happened, what_should_have_happened, why_it_went_wrong, fix_ideas). '
    + 'Describe the SHAPE of the failure — no quotes from the conversation, no file paths, no names, no file '
    + 'contents. Then phase="submit" with the same report_id — that is what puts the card in front of them.',
    '',
    windowNote(w),
    'The evidence below is size-bounded; its own `bounds` section names anything dropped. A shortened or '
    + 'engine-truncated bundle does NOT block you and is not a reason to gather again — you already have what '
    + 'the brief needs.',
  ];
}

/**
 * DRAFT'S HEAD: the same law one phase later (review F2). The brief and the attachment are
 * already ON THE ROW by the time this renders, so everything below the head is a COPY — and
 * saying that is what stops a truncation notice from reading as "the draft did not take".
 */
export function draftHead(reportId: string, lane: string, signature: string): string[] {
  return [
    `Draft saved on ${reportId} (lane ${lane}, signature ${signature}). STILL NOT FILED — no card exists and the user cannot see this yet.`,
    `NEXT — call dojo_report with phase="submit", report_id="${reportId}": that call, and only that call, puts the preview card in front of the user.`,
    '',
    'Everything below is a COPY of what is already stored on the report. The attachment echo is trimmed to stay '
    + 'readable — the stored attachment is complete and is what rides the issue — and if this result is cut off, or '
    + 'the engine stamps a truncation notice on it, nothing is lost and nothing needs redoing: submit, do not draft '
    + 'again. Draft again ONLY to fix the text below.',
  ];
}

/**
 * SUBMIT'S RESULT — AND THE WORD IT MAY NOT USE (ritual v3.2.0 round-5 red).
 *
 * This said *"Filed as `<id>`. A preview card is now on the dashboard … Nothing is sent until the
 * user presses Post"* — honest in substance, and it opened with the one word the same release
 * defines as the OPPOSITE. `report/state-lane.ts`'s legend, which the agent reads on the same turn,
 * says *"FILED means it reached the builders, at the link shown"* and renders `PREVIEW CARD UP` (not
 * `FILED`) for exactly this row. So the platform shipped one word with two meanings, and the model
 * — correctly paraphrasing its tool — opened its reply with *"Report is filed as a preview card on
 * your dashboard"*, which the release gate reads as a delivery claim. Two sides of one word; this is
 * the product's side.
 *
 * ONE VOCABULARY, AND THE LANE'S LEGEND IS THE DEFINITION. `filed`, `posted`, `sent`, `delivered`
 * and `published` are the lane's reserved DELIVERY words: they mean the report reached the Dojo
 * builders. A row that is `awaiting_approval` has reached nobody, so this result may not use any of
 * them — not even in an honest negative like "nothing is sent", because the model's paraphrase is
 * what ships and a reserved word in the result is a reserved word in the reply. It says
 * `Submitted`, it names the lane's own state word for the row, and it says where the report stands
 * in the lane's terms. A clause holds the absence, and the mutant that restores "Filed as" is RED.
 *
 * WHAT THE SWEEP FOUND AND DELIBERATELY LEFT. `gatherHead`'s *"NOTHING IS FILED"* and `draftHead`'s
 * *"STILL NOT FILED"* are round 1's fix, are pinned by clauses, and are TRUE under both readings of
 * the word (nothing has reached anybody, and no card exists) — rewriting them would trade a live
 * guard for a cosmetic one. The owner-facing arms (`report/post.ts`'s duplicate help,
 * `report/export.ts`) speak about a report that really is being delivered, which is the reserved
 * sense used correctly.
 */
export function submitHead(reportId: string): string {
  return `Submitted as \`${reportId}\`. That is the state your report lane calls PREVIEW CARD UP: the `
    + 'preview card is now on the user\'s dashboard with your brief and the telemetry attachment, and '
    + 'they can read it, edit it and decide. NOTHING has reached the Dojo builders yet — the only thing '
    + 'that does is the user pressing Post on that card, and you cannot press it for them. When you '
    + 'tell them, say the card is up and waiting for their Post.';
}

/** The five fields, rendered the way the owner will read them on the card. */
export function renderBrief(b: ReportBrief): string {
  return [
    `TITLE: ${b.title}`, '', `WHAT HAPPENED\n${b.whatHappened}`, '',
    `WHAT SHOULD HAVE HAPPENED\n${b.whatShouldHaveHappened}`, '',
    `WHY IT WENT WRONG\n${b.whyItWentWrong}`, '', `FIX IDEAS\n${b.fixIdeas}`,
  ].join('\n');
}
