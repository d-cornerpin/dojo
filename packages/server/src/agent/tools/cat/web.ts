// ════════════════════════════════════════════════════════════════════════════
// WEB (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// `web_search`, `web_fetch`, `web_browse`. Three thin bodies, and the thinness
// is the point: the network egress they perform lives behind `web-tools.ts` and
// `browser.ts`, and the PERMISSION they need is a DECLARED gate evaluated by
// T2's gate loop in the executor, ahead of dispatch. §T0-PINS P1's survey found
// two of those the old ladder had already lost by being fifteen hand-written
// branches — `web_browse`'s SECOND gate (manifest `system_control` AND a per-URL
// `checkPermission` for sub-agents) and `web_search`'s, which has no argument to
// key on and is invisible to any scan of the args. Neither was ever in these
// bodies, so this move cannot take one with it.
//
// RELOCATION, NOT REWRITE.
// ════════════════════════════════════════════════════════════════════════════

import { webSearch, webFetch } from '../../web-tools.js';
import { executeWebBrowse } from '../../browser.js';
import type { ToolHandlerMap } from '../handler.js';

// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 11 T45 — SOURCES BOUND THE SPECIFICS (round-11 S1, S4-Denver)
//
// S1's reply stated the Fremont Sunday Market runs "10 AM–4 PM … rain or shine".
// The one source the turn read contains neither specific; the recorder re-checked
// the real hours and found the reply lucky-right, not sourced. S4's "home from
// Denver" is the same class on another surface — no work row, no calendar event,
// the sentence traced to the agent's own earlier chat text while the calendar
// covering that window was silent. Confident specifics beyond what was read, no
// hedge.
//
// The guidance rides the RESULT because that is the decision moment. dsh's F4, in
// their words: "the failure arrives mid-task; a static instruction does not
// reliably reach the retry decision, while the error message is present exactly
// when the model must act." HL6's door-text audit reached the same verdict on
// this platform's own record and migrated a static conduct sentence out of the
// summaries header and into the board-read result for exactly this reason.
//
// It costs ZERO cached prefix bytes: a `return` value is not a tool description
// and not a registry entry — the [FILED] precedent (W17), verified the same way
// at W18's release check. No recognizer, no steer, no floor; one literal,
// appended to results the two READ tools actually produced.
//
// A REFUSAL IS NOT A SOURCE. `isError` results (permission denied, a failed
// search or fetch, the missing-`prompt` refusal) are returned byte-identical:
// there are no results there for the sentence to be about, and appending it
// would put text between the model and a message it has to act on.
// ════════════════════════════════════════════════════════════════════════════

/** The line, one literal, shared by both read tools so they cannot drift apart. */
export const WEB_RESULT_SOURCE_BOUND =
  '[These results are the only sources this turn has read. If your answer states specifics '
  + '(hours, prices, dates, policies) they do not contain, either fetch a page that confirms '
  + 'them or say which details are unverified.]';

const withSourceBound = (content: string): string => `${content}\n\n${WEB_RESULT_SOURCE_BOUND}`;

export const webHandlers: ToolHandlerMap = {
  async "web_search"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await webSearch(agentId, {
      query: args.query as string,
      count: args.count as number | undefined,
    });
    isError = content.startsWith('Permission denied') || content.startsWith('Web search failed');
    if (!isError) content = withSourceBound(content);
    return { content, isError };
  },

  async "web_fetch"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      content =
        'Error: web_fetch requires a `prompt` parameter describing what to extract. ' +
        'Example: web_fetch({ url: "...", prompt: "the main argument and 3 supporting points" }). ' +
        'A required prompt keeps the result small (~1-2K tokens) instead of dumping the raw page (often 50K+).';
      isError = true;
      return { content, isError };
    }
    content = await webFetch(agentId, {
      url: args.url as string,
      prompt: args.prompt as string,
    });
    isError = content.startsWith('Permission denied') || content.startsWith('Fetch failed');
    if (!isError) content = withSourceBound(content);
    return { content, isError };
  },

  async "web_browse"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await executeWebBrowse(agentId, {
      action: args.action as string,
      url: args.url as string | undefined,
      selector: args.selector as string | undefined,
      text: args.text as string | undefined,
      scroll_direction: args.scroll_direction as string | undefined,
      scroll_amount: args.scroll_amount as number | undefined,
      goal: args.goal as string | undefined,
    });
    isError = content.startsWith('Error');
    return { content, isError };
  },

};
