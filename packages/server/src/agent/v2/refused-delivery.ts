// A done claim the same turn's tool refused: dojo_report moves by state transition, no deliveries row.

export const REPORT_ARTIFACT_TOOL = 'dojo_report';

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
  return '[System: The only tool this turn that could have sent your report to the person you are talking to '
    + `REFUSED. Its own words: "${d.quoted}". Nothing was delivered. Tell them plainly what the `
    + 'state really is and what you can do about it, and do not go silent.]';
}
