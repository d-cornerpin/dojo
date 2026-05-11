// ════════════════════════════════════════
// Phase 1A — partitionTools classifier
//
// Groups consecutive same-category tool calls into batches so the
// executor can run safe (read-only) batches concurrently via
// Promise.all and serialize everything else.
//
// Phase 1A: hard-coded category map keyed by tool name.
// Phase 3 will move the source of truth to ToolDefinition.concurrency
// and replace TOOL_CATEGORY here with a registry lookup. The classifier
// signature stays the same.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';

export type ToolCategory = 'safe' | 'serial' | 'agent' | 'special';

export interface ToolBatch {
  category: ToolCategory;
  calls: ToolCall[];
}

/**
 * Hardcoded category map per Part VII table. Audited against
 * cornerpin-platform/packages/server/src/agent/tools.ts as of v2 plan.
 *
 * Categories:
 *   safe    — pure read, no side effects, parallelizable
 *   serial  — has side effects, must run in order
 *   agent   — coordinates with other agents, sequential
 *   special — one-of-a-kind semantics, sequential
 *
 * Unknown tools default to 'special' (safest serial behavior).
 */
export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // ── safe (read-only, parallelizable) ──
  load_tool_docs: 'safe',
  file_read: 'safe',
  file_list: 'safe',
  share_file: 'safe',
  memory_grep: 'safe',
  memory_describe: 'safe',
  memory_expand: 'safe',
  memory_search: 'safe',
  web_search: 'safe',
  web_fetch: 'safe',
  vault_search: 'safe',
  tracker_get_status: 'safe',
  tracker_list_active: 'safe',
  get_current_time: 'safe',
  tunnel_status: 'safe',
  list_agents: 'safe',
  list_models: 'safe',
  list_groups: 'safe',
  list_techniques: 'safe',
  technique_list_versions: 'safe',
  get_agent_profile: 'safe',
  // Google read-only
  gmail_search: 'safe',
  gmail_read: 'safe',
  calendar_agenda: 'safe',
  calendar_search: 'safe',
  drive_search: 'safe',
  drive_read: 'safe',
  docs_read: 'safe',
  sheets_read: 'safe',
  // Microsoft read-only
  outlook_search: 'safe',
  outlook_read: 'safe',
  calendar_agenda_ms: 'safe',
  calendar_search_ms: 'safe',
  onedrive_search: 'safe',
  onedrive_read: 'safe',
  teams_list_chats: 'safe',
  teams_read_chat: 'safe',

  // ── serial (writes, side effects) ──
  file_write: 'serial',
  exec: 'serial',
  applescript_run: 'serial',
  vault_remember: 'serial',
  vault_forget: 'serial',
  tracker_create_project: 'serial',
  tracker_create_task: 'serial',
  tracker_update_status: 'serial',
  tracker_add_notes: 'serial',
  tracker_edit_task: 'serial',
  tracker_complete_step: 'serial',
  tracker_pause_schedule: 'serial',
  tracker_resume_schedule: 'serial',
  tracker_reassign_task: 'serial',
  healer_log_action: 'serial',
  healer_propose: 'serial',
  set_user_presence: 'serial',
  tunnel_start: 'serial',
  tunnel_stop: 'serial',
  tunnel_restart: 'serial',
  // Google writes
  gmail_send: 'serial',
  gmail_reply: 'serial',
  gmail_archive: 'serial',
  gmail_label: 'serial',
  gmail_delete: 'serial',
  calendar_create: 'serial',
  calendar_update: 'serial',
  calendar_delete: 'serial',
  calendar_respond_invite: 'serial',
  drive_upload: 'serial',
  drive_create_folder: 'serial',
  drive_share: 'serial',
  drive_delete: 'serial',
  docs_create: 'serial',
  docs_update: 'serial',
  sheets_create: 'serial',
  sheets_update: 'serial',
  // Microsoft writes
  outlook_send: 'serial',
  outlook_reply: 'serial',
  outlook_archive: 'serial',
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
  // Slides — write-shaped (each call mutates the deck)
  slides_create_deck: 'serial',
  slides_add_slide: 'serial',
  slides_set_style: 'serial',
  // Forms — write-shaped (each call mutates the form). Reads are 'safe'
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
  // Office (Word/Excel/PowerPoint local files)
  word_create: 'serial',
  word_update: 'serial',
  excel_create: 'serial',
  excel_update: 'serial',
  pptx_create: 'serial',
  pptx_update: 'serial',
  // Techniques (writes to disk)
  save_technique: 'serial',
  publish_technique: 'serial',
  update_technique: 'serial',
  submit_technique_for_review: 'serial',
  delete_technique: 'serial',
  use_technique: 'serial',

  // ── agent (multi-agent coordination, sequential) ──
  spawn_agent: 'agent',
  kill_agent: 'agent',
  send_to_agent: 'agent',
  broadcast_to_group: 'agent',
  create_agent_group: 'agent',
  update_group: 'agent',
  delete_group: 'agent',
  assign_to_group: 'agent',
  update_agent_model: 'agent',
  update_agent_profile: 'agent',
  update_agent_permissions: 'agent',
  reset_session: 'agent',

  // ── special (one-of-a-kind semantics) ──
  complete_task: 'special',
  image_create: 'special',
  show_to_user: 'special',
  imessage_send: 'special',
  // System control (mouse/keyboard/screen — sequential, side effects, but not "agent" or "serial write")
  mouse_click: 'special',
  mouse_move: 'special',
  keyboard_type: 'special',
  screen_read: 'special',
  // Browser (stateful, single instance — must be serial)
  web_browse: 'special',
};

/**
 * Per-tool concurrency overrides registered from `tools.ts` (and
 * google/microsoft tool files) at module-init time. Lookups check this
 * map first, then fall back to TOOL_CATEGORY.
 *
 * Phase 3 (2026-05-04): tools.ts iterates its `toolDefinitions` and calls
 * `registerConcurrency` for any tool with a `concurrency` field set on its
 * definition. This makes ToolDefinition the canonical source of truth
 * without creating a circular import (concurrency.ts → tools.ts → ...).
 *
 * Phase 3.5 (2026-05-04): also stores `maxResultTokens` so cross-file tool
 * registries (Google, Microsoft, Slides, Office) can declare their per-tool
 * caps without all of them having to be in the agent/tools.ts toolDefinitions
 * array. Looked up by `applyMaxResultTokensCap` in agent/tools.ts.
 */
const REGISTRY_OVERRIDES = new Map<string, ToolCategory>();
const REGISTRY_MAX_RESULT_TOKENS = new Map<string, number>();

export function registerConcurrency(toolName: string, category: ToolCategory): void {
  REGISTRY_OVERRIDES.set(toolName, category);
}

export function registerMaxResultTokens(toolName: string, tokens: number): void {
  REGISTRY_MAX_RESULT_TOKENS.set(toolName, tokens);
}

/**
 * Look up a tool's max-result-token cap. Returns undefined if no cap
 * was registered for this tool.
 */
export function getRegisteredMaxResultTokens(toolName: string): number | undefined {
  return REGISTRY_MAX_RESULT_TOKENS.get(toolName);
}

/**
 * Look up a tool's concurrency category. Order of precedence:
 *   1. Definition-level override (registered from tools.ts)
 *   2. Hardcoded TOOL_CATEGORY map (Phase 1A baseline)
 *   3. 'special' (safest serial default for unknown tools)
 */
export function classifyConcurrency(toolName: string): ToolCategory {
  const override = REGISTRY_OVERRIDES.get(toolName);
  if (override) return override;
  return TOOL_CATEGORY[toolName] ?? 'special';
}

/**
 * Group consecutive same-category calls into batches.
 *
 * Only `safe` batches will be executed concurrently by the executor.
 * Everything else runs serially. We still group by category so the
 * executor can apply per-category logic uniformly.
 *
 * Critical invariant: a `serial`/`agent`/`special` call BREAKS a
 * preceding `safe` batch. The model called them in a specific order
 * and reordering by category would change semantics.
 */
export function partitionTools(toolCalls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const tc of toolCalls) {
    const category = classifyConcurrency(tc.name);
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
