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

export const webHandlers: ToolHandlerMap = {
  async "web_search"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await webSearch(agentId, {
      query: args.query as string,
      count: args.count as number | undefined,
    });
    isError = content.startsWith('Permission denied') || content.startsWith('Web search failed');
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
