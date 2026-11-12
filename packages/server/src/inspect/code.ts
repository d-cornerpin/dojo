// Argument checks only; reading and search are source-remote.ts's, under the calling agent's stop.

import { pointerLine, readSourceFile, searchSource } from './source-remote.js';

const isLine = (n: unknown): boolean => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 1);

/** Search the Dojo's source; hits grouped by file, with their line numbers at the running commit. */
export async function codeSearch(args: { pattern: string; path?: string }, agentId?: string): Promise<string> {
  const pattern = (args.pattern ?? '').trim();
  if (!pattern) return `Give a pattern to search for (a name or a phrase from the code).\n\n${pointerLine()}`;
  return searchSource(pattern, args.path?.trim() || undefined, agentId);
}

export async function codeRead(args: { path: string; from?: number; to?: number }, agentId?: string): Promise<string> {
  if (!isLine(args.from) || !isLine(args.to)) return `from and to are line numbers, starting at 1.\n\n${pointerLine()}`;
  if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
    return `from (${args.from}) is after to (${args.to}); give the first line, then the last.\n\n${pointerLine()}`;
  }
  return readSourceFile(args.path ?? '', args.from, args.to, agentId);
}
