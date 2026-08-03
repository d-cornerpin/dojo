// ════════════════════════════════════════════════════════════════════════════
// META (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// One tool: `load_tool_docs`. The category is not invented here — it is the
// label the code already carries (`tools/categories.ts` opens with
// `{ label: 'Meta', tools: ['load_tool_docs'] }`), which is why this module
// exists rather than the key being parked in whichever neighbouring file had
// room.
//
// ── WHY IT WAS THE LAST KEY TO MOVE ──
// Its body calls `getFilteredTools(agentId)`, which lived in `agent/tools.ts`
// with ~590 lines of surface machinery. A category module may not import
// `agent/tools.ts` — that rule IS the split — so this key could not move until
// the surface did. It now imports `agent/tools/surface.js`, a leaf.
//
// ── TWO-PHASE LOADING IS THE REQUIREMENT THIS TOOL SERVES ──
// The system prompt carries a tool INDEX (names by category, no schemas); the
// model calls this to pull the full schema for a tool it wants. That is the
// token economics the preserve-verbatim list names, so the body is byte-faithful
// down to the four error strings the model retries on, the C27 hook-3 rename
// notes, and FN-8's conditional `complete_task` pointer.
//
// ── THE LAZY LOAD IS SANCTIONED, AND IT IS NOW SANCTIONED FOR A WEAKER REASON ──
// `await import('tools/tool-docs.js')` is on §T0-PINS P8's pinned list as one
// half of a bidirectional pair (T1 adjudication (d)): `tool-docs.ts:424` loads
// `getFilteredTools` back. RE-DERIVED AT THIS HEAD, the split has DISSOLVED that
// cycle — `tools/tool-docs.ts` statically imports only `logger.js`,
// `index-generator.js`, `agent/tools/types.js` (a leaf), `db/connection.js` and
// `config/platform.js`, none of which reaches a dispatcher, and
// `agent/tools/surface.ts` imports nothing under `cat/`. So both halves COULD be
// static today. Neither was converted here: the pair is adjudicated to T7's
// sanctioned-list revisit, and converting a sanctioned site during a relocation
// is an improvement taken under a licence relocation purity does not grant —
// the same call T4 sitting 2 made for the sixteen `contacts`/`techniques` loads.
// Recorded so T7 inherits the measurement rather than the belief.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolHandlerMap } from '../handler.js';
import { resolveToolAlias } from '../../../tools/aliases.js';
import { getFilteredTools } from '../surface.js';

export const metaHandlers: ToolHandlerMap = {
  async load_tool_docs({ agentId, args }) {
    let content: string = '';
    let isError = false;
    const { executeLoadToolDocs } = await import('../../../tools/tool-docs.js');
    const requestedTools = (args.tools as string[]) ?? [];
    // v2.5.15, Validate the input shape FIRST and emit a precise error
    // so the agent doesn't conflate format problems with permission
    // problems. Previously a permission-stripped request fell through
    // to executeLoadToolDocs([]) which then complained about an
    // "empty array", sending the agent down the wrong rabbit hole.
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
    // C27 hook 3: an old (renamed) tool name resolves to the NEW tool's
    // docs; collect a note so the model learns the new name. Tombstoned
    // (removed) tools keep their name and fall through to the blocked path.
    const aliasDocNotes: string[] = [];
    const canonicalRequested = requestedTools.map((t) => {
      const r = resolveToolAlias(t, {});
      if (r.tombstone) return t;
      if (r.name !== t) aliasDocNotes.push(`"${t}" is now "${r.name}"`);
      return r.name;
    });
    // Now intersect with the agent's accessible tools.
    const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
    const filteredTools = canonicalRequested.filter(t => allowedToolNames.has(t));
    const blockedTools = canonicalRequested.filter(t => !allowedToolNames.has(t));
    if (filteredTools.length === 0) {
      // FN-8: only point at complete_task when this agent actually has it
      // (allowedToolNames already reflects the completability filter).
      const blockedEscalation = allowedToolNames.has('complete_task')
        ? `Ask the user to update this agent's permissions, or call complete_task(status="blocked").`
        : `Ask the user to update this agent's permissions, use send_to_agent to reach an agent with broader permissions, or tell the user you are blocked.`;
      content =
        `Error: none of the requested tools are accessible to this agent. ` +
        `Requested: [${requestedTools.join(', ')}]. ` +
        `This is a permission issue, not a format issue, the tools may exist for other agents but are not on this agent's allow list, or the permission filter is stripping them ` +
        `(e.g. web_search/web_fetch require network_domains != "none", exec requires exec_allow non-empty, file_read requires file_read permission). ` +
        blockedEscalation;
      isError = true;
      return { content, isError };
    }
    content = executeLoadToolDocs(agentId, filteredTools);
    // C27 hook 3: tell the model which requested names were renamed.
    if (aliasDocNotes.length > 0 && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${aliasDocNotes.join('; ')}. Docs above are for the new name(s).]`;
    }
    // If some (but not all) of the requested tools were blocked, append
    // a note so the agent knows which ones it didn't get and why.
    if (blockedTools.length > 0 && !content.startsWith('Error')) {
      content +=
        `\n\n[Note: these requested tools were not accessible to this agent and were skipped: ${blockedTools.join(', ')}. ` +
        `Tools may be blocked by tools_policy or by permission filters (network/file/exec/etc.).]`;
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },
};
