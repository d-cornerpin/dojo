// WEB: `web_search`, `web_fetch`, `web_browse`.
// PERMISSION is a DECLARED gate the executor's gate loop evaluates ahead of
// dispatch, never in these bodies: `web_browse` has two (manifest
// `system_control` AND a per-URL `checkPermission` for sub-agents), and
// `web_search`'s has no argument to key on. Neither lives in a handler body.

import { webSearch, webFetch } from '../../web-tools.js';
import { executeWebBrowse } from '../../browser.js';
import { STOPPED_BY_USER } from '../../abortable-call.js';
import type { ToolHandlerMap } from '../handler.js';

// The line rides the RESULT because that is the decision moment, and a return
// value costs zero cached prefix bytes. A refusal is not a source: error and
// no-results answers are returned byte-identical, with nothing appended.

/** The line, one literal, shared by both read tools so they cannot drift apart. */
export const WEB_RESULT_SOURCE_BOUND =
  '[These results are the only sources this turn has read. If your answer states specifics '
  + '(hours, prices, dates, policies) they do not contain, either fetch a page that confirms '
  + 'them or say which details are unverified.]';

const withSourceBound = (content: string): string => `${content}\n\n${WEB_RESULT_SOURCE_BOUND}`;

/** Answers that hold no results: nothing was read, so the "only sources" line has nothing to be about. */
const holdsNoSources = (content: string): boolean =>
  content === STOPPED_BY_USER
  || content.startsWith('Web search not configured')
  || content.startsWith('That URL returned HTTP ');

export const webHandlers: ToolHandlerMap = {
  async "web_search"({ agentId, args }) {
    let content = '';
    let isError = false;
    content = await webSearch(agentId, {
      query: args.query as string,
      count: args.count as number | undefined,
    });
    isError = content.startsWith('Permission denied') || content.startsWith('Web search failed');
    if (!isError && !holdsNoSources(content)) content = withSourceBound(content);
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
    if (!isError && !holdsNoSources(content)) content = withSourceBound(content);
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
