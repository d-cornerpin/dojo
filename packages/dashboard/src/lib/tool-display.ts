// Friendly, human-readable presentation for tool calls shown in regular chat
// mode. The classifier (@dojo/shared classifyTool) decides the DISPLAY CLASS
// (effectful-action / retrieval / bookkeeping / delivery); this maps a tool to
// a friendly phrase for its badge. Bookkeeping tools are hidden in regular mode
// (the agent restates anything the user needs), so they get no label. Curated
// phrases cover the common, user-visible tools; the long tail falls back to a
// humanized tool name. See DOJO-CHAT-VISIBILITY-PLAN.md §3 / §3a. Lives in the
// dashboard (pure presentation); shared by every chat surface (V2 Chat, V3
// AgentDetail) so the wording cannot drift.
import { classifyTool } from '@dojo/shared';

const FRIENDLY_LABELS: Record<string, string> = {
  // effectful actions
  image_create: 'created an image',
  music_create: 'created music',
  video_create: 'created a video',
  tts_create: 'generated speech',
  file_write: 'wrote a file',
  file_patch: 'edited a file',
  file_delete: 'deleted a file',
  exec: 'ran a command',
  reminder_create: 'set a reminder',
  calendar_create: 'created a calendar event',
  calendar_create_ms: 'created a calendar event',
  calendar_update: 'updated a calendar event',
  calendar_update_ms: 'updated a calendar event',
  calendar_delete: 'deleted a calendar event',
  calendar_delete_ms: 'deleted a calendar event',
  docs_create: 'created a document',
  office_create_word_document: 'created a document',
  sheets_create: 'created a spreadsheet',
  office_create_spreadsheet: 'created a spreadsheet',
  slides_create_presentation: 'created a presentation',
  office_create_presentation: 'created a presentation',
  forms_create_form: 'created a form',
  drive_upload: 'uploaded a file',
  onedrive_upload: 'uploaded a file',
  drive_share: 'shared a file',
  onedrive_share: 'shared a file',
  share_file: 'shared a file',
  show_to_user: 'shared something with you',
  // retrieval
  web_search: 'searched the web',
  web_fetch: 'fetched a page',
  web_browse: 'browsed the web',
  file_read: 'read a file',
  file_list: 'listed files',
  gmail_search: 'searched email',
  outlook_search: 'searched email',
  gmail_read: 'read an email',
  outlook_read: 'read an email',
  gmail_inbox: 'checked the inbox',
  outlook_inbox: 'checked the inbox',
  calendar_agenda: 'checked the calendar',
  calendar_agenda_ms: 'checked the calendar',
  calendar_search: 'searched the calendar',
  calendar_search_ms: 'searched the calendar',
  drive_read: 'read a file',
  docs_read: 'read a document',
  sheets_read: 'read a spreadsheet',
  drive_list: 'listed files',
};

function humanize(name: string): string {
  return name.replace(/_/g, ' ');
}

export function toolFriendlyLabel(name: string): string {
  return FRIENDLY_LABELS[name] ?? humanize(name);
}

export type ToolBadgeClass = 'effectful-action' | 'retrieval' | 'mixed';

export interface ToolTurnSummary {
  primaryClass: ToolBadgeClass;
  label: string;
}

// Summarize a tool-only turn for the regular-mode badge. Bookkeeping tools are
// dropped; if nothing visible remains the turn is hidden (returns null). The
// delivery primitive (show_to_user) counts as a visible action here; V2d will
// render the delivered content itself rather than a badge.
export function summarizeToolTurn(toolNames: string[]): ToolTurnSummary | null {
  const visible = toolNames.filter((n) => classifyTool(n) !== 'bookkeeping');
  if (visible.length === 0) return null;
  const badgeClassOf = (n: string): 'effectful-action' | 'retrieval' =>
    classifyTool(n) === 'retrieval' ? 'retrieval' : 'effectful-action';
  if (visible.length === 1) {
    return { primaryClass: badgeClassOf(visible[0]), label: toolFriendlyLabel(visible[0]) };
  }
  const classes = new Set(visible.map(badgeClassOf));
  const primaryClass: ToolBadgeClass = classes.size === 1 ? [...classes][0] : 'mixed';
  const label =
    primaryClass === 'retrieval' ? `${visible.length} lookups`
    : primaryClass === 'effectful-action' ? `${visible.length} actions`
    : `${visible.length} tools`;
  return { primaryClass, label };
}
