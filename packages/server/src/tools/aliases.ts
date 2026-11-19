// Hidden tool aliases: a renamed or merged tool keeps an old-name entry so agents holding the old name
// reach the new tool. An alias is not a tool definition: it never appears in the tool index or API
// tools array. A tombstone marks a deleted tool: the old name returns a fixed pointer error.
// Each reader of a tool name resolves it first (loop ingestion before any gate, executeTool, load_tool_docs,
// tools_policy, secret fields): a new dispatch path must resolve too, since gates match canonical names.

export interface AliasRename {
  to: string;
  transform?: (args: Record<string, unknown>) => Record<string, unknown>;
}

export interface AliasTombstone {
  tombstone: string;
}

export type AliasEntry = AliasRename | AliasTombstone;

export function isTombstone(e: AliasEntry): e is AliasTombstone {
  return 'tombstone' in e;
}

export const TOOL_ALIASES: Record<string, AliasEntry> = {
  memory_grep: { to: 'history_search' },
  memory_describe: { to: 'history_get' },
  memory_expand: { to: 'history_expand' },
  vault_expand: { to: 'vault_get' },
  // memory_search routes to history_search, renaming its {query} param to {pattern}.
  memory_search: {
    to: 'history_search',
    transform: (args) => {
      const { query, ...rest } = args as { query?: unknown } & Record<string, unknown>;
      return query !== undefined ? { ...rest, pattern: query } : { ...rest };
    },
  },

  show_canvas: { to: 'canvas_render' },
  // view_canvas's path/url/html args are dropped: canvas_read reads only the current canvas.
  view_canvas: { to: 'canvas_read' },
  screen_read: { to: 'screen_screenshot' },
  screen_share: { to: 'screen_broadcast' },
  open_page: { to: 'dashboard_navigate' },
  contact_describe: { to: 'contacts_overview' },

  tunnel_status: { to: 'tunnel', transform: (a) => ({ ...a, action: 'status' }) },
  tunnel_start: { to: 'tunnel', transform: (a) => ({ ...a, action: 'start' }) },
  tunnel_stop: { to: 'tunnel', transform: (a) => ({ ...a, action: 'stop' }) },
  tunnel_restart: { to: 'tunnel', transform: (a) => ({ ...a, action: 'restart' }) },
  // update_agent_* pass through unchanged (the merged tool reads whichever fields are present).
  update_agent_model: { to: 'update_agent' },
  update_agent_profile: { to: 'update_agent' },
  update_agent_permissions: { to: 'update_agent' },

  // Verb collapse: engine sites must key on the verb, since names are canonicalized before any
  // gate or classifier reads the call.
  tracker_create_project: { to: 'work_open', transform: (a) => ({ ...a, kind: 'project' }) },
  tracker_create_task: { to: 'work_open', transform: (a) => ({ ...a, kind: 'task' }) },
  reminder_create: { to: 'work_open', transform: (a) => ({ ...a, kind: 'reminder' }) },
  commitment_open: { to: 'work_open', transform: (a) => ({ ...a, kind: 'commitment' }) },

  tracker_update_status: { to: 'work_update', transform: (a) => ({ ...a, action: 'status' }) },
  tracker_edit_task: { to: 'work_update', transform: (a) => ({ ...a, action: 'edit' }) },
  tracker_edit_project: { to: 'work_update', transform: (a) => ({ ...a, action: 'edit' }) },
  tracker_reassign_task: { to: 'work_update', transform: (a) => ({ ...a, action: 'reassign' }) },
  tracker_complete_step: { to: 'work_update', transform: (a) => ({ ...a, action: 'hand_in' }) },
  tracker_close_project: { to: 'work_update', transform: (a) => ({ ...a, action: 'hand_in' }) },
  tracker_list_active: { to: 'work_update', transform: (a) => ({ ...a, action: 'list' }) },
  tracker_get_status: { to: 'work_update', transform: (a) => ({ ...a, action: 'get' }) },

  tracker_add_notes: { to: 'work_note' },

  commitment_resolve: { to: 'work_close_request', transform: (a) => ({ ...a, action: 'commitment' }) },

  tracker_retask: { to: 'work_validate', transform: (a) => ({ ...a, action: 'retask' }) },

  tracker_pause_schedule: { to: 'work_schedule', transform: (a) => ({ ...a, action: 'pause' }) },
  tracker_resume_schedule: { to: 'work_schedule', transform: (a) => ({ ...a, action: 'resume' }) },

  // Tombstones: the pointer text names the current surface.
  tracker_edit_notes: { tombstone: 'Error: tracker_edit_notes was removed. To append a note use work_note({ task_id, notes }); to replace the notes field use work_update({ action: "edit", task_id, notes }).' },
  tracker_clear_notes: { tombstone: 'Error: tracker_clear_notes was removed. To append a note use work_note({ task_id, notes }); to replace/clear the notes field use work_update({ action: "edit", task_id, notes: "" }).' },
  // Chained in one hop (via tracker_validate) so the oldest names still land on work_validate.
  tracker_validate_complete: { to: 'work_validate', transform: (a) => ({ ...a, action: 'validate', kind: 'complete' }) },
};

export interface ResolvedAlias {
  name: string;
  args: Record<string, unknown>;
  note?: string;
  tombstone?: string;
}

/** Resolve a possibly-aliased name: a rename applies its arg transform and note, a tombstone sets `tombstone`. */
export function resolveToolAlias(name: string, args: Record<string, unknown>): ResolvedAlias {
  const entry = Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : undefined;
  if (!entry) return { name, args };
  if (isTombstone(entry)) {
    return { name, args, tombstone: entry.tombstone };
  }
  const nextArgs = entry.transform ? entry.transform(args) : args;
  const note = `[Engine note: "${name}" is now "${entry.to}". Use the new name next time.]`;
  return { name: entry.to, args: nextArgs, note };
}
