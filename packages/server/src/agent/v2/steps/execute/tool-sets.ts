// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — the tool-name SETS and the one CAP this span decides with,
// moved out of `loop.ts` module level WITH the code they bind. Every use of all
// four was inside the `execute` span, measured by binder census before the move
// (`out=0` on each), which is CUT 6's own rule for a module-level item.
//
// They are one file because they are one kind of thing — a closed, hand-picked
// membership that a classifier deliberately does NOT derive, each carrying its own
// argument for why deriving it would be wrong. The values are copied VERBATIM.
// ════════════════════════════════════════

import { SEND_TO_PEOPLE } from '../../../sensei-policy.js';

export const SEND_TO_PEOPLE_SET: ReadonlySet<string> = new Set(SEND_TO_PEOPLE);
/** Max send_to_agent / broadcast_to_group calls to ONE recipient in a single
 *  turn before the re-send cap refuses further sends to them. Set well above any
 *  genuine multi-send (two distinct messages, a retry or two) so it only ever
 *  catches a pathological async re-send loop. */
export const A2A_SEND_CAP_PER_RECIPIENT = 5;
// Fire-and-forget media generators. Each posts a "started" ack and delivers
// the finished asset later as a synthetic message (from a background worker
// or poller), so the agent must NOT get a second turn, the loop exits
// immediately after one of these is called. This is the engine-enforced
// version of the tool result's "end your turn now" instruction, so a
// disobedient model can't retry-storm.
//
// HAND-PICKED, NOT DERIVABLE: this is the CLOSED set of async media-capability
// generators wired to the background-delivery pipeline (image/tts/music/video).
// "effectful-action" is far too broad, a gmail_send is effectful but is NOT
// fire-and-forget. Membership is tied to the delivery wiring, not the verb, and
// a new media generator would have to be wired here deliberately anyway.
export const FIRE_AND_FORGET_GEN_TOOLS = new Set([
  'image_create',
  'tts_create',
  'music_create',
  'video_create',
]);
// FA-T3: read-only reconnaissance / utility / bookkeeping tools that do NOT
// count as multi-step WORK for the tracker floor. Mirrors the carve-out from the
// deleted classifiers/tracker.ts (get_current_time, load_tool_docs, complete_task,
// vault_search/remember/forget, history_search/get/expand) and adds the obvious
// read-only LOOKUPS a pure reconnaissance turn is made of: checking email,
// calendar, texts, contacts, the vault, chat history, and the clock. Before this,
// such a turn (~6 read-only lookups) tripped the >=6 work-call floor and
// auto-scaffolded a junk project, which then failed the close-out gate,
// auto-paused, and fired CLOSEOUT_MISS at the PM. Trivial lookups are not
// multi-step work.
//
// The line drawn: "looking things up" (your inbox / calendar / contacts / vault /
// history / the clock) is trivial; "producing or transforming an artifact" is
// work. So file_read is DELIBERATELY NOT here, reading a file to act on it is
// real work, and the untracked-multistep-floor scenario locks file_read +
// file_write as the NON-trivial signal that must keep driving the floor.
// Likewise exec, every send / create / write, and document/drive/pdf reads stay
// NON-trivial. (Work-tracker reads are already excluded upstream by the
// tracker-family filter, so they aren't listed here.)
export const TRIVIAL_TOOLS = new Set([
  // Time / utility (no artifact, no side effect)
  'get_current_time',
  'convert_time',
  'load_tool_docs',
  'complete_task',
  // Vault (search/get are reads; remember/forget are bookkeeping per the deleted carve-out)
  'vault_search',
  'vault_get',
  'vault_remember',
  'vault_forget',
  // Chat-history recall (read-only context recovery)
  'history_search',
  'history_get',
  'history_expand',
  'recall_recent_thread',
  // Read-only view surface
  'canvas_read',
  // Contacts / texts lookups
  'imessage_list_contacts',
  'contacts_search',
  'contacts_list',
  'contacts_get',
  // Email reconnaissance (list / search / inbox), Google + Microsoft
  'gmail_search',
  'gmail_read',
  'gmail_inbox',
  'gmail_list_labels',
  'outlook_search',
  'outlook_read',
  'outlook_inbox',
  // Calendar reconnaissance (agenda / list / search / free-busy), Google + Microsoft
  'calendar_agenda',
  'calendar_search',
  'calendar_list',
  'calendar_freebusy',
  'calendar_agenda_ms',
  'calendar_search_ms',
  'calendar_list_ms',
  'calendar_freebusy_ms',
]);
