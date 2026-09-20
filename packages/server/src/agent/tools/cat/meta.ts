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
import { describeNameFailure } from '../../../tools/name-help.js';
import { getFilteredTools } from '../surface.js';
import { getAllToolDefinitions } from '../definitions.js';

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
    // docs; collect a note so the model learns the new name.
    //
    // FIX-WAVE ITEM 1: a TOMBSTONED (removed, no-replacement) name is neither
    // an alias rename nor a bare naming failure — the alias table already
    // holds the exact remedial pointer for it (`tools/aliases.ts`'s
    // `isTombstone` entries, e.g. `tracker_edit_notes`). Previously a
    // tombstoned name kept its own text and fell straight through to
    // `describeNameFailure` below, which told the model "no similar tool
    // name found... the tool was never real" — a lie, since the table holds
    // the pointer the whole time. Collected separately here and EXCLUDED
    // from the allowed/unknown classification entirely, mirroring the
    // execution path's tombstone check ahead of dispatch
    // (`agent/tools/index.ts:180-182`).
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
    // Now intersect with the agent's accessible tools. Tombstoned names are
    // dropped from this set BEFORE the allowed/unknown split, so they can
    // land in neither group — their pointer text is surfaced on its own below.
    const nonTombstoneRequested = canonicalRequested.filter(t => !tombstonedOriginals.has(t));
    const allowedToolNames = new Set(getFilteredTools(agentId).map(t => t.name));
    // T80a: the global tool universe getFilteredTools filters FROM — so a
    // requested name absent from BOTH sets is classified `unknown` (a naming
    // problem) rather than lumped in with names that exist for other agents
    // but not this one (`exists_not_allowed`, a permission problem).
    const knownToolNames = new Set(getAllToolDefinitions().map(t => t.name));
    const filteredTools = nonTombstoneRequested.filter(t => allowedToolNames.has(t));
    const blockedTools = nonTombstoneRequested.filter(t => !allowedToolNames.has(t));
    if (filteredTools.length === 0) {
      // T80a: the incident — an agent guessed five tool names, the engine
      // told it every one of them was a PERMISSION problem, and it reported
      // itself "blocked" while holding full access. `describeNameFailure`
      // classifies each requested name and reports naming failures and
      // permission failures with DIFFERENT wording and DIFFERENT next steps,
      // instead of one blanket "this is a permission issue" for both.
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
    content = executeLoadToolDocs(agentId, filteredTools);
    // C27 hook 3: tell the model which requested names were renamed.
    if (aliasDocNotes.length > 0 && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${aliasDocNotes.join('; ')}. Docs above are for the new name(s).]`;
    }
    // T80a: if some (but not all) of the requested tools were skipped, append
    // a note naming them — this is the partial-miss path the incident's first
    // call actually hit (4 requested, 2 real, 2 invented; the invented ones
    // were folded into a generic "blocked by tools_policy" note that never
    // said they weren't real names, which taught the agent the invented
    // style was fine). Same classified wording as the total-miss branch,
    // same bracket-note placement/format as the aliasDocNotes note above.
    if (blockedTools.length > 0 && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${describeNameFailure(blockedTools, allowedToolNames, knownToolNames)}]`;
    }
    // FIX-WAVE ITEM 1: a tombstoned name's pointer, verbatim, in its own
    // note — never folded into the naming-failure sentence above it.
    if (tombstoneNote && !content.startsWith('Error')) {
      content += `\n\n[Engine note: ${tombstoneNote}]`;
    }
    isError = content.startsWith('Error');
    return { content, isError };
  },
};
