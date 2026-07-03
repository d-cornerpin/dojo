// ════════════════════════════════════════
// C27 Phase 1: hidden tool aliases (rename/merge migration)
// ════════════════════════════════════════
//
// A rename or merge is a tool-CONTRACT change: agents hold old tool names in
// vault memory and in in-flight tracker tasks, and prompts/tests reference
// them. To avoid breaking that on the day a rename lands, every renamed/merged
// tool keeps a HIDDEN alias here for at least one release. An alias is NOT a
// tool definition, so it never appears in the tool index or the API tools array
// (it cannot be selected fresh), but a call to the old name still routes to the
// new tool (with a param transform where the shape changed) and the result
// carries a one-line "renamed" note.
//
// A deleted tool (no replacement) gets a `tombstone` entry: the old name
// returns a fixed pointer error telling the agent what to use instead.
//
// Resolution hooks (see the wiring in tools.ts / v2/loop.ts):
//   1. loop ingestion: canonicalize the model's tool-call names before any gate
//      or classifier reads them (they match on canonical names).
//   2. executeTool wrapper: safety net for every dispatch path (synthetic
//      calls, A2A, auto-route) + emits the rename note on the result.
//   3. load_tool_docs: an old name resolves to the new tool's docs.
//   4. tools_policy: old allow/deny entries map to the new name.

export interface AliasRename {
  to: string;
  transform?: (args: Record<string, unknown>) => Record<string, unknown>;
  note?: string;
  added?: string; // release the alias was added, for the eventual removal pass
}

export interface AliasTombstone {
  tombstone: string; // the pointer-error message returned for the removed tool
  added?: string;
}

export type AliasEntry = AliasRename | AliasTombstone;

export function isTombstone(e: AliasEntry): e is AliasTombstone {
  return 'tombstone' in e;
}

// The alias table. Populated cluster-by-cluster as renames land.
// `added` records the pass; removal needs its own approved pass (keep >= 1 release).
export const TOOL_ALIASES: Record<string, AliasEntry> = {
  // ── C27 Phase 1: memory / retrieval cluster (substrate in the name) ──
  // history_* = raw conversation history + summaries; vault_* = curated store.
  memory_grep: { to: 'history_search', added: 'C27p1 2026-07-03' },
  memory_describe: { to: 'history_get', added: 'C27p1 2026-07-03' },
  memory_expand: { to: 'history_expand', added: 'C27p1 2026-07-03' },
  vault_expand: { to: 'vault_get', added: 'C27p1 2026-07-03' },
  // memory_search was DELETED (self-described wrapper); route to history_search,
  // renaming its {query} param to history_search's {pattern} and keeping the rest.
  memory_search: {
    to: 'history_search',
    added: 'C27p1 2026-07-03',
    transform: (args) => {
      const { query, ...rest } = args as { query?: unknown } & Record<string, unknown>;
      return query !== undefined ? { ...rest, pattern: query } : { ...rest };
    },
  },

  // ── C27 Phase 1: name-collision swap pairs (disambiguate by mechanism) ──
  show_canvas: { to: 'canvas_render', added: 'C27p1 2026-07-03' },
  view_canvas: { to: 'canvas_read', added: 'C27p1 2026-07-03' },       // path/url/html params dropped
  screen_read: { to: 'screen_screenshot', added: 'C27p1 2026-07-03' },
  screen_share: { to: 'screen_broadcast', added: 'C27p1 2026-07-03' },
  open_page: { to: 'dashboard_navigate', added: 'C27p1 2026-07-03' },
  contact_describe: { to: 'contacts_overview', added: 'C27p1 2026-07-03' },

  // ── C27 Phase 1: mechanical merges (old name -> merged tool + injected discriminator) ──
  tunnel_status: { to: 'tunnel', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, action: 'status' }) },
  tunnel_start: { to: 'tunnel', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, action: 'start' }) },
  tunnel_stop: { to: 'tunnel', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, action: 'stop' }) },
  tunnel_restart: { to: 'tunnel', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, action: 'restart' }) },
  tracker_validate_pause: { to: 'tracker_validate', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, kind: 'pause' }) },
  tracker_validate_complete: { to: 'tracker_validate', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, kind: 'complete' }) },
  tracker_validate_blocked: { to: 'tracker_validate', added: 'C27p1 2026-07-03', transform: (a) => ({ ...a, kind: 'blocked' }) },
  // update_agent_* pass through unchanged (the merged tool reads whichever fields are present).
  update_agent_model: { to: 'update_agent', added: 'C27p1 2026-07-03' },
  update_agent_profile: { to: 'update_agent', added: 'C27p1 2026-07-03' },
  update_agent_permissions: { to: 'update_agent', added: 'C27p1 2026-07-03' },

  // ── C27 Phase 1: removed dead stubs (tombstones, no replacement tool) ──
  tracker_edit_notes: { added: 'C27p1 2026-07-03', tombstone: 'Error: tracker_edit_notes was removed. To append a note use tracker_add_notes; to replace the notes field use tracker_edit_task({ task_id, notes }).' },
  tracker_clear_notes: { added: 'C27p1 2026-07-03', tombstone: 'Error: tracker_clear_notes was removed. To append a note use tracker_add_notes; to replace/clear the notes field use tracker_edit_task({ task_id, notes: "" }).' },
};

export interface ResolvedAlias {
  name: string;
  args: Record<string, unknown>;
  note?: string;       // engine note to prepend to the tool result, when aliased
  tombstone?: string;  // set when the old name was removed with no replacement
}

/**
 * Resolve a possibly-aliased tool name to its canonical form. Returns the input
 * unchanged when the name is not an alias. For a rename, applies the optional
 * arg transform and attaches the rename note. For a tombstone, returns the
 * pointer error in `tombstone` (the caller returns it as a tool error).
 */
export function resolveToolAlias(name: string, args: Record<string, unknown>): ResolvedAlias {
  const entry = TOOL_ALIASES[name];
  if (!entry) return { name, args };
  if (isTombstone(entry)) {
    return { name, args, tombstone: entry.tombstone };
  }
  const nextArgs = entry.transform ? entry.transform(args) : args;
  const note = entry.note ?? `[Engine note: "${name}" is now "${entry.to}". Use the new name next time.]`;
  return { name: entry.to, args: nextArgs, note };
}

/** True when a name is a hidden alias (rename or tombstone). */
export function isToolAlias(name: string): boolean {
  return name in TOOL_ALIASES;
}
