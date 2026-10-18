// ════════════════════════════════════════════════════════════════════════════════════════
// THE SIZE OF ONE TOOL RESULT IN THE MODEL'S VIEW, AND WHAT A LONGER ONE BECOMES.
//
// The agent sees at most V2_MAX_TOOL_RESULT_TOKENS of any single tool result. A tool that pages
// (file_read) sizes its page to that number so its "continue at offset N" footer is never the part
// left out (run 7, S4). History of the number: raised 3000 → 15000 in v2.7.3 so a typical document
// the agent just read stays intact while one runaway result still cannot take the whole window.
//
// ── t200 (D12, the owner's own design): A LONGER RESULT IS KEPT WHOLE, NEVER CUT AWAY ──
// Until t200 a longer result was cut: `exec`/`shell` at 16,000 characters per stream before it was
// stored, every tool with a declared `maxResultTokens` at that size, and everything else to its
// first ~15,000 tokens in the view, each with advice to run the tool again. The rest was not
// offered to the agent at all. Now a result that does not fit is kept whole (the executor admits
// it, the loop's recorder writes it to `kept_tool_results`), and what the agent sees is a POINTER
// built here: the start, the end, a label in the gap that says how big the whole is and the exact
// `tool_result_read` call that reads any line range or searches it. Running the tool again is
// never the advice — the rest is one read away.
//
// ── WHY THE POINTER IS SHORT, AND WHAT THAT BUYS A BATCH ──
// The excerpt is an eighth of one view. One response can call several tools at once and all their
// results land in one stored row, which the trim and the fold treat as one unit; showing each long
// result at the full view made a batch of six 40K-token results ~90K tokens in one row. As pointers
// they cost ~1/8 view each, so eight long results cost what ONE cut result used to. And because
// shrinking a result to its pointer loses nothing, a batch admission (ctx 11) can pass a smaller
// `viewChars` for every result of a batch that does not fit and still lose no data: the view is
// decided once, when the result is admitted, and stored on the row, so later assemblies render the
// same bytes.
// ════════════════════════════════════════════════════════════════════════════════════════

import { CHARS_PER_TOKEN } from './budget.js';

export const V2_MAX_TOOL_RESULT_TOKENS = 15000;

/** The same bound in characters, for a tool sizing a page: `estimateTokens(text) <= V2_MAX_TOOL_RESULT_TOKENS`
 *  holds exactly when `text.length <= TOOL_RESULT_VIEW_CHARS`. */
export const TOOL_RESULT_VIEW_CHARS = V2_MAX_TOOL_RESULT_TOKENS * CHARS_PER_TOKEN;

/** The tool that reads a kept result. Named once: the pointer, the definition and the handler use it. */
export const RESULT_READ_TOOL = 'tool_result_read';

/** How much of a too-long result its pointer shows: an eighth of one view (header). */
export const RESULT_EXCERPT_CHARS = Math.floor(TOOL_RESULT_VIEW_CHARS / 8);

/** The room a pointer's label takes beyond its excerpt: a view of `RESULT_EXCERPT_CHARS` plus this is the view
 *  at which a result becomes its standard pointer (`toolResultView` shows `viewChars` less this much of it). */
export const POINTER_LABEL_ROOM_CHARS = 1000;
export const POINTER_VIEW_CHARS = RESULT_EXCERPT_CHARS + POINTER_LABEL_ROOM_CHARS;

/** A result's lines, numbered from 1. A final newline ends the last line rather than opening an
 *  empty one, so the count is the one a person reading the output would give. */
export function resultLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The exact call that reads a kept result, as the agent should type it. */
export function readCall(id: string, args: Record<string, string | number> = {}): string {
  return `${RESULT_READ_TOOL}(${JSON.stringify({ id, ...args })})`;
}

const n = (x: number): string => x.toLocaleString('en-US');

/** 1-based number of the line holding character `at`. */
function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * The view of one tool result. A result that fits `viewChars` is returned exactly as it is. A
 * longer one becomes its pointer: the start, a labelled gap, the end. `id` is the tool call's id,
 * which is the handle `tool_result_read` takes. The whole must be kept by the caller; this only
 * says what the agent sees.
 */
export function toolResultView(text: string, id: string, viewChars: number = TOOL_RESULT_VIEW_CHARS): string {
  if (text.length <= viewChars) return text;
  const excerpt = Math.max(0, Math.min(RESULT_EXCERPT_CHARS, viewChars - POINTER_LABEL_ROOM_CHARS));
  const headBudget = Math.floor(excerpt * 3 / 4);
  // Cut at a line end when one falls in the second half of the budget; otherwise mid-line.
  const nl = text.lastIndexOf('\n', headBudget);
  const headEnd = nl > headBudget / 2 ? nl : headBudget;
  const tailBudget = excerpt - headBudget;
  const tailFrom = text.length - tailBudget;
  const tnl = text.indexOf('\n', tailFrom);
  const tailStart = Math.max(headEnd, tnl !== -1 && tnl < tailFrom + tailBudget / 2 ? tnl + 1 : tailFrom);
  const lines = resultLines(text).length;
  const headLast = lineAt(text, headEnd);
  const headWhole = text[headEnd] === '\n';
  const tailWhole = text[tailStart - 1] === '\n';
  const shown = excerpt === 0 ? 'Nothing of it is shown here.'
    : `Above: ${headWhole ? `lines 1–${n(headLast)}` : `the first ${n(headEnd)} characters`}. `
      + `Below: ${tailWhole ? `lines ${n(lineAt(text, tailStart))}–${n(lines)}` : `the last ${n(text.length - tailStart)} characters`}.`;
  const next = headWhole ? readCall(id, { from_line: headLast + 1 }) : readCall(id, { offset: headEnd });
  const label = `[… KEPT WHOLE, NOT ALL SHOWN: this tool result is ${n(text.length)} characters `
    + `(~${n(Math.ceil(text.length / CHARS_PER_TOKEN))} tokens) in ${n(lines)} line${lines === 1 ? '' : 's'}, too long to show at once. `
    + `${shown} Nothing was lost. Read any part with ${next} (any from_line/to_line range), `
    + `or find text in it with ${readCall(id, { search: '…' })}. …]`;
  return excerpt === 0 ? label : `${text.slice(0, headEnd)}\n\n${label}\n\n${text.slice(tailStart)}`;
}
