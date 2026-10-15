// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE SUMMARISER IS HANDED OF THE AGENT'S OWN WORDS (t169).
//
// `condenseToolJsonForSummary` used to render every `tool_use` as `(called tool NAME)` and drop its
// input, so a note, a file's content or a message the agent wrote never reached the summariser (run 9,
// S1: the wrong-line lists lived only in `work_note` arguments, the summary said "called work_note three
// times", and the agent redid 154 pages to rebuild what it had already written down). The authored text
// now follows the tool name, and this module owns the two rules that go with it:
//
//   1. WHICH TEXT. The fields the platform's tools take the agent's words in. A path, an id, a query or
//      an offset is not authored text and is left out exactly as before, so a call that carries none stays
//      `(called tool NAME)`. A technique body or a credential value passed as input is never carried: it
//      is the rule `scrubTechniqueContentForSummary` already enforces on their results, because a
//      summary is re-injected across sessions.
//   2. HOW MUCH. The summariser's own input budget decides, not a number picked here. A chunk is cut by
//      its rows' stored size, so its input fits whole in the ordinary case; only an input whose written
//      text outgrows the budget is scaled down, every kept text by the same share, each keeping its head
//      and saying how much it cut. Results are unchanged (the first 200 chars).
//
// Cache: this is summariser INPUT. It is in no prompt prefix and moves no cached byte.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokens, CHARS_PER_TOKEN } from './budget.js';

const AUTHORED_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'notes', 'note', 'content', 'text', 'message', 'body', 'payload', 'description', 'instructions',
  'justification', 'reason', 'result', 'summary', 'caption', 'prompt',
]);
const WITHHELD_INPUT_TOOL_PREFIXES = ['credential_', 'technique_'] as const;

/** The agent's written text in a call's input, in the order it was written, as follow-on lines. `keep`
 *  is the share of each text to carry (1 = whole); a cut text keeps its head and says how much is not shown. */
export function authoredInputLines(name: string, input: unknown, keep: number): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  if (WITHHELD_INPUT_TOOL_PREFIXES.some((p) => name.startsWith(p))) return [];
  const lines: string[] = [];
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (!AUTHORED_INPUT_FIELDS.has(field) || typeof value !== 'string' || value.trim().length === 0) continue;
    const kept = keep >= 1 ? value.length : Math.floor(value.length * Math.max(0, keep));
    lines.push(kept >= value.length
      ? `  ${field}: ${value}`
      : `  ${field}: ${value.slice(0, kept)}${kept > 0 ? ' ' : ''}[... ${value.length - kept} more chars of this text are not shown here]`);
  }
  return lines;
}

/**
 * The summariser's input, whole while it fits `budgetTokens`, otherwise rendered with the same share of
 * every authored text. `render(keep)` is the input with `keep` (0..1) of each text; the share is read off
 * the two extremes, `render(1)` and `render(0)` (the framing alone).
 */
export function fitInputToBudget(render: (keep: number) => string, budgetTokens: number): string {
  const whole = render(1);
  if (estimateTokens(whole) <= budgetTokens) return whole;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const framing = render(0);
  const range = Math.max(1, whole.length - framing.length);
  let share = Math.min(1, Math.max(0, budgetChars - framing.length) / range);
  let out = render(share);
  // The "N more chars not shown" notes are part of the framing and change a digit as the share moves, so
  // the first answer can run a few characters over. Take the excess off again, doubling the step each
  // pass, until it fits (a share of 0 is the framing alone, which always ends the walk).
  for (let step = 1; estimateTokens(out) > budgetTokens && share > 0; step *= 2) {
    share = Math.max(0, share - (step * (out.length - budgetChars)) / range);
    out = render(share);
  }
  return out;
}
