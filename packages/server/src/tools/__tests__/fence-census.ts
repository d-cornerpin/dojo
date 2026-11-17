// The fence census lists: every read-shaped tool is fenced at the door (OUTSIDE_READS in tools/inbound-fences.ts),
// fenced by the mailbox banner (BANNER_FENCED_READS), or named in NOT_OUTSIDE_CONTENT with a reason.
import { USER_MAILBOX_READ_TOOLS, AGENT_MAILBOX_READ_TOOLS } from '../../agent/tools/provider/mailbox-banner.js';

/** The mailbox reads: their banner (`provider/mailbox-banner.ts`) fences the outside span and keeps the owner's injection guard outside it. */
export const BANNER_FENCED_READS: ReadonlySet<string> = new Set([...USER_MAILBOX_READ_TOOLS, ...AGENT_MAILBOX_READ_TOOLS]);

/** Read-shaped tools whose result is not someone else's text, each with its reason. The census requires
 *  every read-shaped tool to be in OUTSIDE_READS, BANNER_FENCED_READS or here. */
export const NOT_OUTSIDE_CONTENT: Readonly<Record<string, string>> = {
  history_get: 'the agent\'s own conversation record; outside text in it was fenced when it arrived',
  history_search: 'the agent\'s own conversation record; outside text in it was fenced when it arrived',
  history_expand: 'the agent\'s own conversation record',
  dojo_inspect: 'the platform\'s own records, log and source; outside text in a message was fenced when it arrived',
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
  tool_result_read: 'a page of a result this agent already received: it is stored fenced, and each page re-fences its outside lines under a fresh code (cat/result-read.ts)',
  gmail_list_labels: 'the owner\'s own label names', outlook_list_folders: 'the owner\'s own folder names',
  tasks_list: 'the owner\'s own tasks', tasks_list_lists: 'the owner\'s own task lists',
  teams_list_teams: 'the names of the owner\'s teams', teams_list_channels: 'the names of the owner\'s channels',
  plaud_list_recordings: 'the owner\'s own recording list', plaud_search_recordings: 'the owner\'s own recording list',
  plaud_get_audio_url: 'a link to the owner\'s own recording', calendar_freebusy: 'busy/free times, no text', calendar_freebusy_ms: 'busy/free times, no text',
  slides_get_style: 'style values of a deck', slides_list_presets: 'the platform\'s slide presets',
  // Writes that the word "list" misclassifies as reads.
  tasks_create_list: 'a write (the "list" token misclassifies it)', slides_add_bullet_list: 'a write (the "list" token misclassifies it)',
  outlook_mark_read: 'a write (sets a flag; the "read" token misclassifies it)',
  // Reads that return no text anybody wrote (the census checks every registered read marks its outside span).
  gmail_read_attachment: 'saves the attachment and says where; its content is read with file_read, which fences a received file',
  outlook_download_attachment: 'saves the attachment and says where; its content is read with file_read, which fences a received file',
  teams_download_attachment: 'saves the attachment and says where; its content is read with file_read, which fences a received file',
  slides_get_slides: 'slide ids and positions only, no text', slides_get_elements: 'element ids, types and geometry only, no text',
};
