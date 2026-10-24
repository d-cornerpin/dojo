// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B4 — THE CODE VIEWS: code_search and code_read.
//
// Thin on purpose: the reading, the search, the failure sentences and the pointer line are
// `source-remote.ts`'s (A2), at the commit this box runs. These two check the arguments a
// model hands over and answer a bad one with a plain sentence before any call is made. The
// agent id the dispatcher passes puts every GitHub call under that agent's stop button.
// ════════════════════════════════════════════════════════════════════════════════════════

import { pointerLine, readSourceFile, searchSource } from './source-remote.js';

const isLine = (n: unknown): boolean => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 1);

/** Search the Dojo's source; hits grouped by file, with their line numbers at the running commit. */
export async function codeSearch(args: { pattern: string; path?: string }, agentId?: string): Promise<string> {
  const pattern = (args.pattern ?? '').trim();
  if (!pattern) return `Give a pattern to search for (a name or a phrase from the code).\n\n${pointerLine()}`;
  return searchSource(pattern, args.path?.trim() || undefined, agentId);
}

/** Read one file of the Dojo's source, whole or by line range, numbered. */
export async function codeRead(args: { path: string; from?: number; to?: number }, agentId?: string): Promise<string> {
  if (!isLine(args.from) || !isLine(args.to)) return `from and to are line numbers, starting at 1.\n\n${pointerLine()}`;
  if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
    return `from (${args.from}) is after to (${args.to}); give the first line, then the last.\n\n${pointerLine()}`;
  }
  return readSourceFile(args.path ?? '', args.from, args.to, agentId);
}
