// Hand-picked tool sets the execute step decides with; each is closed on purpose.

import { channelOfSendTool } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../../../sensei-policy.js';

// Every tool that sends something to a person, user_ twins included; the contact list, the call status and
// the hang-up stay in SEND_TO_PEOPLE for the grants and deny lists but are not sends.
export const SEND_TO_PEOPLE_SET: ReadonlySet<string> = new Set(SEND_TO_PEOPLE.filter((n) => channelOfSendTool(n) !== null));
// Async media generators delivered later by a background pipeline: the turn ends after one, bar the words
// step. Closed set tied to the delivery wiring; 'effectful-action' is far broader.
export const FIRE_AND_FORGET_GEN_TOOLS = new Set([
  'image_create',
  'tts_create',
  'music_create',
  'video_create',
]);
// Lookups that do not count as multi-step work for the tracker floor. file_read, exec and every send,
// create or write stay out on purpose: acting on a file is real work. Tracker reads are filtered upstream.
export const TRIVIAL_TOOLS = new Set([
  'get_current_time',
  'convert_time',
  'load_tool_docs',
  'continue_repeating',
  'complete_task',
  'vault_search',
  'vault_get',
  'vault_remember',
  'vault_forget',
  'history_search',
  'history_get',
  'history_expand',
  'recall_recent_thread',
  'tool_result_read',
  'canvas_read',
  'imessage_list_contacts',
  'contacts_search',
  'contacts_list',
  'contacts_get',
  'gmail_search',
  'gmail_read',
  'gmail_inbox',
  'gmail_list_labels',
  'outlook_search',
  'outlook_read',
  'outlook_inbox',
  'calendar_agenda',
  'calendar_search',
  'calendar_list',
  'calendar_freebusy',
  'calendar_agenda_ms',
  'calendar_search_ms',
  'calendar_list_ms',
  'calendar_freebusy_ms',
]);
