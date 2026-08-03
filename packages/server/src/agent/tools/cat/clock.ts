// ════════════════════════════════════════════════════════════════════════════
// CLOCK (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `get_current_time` and `convert_time`. `tools/categories.ts` files both under
// "File & System", which research 05 §1 already calls out as the worst-mixed
// category in the tree — *"exec + 5 file verbs + scratchpad + screenshot +
// keyboard/mouse + applescript + 2 time tools = 3 brokers + HID in one label"*.
// They are two pure functions with no effect, no gate and no filesystem, so
// they get their own module rather than riding along with the file verbs.
//
// The CATEGORY LABEL IS NOT CHANGED — `tools/categories.ts` still files them
// under "File & System" and that string is on the wire in the tool index, so
// touching it would move the cache prefix. This is a module boundary, not a
// re-categorisation.
//
// RELOCATION, NOT REWRITE. Both bodies are byte-faithful, including
// `get_current_time`'s JSON shape (the `note` field the scheduler depends on)
// and `convert_time`'s parse-failure message with its full format list.
//
// ── THE LAZY LOAD THAT DIED ──
// `convert_time` fetched `../services/format-time.js` through `await import(…)`.
// Not on §T0-PINS P8's sanctioned list, and that module imports nothing from
// the toolbox, so there was no cycle to break.
// ════════════════════════════════════════════════════════════════════════════

import { parseFlexibleTime, formatTimeForAgent } from '../../../services/format-time.js';
import type { ToolHandlerMap } from '../handler.js';

export const clockHandlers: ToolHandlerMap = {
  async get_current_time() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const utcIso = now.toISOString();
    const localStr = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    // Calculate UTC offset string (e.g., "-06:00") and conversion hint
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
