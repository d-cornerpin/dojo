// ════════════════════════════════════════════════════════════════════════════
// RESULT PAGINATION — A LEAF (PHASE-5 T1 Step 2)
//
// `applyTextPagination` lived in `agent/tools.ts` and six call sites in
// `google/tools-read.ts` and `microsoft/tools-read.ts` reached it through
// `await import('../agent/tools.js')` — six of the seven dynamic-import hacks
// §T0-PINS P8 pinned to the site. The hacks existed for one reason: those
// modules already type-imported `tools.ts`, `tools.ts` imports them straight
// back, and a static value import would have closed the loop. With the helper
// living in a module that imports NOTHING, the loop does not exist and the six
// call sites are ordinary static imports.
//
// `coerceNumberArg` comes with it because it is the helper's only dependency
// and `agent/tools.ts` was its sole consumer otherwise
// (`git grep -n coerceNumberArg -- packages/` at `d0b3320`: no hits outside
// that file). `tools.ts` imports it back and keeps re-exporting it, so the nine
// coercion sites T3 Step 3 is going to replace are exactly where they were.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Defensive type coercion for numeric tool arguments.
 *
 * Some providers (DeepSeek via OpenRouter, weak Ollama models) emit numeric
 * tool args as JSON STRINGS even when the schema says `type: 'number'`. A
 * naive `typeof v === 'number'` check rejects them and the tool falls back
 * to defaults, silently breaking pagination, timeouts, and other numeric
 * params. This helper accepts either type and returns the parsed number,
 * or null if the value is missing / unparseable.
 *
 * Phase 3.5 (2026-05-04). Apply to every numeric tool arg that needs strict
 * handling (offset/limit, timeout, etc.). Args that flow into JS arithmetic
 * (Math.min, slice ranges) often survive without this because JS coerces;
 * args used in strict-equality or typeof checks need it.
 */
export function coerceNumberArg(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Slice a fetched text body by (offset, limit) chars and append a friendly
 * pagination trailer when more remains. Used by *_read tools (gmail_read,
 * drive_read, docs_read, sheets_read, outlook_read, onedrive_read) so an
 * agent can read large content end-to-end without losing data to the cap.
 *
 * Phase 3.5 (2026-05-04). Char-based (not line-based) because email/doc
 * content has variable line lengths; chars give the agent a predictable
 * stride. Default limit = 20K chars (~5K tokens), well under the engine
 * maxResultTokens cap and leaves room for the trailer.
 *
 * The trailer format ("[Read chars X-Y of Z…]") is recognized by
 * applyMaxResultTokensCap's carve-out so the engine cap doesn't strip
 * the friendly per-tool guidance.
 */
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

  // No truncation, entire content fits in this slice.
  if (offset === 0 && end >= total) return slice;

  if (end >= total) {
    return slice + `\n\n[End of content. Read chars ${offset}-${end} of ${total} total.]`;
  }

  // More content remains, give exact next-call guidance.
  const remaining = total - end;
  const nextArgs = { ...callExampleArgs, offset: end, limit };
  return (
    slice +
    `\n\n[Read chars ${offset}-${end} of ${total} total. ${remaining} more chars remain.\n` +
    ` To continue: ${toolName}(${stringifyArgs(nextArgs)}).]`
  );
}

function stringifyArgs(args: Record<string, unknown>): string {
  // Compact key=value rendering for the trailer, e.g. message_id="abc", offset=5000, limit=20000.
  return Object.entries(args)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}="${v}"`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(', ');
}
