// ════════════════════════════════════════════════════════════════════════════
// READING A KEPT TOOL RESULT (t200, D12 — the owner's own design)
//
// A tool result too long for the view is kept whole, and the agent sees its start, its end and
// a note naming this tool with the result's id (`memory/tool-result-view.ts`). This is the read:
// a line range, a character offset for a line longer than a page, or a search that lists the
// matching lines with their numbers. Every answer is one page sized to the view, and its last
// line says exactly how to read on, so a page is never cut and never itself becomes a pointer.
//
// Any of the agent's own tool results can be read by its call id: a long one from the store, any
// other from the `tool` row it was recorded on (`memory/kept-results.ts`).
// ════════════════════════════════════════════════════════════════════════════

import { coerceNumberArg } from '../pagination.js';
import { findToolResult } from '../../../memory/kept-results.js';
import { RESULT_READ_TOOL, TOOL_RESULT_VIEW_CHARS, readCall, resultLines } from '../../../memory/tool-result-view.js';
import type { ToolHandlerMap } from '../handler.js';

/** One page of an answer. The room left under the view is for the header, the footer and the
 *  short engine notes that are appended to a result after it is admitted (a link reminder, a
 *  repeated-call brake), so a full page plus those still fits the view whole. */
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
    let used = 0;
    let last = 0;
    let more = false;
    for (let i = from - 1; i < total; i++) {
      const at = lower[i].indexOf(needle);
      if (at === -1) continue;
      const line = lines[i];
      const start = Math.max(0, at - SEARCH_CONTEXT_CHARS);
      const end = Math.min(line.length, at + needle.length + SEARCH_CONTEXT_CHARS);
      const shown = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
      const r = row(i + 1, shown);
      if (used + r.length + 1 > PAGE_CHARS) { more = true; break; }
      out.push(r);
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
      : `${head}\n${out.join('\n')}\n${foot}`;
  }

  const offsetArg = coerceNumberArg(args.offset);
  if (offsetArg !== null) {
    const start = Math.max(0, Math.floor(offsetArg));
    if (start >= text.length) return `[Tool result ${id} has ${n(text.length)} characters; offset ${n(start)} is past its end.]`;
    const end = Math.min(text.length, start + PAGE_CHARS);
    const foot = end < text.length
      ? `[Characters ${n(start)}–${n(end)} of ${n(text.length)}. Continue: ${readCall(id, { offset: end })}]`
      : `[Characters ${n(start)}–${n(end)} of ${n(text.length)}; end of result.]`;
    return `${text.slice(start, end)}\n${foot}`;
  }

  if (from > total) return `[Tool result ${id} has ${n(total)} lines; line ${n(from)} is past its end.]`;
  const toArg = coerceNumberArg(args.to_line);
  const to = toArg === null ? total : Math.min(total, Math.max(from, Math.floor(toArg)));
  const out: string[] = [];
  let used = 0;
  let last = from - 1;
  for (let i = from; i <= to; i++) {
    const r = row(i, lines[i - 1]);
    if (used + r.length + 1 <= PAGE_CHARS) {
      out.push(r);
      used += r.length + 1;
      last = i;
      continue;
    }
    if (out.length === 0) {
      // One line longer than a page: its start, and the offset that reads on inside it.
      const take = PAGE_CHARS - width - 1;
      let lineStart = 0;
      for (let k = 0; k < i - 1; k++) lineStart += lines[k].length + 1;
      return `${row(i, lines[i - 1].slice(0, take))}\n[Line ${n(i)} is longer than one page; this is its first `
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
  return `${out.join('\n')}\n${foot}`;
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
