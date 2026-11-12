// THE REPORT'S WORDS. Every result leads with the world state and the next
// call: the engine truncates from the END and a cut result reads as FINISHED,
// so instructions go above the evidence. A trimmed payload is not a failure.

import { FAILURE_LANES } from '../../../report/signature.js';
import type { ReportBrief } from '../../../report/store.js';
import type { GatherWindow } from '../../../report/window.js';

export function windowNote(w: GatherWindow): string {
  return w.truncated
    ? `You asked for ${w.askedFor}. The window is capped, so this is the last ${w.turns} turns `
      + `within the last ${w.minutes} minutes — the cap is deliberate and cannot be raised from a tool call.`
    : `Window: the last ${w.turns} turns within the last ${w.minutes} minutes.`;
}

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

/** Everything below the head is a COPY of what the row already stores; that
 *  is what stops a truncation notice reading as "the draft did not take". */
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

/** Reserved DELIVERY words (filed/posted/sent/delivered/published, per `report/state-lane.ts`'s
 *  legend) mean "reached the builders"; an `awaiting_approval` row reached nobody, so the result
 *  uses none, even in a negative: its paraphrase is what ships. The gather and draft heads' "NOT
 *  FILED" is true under both readings and stays. */
export function submitHead(reportId: string): string {
  return `Submitted as \`${reportId}\`. That is the state your report lane calls PREVIEW CARD UP: the `
    + 'preview card is now on the user\'s dashboard with your brief and the telemetry attachment, and '
    + 'they can read it, edit it and decide. NOTHING has reached the Dojo builders yet — the only thing '
    + 'that does is the user pressing Post on that card, and you cannot press it for them. When you '
    + 'tell them, say the card is up and waiting for their Post.';
}

export function renderBrief(b: ReportBrief): string {
  return [
    `TITLE: ${b.title}`, '', `WHAT HAPPENED\n${b.whatHappened}`, '',
    `WHAT SHOULD HAVE HAPPENED\n${b.whatShouldHaveHappened}`, '',
    `WHY IT WENT WRONG\n${b.whyItWentWrong}`, '', `FIX IDEAS\n${b.fixIdeas}`,
  ].join('\n');
}
