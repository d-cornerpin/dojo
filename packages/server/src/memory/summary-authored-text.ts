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
//      and saying how much it cut. t269: tool RESULTS are scaled with them (they were cut to their first
//      200 characters, 46% of all the text being summarised on the dev box): whole while the span fits, and
//      past it a result keeps its head and tail at the live pointer's 3:1 split (`tool-result-view.ts`), the
//      facts of the part not shown, and the id its whole is kept under (`tool_result_read`).
//
// Cache: this is summariser INPUT. It is in no prompt prefix and moves no cached byte.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokens, CHARS_PER_TOKEN } from './budget.js';
import { charBoundary } from './tool-result-view.js';
import { summaryFacts } from './summary-target.js';

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
    // A cut between the two halves of an emoji leaves a lone surrogate, so the kept end snaps back
    // to the character boundary, the way resultForSummary already does.
    const cut = charBoundary(value, kept, 'back');
    lines.push(cut >= value.length
      ? `  ${field}: ${value}`
      : `  ${field}: ${value.slice(0, cut)}${cut > 0 ? ' ' : ''}[... ${value.length - cut} more chars of this text are not shown here]`);
  }
  return lines;
}

/** The text of a stored result's content: a string as it is; content blocks as their text, each image or
 *  document as its kind (never its base64, which is no reading for a summariser). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((b) => {
    const block = b as { type?: unknown; text?: unknown } | null;
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : `[${String(block?.type ?? 'content')}]`;
  }).join('\n');
}

/** Head and tail of `body` in `room` characters at the live pointer's 3:1 split, and the part between. */
function aroundTheGap(body: string, room: number): { head: string; middle: string; tail: string } {
  const headEnd = charBoundary(body, Math.floor((room * 3) / 4), 'back');
  const tailStart = Math.max(headEnd, charBoundary(body, body.length - (room - headEnd), 'forward'));
  return { head: body.slice(0, headEnd), middle: body.slice(headEnd, tailStart), tail: body.slice(tailStart) };
}

/**
 * One tool result as the summariser reads it, with `keep` (0..1) of its length shown (the share
 * `fitInputToBudget` gives every text of the span). Whole at 1. Below it, the shown room is spent on the
 * facts of the part not shown first (at most half of it, whole facts only), then the head and the tail.
 */
export function resultForSummary(body: string, id: string | null, keep: number): string {
  const room = keep >= 1 ? body.length : Math.floor(body.length * Math.max(0, keep));
  if (room >= body.length) return body;
  const listed: string[] = [];
  let used = 0;
  for (const f of summaryFacts(aroundTheGap(body, Math.floor(room / 2)).middle)) {
    if (used + f.length + 2 > room / 2) break;
    listed.push(f);
    used += f.length + 2;
  }
  const { head, middle, tail } = aroundTheGap(body, room - used);
  const facts = listed.filter((f) => middle.includes(f));
  return `${head} [... ${middle.length} more characters of this result are not shown here${id ? `; its whole is kept under id ${id}` : ''}`
    + `${facts.length > 0 ? `; facts in the part not shown: ${facts.join(', ')}` : ''} ...] ${tail}`;
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
