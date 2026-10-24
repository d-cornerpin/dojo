// ════════════════════════════════════════════════════════════════════════════
// THE TOOLS WHOSE RESULT IS OTHER PEOPLE'S TEXT (v3.5 K33 fix round 1) — one registry, one door.
//
// A read tool that returns text somebody else wrote (a web page, an invite, a shared document, a
// Teams thread, an attachment, a recording) is registered here with the fence kind it carries.
// Registering it IS fencing it: the tool door (`agent/tools/index.ts` `dispatchResolved`) passes
// every result through `fenceToolResult`, so a registered tool cannot reach the model unfenced and
// no handler fences on its own. The one exception is the mailbox reads, whose banner
// (`provider/mailbox-banner.ts`) keeps the identification and the owner's injection guard OUTSIDE
// the fence and fences the mail itself — the door leaves those alone.
//
// The census (`tools/__tests__/every-external-render-is-fenced.test.ts`) DERIVES the candidate
// tools from the definitions (every read-shaped tool) and requires each to be registered here or
// named in `NOT_OUTSIDE_CONTENT` with its reason, so a new read tool cannot slip through.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { fenceExternal, type ExternalKind } from '../../tools/external-content.js';
import { USER_MAILBOX_READ_TOOLS, AGENT_MAILBOX_READ_TOOLS } from './provider/mailbox-banner.js';
import { homeDir } from '../../home.js';

interface OutsideRead {
  readonly kind: ExternalKind;
  /** The source line for this call, or null when this call returns no outside text. */
  readonly from: (args: Record<string, unknown>) => string | null;
}

/** The first identifying argument a call carries, for the source line. */
const ID_ARGS = ['url', 'path', 'file_id', 'document_id', 'spreadsheet_id', 'presentation_id', 'item_id', 'page_id', 'form_id',
  'message_id', 'chat_id', 'channel_id', 'team_id', 'meeting_id', 'event_id', 'recording_id', 'attachment_id', 'calendar_id', 'query', 'account'] as const;
function idOf(args: Record<string, unknown>): string | null {
  for (const k of ID_ARGS) { const v = args[k]; if (typeof v === 'string' && v.trim() !== '') return v.trim(); }
  return null;
}
const named = (what: string) => (args: Record<string, unknown>): string => { const id = idOf(args); return id ? `${what} (${id})` : what; };

/** A file someone sent or handed over (attachments, downloads, uploads) — not what this platform generated. */
function receivedFile(args: Record<string, unknown>): string | null {
  const p = typeof args.path === 'string' ? path.resolve(args.path) : null;
  const uploads = path.join(homeDir(), '.dojo', 'uploads');
  if (!p || !p.startsWith(uploads + path.sep) || p.startsWith(path.join(uploads, 'generated') + path.sep)) return null;
  return `the received file ${path.basename(p)}`;
}

const doc = (what: string): OutsideRead => ({ kind: 'document', from: named(what) });
const cal = (what: string): OutsideRead => ({ kind: 'calendar event', from: named(what) });

/** Door-fenced reads (canonical names; a `user_` twin reads the same way). */
const OUTSIDE_READS: Readonly<Record<string, OutsideRead>> = {
  web_search: { kind: 'search result', from: (a) => `a web search for "${typeof a.query === 'string' ? a.query : ''}"` },
  web_fetch: { kind: 'web page', from: (a) => (typeof a.url === 'string' ? a.url : 'a web page') },
  web_browse: { kind: 'web page', from: (a) => (a.action === 'extract' || a.action === 'screenshot' ? 'the page open in web_browse' : null) },
  email_search: { kind: 'email', from: () => 'the connected mailboxes' },
  gmail_read_attachment: doc('an email attachment'),
  outlook_download_attachment: doc('an email attachment'),
  teams_download_attachment: doc('a Teams attachment'),
  file_read: { kind: 'document', from: receivedFile },
  pdf_read: doc('a PDF'), pdf_get_info: doc('a PDF'),
  docs_read: doc('a Google Doc'), drive_read: doc('a Drive file'), drive_list: doc('a Drive folder'), drive_versions_list: doc('a Drive file'),
  sheets_read: doc('a Google Sheet'), slides_get_slides: doc('a Google Slides deck'), slides_get_elements: doc('a Google Slides deck'),
  forms_get: doc('a Google Form'), forms_list_responses: doc('the responses to a Google Form'),
  onedrive_read: doc('a OneDrive file'), onedrive_list: doc('a OneDrive folder'), onedrive_list_shared: doc('files shared on OneDrive'),
  onedrive_search: doc('a OneDrive search'), onedrive_versions_list: doc('a OneDrive file'),
  sharepoint_list_sites: doc('SharePoint'), sharepoint_list_drives: doc('SharePoint'), onedrive_list_drives: doc('OneDrive'),
  office_read_word_document: doc('a Word document'), office_get_word_document_outline: doc('a Word document'),
  office_read_presentation: doc('a PowerPoint deck'), office_get_presentation_outline: doc('a PowerPoint deck'),
  office_get_spreadsheet_range: doc('an Excel workbook'),
  onenote_read_page: doc('a OneNote page'), onenote_list_pages: doc('a OneNote section'),
  onenote_list_sections: doc('a OneNote notebook'), onenote_list_notebooks: doc('OneNote'),
  calendar_agenda: cal('the calendar'), calendar_list: cal('the calendar'), calendar_search: cal('the calendar'),
  calendar_agenda_ms: cal('the Outlook calendar'), calendar_list_ms: cal('the Outlook calendar'), calendar_search_ms: cal('the Outlook calendar'),
  online_meeting_get: cal('an online meeting'), online_meeting_list: cal('online meetings'),
  teams_read_messages: { kind: 'chat message', from: named('a Teams chat') },
  teams_read_channel_messages: { kind: 'chat message', from: named('a Teams channel') },
  teams_list_chats: { kind: 'chat message', from: () => 'Teams chats' },
  teams_list_attachments: { kind: 'chat message', from: named('a Teams chat') },
  plaud_get_transcript: { kind: 'transcript', from: named('a Plaud recording') },
  plaud_get_summary: { kind: 'transcript', from: named('the summary of a Plaud recording') },
  plaud_get_recording: { kind: 'transcript', from: named('a Plaud recording') },
  transcribe_audio: { kind: 'transcript', from: named('an audio recording') },
};

/** The mailbox reads: fenced by their banner, with the guard outside the fence (see header). */
export const BANNER_FENCED_READS: ReadonlySet<string> = new Set([...USER_MAILBOX_READ_TOOLS, ...AGENT_MAILBOX_READ_TOOLS]);

/**
 * Read-shaped tools whose result is NOT someone else's text, each with its reason. The census
 * requires every read-shaped tool to be in OUTSIDE_READS, BANNER_FENCED_READS or here.
 */
export const NOT_OUTSIDE_CONTENT: Readonly<Record<string, string>> = {
  // The platform's own records and the agent's own memory (already fenced where they were written).
  history_get: 'the agent\'s own conversation record; outside text in it was fenced when it arrived',
  history_search: 'the agent\'s own conversation record; outside text in it was fenced when it arrived',
  history_expand: 'the agent\'s own conversation record',
  recall_recent_thread: 'the agent\'s own conversation record',
  canvas_read: 'the agent\'s own canvas', file_list: 'a listing of names on this machine', vault_get: 'the agent\'s own memory',
  vault_search: 'the agent\'s own memory', squad_recall: 'what the agents shared among themselves',
  technique_read: 'a technique the platform holds', list_techniques: 'the platform\'s techniques', technique_list_versions: 'the platform\'s techniques',
  contact_get: 'the owner\'s own contact records', contact_list: 'the owner\'s own contact records', contact_search: 'the owner\'s own contact records',
  contacts_get: 'the owner\'s own contact records', contacts_list: 'the owner\'s own contact records', contacts_search: 'the owner\'s own contact records',
  contacts_overview: 'the owner\'s own contact records', imessage_list_contacts: 'the owner\'s safe-sender list',
  credential_get: 'a credential the owner stored', credential_list: 'the owner\'s credential names',
  list_agents: 'the platform\'s agents', list_groups: 'the platform\'s groups', list_models: 'the platform\'s models',
  get_agent_profile: 'the platform\'s agents', get_group_detail: 'the platform\'s groups', cost_summary: 'the platform\'s cost ledger',
  get_current_time: 'the clock', convert_time: 'arithmetic', healer_recent_actions: 'the platform\'s own log', healer_action_detail: 'the platform\'s own log',
  voice_call_status: 'the platform\'s call state', channel_inspect: 'the platform\'s channel state', plaud_account_info: 'the owner\'s account details',
  load_tool_docs: 'the platform\'s tool documentation',
  tool_result_read: 'a tool result this agent already received; outside text in it was fenced when it arrived',
  // The owner's own lists and structure, written by him (names of his labels, folders, task lists, teams).
  gmail_list_labels: 'the owner\'s own label names', outlook_list_folders: 'the owner\'s own folder names',
  tasks_list: 'the owner\'s own tasks', tasks_list_lists: 'the owner\'s own task lists',
  teams_list_teams: 'the names of the owner\'s teams', teams_list_channels: 'the names of the owner\'s channels',
  plaud_list_recordings: 'the owner\'s own recording list', plaud_search_recordings: 'the owner\'s own recording list',
  plaud_get_audio_url: 'a link to the owner\'s own recording', calendar_freebusy: 'busy/free times, no text', calendar_freebusy_ms: 'busy/free times, no text',
  slides_get_style: 'style values of a deck', slides_list_presets: 'the platform\'s slide presets',
  // Writes that the word "list" misclassifies as reads.
  tasks_create_list: 'a write (the "list" token misclassifies it)', slides_add_bullet_list: 'a write (the "list" token misclassifies it)',
  outlook_mark_read: 'a write (sets a flag; the "read" token misclassifies it)',
};

/** The registry entry for a tool (a `user_` twin reads like its base), if its result is outside text. */
export function outsideReadOf(toolName: string): OutsideRead | undefined {
  return OUTSIDE_READS[toolName] ?? (toolName.startsWith('user_') ? OUTSIDE_READS[toolName.slice('user_'.length)] : undefined);
}

/** Every door-fenced tool name (canonical). */
export const OUTSIDE_READ_NAMES: readonly string[] = Object.keys(OUTSIDE_READS);

/**
 * THE DOOR'S HOOK: a registered read's successful result goes to the model fenced. An error, a
 * refusal or an empty result is the platform speaking, not the outside, and is left alone.
 */
export function fenceToolResult(toolName: string, args: Record<string, unknown>, result: { content: string; isError?: boolean }): void {
  const read = outsideReadOf(toolName);
  if (!read || result.isError === true || result.content.trim() === '' || /^(Error|Permission denied)\b/.test(result.content)) return;
  const from = read.from(args);
  if (from === null) return;
  result.content = fenceExternal(read.kind, from, result.content);
}
