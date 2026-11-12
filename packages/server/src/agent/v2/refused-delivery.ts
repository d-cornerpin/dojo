// A done claim the same turn's tool refused: dojo_report moves by state transition, no deliveries row.

export const REPORT_ARTIFACT_TOOL = 'dojo_report';

// Done-claim words, twin in agent/tools/cat/report-prose.ts; sent/posted/filed/published need
// an object, bare submitted/delivered do not, because the tool's refusal is the stronger proof.
const DELIVERY_CLAIM_RE =
  /\b(?:(?:it|that|this)\s+(?:has\s+been|is|was)\s+(?:submitted|sent|filed|delivered|published|posted)|(?:i\s+)?(?:submitted|sent|filed|delivered|published|posted)\s+it|submitted|delivered|sent\s+it\s+in|filed\s+(?:it\s+)?with)\b/i;

// Checked after the claim so it can only quieten: an honest denial must never be steered.
const DISCLAIMED_DELIVERY_RE =
  /\b(?:not|never|no|cannot|can't|could\s?n[o']t|failed|fails|refused|rejected|nothing)\b[^.!?]{0,60}\b(?:submit|submitted|sent|send|filed|file|delivered|deliver|published|posted)\b|\b(?:submit|submitted|sending|submitting|filing)\b[^.!?]{0,40}\b(?:failed|refused|rejected|cancelled|canceled)\b/i;

export function claimsDelivery(reply: string): boolean {
  return DELIVERY_CLAIM_RE.test(reply) && !DISCLAIMED_DELIVERY_RE.test(reply);
}

export interface TurnToolResult { readonly name?: string; readonly content?: string; readonly isError?: boolean }

export interface RefusedDelivery { readonly refused: number; readonly quoted: string }

export function decideRefusedDelivery(results: readonly TurnToolResult[]): RefusedDelivery | null {
  const calls = results.filter((r) => r.name === REPORT_ARTIFACT_TOOL);
  if (calls.length === 0 || calls.some((r) => r.isError !== true)) return null;
  return {
    refused: calls.length,
    quoted: (calls[calls.length - 1].content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

// Quotes the tool's own words and asks for the truth to reach the person; never asks the model for silence.
export function refusedDeliverySteer(d: RefusedDelivery): string {
  return '[System: You told the person you are talking to that went out, and the only tool this turn that could have sent it '
    + `REFUSED. Its own words: "${d.quoted}". Nothing was delivered. Tell them plainly what the `
    + 'state really is and what you can do about it — do not let the claim stand, and do not go silent.]';
}
