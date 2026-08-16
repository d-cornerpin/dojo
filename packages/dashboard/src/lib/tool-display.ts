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

// COSMETIC map: curated friendly phrasing for the common user-visible tools.
// It does NOT need to be exhaustive, toolFriendlyLabel() falls back to a
// humanized tool name for anything absent, so drift here only makes a rare
// tool's badge read "onedrive upload" instead of "uploaded a file". The tool-
// list conformance test still asserts every KEY here is a real tool (the phantom
// `file_delete`, which was never a tool, was removed in the 2026-07-08 sweep).
const FRIENDLY_LABELS: Record<string, string> = {
  // effectful actions
  image_create: 'created an image',
  music_create: 'created music',
  video_create: 'created a video',
  tts_create: 'generated speech',
  file_write: 'wrote a file',
  file_patch: 'edited a file',
  exec: 'ran a command',
  work_open: 'open work',
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

// ── Chip pill labels for the "generic runner" tools ──
//
// The collapsed chip pill (dojo3 chat) shows the raw tool NAME, uppercased by
// CSS, so a heavily-used generic runner like `exec` always reads as a vague
// "EXEC" no matter what it actually ran. For the handful of tools whose name
// hides the real operation, derive a sharper pill label from the call's own
// arguments: `exec` -> the base command (`mv`, `git`, `rm`), `applescript_run`
// -> the app it drives (`finder`, `messages`). This is PILL-ONLY cosmetics; the
// expanded detail still shows the true tool name + full args, and anything we
// cannot read cleanly falls back to the tool name so the label never lies.
//
// Pipelines relabel by their FIRST command plus a continuation marker
// (`ps -e | wc -l` -> "ps …"): measured against real agent history, nearly
// every exec is a pipeline, so the original refuse-all-pipelines rule left
// almost every chip reading EXEC (owner report 2026-07-10). The first segment
// plus an ellipsis is honest, it says what the command starts with AND that
// there is more. Hard bailouts remain for the genuinely unreadable shapes:
// multi-line scripts, subshells, backticks, and quoted metacharacters (a
// quoted pipe in e.g. grep "a|b" splits wrong, but the mislabeled first
// segment is still `grep`, which stays truthful; heredocs and $( trip the
// bailout before any guess). Trailing redirects (2>/dev/null) never
// disqualify; they are stripped with their targets.

// Shapes we refuse to guess about: multi-line, subshell, backtick.
const SHELL_BAILOUT_RE = /[`\n]|\$\(/;
// Segment separators: pipe, && , ||, ; (first segment wins, marker added).
const SEGMENT_SPLIT_RE = /\||&&|;/;
// A leading `NAME=value` env assignment prefix (`FOO=bar mv ...`).
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A redirect token (2>/dev/null, >out.txt, <in.txt) and its glued target.
const REDIRECT_TOKEN_RE = /^[0-9]*[<>]/;
// What a real base-command token may contain once path + prefixes are stripped.
const CLEAN_COMMAND_RE = /^[A-Za-z0-9._-]+$/;

function baseCommandOf(command: string): string | null {
  const cmd = command.trim();
  if (!cmd || SHELL_BAILOUT_RE.test(cmd)) return null; // multi-line/subshell -> keep EXEC
  const segments = cmd.split(SEGMENT_SPLIT_RE);
  const first = segments[0]?.trim();
  if (!first) return null;
  const hasMore = segments.length > 1;
  const tokens = first.split(/\s+/).filter((t) => !REDIRECT_TOKEN_RE.test(t));
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i++; // FOO=bar mv ...
  if (tokens[i] === 'sudo') {
    i++;
    // A flagged sudo (`sudo -u root cmd`) is ambiguous to tokenize (its options
    // can take arguments), so bail to EXEC; only the clean `sudo cmd` relabels.
    if (i < tokens.length && tokens[i].startsWith('-')) return null;
  }
  const head = tokens[i];
  if (!head) return null;
  const base = head.slice(head.lastIndexOf('/') + 1); // /usr/bin/mv -> mv
  if (!base || base.length > 24 || !CLEAN_COMMAND_RE.test(base)) return null;
  return hasMore ? `${base} …` : base;
}

function appDrivenBy(script: string): string | null {
  const m = /tell\s+application\s+"([^"]{1,40})"/i.exec(script);
  return m ? m[1] : null;
}

// The pill text for a tool call: the tool name for everything except the
// generic runners, which get a payload-derived label (falling back to the name
// when the payload cannot be read cleanly). Never returns empty.
export function deriveChipLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'exec' && typeof input.command === 'string') {
    return baseCommandOf(input.command) ?? name;
  }
  if (name === 'applescript_run' && typeof input.script === 'string') {
    return appDrivenBy(input.script) ?? name;
  }
  return name;
}

export type ToolBadgeClass = 'effectful-action' | 'retrieval' | 'mixed';

export interface ToolTurnSummary {
  primaryClass: ToolBadgeClass;
  label: string;
}

// One tool call as the badge path reads it: the name, plus the arguments that
// decide its class for the one operation where they do (see below).
export interface ToolTurnCall {
  name: string;
  input?: Record<string, unknown>;
}

// Summarize a tool-only turn for the regular-mode badge. Bookkeeping tools are
// dropped; if nothing visible remains the turn is hidden (returns null). The
// delivery primitive (show_to_user, and since UX-REPAIR T54 the two right-dock
// view surfaces canvas_render / open_browser) counts as a visible action here;
// V2d will render the delivered content itself rather than a badge.
//
// UX-REPAIR T54(d): this takes CALLS, not names. `classifyTool` has accepted a
// call's arguments since PHASE-2 T8V for the single operation whose display
// class they change (`work_open` with a reminder shape is effectful; its 23
// sibling ops are bookkeeping), and every client site passed the name alone, so
// the promotion was unreachable. Passing the name alone here would also put this
// badge path out of step with the chip filter in Chat.tsx and with the row tier
// in @dojo/shared — a reminder turn the tier calls user-visible would be
// classed 'hidden' by the pill grouping and skipped.
export function summarizeToolTurn(calls: ToolTurnCall[]): ToolTurnSummary | null {
  const visible = calls.filter((c) => classifyTool(c.name, c.input) !== 'bookkeeping');
  if (visible.length === 0) return null;
  const badgeClassOf = (c: ToolTurnCall): 'effectful-action' | 'retrieval' =>
    classifyTool(c.name, c.input) === 'retrieval' ? 'retrieval' : 'effectful-action';
  if (visible.length === 1) {
    return { primaryClass: badgeClassOf(visible[0]), label: toolFriendlyLabel(visible[0].name) };
  }
  const classes = new Set(visible.map(badgeClassOf));
  const primaryClass: ToolBadgeClass = classes.size === 1 ? [...classes][0] : 'mixed';
  const label =
    primaryClass === 'retrieval' ? `${visible.length} lookups`
    : primaryClass === 'effectful-action' ? `${visible.length} actions`
    : `${visible.length} tools`;
  return { primaryClass, label };
}
