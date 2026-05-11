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
      'office_get_word_document_outline', 'office_replace_in_word_document',
      'office_insert_in_word_document', 'office_delete_block_in_word_document',
      // Excel
      'office_create_spreadsheet',
      'office_get_spreadsheet_range', 'office_write_spreadsheet_range',
      'office_append_spreadsheet_rows', 'office_add_sheet', 'office_delete_sheet',
      // PowerPoint
      'office_create_presentation',
      'office_get_presentation_outline', 'office_replace_in_presentation',
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
  } else {
    lines.push('You have access to the following tools. Tool names and short descriptions are listed below. To use any tool:');
    lines.push('1. If the tool is in your **Always-Loaded** set, you can call it directly without any preparation.');
    lines.push('2. Otherwise, call `load_tool_docs` first with the tool names you need. The full parameter schemas will be loaded and the tools will be callable from that turn forward.');
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
