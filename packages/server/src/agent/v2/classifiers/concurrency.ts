// Groups consecutive same-category tool calls into batches so the executor can run
// safe (read-only) batches concurrently via Promise.all and serialize everything
// else. Unknown tools default to 'special', the safest serial behavior.

import type { ToolCall } from '@dojo/shared';
import { workOperation } from '../../../tools/work-verbs.js';

export type ToolCategory = 'safe' | 'serial' | 'agent' | 'special';

export interface ToolBatch {
  category: ToolCategory;
  calls: ToolCall[];
}

/** Category map, now the fallback only: ToolDefinition.concurrency registers into
 *  REGISTRY_OVERRIDES and wins every lookup here. Drift costs parallelism, never
 *  correctness: unmapped tools fall back to 'special' (serial), the safest behavior. */
export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // ── safe (read-only, parallelizable) ──
  load_tool_docs: 'safe',
  file_read: 'safe',
  file_list: 'safe',
  share_file: 'safe',
  history_search: 'safe',
  history_get: 'safe',
  history_expand: 'safe',
  web_search: 'safe',
  web_fetch: 'safe',
  vault_search: 'safe',
  get_current_time: 'safe',
  list_agents: 'safe',
  list_models: 'safe',
  list_groups: 'safe',
  list_techniques: 'safe',
  technique_list_versions: 'safe',
  technique_read: 'safe',
  get_agent_profile: 'safe',
  gmail_search: 'safe',
  gmail_read: 'safe',
  calendar_agenda: 'safe',
  calendar_search: 'safe',
  drive_read: 'safe',
  docs_read: 'safe',
  sheets_read: 'safe',
  outlook_search: 'safe',
  outlook_read: 'safe',
  calendar_agenda_ms: 'safe',
  calendar_search_ms: 'safe',
  onedrive_search: 'safe',
  onedrive_read: 'safe',
  teams_list_chats: 'safe',

  // ── serial (writes, side effects) ──
  file_write: 'serial',
  exec: 'serial',
  applescript_run: 'serial',
  vault_remember: 'serial',
  vault_forget: 'serial',
  // The tracker verbs moved to WORK_OP_CONCURRENCY below: `work_update` is both the
  // status write (serial) and the two reads (safe), so no single name-keyed entry fits.
  healer_log_action: 'serial',
  healer_propose: 'serial',
  set_user_presence: 'serial',
  tunnel: 'serial',
  gmail_send: 'serial',
  gmail_draft: 'serial',
  gmail_reply: 'serial',
  gmail_label: 'serial',
  calendar_create: 'serial',
  calendar_update: 'serial',
  calendar_delete: 'serial',
  calendar_respond_invite: 'serial',
  drive_upload: 'serial',
  drive_create_folder: 'serial',
  drive_share: 'serial',
  drive_delete: 'serial',
  docs_create: 'serial',
  sheets_create: 'serial',
  outlook_send: 'serial',
  outlook_draft: 'serial',
  outlook_reply: 'serial',
  outlook_delete: 'serial',
  calendar_create_ms: 'serial',
  calendar_update_ms: 'serial',
  calendar_delete_ms: 'serial',
  onedrive_upload: 'serial',
  onedrive_create_folder: 'serial',
  onedrive_share: 'serial',
  onedrive_delete: 'serial',
  teams_send_message: 'serial',
  teams_create_chat: 'serial',
  // Slides, write-shaped (each call mutates the deck)
  slides_create_presentation: 'serial',
  slides_add_slide: 'serial',
  slides_set_style: 'serial',
  // Forms, write-shaped (each call mutates the form). Reads are 'safe'
  // and don't need entries here (default).
  forms_create_form: 'serial',
  forms_add_text_question: 'serial',
  forms_add_choice_question: 'serial',
  forms_add_scale_question: 'serial',
  forms_add_date_question: 'serial',
  forms_update_question: 'serial',
  forms_rename_question: 'serial',
  forms_set_settings: 'serial',
  forms_delete_item: 'serial',
  forms_delete_form: 'serial',
  office_create_word_document: 'serial',
  office_append_to_word_document: 'serial',
  office_get_word_document_outline: 'safe',
  office_read_word_document: 'safe',
  office_replace_in_word_document: 'serial',
  office_insert_in_word_document: 'serial',
  office_delete_block_in_word_document: 'serial',
  office_create_spreadsheet: 'serial',
  office_get_spreadsheet_range: 'safe',
  office_write_spreadsheet_range: 'serial',
  office_append_spreadsheet_rows: 'serial',
  office_add_sheet: 'serial',
  office_delete_sheet: 'serial',
  office_create_presentation: 'serial',
  office_get_presentation_outline: 'safe',
  office_read_presentation: 'safe',
  office_replace_in_presentation: 'serial',
  office_insert_slide: 'serial',
  office_delete_slide: 'serial',
  save_technique: 'serial',
  publish_technique: 'serial',
  update_technique: 'serial',
  submit_technique_for_review: 'serial',
  delete_technique: 'serial',
  use_technique: 'serial',

  // ── agent (multi-agent coordination, sequential) ──
  spawn_agent: 'agent',
  kill_agent: 'agent',
  spawn_timeout_decision: 'agent',
  send_to_agent: 'agent',
  broadcast_to_group: 'agent',
  create_agent_group: 'agent',
  update_group: 'agent',
  delete_group: 'agent',
  assign_to_group: 'agent',
  update_agent: 'agent',
  reset_session: 'agent',

  // ── special (one-of-a-kind semantics) ──
  complete_task: 'special',
  image_create: 'special',
  show_to_user: 'special',
  imessage_send: 'special',
  // System control (mouse/keyboard/screen, sequential, side effects, but not "agent" or "serial write")
  mouse_click: 'special',
  mouse_move: 'special',
  keyboard_type: 'special',
  screen_screenshot: 'special',
  // Browser (stateful, single instance, must be serial)
  web_browse: 'special',
};

/** Per-tool overrides registered from the tool files at module-init time; lookups
 *  check this first, then TOOL_CATEGORY. Registration is one-way (the tool file calls
 *  registerConcurrency), so this map needs no import back there and no cycle exists.
 *  Also stores per-tool max-result-token caps for registries outside tools.ts. */
const REGISTRY_OVERRIDES = new Map<string, ToolCategory>();
const REGISTRY_MAX_RESULT_TOKENS = new Map<string, number>();

export function registerConcurrency(toolName: string, category: ToolCategory): void {
  REGISTRY_OVERRIDES.set(toolName, category);
}

export function registerMaxResultTokens(toolName: string, tokens: number): void {
  REGISTRY_MAX_RESULT_TOKENS.set(toolName, tokens);
}

/** The tool's registered max-result-token cap, or undefined if none. */
export function getRegisteredMaxResultTokens(toolName: string): number | undefined {
  return REGISTRY_MAX_RESULT_TOKENS.get(toolName);
}

/** Keyed on the OPERATION, not the name: `work_update` is both the two reads (safe)
 *  and the status/edit writes; one name-keyed entry could only be one of those. */
export const WORK_OP_CONCURRENCY: Readonly<Record<string, ToolCategory>> = {
  'work_update:list': 'safe',
  'work_update:get': 'safe',
  // Same class as its siblings: it runs SELECTs and nothing else, so it cannot race.
  'work_update:activity': 'safe',
};

/** Lookup order: tracker operation map, then registry override, then TOOL_CATEGORY. */
export function classifyConcurrency(toolName: string, args?: Record<string, unknown>): ToolCategory {
  const op = workOperation(toolName, args);
  if (op !== null) return WORK_OP_CONCURRENCY[op] ?? 'special';
  const override = REGISTRY_OVERRIDES.get(toolName);
  if (override) return override;
  return TOOL_CATEGORY[toolName] ?? 'special';
}

/** Only `safe` batches run concurrently; everything else runs serially. Invariant: a
 *  serial/agent/special call BREAKS a preceding safe batch, the model chose that order
 *  and regrouping by category would change semantics. */
export function partitionTools(toolCalls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const tc of toolCalls) {
    const category = classifyConcurrency(tc.name, tc.arguments);
    const last = batches[batches.length - 1];
    // Only `safe` batches accumulate calls. All other categories produce
    // single-element batches so each gets its own awaited execution.
    if (last && last.category === category && category === 'safe') {
      last.calls.push(tc);
    } else {
      batches.push({ category, calls: [tc] });
    }
  }
  return batches;
}
