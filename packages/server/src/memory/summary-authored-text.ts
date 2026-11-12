// What the summariser is handed of the agent's own words in a tool call: only the fields the tools take its words
// in (a path, id, query or offset is left out), never a technique body or credential value (a summary is re-injected
// across sessions). Over budget, every kept text and result scales by one share, keeping its head (results: head and
// tail at the live pointer's 3:1 split, `tool-result-view.ts`) and saying how much was cut. No cached byte moves.

import { estimateTokens, CHARS_PER_TOKEN } from './budget.js';
import { charBoundary } from './tool-result-view.js';
import { summaryFacts } from './summary-target.js';

const AUTHORED_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'notes', 'note', 'content', 'text', 'message', 'body', 'payload', 'description', 'instructions',
  'justification', 'reason', 'result', 'summary', 'caption', 'prompt',
]);
const WITHHELD_INPUT_TOOL_PREFIXES = ['credential_', 'technique_'] as const;

/** The agent's written text in a call's input, in order, as follow-on lines; `keep` is the share of each carried. */
export function authoredInputLines(name: string, input: unknown, keep: number): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  if (WITHHELD_INPUT_TOOL_PREFIXES.some((p) => name.startsWith(p))) return [];
  const lines: string[] = [];
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (!AUTHORED_INPUT_FIELDS.has(field) || typeof value !== 'string' || value.trim().length === 0) continue;
    const kept = keep >= 1 ? value.length : Math.floor(value.length * Math.max(0, keep));
    // Snap back to a character boundary so a cut never leaves a lone surrogate (as `resultForSummary` does).
    const cut = charBoundary(value, kept, 'back');
    lines.push(cut >= value.length
      ? `  ${field}: ${value}`
      : `  ${field}: ${value.slice(0, cut)}${cut > 0 ? ' ' : ''}[... ${value.length - cut} more chars of this text are not shown here]`);
  }
  return lines;
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((b) => {
    const block = b as { type?: unknown; text?: unknown } | null;
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : `[${String(block?.type ?? 'content')}]`;
  }).join('\n');
}

function aroundTheGap(body: string, room: number): { head: string; middle: string; tail: string } {
  const headEnd = charBoundary(body, Math.floor((room * 3) / 4), 'back');
  const tailStart = Math.max(headEnd, charBoundary(body, body.length - (room - headEnd), 'forward'));
  return { head: body.slice(0, headEnd), middle: body.slice(headEnd, tailStart), tail: body.slice(tailStart) };
}

/** One tool result with `keep` (0..1) of its length shown; whole at 1. Below it the room goes first to the facts
 *  of the part not shown (at most half, whole facts only), then the head and tail. */
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

/** The input whole while it fits `budgetTokens`, else every text at one share read off `render(1)`/`render(0)`. */
export function fitInputToBudget(render: (keep: number) => string, budgetTokens: number): string {
  const whole = render(1);
  if (estimateTokens(whole) <= budgetTokens) return whole;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const framing = render(0);
  const range = Math.max(1, whole.length - framing.length);
  let share = Math.min(1, Math.max(0, budgetChars - framing.length) / range);
  let out = render(share);
  // The "N more chars" notes change a digit as the share moves, so trim the excess with a doubling step until it fits.
  for (let step = 1; estimateTokens(out) > budgetTokens && share > 0; step *= 2) {
    share = Math.max(0, share - (step * (out.length - budgetChars)) / range);
    out = render(share);
  }
  return out;
}
