// ════════════════════════════════════════════════════════════════════════════
// CLOCK: `get_current_time` and `convert_time`, two pure functions with no effect, no gate and
// no filesystem, so their own module. The category label is NOT changed: `tools/categories.ts`
// still files them under "File & System", a string on the wire in the tool index, so touching it
// would move the cache prefix. Module boundary, not a re-categorisation.
// Byte-faithful, including the scheduler's `note` dependency and the full parse-failure format list.
// ════════════════════════════════════════════════════════════════════════════

import { parseFlexibleTime, formatTimeForAgent } from '../../../services/format-time.js';
import type { ToolHandlerMap } from '../handler.js';

export const clockHandlers: ToolHandlerMap = {
  async get_current_time() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const utcIso = now.toISOString();
    const localStr = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const offsetMin = now.getTimezoneOffset();
    const offsetSign = offsetMin <= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMin);
    const offsetStr = `${offsetSign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
    const offsetHours = Math.abs(offsetMin / 60);
    const conversionHint = offsetMin > 0
      ? `To convert local to UTC: add ${offsetHours} hours`
      : offsetMin < 0
        ? `To convert local to UTC: subtract ${offsetHours} hours`
        : 'Local time is UTC';

    return {
      content: JSON.stringify({
        utc: utcIso,
        local: localStr,
        timezone: tz,
        utc_offset: offsetStr,
        conversion: conversionHint,
        note: 'ALWAYS use the utc value when setting scheduled_start on tasks. All scheduling is UTC.',
      }),
      isError: false,
    };
  },

  async convert_time({ args }) {
    try {
      const parsed = parseFlexibleTime(args.input as string, args.from_tz as string | undefined);
      if (!parsed) {
        return {
          content: `Error: could not parse "${args.input}" as a timestamp. Supported formats: ISO 8601 (with or without offset), unix epoch (seconds or ms), RFC 2822. If the input has no offset, pass from_tz so the tool knows how to interpret it.`,
          isError: true,
        };
      }
      return { content: formatTimeForAgent(parsed, { timezone: args.to_tz as string | undefined }), isError: false };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
