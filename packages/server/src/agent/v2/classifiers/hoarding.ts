// ════════════════════════════════════════
// Anti-hoarding gate (v2.5.43)
//
// Field test: prompt-level guidance about "open a tracker project before
// loading sources" was being ignored by DeepSeek V4 Pro on
// corpus-synthesis tasks. The primary agent made 9 source-loading calls in 4 turns
// (use_technique, file_read x3, list_agents, exec, get_agent_profile x3)
// without ever calling tracker_create_project, file_write, or
// scratchpad_set. The reflex was in its prompt; it just plowed through.
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
// gate any time the agent has unrelated work assigned, exactly when
// hoarding is most likely. Per-turn only: any structuring call this
// turn satisfies the gate for the rest of the turn.
// ════════════════════════════════════════

/** Number of loading-tool calls in a single turn before the gate fires.
 *
 * Kept at 6 (NOT raised, raising the bar would just mask the real cause). The
 * OPEN-16 false-positive, a routine "did I get an email from <someone>?" lookup
 * tripping the gate, was not caused by the threshold being too low. Its cause
 * was that FAILED loading calls counted: a multi-account `outlook_search` that
 * errored ("say which account") and retried padded the count with calls that
 * loaded NOTHING into context and so cannot cause the summarization
 * confabulation this gate exists to prevent. The fix is therefore at the
 * accounting site (failed loads are not counted, see loop.ts) plus exempting the
 * bounded recall_recent_thread read below, not a higher threshold. */
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
  // Shell (always counts, small exec calls accumulate context too)
  'exec',
  'applescript_run',
  // Memory / vault reads
  'memory_grep',
  'memory_describe',
  'memory_expand',
  'memory_search',
  'vault_search',
  'vault_describe',
  // NOTE (OPEN-16): recall_recent_thread is deliberately NOT counted. It is a
  // bounded read of the CURRENT conversation's recent turns (conversation-scoped
  // as of OPEN-15), an orientation read the agent uses to answer "what was just
  // happening", not external corpus accumulation that confabulates. Counting it
  // pushed routine lookups over the gate.
  // Web
  'web_search',
  'web_fetch',
  'web_browse',
  // NOTE (OPEN-2): tracker reads (tracker_get_status / tracker_list_active /
  // tracker_get_project) are deliberately NOT counted here. The gate targets
  // EXTERNAL corpus-synthesis, sources that get summarized into a deliverable
  // and cause confabulation. The tracker is the agent's own STRUCTURED state;
  // it survives compaction (this gate's refusal text says so), so reading it
  // can't confabulate. Reading N tasks to answer "send me the project status"
  // is exactly the behavior the gate wants, not hoarding, counting it refused
  // legitimate status gathering and told the agent to "open a tracker project"
  // while it was reading the tracker. The loop detector still catches a thrash
  // of the SAME read; distinct status reads are free.
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
 * v2.5.46, scratchpad_set REMOVED from the structuring set. Per the
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

// D3 removed the count-based refusal (and with it buildHoardingRefusal, which
// carried the contradictory scratchpad_set instructions). Reads are never
// blocked; the loop.ts advisory nudges a durable write only when context is
// genuinely near compaction.
