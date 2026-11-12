// The view of one tool result. The agent sees at most V2_MAX_TOOL_RESULT_TOKENS of any result; a longer one
// is kept whole (the executor admits it, the loop's recorder writes `kept_tool_results`) and the view is a
// pointer built here: start, end, and a label naming the size and the read call. The view is decided once
// at admission and stored on the row, so later assemblies render the same bytes.

import { CHARS_PER_TOKEN } from './budget.js';
import { fenceRanges, fenceHead, fenceEnd } from '../tools/external-content.js';

export const V2_MAX_TOOL_RESULT_TOKENS = 15000;

/** The view bound in characters; `file_read` sizes its page under it so its "continue" footer stays in. */
export const TOOL_RESULT_VIEW_CHARS = V2_MAX_TOOL_RESULT_TOKENS * CHARS_PER_TOKEN;

export const RESULT_READ_TOOL = 'tool_result_read';

export const RESULT_EXCERPT_CHARS = Math.floor(TOOL_RESULT_VIEW_CHARS / 8);

/** The label's room beyond the excerpt: this plus the excerpt is the view of a standard pointer. */
export const POINTER_LABEL_ROOM_CHARS = 1000;
export const POINTER_VIEW_CHARS = RESULT_EXCERPT_CHARS + POINTER_LABEL_ROOM_CHARS;

/** A result's lines; a final newline ends the last line rather than opening an empty one. */
export function resultLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function readCall(id: string, args: Record<string, string | number> = {}): string {
  return `${RESULT_READ_TOOL}(${JSON.stringify({ id, ...args })})`;
}

const n = (x: number): string => x.toLocaleString('en-US');

// Cuts land on a whole grapheme where one is near, never inside a surrogate pair (a lone surrogate is
// malformed on every assembly). Indexes are UTF-16 units; only a short window around the cut is segmented.
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const GRAPHEME_WINDOW = 64;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

export function charBoundary(text: string, at: number, toward: 'back' | 'forward'): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  if (graphemes) {
    const from = Math.max(0, at - GRAPHEME_WINDOW);
    let best = -1;
    for (const { index } of graphemes.segment(text.slice(from, Math.min(text.length, at + GRAPHEME_WINDOW)))) {
      const b = from + index;
      if (b === at) return at;
      if (b < at) best = b; else { if (toward === 'forward' && b > from) return b; break; }
    }
    // The window's first boundary is only trusted past its own start (a window may open mid-character).
    if (toward === 'back' && best >= 0 && (best > from || from === 0)) return best;
  }
  return isLow(text.charCodeAt(at)) ? (toward === 'back' ? at - 1 : at + 1) : at;
}

function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Exact when the result fits `viewChars`, else its pointer; the caller must keep the whole. */
export function toolResultView(text: string, id: string, viewChars: number = TOOL_RESULT_VIEW_CHARS, noun = 'tool result'): string {
  if (text.length <= viewChars) return text;
  const excerpt = Math.max(0, Math.min(RESULT_EXCERPT_CHARS, viewChars - POINTER_LABEL_ROOM_CHARS));
  const headBudget = Math.floor(excerpt * 3 / 4);
  const nl = text.lastIndexOf('\n', headBudget);
  const headEnd = nl > headBudget / 2 ? nl : charBoundary(text, headBudget, 'back');
  const tailBudget = excerpt - headBudget;
  const tailFrom = text.length - tailBudget;
  const tnl = text.indexOf('\n', tailFrom);
  const tailStart = Math.max(headEnd, tnl !== -1 && tnl < tailFrom + tailBudget / 2 ? tnl + 1 : charBoundary(text, tailFrom, 'forward'));
  const lines = resultLines(text).length;
  const headLast = lineAt(text, headEnd);
  const headWhole = text[headEnd] === '\n';
  const tailWhole = text[tailStart - 1] === '\n';
  const shown = excerpt === 0 ? 'Nothing of it is shown here.'
    : `Above: ${headWhole ? `lines 1–${n(headLast)}` : `the first ${n(headEnd)} characters`}. `
      + `Below: ${tailWhole ? `lines ${n(lineAt(text, tailStart))}–${n(lines)}` : `the last ${n(text.length - tailStart)} characters`}.`;
  const next = headWhole ? readCall(id, { from_line: headLast + 1 }) : readCall(id, { offset: headEnd });
  const label = `[… KEPT WHOLE, NOT ALL SHOWN: this ${noun} is ${n(text.length)} characters `
    + `(~${n(Math.ceil(text.length / CHARS_PER_TOKEN))} tokens) in ${n(lines)} line${lines === 1 ? '' : 's'}, too long to show at once. `
    + `${shown} Nothing was lost. Read any part with ${next} (any from_line/to_line range), `
    + `or find text in it with ${readCall(id, { search: '…' })}. …]`;
  const [head, tail] = aroundTheLabel(text, headEnd, tailStart);
  return excerpt === 0 ? label : `${head}\n\n${label}\n\n${tail}`;
}

/** The two excerpts of a FENCED whole: a cut inside the fence closes the start with the fence end and
 *  reopens the end with its head, so the label (the platform's own words) never sits inside the fence. */
function aroundTheLabel(text: string, headEnd: number, tailStart: number): [string, string] {
  let head = text.slice(0, headEnd);
  let tail = text.slice(tailStart);
  const fence = fenceRanges(text)[0];
  if (fence) {
    if (fence.headStart < headEnd && fence.endEnd > headEnd) head += `\n${fenceEnd(fence.kind, fence.code)}`;
    if (fence.headStart < tailStart && fence.endEnd > tailStart) tail = `${fenceHead(fence.kind, fence.code, fence.from, fence.addressedToAgent)}\n${tail}`;
  }
  return [head, tail];
}
