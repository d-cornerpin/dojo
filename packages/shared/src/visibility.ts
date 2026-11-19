// Chat visibility taxonomy: one classification for the dashboard render and the engine, so they agree.
// Tiers: user-visible (regular mode), agent-only (wordy mode only), never-shown (secrets, silent sentinel).
// Wordy mode is a per-viewer display filter; it never changes storage or what the agent sees.

// Type-only import: erased at runtime, so no cycle with origin.js (which imports from here).
import type { MessageOrigin } from './origin.js';

import { A2A_ENVELOPE_PREFIX, A2A_INBOUND_RE, ENGINE_INJECTION_PREFIXES,
  SOURCE_ENVELOPE_PREFIXES } from './markers.js';

export const DISPLAY_TIERS = ['user-visible', 'agent-only', 'never-shown'] as const;
export type VisibilityTier = (typeof DISPLAY_TIERS)[number];

// What `messages.display_kind` may hold (a schema CHECK mirrors it); facts other columns carry get no kind.
// `unclassified` is the column DEFAULT so a legacy INSERT that bypasses the writer still persists.
export const DISPLAY_KINDS = [
  'user-text',        // a person speaking, on any channel
  'agent-text',       // the agent's own reply
  'tool-turn',        // an assistant row of tool_use blocks, or its role='tool' result
  'working-note',     // demoted mid-work narration ([working-note] / :internal)
  'divider',          // a lifecycle divider, "── label ──"
  'routing-marker',   // [Reply routed via ...] raw hidden, rendered as a badge
  'owner-alert',      // an allowlisted plain-language heads-up FOR THE OWNER
  'engine-note',      // platform coordination: steers, [SOURCE:] envelopes, engine events
  'a2a',              // peer traffic, either direction
  'no-reply-marker',  // the silent-turn close marker
  'fallback',         // text the ENGINE composed and signed as the agent
  'unclassified',     // fail-open default; never written by the writer module
] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];

export type MessageLane = 'owner' | 'a2a' | 'events';

export interface DisplayClassification {
  tier: VisibilityTier;
  kind: DisplayKind;
}

export interface DisplayMessageInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** The row's stored lane, when known; a lane can only LOWER visibility (see the clamp below). */
  lane?: MessageLane;
  /** On an owner-lane assistant row, `origin_intent` means the engine composed the words (`fallback`). */
  originIntent?: string | null;
  /** `'a2a'`: an inter-agent turn, wholly agent-only. The engine stamps it; content cannot show it. */
  source?: 'voice' | 'a2a' | null;
  /** Structured attribution (deriveOrigin); when absent (optimistic bubbles) the content path answers. */
  origin?: MessageOrigin;
}



export type ChannelKind = 'imessage' | 'teams' | 'sms' | 'email' | 'phone';

// Engine noise in user-role content, hidden in regular mode. Inbound CHANNEL markers are not listed:
// parseInboundChannel handles them first. Shapes come from `markers.ts`.
export const HIDDEN_USER_CONTENT_PREFIXES: readonly string[] = [
  ...SOURCE_ENVELOPE_PREFIXES,
  A2A_ENVELOPE_PREFIX,
  '[System:',
  '[CONTINUITY BRIEF',
  'Tracker review --',
];

export { ENGINE_INJECTION_PREFIXES };

// Engine-written assistant text, hidden in regular mode. Exact strings only: a bare "I'm sorry" would hide
// real replies. The em-dash there is data.
export const ASSISTANT_FALLBACK_PREFIXES: readonly string[] = [
  'I got stuck on that',
  "I'm sorry — I'm having trouble",
  'Understood, I have reviewed the continuity brief',
  'Understood, I have reviewed my background context',
];

// The literal the engine persists when the agent ends a turn silently. Writer and readers import this one
// constant; never spell the string elsewhere (the em-dash is data).
export const NO_REPLY_CLOSED_MARKER =
  '[Agent ended turn without replying — conversation closed]';

// The `[no-reply]` sentinel the AGENT emits: whole message, tail, or mid-text, markdown wrappers tolerated.
const NO_REPLY_SENTINEL_BODY = String.raw`[\`*_]*\s*\[no[-_]?reply\]\s*[\`*_]*`;
export const NO_REPLY_BARE_RE = new RegExp(`^\\s*${NO_REPLY_SENTINEL_BODY}\\s*$`, 'i');
export const NO_REPLY_TAIL_RE = new RegExp(`\\s*${NO_REPLY_SENTINEL_BODY}\\s*$`, 'i');

export function isBareNoReplySentinel(text: string): boolean {
  return NO_REPLY_BARE_RE.test(text ?? '');
}

export function stripNoReplySentinel(text: string): string {
  if (!text) return text;
  // A mark between two words leaves one space, so "word[no-reply]word" does not glue.
  return text.replace(new RegExp(`\\s*${NO_REPLY_SENTINEL_BODY}\\s*`, 'gi'), (m, at: number, whole: string) =>
    /\w/.test(whole[at - 1] ?? '') && /\w/.test(whole[at + m.length] ?? '') ? ' ' : '');
}

// `((mood: NAME))` leads a reply and animates the orb; it is stripped before display or speech.
export const MOOD_MARKER_SOURCE = String.raw`\(\(\s*mood\s*:\s*[a-z]+\s*\)\)`;

export function parseMoodMarker(text: string): string | null {
  if (!text) return null;
  let last: string | null = null;
  for (const m of text.matchAll(new RegExp(MOOD_MARKER_SOURCE, 'gi'))) {
    last = m[0].replace(/\(\(\s*mood\s*:\s*/i, '').replace(/\s*\)\)$/, '').trim().toLowerCase();
  }
  return last;
}

export function stripMoodMarker(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(MOOD_MARKER_SOURCE, 'gi'), '').trim();
}

// Working notes: tool-call narration that already streamed live, demoted in place to a dimmed system row.
export const WORKING_NOTE_PREFIX = '[working-note] ';
export const INTERNAL_WORKING_NOTE_PREFIX = '[working-note:internal] ';

export interface WorkingNoteMatch {
  text: string;
  internal: boolean;
}

export function parseWorkingNote(content: string): WorkingNoteMatch | null {
  if (content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)) {
    return { text: content.slice(INTERNAL_WORKING_NOTE_PREFIX.length), internal: true };
  }
  if (content.startsWith(WORKING_NOTE_PREFIX)) {
    return { text: content.slice(WORKING_NOTE_PREFIX.length), internal: false };
  }
  return null;
}

// Owner alerts: plain-language heads-ups posted into the primary chat FOR THE OWNER. CONTRACT: each server
// write site prefixes its note with one of these exact strings taken from here. The PROJECT_ATTENTION
// prefix has no writer but stays as a classifier key so existing rows render without a raw tag (Chat.tsx).
export const OWNER_ALERT_HEADS_UP_PREFIX = 'Heads up:';
export const OWNER_ALERT_PROJECT_ATTENTION_PREFIX = '[tracker:project_needs_attention]';
export const OWNER_ALERT_DOJO_PREFIX = 'Dojo:';   // an engine message that stays because the agent cannot act: plainly the Dojo, never the agent's voice
export const OWNER_ALERT_SYSTEM_PREFIXES: readonly string[] = [
  OWNER_ALERT_HEADS_UP_PREFIX,
  OWNER_ALERT_DOJO_PREFIX,
  OWNER_ALERT_PROJECT_ATTENTION_PREFIX,
];

export function stripSourceEnvelope(content: string): string {
  return content.replace(/^\[SOURCE:[^\]]*\]\s*/, '');
}

export function isOwnerAlertSystemNote(content: string): boolean {
  const body = stripSourceEnvelope(content.trim());
  return OWNER_ALERT_SYSTEM_PREFIXES.some((prefix) => body.startsWith(prefix));
}

// Lifecycle dividers: "── label ──" (U+2500); writer and `parseDivider` share this shape.
export function formatDivider(label: string): string {
  return `── ${label} ──`;
}
export const NEW_SESSION_DIVIDER_LABEL = 'New Session';
export const NEW_SESSION_DIVIDER = formatDivider(NEW_SESSION_DIVIDER_LABEL);

const INBOUND_CHANNEL_RES: ReadonlyArray<{ channel: ChannelKind; re: RegExp }> = [
  { channel: 'imessage', re: /^\[SOURCE: IMESSAGE FROM ([^\]]+)\]/i },
  { channel: 'phone', re: /^\[SOURCE: PHONE CALL FROM ([^\]]+)\]/i },
  { channel: 'teams', re: /^\[SOURCE: TEAMS MESSAGE FROM ([^\]]+)\]/i },
  { channel: 'sms', re: /^\[SOURCE: SMS FROM ([^\]]+)\]/i },
  { channel: 'sms', re: /^\[SOURCE: SMS NOTIFICATION\b[^\]]*\]/i },
  { channel: 'email', re: /^\[SOURCE: GMAIL NOTIFICATION\b[^\]]*\]/i },
  { channel: 'email', re: /^\[SOURCE: OUTLOOK NOTIFICATION\b[^\]]*\]/i },
];

// Outbound routing marker: the current form and the legacy iMessage form, for every reply channel.
const OUTBOUND_ROUTING_RE =
  /^\[(?:SENT VIA IMESSAGE to (.+?)|Reply routed via (iMessage|Teams|email|phone call|SMS)([^\]]*))\]$/i;

const DIVIDER_RE = /^──\s*(.+?)\s*──$/;

export interface InboundChannelMatch {
  channel: ChannelKind;
  sender: string | null;
}

// Structured inbound routing record, stamped by the channel producer onto messages.inbound_meta. The engine
// routes the reply off this, not the [SOURCE: ...] prose, so rewording a notification cannot break routing.
// accountKind 'user' is monitored only, never auto-replied; authorized is the producer's auto-reply verdict.
export interface InboundMeta {
  channel: ChannelKind | 'dashboard' | 'voice';
  accountKind?: 'agent' | 'user';
  authorized?: boolean;
  sender?: string | null;
  senderName?: string;   // a Teams sender's display name, for the badge (the model reads it inside the fence only)
  /** Sender's relationship to the owner. Mirrors origin.ts Relation, inline to avoid an import cycle. */
  relation?: 'owner' | 'known_contact' | 'third_party' | 'agent' | 'engine';
  senderIsAgent?: boolean;
  // Reply-addressing context (mirrors the server-side ChannelInboundContext).
  recipientAddress?: string;
  emailMessageId?: string;
  emailService?: 'gmail' | 'outlook';
  emailAccount?: string;
  emailSubject?: string;
  chatId?: string;
  chatType?: 'dm' | 'group';
  /** The Teams work account the message came to; the reply goes from the same one. */
  teamsAccount?: string;
  smsFromNumber?: string;
  smsToNumber?: string;
  phoneCallSid?: string;
  phoneFromNumber?: string;
  /** Who an email went to, from the provider's recipient headers or fields, never the (forgeable) body;
   *  `authenticationResults` are the provider's own header values, unparsed. */
  mailAddressing?: { to: Array<{ address: string; display: string | null }>; cc: Array<{ address: string; display: string | null }>; placement: 'to' | 'cc' | 'neither'; authenticationResults: string[] };
  /** The owner's NEW words in an email the provider confirmed as theirs; set only by mail watchers. */
  ownerWords?: string;
  /** When the PROVIDER received it (ms), never the sender-written Date; words must not predate the ask. */
  ownerWordsAt?: number;
}

/** Where a reply stands when it is not simply delivered: waiting to go, failed for good, or dropped by Stop. */
export type RoutingState = 'sending' | 'not delivered' | 'not sent';

export interface OutboundRoutingMatch {
  channel: ChannelKind;
  recipient: string | null;
  state: { kind: RoutingState; reason: string | null } | null;
}

/** Written only by the reply sender's pill writer. The label is "<channel> to <recipient>" ("iMessage to Sam"),
 *  then an optional state from `withRoutingState`; a delivered reply carries none. */
export function formatRoutingMarker(label: string): string {
  return `[Reply routed via ${label}]`;
}

/** "<label> (<state>: <reason>)"; the reason is cut short and kept free of the marker's own brackets. */
export function withRoutingState(label: string, kind: RoutingState, reason?: string | null): string {
  const why = (reason ?? '').replace(/[[\]()\s]+/g, ' ').trim().slice(0, 80);
  return `${label} (${kind}${why ? `: ${why}` : ''})`;
}

export function cleanSenderLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cut = raw.split(/[(,—]|\s-\s/)[0]?.trim();
  return cut && cut.length > 0 ? cut : null;
}

export function parseInboundChannel(content: string): InboundChannelMatch | null {
  const c = content.trimStart();
  for (const { channel, re } of INBOUND_CHANNEL_RES) {
    const m = c.match(re);
    if (m) return { channel, sender: cleanSenderLabel(m[1] ?? null) };
  }
  return null;
}

const PHONE_TRAILER_RE =
  /\n+Call SID:\s*\S+(?:\n(?:To|Direction|Voicemail|Disclosures|Their Name|Purpose|Callback):\s*[^\n]*)*\s*$/;

export function stripInboundChannelMarker(content: string): string {
  let out = content;
  for (const { re } of INBOUND_CHANNEL_RES) {
    if (re.test(out.trimStart())) {
      out = out.replace(re, '').replace(/^\s+/, '');
      break;
    }
  }
  return out.replace(PHONE_TRAILER_RE, '').trim();
}

// An email reply marker carrying a subject instead of an address has no "to <addr>" tail, so its recipient
// stays null and the badge shows the channel only.
export function parseOutboundRouting(content: string): OutboundRoutingMatch | null {
  const m = content.trim().match(OUTBOUND_ROUTING_RE);
  if (!m) return null;
  if (m[1] !== undefined) {
    return { channel: 'imessage', recipient: m[1].trim() || null, state: null };
  }
  const raw = (m[2] || 'imessage').toLowerCase();
  const channel: ChannelKind =
    raw === 'teams' ? 'teams'
    : raw === 'email' ? 'email'
    : raw === 'phone call' ? 'phone'
    : raw === 'sms' ? 'sms'
    : 'imessage';
  const st = (m[3] || '').match(/\s\((sending|not delivered|not sent)(?::\s*([^)]*))?\)$/i);
  const tail = (m[3] || '').slice(0, st?.index);
  // Teams stamps "to chat <id>", others "to <recipient>"; the non-Teams match is anchored to the tail start
  // so a "to " inside an email subject is never mistaken for a recipient.
  const recipient =
    channel === 'teams'
      ? tail.match(/to chat (.+)$/i)?.[1]?.trim() || null
      : tail.match(/^\s*to (.+)$/i)?.[1]?.trim() || null;
  const state = st ? { kind: st[1].toLowerCase() as RoutingState, reason: st[2]?.trim() || null } : null;
  return { channel, recipient, state };
}

export function isNoReplyClosedMarker(content: string): boolean {
  return content.trim() === NO_REPLY_CLOSED_MARKER;
}

export interface DividerMatch {
  label: string;
  isMemoryCompaction: boolean;
}

export function parseDivider(content: string): DividerMatch | null {
  const m = content.trim().match(DIVIDER_RE);
  if (!m) return null;
  const label = m[1].trim();
  // Compaction dividers are agent-only; anchored to the start to match the dashboard's own check (Chat.tsx).
  return { label, isMemoryCompaction: /^Memory Compacted/i.test(label) };
}

function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

// Message-level classifier. The write side passes `lane`/`originIntent` (facts it stamps); the read side
// passes `origin`, or nothing for a local streaming bubble, and the content path answers. Same answer.
// Precedence: a2a (lane, origin.channel or source) whatever it looks like; role='tool'; role='system' (marker
// family, most specific first); lane='events'; role user/assistant. Last, an events-lane row is clamped
// below user-visible (visibility is earned).

export function classifyMessageForDisplay(msg: DisplayMessageInput): DisplayClassification {
  const out = classifyInner(msg);
  if (msg.lane === 'events' && out.tier === 'user-visible') {
    return { tier: 'agent-only', kind: out.kind };
  }
  return out;
}

function classifyInner(msg: DisplayMessageInput): DisplayClassification {
  const content = msg.content ?? '';
  const trimmed = content.trim();
  const origin = msg.origin;

  if (msg.lane === 'a2a' || origin?.channel === 'a2a' || msg.source === 'a2a') {
    return { tier: 'agent-only', kind: 'a2a' };
  }

  if (msg.role === 'tool') {
    return { tier: 'agent-only', kind: 'tool-turn' };
  }

  if (msg.role === 'system') {
    if (isNoReplyClosedMarker(content)) {
      return { tier: 'never-shown', kind: 'no-reply-marker' };
    }
    const note = parseWorkingNote(trimmed);
    if (note) {
      return { tier: note.internal ? 'agent-only' : 'user-visible', kind: 'working-note' };
    }
    const divider = parseDivider(content);
    if (divider) {
      return { tier: divider.isMemoryCompaction ? 'agent-only' : 'user-visible', kind: 'divider' };
    }
    if (parseOutboundRouting(content)) {
      return { tier: 'agent-only', kind: 'routing-marker' };
    }
    if (isOwnerAlertSystemNote(trimmed)) {
      return { tier: 'user-visible', kind: 'owner-alert' };
    }
    return { tier: 'agent-only', kind: 'engine-note' };
  }

  // A platform row, checked before the role branches because insertEngineEvent writes role='user'.
  // An owner-alert prefix here is not an owner alert: scheduler "Heads up:" notes ride postAgentNotice so
  // the primary relays them. Real owner alerts are owner-lane role='system' rows (destructive-gate.ts).
  if (msg.lane === 'events') {
    return { tier: 'agent-only', kind: 'engine-note' };
  }

  if (msg.role === 'user') {
    // No user-role A2A branch: new traffic is lane='a2a'/'events' (the chat view is `WHERE lane='owner'`) and
    // legacy pre-cutover A2A rows are filtered by `retired_at IS NULL` in the serving routes.
    if (origin) {
      if (origin.kind === 'engine') {
        return { tier: 'agent-only', kind: 'engine-note' };
      }
      // Unauthorized human inbound (a mailbox notification, an unknown sender) is a PERSON speaking, but has
      // not earned the tier: the agent surfaces it only if it matters.
      if (origin.authorized === false) {
        return { tier: 'agent-only', kind: 'user-text' };
      }
      return { tier: 'user-visible', kind: 'user-text' };
    }

    // Fallback for origin-less inputs (local optimistic/streaming bubbles): the content-marker path.
    if (parseInboundChannel(content)) {
      return { tier: 'user-visible', kind: 'user-text' };
    }
    if (A2A_INBOUND_RE.test(trimmed)) {
      return { tier: 'agent-only', kind: 'a2a' };
    }
    if (
      trimmed.startsWith('[SOURCE:')
      || startsWithAny(trimmed, ENGINE_INJECTION_PREFIXES)
      || startsWithAny(trimmed, HIDDEN_USER_CONTENT_PREFIXES)
    ) {
      return { tier: 'agent-only', kind: 'engine-note' };
    }
    return { tier: 'user-visible', kind: 'user-text' };
  }

  // deriveOrigin marks all assistant output kind='self', so only this prefix match sees engine fallback.
  if (startsWithAny(trimmed, ASSISTANT_FALLBACK_PREFIXES)) {
    return { tier: 'agent-only', kind: 'fallback' };
  }
  // Engine-composed text signed as the agent: the kind changes, the tier stays user-visible. A writer whose
  // row is not engine-composed (the start-ack) declares `displayKind` (memory/message-store.ts).
  if (msg.originIntent) {
    return { tier: 'user-visible', kind: 'fallback' };
  }
  if (trimmed.startsWith('[{') && trimmed.includes('"tool_use"')) {
    return { tier: toolTurnTier(trimmed), kind: 'tool-turn' };
  }
  return { tier: 'user-visible', kind: 'agent-text' };
}

// Tool classifier. Classes govern only what shows in regular mode (a tool RESULT is always agent-only):
// effectful-action and retrieval get a badge, delivery renders content, bookkeeping is hidden.
// Precedence: overrides, bookkeeping membership, retrieval verb, effectful verb, then bookkeeping.

// The one work-verb discriminator that changes a display class. `@dojo/shared` cannot import the server's
// tools/work-verbs.ts (the dependency runs the other way); this reads the same `kind` and `what`/`when`.
const WORK_VERB_NAMES: ReadonlySet<string> = new Set([
  'work_open', 'work_update', 'work_note', 'work_close_request', 'work_validate', 'work_schedule',
]);

function workDisplayOp(name: string, args?: Record<string, unknown>): string {
  if (name !== 'work_open') return name;
  const kind = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase() : null;
  if (kind) return `work_open:${kind}`;
  if (args?.what !== undefined || args?.when !== undefined) return 'work_open:reminder';
  return 'work_open:other';
}

export type ToolDisplayClass = 'effectful-action' | 'retrieval' | 'bookkeeping' | 'delivery';

const TOOL_OVERRIDES: Readonly<Record<string, ToolDisplayClass>> = {
  show_to_user: 'delivery',
  send_to_agent: 'bookkeeping',
  broadcast_to_group: 'bookkeeping',
  spawn_agent: 'bookkeeping',
  kill_agent: 'bookkeeping',
  transcribe_audio: 'bookkeeping',
  // effectful but the verb token is not in the list (exec, and the two that type and click on the screen).
  exec: 'effectful-action',
  keyboard_type: 'effectful-action', mouse_click: 'effectful-action',
  // `shell` is `exec`'s other half; engine sites read this class, so it counts as real work like exec.
  shell: 'effectful-action',
  // The right-dock views render content visibly, so `delivery`; `effectful-action` would count them as work.
  canvas_render: 'delivery',
  open_browser: 'delivery',
  // 'list'/'add'/'call'/'get' tokens would misfire; these are internal.
  add_safe_sender: 'bookkeeping',
  imessage_list_contacts: 'bookkeeping',
  voice_call_status: 'bookkeeping',
  list_agents: 'bookkeeping',
  list_groups: 'bookkeeping',
  list_models: 'bookkeeping',
  get_agent_profile: 'bookkeeping',
  get_group_detail: 'bookkeeping',
  get_current_time: 'bookkeeping',
  cost_summary: 'bookkeeping',
  channel_inspect: 'bookkeeping',
  complete_task: 'bookkeeping',
  load_tool_docs: 'bookkeeping',
  approve_destructive_action: 'bookkeeping',
  convert_time: 'bookkeeping',
  reset_session: 'bookkeeping',
  set_user_presence: 'bookkeeping',
  dreamer_run_now: 'bookkeeping',
};

const BOOKKEEPING_PREFIXES: readonly string[] = [
  'scratchpad_',
  'vault_',
  'memory_',
  'recall_',
  'squad_',
  // `work_` is load-bearing: a work_* name outside WORK_VERB_NAMES would otherwise take a verb class.
  'work_',
  // `tracker_` is kept: persisted tool_use blocks carry it and the dashboard re-classifies them on render.
  'tracker_',
  'credential_',
  'contact_',
  'contacts_',
  'technique_',
  'healer_',
  'tunnel_',
  'update_agent',
  'update_group',
  'create_agent_group',
  'assign_to_group',
  'delete_group',
];

const BOOKKEEPING_EXACT: ReadonlySet<string> = new Set([
  'use_technique',
  'save_technique',
  'list_techniques',
  'publish_technique',
  'update_technique',
  'submit_technique_for_review',
  'delete_technique',
]);

// Verb tokens (name split on '_'). Retrieval beats effectful (slides_get_style reads); `mark` goes first.
const EFFECTFUL_VERBS: ReadonlySet<string> = new Set([
  'send', 'reply', 'forward',
  // `draft` writes into the owner's Drafts folder, so it counts as real work.
  'draft',
  'create', 'write', 'edit', 'append', 'insert', 'replace', 'update',
  'delete', 'remove', 'patch',
  'upload', 'share', 'move',
  'add', 'set', 'populate', 'duplicate', 'reorder', 'resize', 'rename',
  'layout', 'style',
  'call', 'run', 'finalize',
  'respond', 'accept', 'subscribe', 'unsubscribe',
  'start', 'stop', 'restart', 'end',
  'label', 'archive', 'trash', 'untrash', 'spam', 'star', 'unstar', 'flag', 'mark',
  'modify', 'batch',
]);

const RETRIEVAL_VERBS: ReadonlySet<string> = new Set([
  'read', 'list', 'search', 'get', 'inbox', 'agenda', 'fetch', 'browse', 'outline',
]);

/** The one work operation that is not bookkeeping: setting a reminder (`work_open` with `what`/`when`) is
 *  effectful. A caller passing no arguments gets the safe answer, bookkeeping. */
const WORK_OP_DISPLAY_CLASS: Readonly<Record<string, ToolDisplayClass>> = {
  'work_open:reminder': 'effectful-action',
};

export function classifyTool(name: string, args?: Record<string, unknown>): ToolDisplayClass {
  const override = TOOL_OVERRIDES[name];
  if (override) return override;

  if (WORK_VERB_NAMES.has(name)) {
    return WORK_OP_DISPLAY_CLASS[workDisplayOp(name, args)] ?? 'bookkeeping';
  }

  if (BOOKKEEPING_EXACT.has(name)) return 'bookkeeping';
  if (BOOKKEEPING_PREFIXES.some((p) => name.startsWith(p))) return 'bookkeeping';

  const tokens = name.split('_');
  if (tokens.includes('mark')) return 'effectful-action'; // outlook_mark_read sets a flag, fetches nothing
  if (tokens.some((t) => RETRIEVAL_VERBS.has(t))) return 'retrieval';
  if (tokens.some((t) => EFFECTFUL_VERBS.has(t))) return 'effectful-action';

  return 'bookkeeping';
}

export function toolBadgeTier(cls: ToolDisplayClass): VisibilityTier {
  return cls === 'bookkeeping' ? 'agent-only' : 'user-visible';
}

// The row tier folds its blocks so the stored `display_tier` agrees with the dashboard's chip filter:
// the same `toolBadgeTier(classifyTool(name, input))`, arguments included. A block that is not `tool_use`
// is not governed by that filter, so it keeps the row `user-visible`.
function toolTurnTier(rawBlocks: string): VisibilityTier {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlocks);
  } catch {
    return 'user-visible';   // unparseable: fail toward showing it, never toward hiding
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return 'user-visible';
  for (const block of parsed) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown } | null;
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') return 'user-visible';
    const args = b.input as Record<string, unknown> | undefined;
    if (toolBadgeTier(classifyTool(b.name, args)) === 'user-visible') return 'user-visible';
  }
  return 'agent-only';
}

/** One row per tool that reaches people on an owner channel, by base name: its channel, and whether a call sends
 *  something. The contact list, the call status and the hang-up keep their channel but are not sends. */
export interface PeopleTool { readonly channel: ChannelKind; readonly sends: boolean }
const on = (channel: ChannelKind, sends = true): PeopleTool => ({ channel, sends });
export const PEOPLE_TOOLS: ReadonlyMap<string, PeopleTool> = new Map<string, PeopleTool>([
  ['imessage_send', on('imessage')], ['imessage_list_contacts', on('imessage', false)],
  ['sms_send', on('sms')],
  ['teams_send_message', on('teams')], ['teams_send_channel_message', on('teams')],
  ['gmail_send', on('email')], ['gmail_reply', on('email')], ['gmail_forward', on('email')],
  ['outlook_send', on('email')], ['outlook_reply', on('email')], ['outlook_forward', on('email')],
  ['voice_call', on('phone')], ['voice_call_end', on('phone', false)], ['voice_call_status', on('phone', false)],
]);

/** The row for a tool or its `user_` twin (a twin runs its base tool's executor), or null. */
export function peopleToolOf(name: string): PeopleTool | null {
  return PEOPLE_TOOLS.get(name.startsWith('user_') ? name.slice('user_'.length) : name) ?? null;
}

export function channelOfSendTool(name: string): ChannelKind | null {
  const tool = peopleToolOf(name);
  return tool?.sends ? tool.channel : null;
}
