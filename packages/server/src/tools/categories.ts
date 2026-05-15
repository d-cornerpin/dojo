// ════════════════════════════════════════
// Tool Categories & Index Generator
// Produces the lightweight text index that goes into system prompts.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';

// Tool category definitions — order matters, categories are shown in this order
export const TOOL_CATEGORIES: Array<{ label: string; tools: string[] }> = [
  {
    label: 'Meta',
    tools: ['load_tool_docs'],
  },
  {
    label: 'File & System',
    tools: ['file_read', 'file_list', 'file_write', 'file_patch', 'file_delete', 'exec', 'screen_read', 'keyboard_type', 'mouse_click', 'mouse_move', 'applescript_run', 'get_current_time'],
  },
  {
    label: 'Web',
    tools: ['web_search', 'web_fetch', 'web_browse'],
  },
  {
    label: 'Vault (Long-Term Memory)',
    tools: ['vault_remember', 'vault_search', 'vault_forget', 'vault_describe', 'vault_expand'],
  },
  {
    label: 'Conversation Recall',
    tools: ['recall_recent_thread', 'memory_grep', 'memory_describe', 'memory_expand', 'memory_search'],
  },
  {
    // Squad-shared memory for multi-agent coordination (Phase 7 / Part X).
    // Members of the same group_id can write/read a shared namespace; faster
    // and lossless compared to A2A handoff messages.
    label: 'Squad Coordination',
    tools: ['squad_share', 'squad_recall'],
  },
  {
    label: 'Project Tracker',
    tools: ['tracker_create_project', 'tracker_create_task', 'tracker_update_status', 'tracker_edit_task', 'tracker_complete_step', 'tracker_add_notes', 'tracker_list_active', 'tracker_pause_schedule', 'tracker_resume_schedule', 'tracker_get_status'],
  },
  {
    // Tools the primary agent uses to create, edit, organize, and communicate
    // with its sub-agents. Ordered by workflow: discovery → create/end →
    // edit identity → groups → messaging → session/presence.
    label: 'Managing Other Agents',
    tools: [
      // Discovery — find what's out there before acting on it
      'list_agents',
      'list_groups',
      'list_models',
      // Creating and ending sub-agents
      'spawn_agent',
      'kill_agent',
      // Reading sub-agent state
      'get_agent_profile',
      // Editing an existing sub-agent in place (non-destructive)
      'update_agent_profile',
      'update_agent_model',
      'update_agent_permissions',
      // Groups
      'create_agent_group',
      'update_group',
      'assign_to_group',
      'delete_group',
      // Messaging between agents
      'send_to_agent',
      'broadcast_to_group',
      'complete_task',
      // Session and presence management
      'reset_session',
      'set_user_presence',
    ],
  },
  {
    label: 'Techniques',
    tools: ['save_technique', 'use_technique', 'list_techniques', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique', 'technique_list_versions'],
  },
  {
    label: 'Communication',
    tools: ['show_to_user', 'imessage_send', 'share_publicly'],
  },
  {
    label: 'Tunnel (Remote Access)',
    tools: ['tunnel_status', 'tunnel_start', 'tunnel_stop', 'tunnel_restart'],
  },
  {
    label: 'Gmail',
    tools: ['gmail_search', 'gmail_read', 'gmail_inbox', 'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_label'],
  },
  {
    label: 'Google Calendar',
    tools: ['calendar_agenda', 'calendar_search', 'calendar_list', 'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_respond_invite', 'calendar_subscribe', 'calendar_unsubscribe'],
  },
  {
    label: 'Google Drive / Docs / Sheets',
    tools: ['drive_list', 'drive_read', 'drive_upload', 'drive_share', 'drive_delete', 'docs_read', 'docs_create', 'docs_edit', 'sheets_read', 'sheets_create', 'sheets_append', 'sheets_write'],
  },
  {
    label: 'Google Slides',
    tools: [
      // Style & deck management
      'slides_create_presentation', 'slides_set_style', 'slides_get_style', 'slides_list_presets',
      // Slide ops
      'slides_add_slide', 'slides_duplicate_slide', 'slides_delete_slide', 'slides_reorder_slides', 'slides_set_background',
      // Text
      'slides_add_text_box', 'slides_add_bullet_list', 'slides_update_text', 'slides_style_text_range',
      // Layout helpers (compound)
      'slides_layout_title', 'slides_layout_section', 'slides_layout_content', 'slides_layout_two_column', 'slides_layout_image', 'slides_layout_comparison',
      // Media
      'slides_add_image', 'slides_add_image_from_drive', 'slides_replace_shape_with_image', 'slides_add_video',
      // Shapes & tables
      'slides_add_shape', 'slides_add_line', 'slides_add_table', 'slides_populate_table',
      // Utility
      'slides_get_slides', 'slides_get_elements', 'slides_delete_element', 'slides_move_element', 'slides_resize_element', 'slides_find_replace',
    ],
  },
  {
    label: 'Google Forms',
    tools: [
      'forms_create_form',
      'forms_add_text_question', 'forms_add_choice_question', 'forms_add_scale_question', 'forms_add_date_question',
      'forms_update_question', 'forms_rename_question',
      'forms_set_settings',
      'forms_delete_item', 'forms_delete_form',
      'forms_get', 'forms_list_responses',
    ],
  },
  {
    label: 'Outlook',
    tools: ['outlook_search', 'outlook_read', 'outlook_inbox', 'outlook_send', 'outlook_reply', 'outlook_forward'],
  },
  {
    label: 'Microsoft Calendar',
    tools: ['calendar_agenda_ms', 'calendar_search_ms', 'calendar_list_ms', 'calendar_create_ms', 'calendar_update_ms', 'calendar_delete_ms', 'calendar_respond_invite_ms', 'calendar_share_invites_ms', 'calendar_accept_share_ms'],
  },
  {
    label: 'OneDrive',
    tools: ['onedrive_list', 'onedrive_read', 'onedrive_search', 'onedrive_upload', 'onedrive_upload_batch', 'onedrive_share', 'onedrive_create_folder', 'onedrive_delete', 'onedrive_move', 'onedrive_list_shared', 'onedrive_list_drives'],
  },
  {
    label: 'SharePoint',
    tools: ['sharepoint_list_sites', 'sharepoint_list_drives'],
  },
  {
    label: 'Teams Online Meetings',
    tools: ['online_meeting_create', 'online_meeting_get', 'online_meeting_update', 'online_meeting_delete'],
  },
  {
    label: 'Microsoft Teams',
    tools: ['teams_read_messages', 'teams_send_message'],
  },
  {
    label: 'Office Documents',
    tools: [
      // Word
      'office_create_word_document', 'office_append_to_word_document',
      'office_read_word_document', 'office_get_word_document_outline',
      'office_replace_in_word_document',
      'office_insert_in_word_document', 'office_delete_block_in_word_document',
      // Excel
      'office_create_spreadsheet',
      'office_get_spreadsheet_range', 'office_write_spreadsheet_range',
      'office_append_spreadsheet_rows', 'office_add_sheet', 'office_delete_sheet',
      // PowerPoint
      'office_create_presentation',
      'office_read_presentation', 'office_get_presentation_outline',
      'office_replace_in_presentation',
      'office_insert_slide', 'office_delete_slide',
    ],
  },
];

/**
 * Truncate a tool description to a short one-liner for the index.
 * Takes the first sentence, caps at 120 chars.
 */
function shortDescription(desc: string, maxLen: number = 120): string {
  const firstSentence = desc.split(/\.\s|\n/)[0].trim();
  if (firstSentence.length <= maxLen) return firstSentence;
  return firstSentence.slice(0, maxLen - 3) + '...';
}

/**
 * Generate the lightweight tool index for system prompts.
 * Only includes tools the agent actually has access to.
 */
export function generateToolIndex(agentTools: ToolDefinition[], alwaysLoaded: string[]): string {
  return generateToolIndexInternal(agentTools, alwaysLoaded, /*compact*/ false);
}

/**
 * Phase 5 (Part IV) — compact tool index for v2. Same content shape but
 * shorter descriptions (60 char vs 120) and no per-tool always-loaded
 * markers (the always-loaded list is enumerated once at the top, not
 * repeated on every entry). For Kevin (~165 tools) this drops the index
 * from ~2.8K tokens to ~1.4K, getting Phase 5's <2K total prompt target
 * within reach.
 */
export function generateToolIndexCompact(agentTools: ToolDefinition[], alwaysLoaded: string[]): string {
  return generateToolIndexInternal(agentTools, alwaysLoaded, /*compact*/ true);
}

function generateToolIndexInternal(
  agentTools: ToolDefinition[],
  alwaysLoaded: string[],
  compact: boolean,
): string {
  const toolMap = new Map(agentTools.map(t => [t.name, t]));
  const alwaysLoadedSet = new Set(alwaysLoaded);
  const descLen = compact ? 60 : 120;

  const lines: string[] = [];
  lines.push('## Available Tools');
  lines.push('');
  if (compact) {
    lines.push('Tools listed below by category. Always-loaded tools are callable immediately; for any other tool, call `load_tool_docs` first to get the full schema.');
    lines.push('**Before defaulting to `exec`**, scan the index below for a purpose-built tool that fits the task — file/web/office/forms/tracker/vault/chat-recall all have dedicated tools. **If you feel disoriented or have just been compacted/model-switched**, call `recall_recent_thread` first. **When sharing a URL or file path with the user**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (the closing tick gets sucked into the href and breaks the link). Never write the same URL twice in a row. Never paraphrase, truncate, or type a URL from memory — if you don\'t have the full string, call the source tool again. **For tasks that span many sources or produce a long output**: your context is FINITE — when it fills, the engine summarizes older turns and you lose literal source detail (you\'ll write from summaries and confabulate). Open `tracker_create_project` BEFORE you start (with each batch as a task). Build the deliverable as a scaffold via `file_write` (section headers + placeholders). Loop: read 3-5 sources, write findings via `file_append` or `file_patch`, update `scratchpad_set` with progress, mark the tracker task complete, move on. Re-read the scaffold and scratchpad when lost — they survive compaction. End with a verification pass. **Close out tracker tasks the moment you finish them** — don\'t end a turn with `in_progress` tasks you\'ve actually completed. If you finished it, `tracker_complete_step` (or `tracker_update_status(complete)`). If blocked, mark blocked. Never leave the tracker out of sync with reality — the engine will catch dangling tasks at end-of-turn and the PM agent will poke you 30 min later. Both cost a turn the user is waiting on.');
  } else {
    lines.push('You have access to the following tools. Tool names and short descriptions are listed below. To use any tool:');
    lines.push('1. If the tool is in your **Always-Loaded** set, you can call it directly without any preparation.');
    lines.push('2. Otherwise, call `load_tool_docs` first with the tool names you need. The full parameter schemas will be loaded and the tools will be callable from that turn forward.');
    lines.push('');
    lines.push('**Five reflexes worth building:**');
    lines.push('- **Before defaulting to `exec`**, scan the index below for a purpose-built tool — file/web/office/forms/tracker/vault/chat-recall all have dedicated tools. `exec` is the fallback, not the default.');
    lines.push('- **If you feel disoriented, just got compacted, or just switched models**, call `recall_recent_thread` first — it reads the actual chat history from your messages table and is your fastest path back to context.');
    lines.push('- **When sharing a URL or file path with the user**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (the closing tick gets sucked into the href and the browser encodes it as `%60`, breaking the link). Never write the same URL twice in a row in the same sentence. Never paraphrase, never truncate to "something like…", and never type one from memory — if you don\'t have the full string handy, call the source tool again. URLs and paths are exact strings; one missing character makes them broken.');
    lines.push('- **For tasks that span many sources or produce a long output** (read 5+ files then synthesize, build a long doc from a corpus, walk through a complex project): **your context is a FINITE window.** When it fills, the engine automatically summarizes older turns — file contents you read 30 minutes ago become a one-line summary that loses literal detail. An agent that reads a 50-page doc, then a 30-page doc, then a 40-page doc, then tries to write a flowchart, will be writing the flowchart from summaries — not from source — and **WILL fabricate plausible-sounding details that aren\'t actually there**. Defenses, in order: (1) **Open `tracker_create_project` BEFORE you start work**, with the batches as initial tasks — multi-step work without a tracker entry drifts and stalls, and the PM agent can\'t intervene because there\'s nothing to monitor. (2) **Scaffold the deliverable first** via `file_write` with section headers and placeholders. (3) **Loop**: read 3-5 sources, write findings into the right section using `file_append` (end-of-file) or `file_patch` (between markers), update `scratchpad_set` with what\'s covered and what\'s left, mark the tracker task complete, move on. (4) **Re-read the scaffold and scratchpad** when you feel lost — they survive compaction; your raw context does not. (5) **Verification pass at the end**: re-read each major source briefly and confirm the section that depends on it is accurate. The whole pattern exists to keep you working from literal source rather than from your own summarized memory.');
    lines.push('- **Close out tracker tasks the moment you finish them.** Don\'t end a turn with `in_progress` tasks you\'ve actually completed. For multi-step projects use `tracker_complete_step` (it auto-advances the project pointer to the next step — leaves no gap). For standalone tasks use `tracker_update_status(complete)`. If you hit a blocker, mark it `blocked`. If you paused intentionally, mark it `paused`. Never leave the tracker out of sync with reality. The engine will detect dangling `in_progress` tasks at end-of-turn and inject a nudge asking you to close them — and if you ignore that, the PM agent will poke you 30 minutes later. Both cost a turn the user is waiting on. Update status the instant a transition happens: starting work → in_progress, finishing → complete, stuck → blocked.');
  }
  lines.push('');
  lines.push(`**Always-loaded tools**: ${alwaysLoaded.join(', ')}`);
  lines.push('');

  // Track which tools we've listed so we can report any uncategorized at the end
  const listed = new Set<string>();

  for (const category of TOOL_CATEGORIES) {
    const available = category.tools.filter(name => toolMap.has(name));
    if (available.length === 0) continue;

    lines.push(`**${category.label}:**`);
    for (const name of available) {
      const tool = toolMap.get(name)!;
      const marker = compact ? '' : (alwaysLoadedSet.has(name) ? ' _(always loaded)_' : '');
      lines.push(`- \`${name}\`${marker}: ${shortDescription(tool.description, descLen)}`);
      listed.add(name);
    }
    lines.push('');
  }

  // Any tools not in a category get dumped at the end under "Other"
  const uncategorized = agentTools.filter(t => !listed.has(t.name));
  if (uncategorized.length > 0) {
    lines.push('**Other:**');
    for (const tool of uncategorized) {
      const marker = compact ? '' : (alwaysLoadedSet.has(tool.name) ? ' _(always loaded)_' : '');
      lines.push(`- \`${tool.name}\`${marker}: ${shortDescription(tool.description, descLen)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
