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
    tools: ['file_read', 'file_list', 'file_write', 'file_delete', 'exec', 'screen_read', 'keyboard_type', 'mouse_click', 'mouse_move', 'applescript_run', 'get_current_time'],
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
    label: 'Project Tracker',
    tools: ['tracker_create_project', 'tracker_create_task', 'tracker_update_status', 'tracker_complete_step', 'tracker_add_notes', 'tracker_list_active', 'tracker_pause_schedule', 'tracker_resume_schedule', 'tracker_get_task'],
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
    tools: ['save_technique', 'use_technique', 'list_techniques', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique'],
  },
  {
    label: 'Communication',
    tools: ['imessage_send'],
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
    tools: ['calendar_agenda', 'calendar_search', 'calendar_create', 'calendar_update', 'calendar_delete'],
  },
  {
    label: 'Google Drive / Docs / Sheets',
    tools: ['drive_list', 'drive_read', 'drive_upload', 'drive_share', 'docs_read', 'docs_create', 'docs_edit', 'sheets_read', 'sheets_create', 'sheets_append', 'sheets_write'],
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
    label: 'Outlook',
    tools: ['outlook_search', 'outlook_read', 'outlook_inbox', 'outlook_send', 'outlook_reply', 'outlook_forward'],
  },
  {
    label: 'Microsoft Calendar',
    tools: ['calendar_agenda_ms', 'calendar_search_ms', 'calendar_create_ms', 'calendar_update_ms', 'calendar_delete_ms'],
  },
  {
    label: 'OneDrive',
    tools: ['onedrive_list', 'onedrive_read', 'onedrive_upload', 'onedrive_share'],
  },
  {
    label: 'Microsoft Teams',
    tools: ['teams_read_messages', 'teams_send_message'],
  },
  {
    label: 'Office Documents',
    tools: ['office_create_word_document', 'office_append_to_word_document', 'office_create_spreadsheet', 'office_create_presentation'],
  },
];

/**
 * Truncate a tool description to a short one-liner for the index.
 * Takes the first sentence, caps at 120 chars.
 */
function shortDescription(desc: string): string {
  const firstSentence = desc.split(/\.\s|\n/)[0].trim();
  if (firstSentence.length <= 120) return firstSentence;
  return firstSentence.slice(0, 117) + '...';
}

/**
 * Generate the lightweight tool index for system prompts.
 * Only includes tools the agent actually has access to.
 */
export function generateToolIndex(agentTools: ToolDefinition[], alwaysLoaded: string[]): string {
  const toolMap = new Map(agentTools.map(t => [t.name, t]));
  const alwaysLoadedSet = new Set(alwaysLoaded);

  const lines: string[] = [];
  lines.push('## Available Tools');
  lines.push('');
  lines.push('You have access to the following tools. Tool names and short descriptions are listed below. To use any tool:');
  lines.push('1. If the tool is in your **Always-Loaded** set, you can call it directly without any preparation.');
  lines.push('2. Otherwise, call `load_tool_docs` first with the tool names you need. The full parameter schemas will be loaded and the tools will be callable from that turn forward.');
  lines.push('');
  lines.push(`**Always-loaded tools** (callable immediately, no lookup needed): ${alwaysLoaded.join(', ')}`);
  lines.push('');

  // Track which tools we've listed so we can report any uncategorized at the end
  const listed = new Set<string>();

  for (const category of TOOL_CATEGORIES) {
    const available = category.tools.filter(name => toolMap.has(name));
    if (available.length === 0) continue;

    lines.push(`**${category.label}:**`);
    for (const name of available) {
      const tool = toolMap.get(name)!;
      const marker = alwaysLoadedSet.has(name) ? ' _(always loaded)_' : '';
      lines.push(`- \`${name}\`${marker}: ${shortDescription(tool.description)}`);
      listed.add(name);
    }
    lines.push('');
  }

  // Any tools not in a category get dumped at the end under "Other"
  const uncategorized = agentTools.filter(t => !listed.has(t.name));
  if (uncategorized.length > 0) {
    lines.push('**Other:**');
    for (const tool of uncategorized) {
      const marker = alwaysLoadedSet.has(tool.name) ? ' _(always loaded)_' : '';
      lines.push(`- \`${tool.name}\`${marker}: ${shortDescription(tool.description)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
