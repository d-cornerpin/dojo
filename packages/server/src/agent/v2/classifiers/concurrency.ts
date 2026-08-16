// ════════════════════════════════════════
// Phase 1A, partitionTools classifier
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
import { workOperation } from '../../../tools/work-verbs.js';

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
 *   safe, pure read, no side effects, parallelizable
 *   serial, has side effects, must run in order
 *   agent, coordinates with other agents, sequential
 *   special, one-of-a-kind semantics, sequential
 *
 * Unknown tools default to 'special' (safest serial behavior).
 *
 * HAND-PICKED, but SAFE-BY-CONSTRUCTION and superseded as source of truth: the
 * canonical concurrency category is now ToolDefinition.concurrency, registered
 * into REGISTRY_OVERRIDES at module init (see registerConcurrency below), which
 * classifyConcurrency checks FIRST. This map is only the Phase-1A fallback for
 * tools that declare no concurrency field, and the fallback default for anything
 * missing is 'special' (serial), the SAFEST behavior, so drift here can only
 * cost parallelism, never correctness. The 2026-07-08 sweep removed phantom keys
 * (drive_search, teams_read_chat, gmail_archive/gmail_delete, docs_update/
 * sheets_update, outlook_archive, slides_create_deck, word_/excel_/pptx_*) that
 * named no real tool and so never matched a call; the conformance test now
 * asserts every remaining key is a real registered tool.
 */
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
  // Google read-only
  gmail_search: 'safe',
  gmail_read: 'safe',
  calendar_agenda: 'safe',
  calendar_search: 'safe',
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

  // ── serial (writes, side effects) ──
  file_write: 'serial',
  exec: 'serial',
  applescript_run: 'serial',
  vault_remember: 'serial',
  vault_forget: 'serial',
  // PHASE-2 T8V: the eleven tracker entries moved to WORK_OP_CONCURRENCY below.
  // They cannot live in this name-keyed map any more: `work_update` is both the
  // status write (serial) and the two reads (safe), so a single entry would
  // either serialise every board read or — far worse — mark a status write safe
  // and let two of them run concurrently.
  healer_log_action: 'serial',
  healer_propose: 'serial',
  set_user_presence: 'serial',
  tunnel: 'serial',
  // Google writes
  gmail_send: 'serial',
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
  // Microsoft writes
  outlook_send: 'serial',
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
  // Office docs over Graph (OneDrive in-place edits)
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
/**
 * PHASE-2 T8V — the collapsed verbs' concurrency, keyed on the OPERATION.
 *
 * `work_update` is the reason this map has to exist: it performs both the two
 * read operations (parallelisable) and the status/edit writes (must serialise).
 * A single name-keyed entry could only be one of those, and the wrong direction
 * is not a parallelism cost but a correctness bug — two concurrent status writes
 * to the same task. Anything not listed falls through to 'special' (serial),
 * which is the safe direction and is what the eleven retired write entries had.
 */
export const WORK_OP_CONCURRENCY: Readonly<Record<string, ToolCategory>> = {
  'work_update:list': 'safe',
  'work_update:get': 'safe',
  // UX-REPAIR ROUND 13 T60. Same class as its two siblings and for the same reason: it
  // executes SELECTs and nothing else, so two of them cannot race each other or anything.
  'work_update:activity': 'safe',
};

export function classifyConcurrency(toolName: string, args?: Record<string, unknown>): ToolCategory {
  const op = workOperation(toolName, args);
  if (op !== null) return WORK_OP_CONCURRENCY[op] ?? 'special';
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
