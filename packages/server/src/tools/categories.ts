// ════════════════════════════════════════
// Tool Categories & Index Generator
// Produces the lightweight text index that goes into system prompts.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools.js';

// Tool-index representation (remediation C / tool-index slimming): the index
// lists tool NAMES grouped by category, dropping per-tool descriptions. The
// model still knows every tool exists and can load_tool_docs any of them (the
// two-phase-load design is preserved), at a fraction of the tokens.

// Tool category definitions, order matters, categories are shown in this order
export const TOOL_CATEGORIES: Array<{ label: string; tools: string[] }> = [
  {
    label: 'Meta',
    tools: ['load_tool_docs'],
  },
  {
    label: 'File & System',
    tools: ['file_read', 'file_list', 'file_write', 'file_append', 'file_patch', 'exec', 'screen_screenshot', 'keyboard_type', 'mouse_click', 'mouse_move', 'applescript_run', 'scratchpad_set', 'scratchpad_clear', 'get_current_time', 'convert_time'],
  },
  {
    label: 'Web',
    tools: ['web_search', 'web_fetch', 'web_browse'],
  },
  {
    // Right-dock workspace: slides the dojo aside and shows something next to
    // the chat. canvas_render renders agent-produced HTML/docs; open_browser
    // loads a live website. Both are view-together surfaces, not file writes.
    label: 'Shared Workspace (right dock)',
    tools: ['canvas_render', 'open_browser', 'canvas_read', 'screen_broadcast'],
  },
  {
    // Platform-capability media generators. Each dispatches to the model
    // configured for that capability (see set_capability_model).
    label: 'Media Generation (image / video / music / speech)',
    tools: ['image_create', 'video_create', 'music_create', 'tts_create', 'transcribe_audio'],
  },
  {
    label: 'PDF',
    tools: ['pdf_read', 'pdf_get_info', 'pdf_create', 'pdf_merge', 'pdf_extract_pages', 'pdf_delete_pages', 'pdf_reorder_pages', 'pdf_rotate_pages', 'pdf_watermark', 'pdf_fill_form'],
  },
  {
    label: 'DOJO Contacts (people the owner interacts with - persistent, agent-authored)',
    tools: ['contact_remember', 'contact_search', 'contact_list', 'contact_get', 'contact_update', 'contact_forget', 'contacts_overview'],
  },
  {
    label: 'Agent Credentials (encrypted API keys / tokens the agent uses to call services)',
    tools: ['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete'],
  },
  {
    label: 'Vault (Long-Term Memory)',
    tools: ['vault_remember', 'vault_search', 'vault_forget', 'vault_get', 'vault_update', 'vault_refresh', 'vault_discard_archives'],
  },
  {
    label: 'Conversation Recall',
    tools: ['recall_recent_thread', 'history_search', 'history_get', 'history_expand'],
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
    tools: ['tracker_create_project', 'tracker_create_task', 'tracker_update_status', 'tracker_edit_task', 'tracker_edit_project', 'tracker_complete_step', 'tracker_close_project', 'tracker_add_notes', 'tracker_list_active', 'tracker_pause_schedule', 'tracker_resume_schedule', 'tracker_get_status', 'tracker_reassign_task', 'tracker_retask', 'tracker_resolve_missed_runs', 'tracker_validate', 'tracker_override', 'tracker_request_override', 'tracker_request_user_verdict', 'tracker_apply_user_verdict', 'tracker_apply_user_validation', 'reminder_create'],
  },
  {
    // Tools the primary agent uses to create, edit, organize, and communicate
    // with its sub-agents. Ordered by workflow: discovery → create/end →
    // edit identity → groups → messaging → session/presence.
    label: 'Managing Other Agents',
    tools: [
      // Discovery, find what's out there before acting on it
      'list_agents',
      'list_groups',
      'list_models',
      // Creating and ending sub-agents
      'spawn_agent',
      'kill_agent',
      // Reading sub-agent state
      'get_agent_profile',
      // Editing an existing sub-agent in place (non-destructive)
      'update_agent',
      // Groups
      'create_agent_group',
      'update_group',
      'assign_to_group',
      'delete_group',
      'get_group_detail',
      // Messaging between agents
      'send_to_agent',
      'broadcast_to_group',
      'complete_task',
      // Session management
      'reset_session',
    ],
  },
  {
    label: 'Techniques',
    tools: ['save_technique', 'use_technique', 'technique_read', 'list_techniques', 'publish_technique', 'update_technique', 'submit_technique_for_review', 'delete_technique', 'technique_list_versions', 'technique_acknowledge', 'technique_set_placeholder', 'technique_finalize'],
  },
  {
    label: 'Communication',
    tools: ['show_to_user', 'imessage_send', 'imessage_list_contacts', 'share_publicly', 'share_file', 'add_safe_sender'],
  },
  {
    // Tools the owner-facing primary uses to run the Dojo itself on the
    // owner's behalf: change platform settings, navigate the dashboard,
    // toggle channels, and manage updates. See agent-controls.ts.
    label: 'DOJO Controls (change settings / navigate the dashboard on the owner\'s behalf)',
    tools: ['set_user_presence', 'open_settings', 'dashboard_navigate', 'set_capability_model', 'set_voice', 'set_channel', 'check_for_update', 'apply_update'],
  },
  {
    // Owner-facing oversight + the engine's self-repair surface.
    label: 'Oversight & Admin',
    tools: ['cost_summary', 'channel_inspect', 'dreamer_run_now', 'approve_destructive_action'],
  },
  {
    label: 'Healer (self-repair)',
    tools: ['healer_log_action', 'healer_propose', 'healer_recent_actions', 'healer_action_detail', 'healer_mark_applied'],
  },
  {
    label: 'Tunnel (Remote Access)',
    tools: ['tunnel'],
  },
  {
    // Merged cross-account reads (F4): one call covers every connected surface
    // so a weak model can't silently answer from an arbitrary subset. The base
    // `calendar_agenda` is the merged agenda (listed under Google Calendar);
    // `email_search` is the merged mailbox search.
    label: 'Unified Search (all connected accounts at once)',
    tools: ['email_search'],
  },
  {
    label: 'Gmail',
    tools: ['gmail_search', 'gmail_read', 'gmail_inbox', 'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_label', 'gmail_list_labels', 'gmail_create_label', 'gmail_delete_label', 'gmail_list_attachments', 'gmail_read_attachment'],
  },
  {
    label: 'Google Calendar',
    tools: ['calendar_agenda', 'calendar_search', 'calendar_list', 'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_respond_invite', 'calendar_subscribe', 'calendar_unsubscribe', 'calendar_freebusy'],
  },
  {
    label: 'Google Drive / Docs / Sheets',
    tools: ['drive_list', 'drive_read', 'drive_upload', 'drive_create_folder', 'drive_share', 'drive_delete', 'drive_move', 'drive_rename', 'drive_versions_list', 'docs_read', 'docs_create', 'docs_edit', 'docs_insert_text', 'docs_find_replace', 'docs_delete_range', 'sheets_read', 'sheets_create', 'sheets_append', 'sheets_write', 'sheets_add_sheet', 'sheets_delete_sheet', 'sheets_format'],
  },
  {
    label: 'Google Tasks',
    tools: ['tasks_list_lists', 'tasks_create_list', 'tasks_list', 'tasks_create', 'tasks_update', 'tasks_complete', 'tasks_delete'],
  },
  {
    label: 'Google Slides',
    tools: [
      // Style & deck management
      'slides_create_presentation', 'slides_set_style', 'slides_get_style', 'slides_list_presets',
      // Slide ops
      'slides_add_slide', 'slides_build_slide', 'slides_duplicate_slide', 'slides_delete_slide', 'slides_reorder_slides', 'slides_set_background',
      // Text
      'slides_add_text_box', 'slides_add_bullet_list', 'slides_update_text', 'slides_style_text_range', 'slides_format_text',
      // Layout helpers (compound)
      'slides_layout_title', 'slides_layout_section', 'slides_layout_content', 'slides_layout_two_column', 'slides_layout_image', 'slides_layout_comparison',
      // Media
      'slides_add_image', 'slides_add_image_from_drive', 'slides_add_image_from_local_path', 'slides_replace_shape_with_image', 'slides_add_video',
      // Shapes & tables
      'slides_add_shape', 'slides_add_line', 'slides_add_table', 'slides_populate_table',
      // Utility
      'slides_get_slides', 'slides_get_elements', 'slides_delete_element', 'slides_move_element', 'slides_resize_element', 'slides_find_replace', 'slides_export_pngs',
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
    tools: ['outlook_search', 'outlook_read', 'outlook_inbox', 'outlook_send', 'outlook_reply', 'outlook_forward', 'outlook_mark_read', 'outlook_delete', 'outlook_move_to_folder', 'outlook_list_folders', 'outlook_create_folder', 'outlook_categories_set', 'outlook_list_attachments', 'outlook_download_attachment'],
  },
  {
    label: 'Twilio (SMS + Voice phone calls)',
    tools: ['sms_send', 'voice_call', 'voice_call_end', 'voice_call_status'],
  },
  {
    label: 'Microsoft Contacts (read-only escape hatch into the Microsoft directory)',
    tools: ['contacts_search', 'contacts_list', 'contacts_get', 'contacts_create', 'contacts_update', 'contacts_delete'],
  },
  {
    label: 'Microsoft Calendar',
    tools: ['calendar_agenda_ms', 'calendar_search_ms', 'calendar_list_ms', 'calendar_create_ms', 'calendar_update_ms', 'calendar_delete_ms', 'calendar_respond_invite_ms', 'calendar_share_invites_ms', 'calendar_accept_share_ms', 'calendar_freebusy_ms'],
  },
  {
    label: 'OneDrive',
    tools: ['onedrive_list', 'onedrive_read', 'onedrive_search', 'onedrive_upload', 'onedrive_upload_batch', 'onedrive_share', 'onedrive_create_folder', 'onedrive_delete', 'onedrive_move', 'onedrive_list_shared', 'onedrive_list_drives', 'onedrive_versions_list', 'onedrive_versions_restore'],
  },
  {
    label: 'OneNote',
    tools: ['onenote_list_notebooks', 'onenote_list_sections', 'onenote_list_pages', 'onenote_read_page', 'onenote_create_page', 'onenote_append_page'],
  },
  {
    label: 'SharePoint',
    tools: ['sharepoint_list_sites', 'sharepoint_list_drives'],
  },
  {
    label: 'Teams Online Meetings',
    tools: ['online_meeting_create', 'online_meeting_get', 'online_meeting_update', 'online_meeting_delete', 'online_meeting_list'],
  },
  {
    label: 'Microsoft Teams',
    tools: ['teams_read_messages', 'teams_send_message', 'teams_list_teams', 'teams_list_channels', 'teams_read_channel_messages', 'teams_send_channel_message', 'teams_list_chats', 'teams_create_chat', 'teams_list_attachments', 'teams_download_attachment'],
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
  {
    label: 'Plaud (voice recorder integration)',
    tools: ['plaud_list_recordings', 'plaud_recent_recordings', 'plaud_search_recordings', 'plaud_get_recording', 'plaud_get_transcript', 'plaud_get_summary', 'plaud_get_audio_url', 'plaud_account_info'],
  },
];

/**
 * Compact tool index for v2: tool names grouped by category (no per-tool
 * descriptions), with the always-loaded set enumerated once at the top instead
 * of marked on every entry. For a primary-class agent (~165 tools) this keeps
 * the index near ~1.4K tokens. The model calls `load_tool_docs` for the full
 * schema of any tool that isn't always-loaded.
 */
export function generateToolIndex(agentTools: ToolDefinition[], alwaysLoaded: string[]): string {
  const toolMap = new Map(agentTools.map(t => [t.name, t]));
  const alwaysLoadedSet = new Set(alwaysLoaded);

  const lines: string[] = [];
  lines.push('## Available Tools');
  lines.push('');
  // v2.5.42, primary-class agents (the primary agent and equivalents) get the structured
  // 5-bullet reflex block even in compact mode. Field test showed DeepSeek V4
  // Pro skimming past the one-paragraph version: the primary agent had file_append,
  // scratchpad_set, and tracker_create_project always-loaded on prod but
  // never used them on a multi-source flowchart task. The dense paragraph
  // was technically present; structurally invisible. Sub-agents stay on the
  // short paragraph since they rarely run the corpus-synthesis pattern.
  const isPrimaryClass =
    alwaysLoadedSet.has('tracker_create_project') &&
    alwaysLoadedSet.has('file_append') &&
    alwaysLoadedSet.has('scratchpad_set');
  if (!isPrimaryClass) {
    lines.push('Tools listed below by category. Always-loaded tools are callable immediately; for any other tool, call `load_tool_docs` first to get the full schema.');
    lines.push('**Before defaulting to `exec`**, scan the index below for a purpose-built tool that fits the task, file/web/office/forms/tracker/vault/chat-recall all have dedicated tools. **If you feel disoriented or have just been compacted/model-switched**, call `recall_recent_thread` first. **When sharing a URL or file path with the user**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (the closing tick gets sucked into the href and breaks the link). Never write the same URL twice in a row. Never paraphrase, truncate, or type a URL from memory, if you don\'t have the full string, call the source tool again.');
  } else {
    lines.push('Tools listed below by category. Always-loaded tools are callable immediately; for any other tool, call `load_tool_docs` first to get the full schema.');
    lines.push('');
    lines.push('**Seven reflexes worth building:**');
    lines.push('- **Document > memory.** When a technique, vault entry, or file *might* have the answer, READ IT before relying on what you think you remember. Your conversation memory is compacted aggressively and grows outdated, recited "facts" from memory are often subtly wrong (renamed sections, removed steps, outright fabrications). Documents on disk are the source of truth. Specifically: when following a technique, call `technique_read` (action="outline" to see structure, then "section" or "search" for what you need), NEVER recite from memory what you think a technique says. Memory is the fallback when no document exists, not the default.');
    lines.push('- **Before defaulting to `exec`**, scan the index below for a purpose-built tool, file/web/office/forms/tracker/vault/technique/chat-recall all have dedicated tools. `exec` is the fallback, not the default.');
    lines.push('- **If you feel disoriented, just got compacted, or just switched models**, call `recall_recent_thread` first, it reads the actual chat history from your messages table and is your fastest path back to context.');
    lines.push('- **When sharing a URL or file path with the user**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (it gets sucked into the href and the browser encodes it as `%60`, breaking the link). Never write the same URL twice in a row. Never paraphrase, truncate, or type one from memory, if you don\'t have the full string, call the source tool again.');
    lines.push('- **Default ON tracker for any work that isn\'t a one-shot lookup.** Open `tracker_create_project` BEFORE starting work on **any** request that has a deliverable, requires multiple steps, or could take more than ~3 tool calls. Don\'t try to predict whether you\'ll finish in one push, you usually can\'t, and the failure mode is silent context loss (compaction summarizes older turns, you write the deliverable from your own summarized memory, and confabulate). Tracker rows survive compaction AND session reset; scratchpad survives compaction but NOT reset; raw context survives neither. **Cost of opening a tracker entry you didn\'t end up needing: zero. Cost of not opening one for work that turns out to be multi-step: 30+ minutes of stalled work, PM pokes, and lost context.** Skip the tracker only for one-shot Q&A where you\'re answering from existing context or a single tool call. After opening the tracker: scaffold the deliverable with `file_write`; loop (read 3-5 sources, write findings with `file_append`/`file_patch`, update `scratchpad_set` for in-flight memory, mark tracker step complete, move on); verify at the end. The engine backstops this: after ~4 work calls with no tracker entry you get a reminder, and at 6+ the engine opens a task for you automatically (nothing is ever refused). Better to open it yourself first with a real title and task list.');
    lines.push('- **Close out tracker tasks the moment you finish them.** Don\'t end a turn with `in_progress` tasks you\'ve actually completed. For multi-step projects use `tracker_complete_step` (auto-advances). For standalone tasks use `tracker_update_status(complete)`. Blocked → mark blocked. Paused → mark paused **only for recurring/scheduled tasks**, pausing a one-shot task as a sloppy substitute for "complete" strands it forever. If a whole project was abandoned, duplicated, or superseded, call `tracker_close_project(project_id, status="cancelled", reason="…")` to clean up the project AND every open task in one call (vastly better than looping `tracker_update_status` per task). The engine catches dangling `in_progress` and stranded `on_deck` tasks at the start of every turn and refuses non-tracker tools until you resolve them; ignoring the gate means the engine suppresses your reply and resolves them itself.');
    lines.push('- **Never read a timestamp without a timezone label.** If a time you encounter (calendar event, email, scraped web text, raw unix epoch, a tool result you\'re unsure of) does NOT include BOTH a timezone abbreviation (PT/ET/UTC/etc.) AND a UTC ISO, call `convert_time` to disambiguate before quoting it to the user or putting it in a reminder/email/task. The default failure mode is reading "19:00" as your local time when it\'s actually UTC, and getting every downstream time wrong by 7+ hours.');
    lines.push('- **Hand off technique authorship to the trainer agent.** `save_technique` / `update_technique` / `publish_technique` / `delete_technique` are reserved for the trainer agent only, the engine refuses them from anyone else. **Why:** techniques are shareable across dojos; that only works if every file the technique needs is inside the technique\'s own directory and every external install (npm/brew/git/model) is declared in `dependencies.json`. If you create a script somewhere arbitrary on disk and reference it from TECHNIQUE.md, the technique silently breaks on every other user\'s machine. To avoid this, **don\'t write files for a future technique on your own**, when you realize a piece of work could become a reusable technique, send the trainer a message describing what you want with any custom file contents inline (use `file_read` to grab existing scripts), and they\'ll build it correctly. You can still `technique_read` and `use_technique` freely, those stay open to every agent.');
  }
  lines.push('');
  lines.push(`**Always-loaded tools**: ${alwaysLoaded.join(', ')}`);
  lines.push('');

  // Track which tools we've listed so we can report any uncategorized at the end
  const listed = new Set<string>();

  for (const category of TOOL_CATEGORIES) {
    const available = category.tools.filter(name => toolMap.has(name));
    if (available.length === 0) continue;

    // One line per category: the names, comma-joined. The model can
    // load_tool_docs any of them for the full schema.
    lines.push(`**${category.label}:** ${available.map(n => `\`${n}\``).join(', ')}`);
    available.forEach(n => listed.add(n));
    lines.push('');
  }

  // Tools not in any category. The user_* account-slot variants (one per
  // Google/Microsoft tool, acting on the owner's personal account instead of
  // the agent's) are summarized as a pattern rather than enumerated, there can
  // be ~120 of them and they mirror the categories above one-to-one, so listing
  // every name would bloat the index for no added information. Anything else
  // genuinely uncategorized still gets an explicit Other line so nothing hides.
  const uncategorized = agentTools.filter(t => !listed.has(t.name));
  const userVariants = uncategorized.filter(t => t.name.startsWith('user_'));
  const trueOther = uncategorized.filter(t => !t.name.startsWith('user_'));

  if (userVariants.length > 0) {
    lines.push(`**User-account variants (${userVariants.length}):** every Gmail / Google / Microsoft tool above also has a \`user_\`-prefixed twin (e.g. \`user_gmail_send\`, \`user_calendar_create\`, \`user_outlook_inbox\`) that acts on the OWNER's personal account instead of your agent account. Call \`load_tool_docs\` on the \`user_\` name exactly as you would the base tool.`);
    lines.push('');
  }
  if (trueOther.length > 0) {
    lines.push(`**Other:** ${trueOther.map(t => `\`${t.name}\``).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}
