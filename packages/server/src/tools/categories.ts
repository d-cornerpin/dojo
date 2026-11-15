// Tool categories and the compact tool index rendered into system prompts. The index lists tool names
// grouped by category (no descriptions); `load_tool_docs` fetches the schema of any of them.

import type { ToolDefinition } from '../agent/tools/types.js';
import { renderIndexName } from './index-notes.js';

// Tool category definitions, order matters, categories are shown in this order
export const TOOL_CATEGORIES: Array<{ label: string; tools: string[] }> = [
  {
    label: 'Meta',
    // `dojo_report` joins the category every agent already holds, so it is default-granted with no new
    // label. Appended, never reordered: the label string is part of the cached prefix.
    tools: ['load_tool_docs', 'dojo_report', 'continue_repeating'],
  },
  {
    label: 'File & System',
    tools: ['file_read', 'file_list', 'file_write', 'file_append', 'file_patch', 'exec', 'shell', 'screen_screenshot', 'keyboard_type', 'mouse_click', 'mouse_move', 'applescript_run', 'scratchpad_set', 'scratchpad_clear', 'get_current_time', 'convert_time'],
  },
  {
    label: 'Web',
    tools: ['web_search', 'web_fetch', 'web_browse'],
  },
  {
    // Right-dock workspace: view-together surfaces next to the chat, not file writes.
    label: 'Shared Workspace (right dock)',
    tools: ['canvas_render', 'open_browser', 'canvas_read', 'screen_broadcast'],
  },
  {
    // Each dispatches to the model configured for that capability (see set_capability_model).
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
    tools: ['vault_remember', 'vault_search', 'vault_forget', 'vault_get', 'vault_update', 'vault_refresh', 'vault_discard_archives', 'lesson_record'],
  },
  {
    label: 'Conversation Recall',
    tools: ['recall_recent_thread', 'history_search', 'history_get', 'history_expand'],
  },
  {
    // Pointer group: commitments are obligations, not recall; work_open / work_close_request carry them.
    label: 'Open Work (what you still owe)',
    tools: ['work_open', 'work_close_request'],
  },
  {
    // Squad-shared memory: members of one group_id read and write a shared namespace.
    label: 'Squad Coordination',
    tools: ['squad_share', 'squad_recall'],
  },
  {
    // The index lists names; each verb's operations are in its description (fetched by `load_tool_docs`).
    label: 'Work Tracker (projects, tasks, reminders, promises)',
    tools: ['work_open', 'work_update', 'work_note', 'work_close_request', 'work_validate', 'work_schedule'],
  },
  {
    // Ordered by workflow: discovery, create/end, edit identity, groups, messaging, session.
    label: 'Managing Other Agents',
    tools: [
      'list_agents',
      'list_groups',
      'list_models',
      'spawn_agent',
      'kill_agent',
      'spawn_timeout_decision',
      'get_agent_profile',
      'update_agent',
      'create_agent_group',
      'update_group',
      'assign_to_group',
      'delete_group',
      'get_group_detail',
      'send_to_agent',
      'broadcast_to_group',
      'complete_task',
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
    // Tools the owner-facing primary uses to run the Dojo on the owner's behalf (see agent-controls.ts).
    label: 'DOJO Controls (change settings / navigate the dashboard on the owner\'s behalf)',
    tools: ['set_user_presence', 'open_settings', 'dashboard_navigate', 'set_capability_model', 'set_voice', 'set_channel', 'check_for_update', 'apply_update'],
  },
  {
    // Owner-facing oversight and the engine's self-repair surface.
    label: 'Oversight & Admin',
    tools: ['cost_summary', 'channel_inspect', 'dojo_inspect', 'dreamer_run_now', 'approve_destructive_action'],
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
    // Merged cross-account reads: one call covers every connected surface, so an answer is never drawn
    // from an arbitrary subset. `calendar_agenda` is the merged agenda (listed under Google Calendar).
    label: 'Unified Search (all connected accounts at once)',
    tools: ['email_search'],
  },
  {
    label: 'Gmail',
    tools: ['gmail_search', 'gmail_read', 'gmail_inbox', 'gmail_send', 'gmail_reply', 'gmail_forward', 'gmail_draft', 'gmail_label', 'gmail_list_labels', 'gmail_create_label', 'gmail_delete_label', 'gmail_list_attachments', 'gmail_read_attachment'],
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
    tools: ['outlook_search', 'outlook_read', 'outlook_inbox', 'outlook_send', 'outlook_reply', 'outlook_forward', 'outlook_draft', 'outlook_mark_read', 'outlook_delete', 'outlook_move_to_folder', 'outlook_list_folders', 'outlook_create_folder', 'outlook_categories_set', 'outlook_list_attachments', 'outlook_download_attachment'],
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

/** Compact tool index: names grouped by category, with the always-loaded set enumerated once at the top. */
export function generateToolIndex(agentTools: ToolDefinition[], alwaysLoaded: string[]): string {
  const toolMap = new Map(agentTools.map(t => [t.name, t]));
  const alwaysLoadedSet = new Set(alwaysLoaded);

  const lines: string[] = [];
  lines.push('## Available Tools', '');
  // Primary-class agents get the structured reflex block, sub-agents the short paragraph.
  const isPrimaryClass =
    alwaysLoadedSet.has('work_open') &&
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
    lines.push('- **When sharing a URL or file path with the person you are talking to**: paste the literal string from the most recent tool result, ONCE, surrounded by spaces. Never wrap a URL in backticks (it gets sucked into the href and the browser encodes it as `%60`, breaking the link). Never write the same URL twice in a row. Never paraphrase, truncate, or type one from memory, if you don\'t have the full string, call the source tool again.');
    lines.push('- **Default ON tracker for any work that isn\'t a one-shot lookup.** Open `work_open(kind="project")` BEFORE starting work on **any** request that has a deliverable, requires multiple steps, or could take more than ~3 tool calls. Don\'t try to predict whether you\'ll finish in one push, you usually can\'t, and the failure mode is silent context loss (compaction summarizes older turns, you write the deliverable from your own summarized memory, and confabulate). Tracker rows survive compaction AND session reset; scratchpad survives compaction but NOT reset; raw context survives neither. **Cost of opening a tracker entry you didn\'t end up needing: zero. Cost of not opening one for work that turns out to be multi-step: 30+ minutes of stalled work, PM pokes, and lost context.** Skip the tracker only for one-shot Q&A where you\'re answering from existing context or a single tool call. After opening the tracker: scaffold the deliverable with `file_write`; loop (read 3-5 sources, write findings with `file_append`/`file_patch`, update `scratchpad_set` for in-flight memory, mark the step complete, move on); verify at the end. The engine backstops this: after ~4 work calls with no tracker entry you get a reminder, and at 6+ the engine opens a task for you automatically (nothing is ever refused). Better to open it yourself first with a real title and a plan (the approach, and each step: what, how, and how you will know it is done).');
    lines.push('- **Keep the tracker true.** Waiting on the user → `paused`; stuck on something they do not know → `blocked`. Finished, or cannot be done → `work_update(action="hand_in")` with its proof; someone other than you decides it. Work still going stays `in_progress`; at the start of a turn nobody is waiting on, the engine asks for one tracker call saying where stale work stands before other tools run.');
    lines.push('- **Never read a timestamp without a timezone label.** If a time you encounter (calendar event, email, scraped web text, raw unix epoch, a tool result you\'re unsure of) does NOT include BOTH a timezone abbreviation (PT/ET/UTC/etc.) AND a UTC ISO, call `convert_time` to disambiguate before quoting it to the user or putting it in a reminder/email/task. The default failure mode is reading "19:00" as your local time when it\'s actually UTC, and getting every downstream time wrong by 7+ hours.');
    lines.push('- **Keep techniques portable.** You may `save_technique` / `update_technique` / `publish_technique` yourself; `delete_technique` too; other agents are redirected to the trainer. **Why:** techniques are shareable across dojos; that only works if every file the technique needs is inside the technique\'s own directory and every external install (npm/brew/git/model) is declared in `dependencies.json`. If you create a script somewhere arbitrary on disk and reference it from TECHNIQUE.md, the technique silently breaks on every other user\'s machine. To avoid this, when you build a technique, pass every custom file in `files` so it lives inside the technique\'s own directory, or send the trainer a message describing what you want with any custom file contents inline (use `file_read` to grab existing scripts) and they\'ll build it. You can still `technique_read` and `use_technique` freely, those stay open to every agent.');
  }
  if (toolMap.has('file_append')) lines.push('', '**When an answer deserves to be long** (a report, a document, a story), build it in a file from the start: `file_write` the first part, `file_append` each next part, then hand over the file with a short message. Never attempt one huge reply.');
  lines.push('');
  // Names what the call carries: `alwaysLoaded` must be the head the transport sends
  // (`partitionToolsForApiCall`), not the declaration, so the line never promises a tool the agent's
  // filter stripped (e.g. `complete_task`). `isPrimaryClass` reads the same argument.
  lines.push(`**Always-loaded tools**: ${alwaysLoaded.join(', ')}`);
  lines.push('');

  const listed = new Set<string>();

  for (const category of TOOL_CATEGORIES) {
    // Per canonical name in declared order: render it if held, else its `user_` twin, else neither. A
    // category is skipped only when no form of any name is held. No Set/Map iteration order.
    const rendered: string[] = [];
    for (const canonical of category.tools) {
      if (toolMap.has(canonical)) {
        rendered.push(canonical);
      } else {
        const userTwin = `user_${canonical}`;
        if (toolMap.has(userTwin)) {
          rendered.push(userTwin);
        }
      }
    }
    if (rendered.length === 0) continue;

    // One line per category. The INDEX_NOTES lookup is the identity for every name but its one entry, so
    // an agent that does not hold that tool gets a byte-identical line.
    lines.push(`**${category.label}:** ${rendered.map(renderIndexName).join(', ')}`);
    rendered.forEach(n => listed.add(n));
    lines.push('');
  }

  // Tools not rendered on a category line. MIRRORED (the canonical sibling is a declared name and was
  // rendered above) stays a pattern sentence, locked by the cache-prefix golden. ORPHANED (no category
  // lists the canonical base) gets a literal `Other` line, so a stray `user_` tool never hides.
  const uncategorized = agentTools.filter(t => !listed.has(t.name));
  const allCategoryNames = new Set(TOOL_CATEGORIES.flatMap(c => c.tools));
  const isMirroredUserVariant = (name: string) =>
    name.startsWith('user_') && allCategoryNames.has(name.slice('user_'.length));
  const mirroredUserVariants = uncategorized.filter(t => isMirroredUserVariant(t.name));
  const trueOther = uncategorized.filter(t => !isMirroredUserVariant(t.name));

  if (mirroredUserVariants.length > 0) {
    // Held twins are named literally, never covered by a pattern sentence: an agent holding both forms
    // otherwise concluded an unprinted `user_` tool did not exist. Order is the categories' declared
    // order, so the line depends only on the held names.
    const held = new Set(mirroredUserVariants.map((t) => t.name));
    const ordered: string[] = [];
    for (const category of TOOL_CATEGORIES) {
      for (const canonical of category.tools) {
        const twin = `user_${canonical}`;
        if (held.has(twin) && !ordered.includes(twin)) ordered.push(twin);
      }
    }
    lines.push(`**User-account variants (${ordered.length}):** these act on the OWNER's personal account instead of your agent account, each the twin of the tool above with the same name after \`user_\`. Call \`load_tool_docs\` on the \`user_\` name exactly as you would the base tool: ${ordered.map((n) => `\`${n}\``).join(', ')}`);
    lines.push('');
  }
  if (trueOther.length > 0) {
    lines.push(`**Other:** ${trueOther.map(t => `\`${t.name}\``).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}
