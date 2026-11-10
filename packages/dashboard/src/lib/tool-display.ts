// Friendly presentation for tool calls in regular chat mode. classifyTool (@dojo/shared) decides
// the display class; this maps a tool to a friendly badge phrase. Bookkeeping tools are hidden
// in regular mode (the agent restates what matters) so they get no label; the long tail falls back.
import { classifyTool } from '@dojo/shared';

// COSMETIC map, not exhaustive: toolFriendlyLabel() falls back to a humanized tool name, and a
// conformance test asserts every key here is a real tool.
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
// A generic runner's raw name hides the operation, so the pill derives one from the args (exec
// -> base command, applescript_run -> the app). Pill-only cosmetics: the expanded detail shows
// the true name, and unreadable payloads fall back to the name so the label never lies.

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
    // A flagged sudo's options can take arguments, so only a clean `sudo cmd` relabels.
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

// The pill text: tool name for most tools, a payload-derived label for generic runners.
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

export interface ToolTurnCall {
  name: string;
  input?: Record<string, unknown>;
}

// Pass the whole call to classifyTool: work_open is effectful only with a reminder-shaped
// input, the rest are bookkeeping; a name-only call would hide reminder turns from badges.
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
