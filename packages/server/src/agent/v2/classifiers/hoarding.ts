// ════════════════════════════════════════
// Anti-hoarding gate (v2.5.43)
//
// Field test: prompt-level guidance about "open a tracker project before
// loading sources" was being ignored by DeepSeek V4 Pro on
// corpus-synthesis tasks. Kevin made 9 source-loading calls in 4 turns
// (use_technique, file_read x3, list_agents, exec, get_agent_profile x3)
// without ever calling tracker_create_project, file_write, or
// scratchpad_set. The reflex was in his prompt; he just plowed through.
//
// CLAUDE.md rule: "The engine enforces. The model follows prompts."
// So we move enforcement out of the prompt and into the loop.
//
// Rule: if the agent makes >= LOADING_GATE_THRESHOLD load-type tool
// calls in a single turn without having called any structuring tool
// THIS turn, the next loading call is refused with a synthetic error
// telling the agent to scaffold first.
//
// We do NOT consult cross-turn state (existing in_progress tracker
// tasks, persisted scratchpad). That check would silently disable the
// gate any time the agent has unrelated work assigned — exactly when
// hoarding is most likely. Per-turn only: any structuring call this
// turn satisfies the gate for the rest of the turn.
// ════════════════════════════════════════

/** Number of loading-tool calls in a single turn before the gate fires. */
export const LOADING_GATE_THRESHOLD = 6;

/**
 * "Loading" tools: their primary purpose is to pull external data into
 * the context window. Repeated unscaffolded loading is the failure
 * pattern that causes summarization confabulation.
 */
const LOADING_TOOLS = new Set<string>([
  // Filesystem reads
  'file_read',
  'file_list',
  // Shell (always counts — small exec calls accumulate context too)
  'exec',
  'applescript_run',
  // Memory / vault reads
  'memory_grep',
  'memory_describe',
  'memory_expand',
  'memory_search',
  'vault_search',
  'vault_describe',
  'recall_recent_thread',
  // Web
  'web_search',
  'web_fetch',
  'web_browse',
  // Tracker reads
  'tracker_get_status',
  'tracker_list_active',
  'tracker_get_project',
  // Agent introspection
  'get_agent_profile',
  'list_agents',
  // Techniques (use_technique + technique_read pull content into context)
  'use_technique',
  'technique_read',
  'list_techniques',
  'technique_list_versions',
  // Google reads
  'gmail_search',
  'gmail_read',
  'gmail_list_messages',
  'gmail_get_message',
  'gmail_get_thread',
  'calendar_agenda',
  'calendar_search',
  'drive_search',
  'drive_read',
  'drive_list',
  'drive_get',
  'docs_read',
  'sheets_read',
  'forms_get',
  'forms_list_responses',
  'forms_get_form_responses',
  // Microsoft reads
  'outlook_search',
  'outlook_read',
  'calendar_agenda_ms',
  'calendar_search_ms',
  'onedrive_search',
  'onedrive_read',
  'teams_list_chats',
  'teams_read_chat',
  'office_get_word_document',
  'office_get_word_document_outline',
  'office_get_excel_workbook',
  'office_get_powerpoint',
]);

/**
 * "Structuring" tools: calling any of these in a turn proves the agent
 * has somewhere for the loading work to land. Satisfies the gate for
 * the rest of the turn.
 *
 * v2.5.46 — scratchpad_set REMOVED from the structuring set. Per the
 * tracker-adoption audit, agents were satisfying the gate with a
 * one-liner scratchpad call (the cheapest escape) and never opening a
 * tracker project. Scratchpad is for in-flight memory INSIDE a tracker
 * step, not a substitute for the durable plan. Now requires a real
 * tracker action or a real file write.
 */
const STRUCTURING_TOOLS = new Set<string>([
  'tracker_create_project',
  'tracker_create_task',
  'tracker_update_status',
  'tracker_complete_step',
  'tracker_add_notes',
  'tracker_edit_task',
  'file_write',
  'file_append',
  'file_patch',
]);

export function isLoadingTool(name: string): boolean {
  return LOADING_TOOLS.has(name);
}

export function isStructuringTool(name: string): boolean {
  return STRUCTURING_TOOLS.has(name);
}

/**
 * The synthetic refusal returned in place of the actual tool result.
 * Lists the qualifying actions explicitly so the agent knows what to
 * do, in priority order. Reads back as a tool error, so the assistant
 * sees it on the very next iteration.
 */
export function buildHoardingRefusal(toolName: string, loadingCount: number): string {
  return (
    `Refused: engine anti-hoarding gate. You've made ${loadingCount} source-loading tool calls this turn ` +
    `(file_read, get_agent_profile, exec, vault_search, web_fetch, etc.) without opening a durable plan for the work.\n\n` +
    `**\`tracker_create_project\` is the right answer here.** Loading more sources without a tracker entry causes ` +
    `summarization confabulation: when context fills, older sources get summarized and you write the deliverable ` +
    `from your own summarized memory instead of source. Tracker rows survive compaction; context does not.\n\n` +
    `Open one with just a title — you don't need to know every task upfront. Add tasks with tracker_create_task ` +
    `as you discover the shape of the work. If you're not sure whether to open a tracker, open one — the cost is zero.\n\n` +
    `Acceptable alternatives (only if this work will genuinely finish in THIS turn and produce no deliverable):\n` +
    `  - file_write to scaffold the deliverable now (section headers + placeholders)\n` +
    `  - file_append / file_patch if you're building on a file you already started\n\n` +
    `NOTE: scratchpad_set does NOT satisfy this gate. Scratchpad is for in-flight working memory INSIDE a ` +
    `tracker step, not a substitute for the durable plan. After you open a tracker, scratchpad becomes useful.\n\n` +
    `After ANY one of the qualifying actions above, loading tools (including the refused "${toolName}" call) ` +
    `work normally for the rest of this turn.`
  );
}
