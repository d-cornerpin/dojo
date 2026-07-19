// ════════════════════════════════════════
// Deliverable-claim classifier (2026-07-18 confabulation incident)
//
// Sibling of the grounding classifier. Grounding catches a fabricated DELIVERY
// to a named third party ("sent it to Sam"); this catches a fabricated
// COMPLETION of WORK ("Longhorizon report is compiled", "the new photo is done
// and posted"). The observed case: the agent answered a time question, then
// self-directed into leftover tracker/vault state and narrated a task row it had
// never worked as its own finished report, with fabricated specifics and zero
// side-effecting tools in the turn.
//
// This mirrors the dev harness anomaly 'claims:completion_without_receipts'
// (dev-test-tools/behavioral/anomaly.mjs): the same two claim shapes and the same
// "did a receipt-tier tool actually run" gate, promoted from a surface-only report
// finding into a live, one-shot engine steer. Photo/image nouns are added on top
// of the harness noun list because the image-completion honesty work lives in the
// same wave and "the photo is done" is the identical confabulation shape.
//
// HARD LAW: prose classification NEVER gains authority. This predicate only
// DETECTS a claim SHAPE. The caller may steer + re-enter ONCE; it may never block,
// suppress, or rewrite the reply, and if the model repeats the claim after the
// steer the reply stands (log-only). The receipt gate is the real signal; the text
// match is the cheap trigger.
// ════════════════════════════════════════

/**
 * Side-effecting tools that produce an ARTIFACT or a RECEIPT. When one of these
 * SUCCEEDED this turn, a "the work is done" claim is grounded and the floor must
 * not fire. Mirrors the RECEIPT_TOOLS list in
 * dev-test-tools/behavioral/anomaly.mjs (the 'claims:completion_without_receipts'
 * check) so the live floor and the harness report agree on what counts as a
 * receipt. This is deliberately BROADER than receipts/store.ts RECEIPT_TOOLS
 * (which is the comms-to-people delivery-verification map): a compiled report is
 * grounded by file_write / vault_remember / tracker_*, not only by a message send.
 */
export const RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  'file_write', 'file_append', 'exec', 'send_to_agent', 'imessage_send', 'sms_send',
  'vault_remember', 'contact_remember', 'tracker_update_status', 'tracker_create_project',
  'tracker_create_task', 'reminder_create', 'image_create', 'complete_task',
  'screen_broadcast', 'show_to_user', 'scratchpad_set',
]);

// The two claim shapes, mirroring anomaly.mjs CLAIM_RES:
//   1. verb-then-artifact  ("compiled ... the final report", "posted the photo")
//   2. artifact-then-verb  ("the report is compiled", "the photo is done")
// Same-clause only ([^.!?\n] bounds), so a completion verb and an artifact noun in
// two unrelated sentences do not join into a false claim. Noun set = the harness
// list plus image/photo/picture/graphic/chart/artwork (this wave's image work).
const ARTIFACT_NOUN =
  '(?:report|file|document|memo|summary|task|project|email|message|note|image|photo|picture|graphic|chart|artwork)';
const ARTIFACT_NOUN_PASSIVE =
  '(?:report|file|document|memo|summary|task|project|email|note|image|photo|picture|graphic|chart|artwork)';

const CLAIM_RES: RegExp[] = [
  new RegExp(
    `\\b(?:compiled|assembled|generated|created|wrote|saved|sent|delivered|finished|completed|posted)\\b` +
    `[^.!?\\n]{0,80}\\b${ARTIFACT_NOUN}\\b`,
    'i',
  ),
  new RegExp(
    `\\b${ARTIFACT_NOUN_PASSIVE}\\b[^.!?\\n]{0,40}\\b(?:is|was|are|were|has been|have been)\\s+` +
    `(?:compiled|assembled|generated|created|written|saved|sent|delivered|finished|completed|done|posted)\\b`,
    'i',
  ),
];

export interface DeliverableClaimDecision {
  /** True when the text asserts completed/delivered WORK (a claim shape). */
  matched: boolean;
  /** The regex source that matched, for the fire log. null when no match. */
  pattern: string | null;
}

/**
 * Pure predicate: does this reply text ASSERT completed/delivered work? Detection
 * only, no receipt gate, no authority. The caller pairs a positive with a
 * zero-receipt check before steering.
 */
export function detectDeliverableClaim(text: string | null | undefined): DeliverableClaimDecision {
  const t = text?.trim();
  if (!t || t.length < 4) return { matched: false, pattern: null };
  for (const re of CLAIM_RES) {
    if (re.test(t)) return { matched: true, pattern: re.source };
  }
  return { matched: false, pattern: null };
}

/**
 * True when a receipt-tier tool SUCCEEDED among the turn's tool results (name +
 * isError). Grounds a completion claim. Mirrors the caller's use of
 * state.toolResults (the same accumulator the RC-13.2 save-claim floor reads).
 */
export function hadReceiptToolThisTurn(
  toolResults: ReadonlyArray<{ name: string; isError: boolean }>,
): boolean {
  return toolResults.some((r) => !r.isError && RECEIPT_TOOLS.has(r.name));
}
