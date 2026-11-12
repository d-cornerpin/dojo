// RESULT PAGINATION, a leaf: this module imports nothing of the server, so the `*_read` tools
// can import it statically without closing an import loop back through `agent/tools.ts`.

import { outsideSpan } from '@dojo/shared';

/** Some providers emit numeric tool args as JSON strings despite the schema's `type: 'number'`,
 *  so a plain `typeof` check drops them to defaults; accept number or parseable string, else null. */
export function coerceNumberArg(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Slice a fetched text body by (offset, limit) chars for the `*_read` tools; the trailer names the
 *  exact next-call args when content remains, and the executor's own-page carve-out (`resultViewChars`)
 *  recognizes it, so keep the two in step. Every caller pages a body somebody else wrote, so the slice
 *  is marked as the outside span (`outsideSpan`); the trailers stay the platform's own words. */
export function applyTextPagination(
  content: string,
  toolName: string,
  args: { offset?: number | string; limit?: number | string },
  callExampleArgs: Record<string, unknown>,
  defaultLimit: number = 20_000,
): string {
  const total = content.length;
  const offsetNum = coerceNumberArg(args.offset);
  const limitNum = coerceNumberArg(args.limit);
  const offset = offsetNum !== null ? Math.max(0, Math.floor(offsetNum)) : 0;
  const limit = limitNum !== null ? Math.max(1, Math.floor(limitNum)) : defaultLimit;

  if (total === 0) return content;

  if (offset >= total) {
    return `[End of content. Total: ${total} chars. Requested offset (${offset}) is past the end. To read from the start: ${toolName}(${stringifyArgs({ ...callExampleArgs })}).]`;
  }

  const end = Math.min(offset + limit, total);
  const slice = content.slice(offset, end);

  if (offset === 0 && end >= total) return outsideSpan(slice);

  if (end >= total) {
    return outsideSpan(slice) + `\n\n[End of content. Read chars ${offset}-${end} of ${total} total.]`;
  }

  const remaining = total - end;
  const nextArgs = { ...callExampleArgs, offset: end, limit };
  return (
    outsideSpan(slice) +
    `\n\n[Read chars ${offset}-${end} of ${total} total. ${remaining} more chars remain.\n` +
    ` To continue: ${toolName}(${stringifyArgs(nextArgs)}).]`
  );
}

function stringifyArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}="${v}"`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(', ');
}
