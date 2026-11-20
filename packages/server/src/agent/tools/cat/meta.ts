// META: `load_tool_docs`, and the repeat rule's lift; the label is `tools/categories.ts`'s, not ours.
// Category modules must NOT import `agent/tools.ts` (the rule IS the split), so the
// list comes from the `surface.js` leaf. The `tool-docs.js` lazy load is pinned-sanctioned.

import type { ToolHandlerMap } from '../handler.js';
import { resolveToolAlias } from '../../../tools/aliases.js';
import { describeNameFailure } from '../../../tools/name-help.js';
import { getFilteredTools } from '../surface.js';
import { getAllToolDefinitions } from '../definitions.js';
import { LOAD_TOOL_DOCS_MAX_PER_CALL, loadToolDocsOverflowRefusal } from '../../../tools/tool-session-set.js';
import { liftRepeatStops } from '../../v2/repeat-rule.js';

export const metaHandlers: ToolHandlerMap = {
  async continue_repeating({ agentId, args }) {
    return liftRepeatStops(agentId, args.reason);
  },
  async load_tool_docs({ agentId, args }) {
    let content: string = '';
    let isError = false;
    const { executeLoadToolDocs } = await import('../../../tools/tool-docs.js');
    const requestedTools = (args.tools as string[]) ?? [];
    // Validate the shape FIRST: an "empty array" complaint blames the wrong cause.
    if (!Array.isArray(requestedTools)) {
      content = `Error: tools parameter must be an array of tool names. You passed ${typeof args.tools}. Example: load_tool_docs({tools: ["web_fetch", "gmail_send"]}).`;
      isError = true;
      return { content, isError };
    }
    if (requestedTools.length === 0) {
      content = 'Error: tools parameter must be a non-empty array. Pass at least one tool name. Example: load_tool_docs({tools: ["web_fetch"]}).';
      isError = true;
      return { content, isError };
    }
    // Cap measured on the REQUESTED names, not post-filter (a 40-name request
    // with 6 allowed must fail). Not `maxItems`: the schema sits in the cached prefix.
    if (requestedTools.length > LOAD_TOOL_DOCS_MAX_PER_CALL) {
      return { content: loadToolDocsOverflowRefusal(requestedTools.length), isError: true, errorCode: 'INVALID_ARGS' };
    }
    // A renamed name resolves to the NEW tool's docs and the model is told.
    // A tombstoned name rides its alias-table pointer, EXCLUDED from both groups.
    const aliasDocNotes: string[] = [];
    const tombstoneTexts: string[] = [];
    const tombstonedOriginals = new Set<string>();
    const canonicalRequested = requestedTools.map((t) => {
      const r = resolveToolAlias(t, {});
      if (r.tombstone) {
        tombstonedOriginals.add(t);
        tombstoneTexts.push(r.tombstone);
        return t;
      }
      if (r.name !== t) aliasDocNotes.push(`"${t}" is now "${r.name}"`);
      return r.name;
    });
    const tombstoneNote = tombstoneTexts.length > 0 ? tombstoneTexts.join(' ') : null;
    const nonTombstoneRequested = canonicalRequested.filter(t => !tombstonedOriginals.has(t));
    const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
    const knownToolNames = new Set(getAllToolDefinitions().map(t => t.name));
    const filteredTools = nonTombstoneRequested.filter(t => allowedToolNames.has(t));
    const blockedTools = nonTombstoneRequested.filter(t => !allowedToolNames.has(t));
    if (filteredTools.length === 0) {
      // Naming failures and permission failures get DIFFERENT wording and steps.
      const namingFailureText = blockedTools.length > 0
        ? describeNameFailure(blockedTools, allowedToolNames, knownToolNames)
        : '';
      content =
        `Error: none of the requested tools are accessible to this agent. ` +
        `Requested: [${requestedTools.join(', ')}]. ` +
        [namingFailureText, tombstoneNote].filter(Boolean).join(' ');
      isError = true;
      return { content, isError };
    }
    // Third arg: the live registry, so a missing generated manual has a fallback.
    content = executeLoadToolDocs(agentId, filteredTools, getAllToolDefinitions());
    if (aliasDocNotes.length > 0 && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${aliasDocNotes.join('; ')}. Docs above are for the new name(s).]`;
    }
    if (blockedTools.length > 0 && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${describeNameFailure(blockedTools, allowedToolNames, knownToolNames)}]`;
    }
    // A tombstone pointer rides verbatim, in its own note, never folded in.
    if (tombstoneNote && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${tombstoneNote}]`;
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },
};
