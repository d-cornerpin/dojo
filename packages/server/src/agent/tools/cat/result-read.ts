// ════════════════════════════════════════════════════════════════════════════
// READING A KEPT TOOL RESULT: a result too long for the view is kept whole, and
// the agent sees its start, its end and a note naming the tool with the id
// (`memory/tool-result-view.ts`). This is the read: a line range, a character
// offset for a line longer than a page, or a search listing matches with their
// numbers. Every answer is one page sized to the view, and its last line says
// exactly how to read on, so a page is never cut and never becomes a pointer.
// Any of the agent's own results reads by call id: a long one from the store,
// any other from the `tool` row it was recorded on (`memory/kept-results.ts`).
// ════════════════════════════════════════════════════════════════════════════

import { coerceNumberArg } from '../pagination.js';
import { findToolResult } from '../../../memory/kept-results.js';
import { RESULT_READ_TOOL, TOOL_RESULT_VIEW_CHARS, charBoundary, readCall, resultLines } from '../../../memory/tool-result-view.js';
import type { ToolHandlerMap } from '../handler.js';
import { fenceRanges, fenceHead, fenceEnd, newFenceCode, type FenceRange } from '../../../tools/external-content.js';

// A kept whole is stored FENCED (the tool door fences before admission). A page
// shows lines inside a fence under a FRESH code of the same kind and source and
// leaves the stored fence's marker lines out: a middle page is fenced too, and
// the page's own head and foot stay outside the fencing.
type FenceMap = { inside: Array<FenceRange | null>; marker: boolean[] };
function fenceMap(text: string, lines: readonly string[]): FenceMap {
  const ranges = fenceRanges(text);
  const inside: Array<FenceRange | null> = [];
  const marker: boolean[] = [];
  let at = 0;
  for (const line of lines) {
    const r = ranges.find((f) => at >= f.headStart && at < f.endEnd + 1) ?? null;
    const isMarker = r !== null && (at < r.bodyStart || at > r.bodyEnd);
    marker.push(isMarker);
    inside.push(r !== null && !isMarker ? r : null);
    at += line.length + 1;
  }
  return { inside, marker };
}
/** Rows of a page (each with its 1-based line), marker lines dropped, inside runs re-fenced. */
function presentRows(rows: readonly string[], at: readonly number[], map: FenceMap): string[] {
  const out: string[] = [];
  let open: { range: FenceRange; code: string } | null = null;
  const close = (): void => { if (open) { out.push(fenceEnd(open.range.kind, open.code)); open = null; } };
  rows.forEach((row, k) => {
    const i = at[k] - 1;
    if (map.marker[i]) return;
    const range = map.inside[i];
    if (open && (range !== open.range || (k > 0 && at[k] !== at[k - 1] + 1))) close();
    if (range && !open) { open = { range, code: newFenceCode() }; out.push(fenceHead(range.kind, open.code, range.from, range.addressedToAgent)); }
    out.push(row);
  });
  close();
  return out;
}
/** A character slice of a kept whole, its fenced share re-fenced and the stored markers left out. */
function presentSlice(text: string, start: number, end: number): string {
  let out = '';
  let pos = start;
  for (const r of fenceRanges(text)) {
    if (r.endEnd <= pos || r.headStart >= end) continue;
    if (r.headStart > pos) out += text.slice(pos, r.headStart);
    const a = Math.max(r.bodyStart, pos);
    const b = Math.min(r.bodyEnd, end);
    if (b > a) { const code = newFenceCode(); out += `${fenceHead(r.kind, code, r.from, r.addressedToAgent)}\n${text.slice(a, b)}\n${fenceEnd(r.kind, code)}`; }
    pos = Math.min(end, r.endEnd);
  }
  return out + (pos < end ? text.slice(pos, end) : '');
}

/** One page of an answer. The room left under the view is for the header, the footer and the
 *  short engine notes that are appended to a result after it is admitted (a link reminder, a
 *  repeat rule note), so a full page plus those still fits the view whole. */
const PAGE_CHARS = TOOL_RESULT_VIEW_CHARS - 1_000;

/** How much of a long matching line a search shows around the match. */
const SEARCH_CONTEXT_CHARS = 150;

const n = (x: number): string => x.toLocaleString('en-US');

export interface ReadArgs {
  from_line?: unknown;
  to_line?: unknown;
  offset?: unknown;
  search?: unknown;
}

/** One page of a kept result, as the agent asked for it. Pure: the text in, the answer out. */
export function readResultPage(text: string, id: string, args: ReadArgs): string {
  const lines = resultLines(text);
  const map = fenceMap(text, lines);
  const total = lines.length;
  const width = String(total).length;
  const row = (i: number, body: string): string => `${String(i).padStart(width)}\t${body}`;
  const fromArg = coerceNumberArg(args.from_line);
  const from = Math.max(1, Math.floor(fromArg ?? 1));
  const search = typeof args.search === 'string' ? args.search : '';

  if (search.trim() !== '') {
    const needle = search.toLowerCase();
    const lower = lines.map((l) => l.toLowerCase());
    const matching = lower.reduce((c, l) => (l.includes(needle) ? c + 1 : c), 0);
    if (matching === 0) return `No line of tool result ${id} contains ${JSON.stringify(search)} (${n(total)} lines searched).`;
    const out: string[] = [];
    const lineOf: number[] = [];
    let used = 0;
    let last = 0;
    let more = false;
    for (let i = from - 1; i < total; i++) {
      const at = lower[i].indexOf(needle);
      if (at === -1) continue;
      const line = lines[i];
      const start = charBoundary(line, Math.max(0, at - SEARCH_CONTEXT_CHARS), 'back');   // never half a character
      const end = charBoundary(line, Math.min(line.length, at + needle.length + SEARCH_CONTEXT_CHARS), 'forward');
      const shown = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
      const r = row(i + 1, shown);
      if (used + r.length + 1 > PAGE_CHARS) { more = true; break; }
      out.push(r);
      lineOf.push(i + 1);
      used += r.length + 1;
      last = i + 1;
    }
    const head = `Search for ${JSON.stringify(search)} in tool result ${id} (${n(total)} lines): `
      + `${n(matching)} matching line${matching === 1 ? '' : 's'}${from > 1 ? `; listed from line ${n(from)}` : ''}. `
      + 'Each line starts with its line number.';
    const foot = more
      ? `[More matches after line ${n(last)}: ${readCall(id, { search, from_line: last + 1 })}]`
      : `[End of matches. Read around a match with ${readCall(id, { from_line: Math.max(1, (last || from) - 5) })}.]`;
    return out.length === 0
      ? `${head}\n[No matches at or after line ${n(from)}. Search from the start with ${readCall(id, { search })}.]`
      : `${head}\n${presentRows(out, lineOf, map).join('\n')}\n${foot}`;
  }

  const offsetArg = coerceNumberArg(args.offset);
  if (offsetArg !== null) {
    const asked = Math.max(0, Math.floor(offsetArg));
    if (asked >= text.length) return `[Tool result ${id} has ${n(text.length)} characters; offset ${n(asked)} is past its end.]`;
    // A page opens and ends on a character boundary, never inside a surrogate pair.
    const start = charBoundary(text, asked, 'back');
    const cut = charBoundary(text, Math.min(text.length, start + PAGE_CHARS), 'back');
    const end = cut > start ? cut : charBoundary(text, start + 1, 'forward');
    const foot = end < text.length
      ? `[Characters ${n(start)}–${n(end)} of ${n(text.length)}. Continue: ${readCall(id, { offset: end })}]`
      : `[Characters ${n(start)}–${n(end)} of ${n(text.length)}; end of result.]`;
    return `${presentSlice(text, start, end)}\n${foot}`;
  }

  if (from > total) return `[Tool result ${id} has ${n(total)} lines; line ${n(from)} is past its end.]`;
  const toArg = coerceNumberArg(args.to_line);
  const to = toArg === null ? total : Math.min(total, Math.max(from, Math.floor(toArg)));
  const out: string[] = [];
  const at: number[] = [];
  let used = 0;
  let last = from - 1;
  for (let i = from; i <= to; i++) {
    const r = row(i, lines[i - 1]);
    if (used + r.length + 1 <= PAGE_CHARS) {
      out.push(r);
      at.push(i);
      used += r.length + 1;
      last = i;
      continue;
    }
    if (out.length === 0) {
      // One line longer than a page: its start, and the offset that reads on inside it.
      const take = charBoundary(lines[i - 1], PAGE_CHARS - width - 1, 'back');   // never half a character
      let lineStart = 0;
      for (let k = 0; k < i - 1; k++) lineStart += lines[k].length + 1;
      return `${presentRows([row(i, lines[i - 1].slice(0, take))], [i], map).join('\n')}\n[Line ${n(i)} is longer than one page; this is its first `
        + `${n(take)} of ${n(lines[i - 1].length)} characters. Read on inside it: ${readCall(id, { offset: lineStart + take })}]`;
    }
    break;
  }
  const range = `Lines ${n(from)}–${n(last)} of ${n(total)}`;
  const foot = last === total
    ? `[${range}; end of result.]`
    : last < to
      ? `[${range}. Continue: ${readCall(id, { from_line: last + 1, ...(toArg === null ? {} : { to_line: to }) })}]`
      : `[${range}.]`;
  return `${presentRows(out, at, map).join('\n')}\n${foot}`;
}

export const resultReadHandlers: ToolHandlerMap = {
  async [RESULT_READ_TOOL]({ agentId, args }) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) {
      return {
        content: `Error: ${RESULT_READ_TOOL} needs the id named in the result's note, e.g. ${readCall('call_abc', { from_line: 1 })}.`,
        isError: true, errorCode: 'INVALID_ARGS',
      };
    }
    const found = findToolResult(agentId, id);
    if (!found) {
      return {
        content: `No tool result with id "${id}" is stored for you. Use the id exactly as the result's note names it: the id of the tool call that produced it.`,
        isError: true, errorCode: 'NOT_FOUND',
      };
    }
    return { content: readResultPage(found.content, id, args), isError: false };
  },
};
