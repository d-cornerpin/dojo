// ════════════════════════════════════════
// Chat Visibility Taxonomy (single source of truth)
//
// ONE canonical classification consumed by BOTH the dashboard render
// (what shows in a chat bubble) and the engine (what gets a "you cannot
// see this" tag). Keeping it here in @dojo/shared is what stops the two
// sides from drifting. See DOJO-CHAT-VISIBILITY-PLAN.md (§2.3, §3, §3a).
//
// Three tiers:
//   user-visible : shown in the chat bubbles in REGULAR mode.
//   agent-only   : in the agent's context, shown ONLY in wordy mode.
//   never-shown  : not rendered in any mode (secrets, raw binary, the
//                  silent-turn sentinel).
//
// Wordy mode is a per-viewer DISPLAY FILTER. It never changes storage or
// what the agent sees. Default is regular mode.
// ════════════════════════════════════════

// Type-only import (erased at runtime, so no runtime cycle with origin.js,
// which imports parseInboundChannel from here). The classifier reads the
// structured MessageOrigin instead of re-parsing content markers.
import type { MessageOrigin, Channel } from './origin.js';

export type VisibilityTier = 'user-visible' | 'agent-only' | 'never-shown';

// How a classified message should be rendered. The dashboard maps each
// kind to a component; the engine ignores kind and reads only the tier.
export type DisplayKind =
  | 'user-text'                 // the user's own typed message
  | 'agent-text'                // the agent's reply text
  | 'inbound-channel'           // a channel-sourced inbound message (badge + stripped header)
  | 'outbound-routing-marker'   // [Reply routed via ...] (raw hidden, becomes a badge on the prior reply)
  | 'divider'                   // a lifecycle divider, e.g. New Session
  | 'memory-compaction-divider' // a compaction divider (agent-only)
  | 'no-reply-closed'           // the silent-turn close marker (never shown)
  | 'a2a'                       // inter-agent message (agent-only)
  | 'engine-injection'          // technique / nudge / context-gap / tracker-notif / tool-note
  | 'system-other'              // any other system message (agent-only)
  | 'tool-result'               // a role='tool' result (agent-only)
  | 'fallback';                 // engine fallback/ack text (agent-only)

export interface DisplayClassification {
  tier: VisibilityTier;
  kind: DisplayKind;
}

// Minimal structural shape both consumers can satisfy. The dashboard and
// server message objects each have at least these two fields.
export interface DisplayMessageInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /**
   * Optional message source. When `'a2a'`, the message was produced on a
   * dedicated inter-agent turn and the ENTIRE message (planning text AND tool
   * badges) is agent-only — the user never sees an A2A turn in regular mode.
   * Content-based classification can't detect this (a file_read tool_use looks
   * identical on a user turn vs. an A2A turn), so the engine stamps it at the
   * source and the dashboard passes it through.
   */
  source?: 'voice' | 'a2a' | null;
  /**
   * The canonical structured attribution (origin.ts deriveOrigin). When
   * present, the classifier reads THIS to decide visibility instead of
   * re-parsing `content` markers — a2a/engine/agent-only vs user-visible
   * falls straight out of `origin.kind`/`channel`. Server-fetched and
   * broadcast messages always carry it; locally-built optimistic/streaming
   * bubbles may not, and fall back to the legacy content path below.
   */
  origin?: MessageOrigin;
}

// A human message that physically arrived on one of these channels renders
// as a user-visible inbound badge (header stripped). dashboard/voice are the
// owner typing/speaking locally and render as plain user text.
function isInboundChannel(ch: Channel | null | undefined): boolean {
  return ch === 'imessage' || ch === 'teams' || ch === 'sms' || ch === 'email' || ch === 'phone';
}

// ════════════════════════════════════════
// Marker constants (the ONLY place these strings live)
// ════════════════════════════════════════

export type ChannelKind = 'imessage' | 'teams' | 'sms' | 'email' | 'phone';

// User-role content that is engine/coordination noise, hidden in regular
// mode. Inbound CHANNEL markers (iMessage/phone/Teams/SMS/email) are NOT
// in this list: they are user-visible (header stripped + a clean badge),
// handled by parseInboundChannel before these prefixes are checked.
export const HIDDEN_USER_CONTENT_PREFIXES: readonly string[] = [
  '[A2A:',
  '[SOURCE: AGENT MESSAGE FROM',
  '[SOURCE: PM AGENT POKE FROM',
  '[SOURCE: TRACKER TASK',
  '[SOURCE: SCHEDULER',
  '[SOURCE: HEALER',
  '[SOURCE: ENGINE',
  '[SOURCE: SUB-AGENT COMPLETION',
  '[SOURCE: SYSTEM',
  '[System:',
  '[CONTINUITY BRIEF',
  'Tracker review --',
];

// Engine injections that carry a visible-ish prefix. Hidden in regular.
export const ENGINE_INJECTION_PREFIXES: readonly string[] = [
  '[Engine hint:',
  '[Engine note:',
  '[System note:',
];

// Assistant text the engine produced on the agent's behalf (errors,
// continuity acks). Hidden in regular; the agent's real words are shown.
// These match the exact engine-emitted strings (the apology one is the
// specific failure message, NOT a bare "I'm sorry", so a genuine "I'm sorry
// to hear that" reply is never hidden). The em-dash here is data: it must
// match what the engine writes.
export const ASSISTANT_FALLBACK_PREFIXES: readonly string[] = [
  'I got stuck on that',
  "I'm sorry — I'm having trouble",
  'Understood, I have reviewed the continuity brief',
  'Understood, I have reviewed my background context',
];

// The literal the engine persists when the agent ends a turn silently.
export const NO_REPLY_CLOSED_MARKER =
  '[Agent ended turn without replying — conversation closed]';

// Inbound channel source markers, per channel. Capturing group 1 is the
// raw sender label where one exists.
const INBOUND_CHANNEL_RES: ReadonlyArray<{ channel: ChannelKind; re: RegExp }> = [
  { channel: 'imessage', re: /^\[SOURCE: IMESSAGE FROM ([^\]]+)\]/i },
  { channel: 'phone', re: /^\[SOURCE: PHONE CALL FROM ([^\]]+)\]/i },
  { channel: 'teams', re: /^\[SOURCE: TEAMS MESSAGE FROM ([^\]]+)\]/i },
  { channel: 'sms', re: /^\[SOURCE: SMS FROM ([^\]]+)\]/i },
  // SMS NOTIFICATION (unknown sender) and email notifications carry no
  // clean sender, so group 1 is optional / absent.
  { channel: 'sms', re: /^\[SOURCE: SMS NOTIFICATION\b[^\]]*\]/i },
  { channel: 'email', re: /^\[SOURCE: GMAIL NOTIFICATION\b[^\]]*\]/i },
  { channel: 'email', re: /^\[SOURCE: OUTLOOK NOTIFICATION\b[^\]]*\]/i },
];

// Outbound routing marker the engine writes after delivering a reply.
// Supports the current form ([Reply routed via X ...]) and the legacy
// iMessage form ([SENT VIA IMESSAGE to X]).
const OUTBOUND_ROUTING_RE =
  /^\[(?:SENT VIA IMESSAGE to (.+?)|Reply routed via (iMessage|Teams|email|phone call)([^\]]*))\]$/i;

// Lifecycle divider: the engine persists these as a system message shaped
// "── label ──" (box-drawing U+2500), e.g. "── New Session ──" or
// "── Memory Compacted ... ──" (server memory/compaction.ts + agent/tools.ts).
const DIVIDER_RE = /^──\s*(.+?)\s*──$/;

export interface InboundChannelMatch {
  channel: ChannelKind;
  sender: string | null;
}

// Structured inbound routing record (v3.0.9). The channel PRODUCER stamps this
// JSON onto the inbound message row (messages.inbound_meta) at injection
// time, so the engine routes the reply off reliable structured data instead
// of re-parsing the [SOURCE: ...] prose. The prose markers stay (the agent
// reads them; the dashboard badges off them) — but THIS is what decides
// where the reply goes. Re-wording a notification can no longer break
// routing, which is the recurring failure this design closes.
//
//   channel     — the channel the message physically arrived on. 'voice' is
//                 in-person dashboard speech; 'dashboard' is typed chat.
//   accountKind — the kind of account that RECEIVED it. 'agent' = the
//                 agent's own channel (auto-reply eligible). 'user' = a
//                 user-owned account the agent only monitors — never an
//                 auto-reply on the human's behalf, even from a safe sender.
//   authorized  — the producer's verdict (agent-kind + safe-sender) on
//                 whether this message earns an auto-reply. The engine
//                 trusts it: false => treat the turn as a dashboard
//                 notification (the agent reads it, decides, no auto-route).
export interface InboundMeta {
  channel: ChannelKind | 'dashboard' | 'voice';
  accountKind?: 'agent' | 'user';
  authorized?: boolean;
  sender?: string | null;
  /**
   * The sender's relationship to the owner, stamped by the producer when it
   * knows it (e.g. the iMessage bridge knows is_primary). Lets the origin
   * projection tell "the owner texting" from "a friend texting" without
   * re-deriving from scattered safe-sender state. (Union mirrors origin.ts
   * Relation; kept inline to avoid a shared-package import cycle.)
   */
  relation?: 'owner' | 'known_contact' | 'third_party' | 'agent' | 'engine';
  // Reply-addressing context (mirrors the server-side ChannelInboundContext).
  recipientAddress?: string;
  emailMessageId?: string;
  emailService?: 'gmail' | 'outlook';
  emailAccount?: string;
  emailSubject?: string;
  chatId?: string;
  chatType?: 'dm' | 'group';
  smsFromNumber?: string;
  smsToNumber?: string;
  phoneCallSid?: string;
  phoneFromNumber?: string;
}

export interface OutboundRoutingMatch {
  channel: ChannelKind;
  recipient: string | null;
}

// Trim a raw sender label down to a clean display name: cut at the first
// delimiter (comma, paren, dash, em-dash) and trim. Mirrors the prior
// dashboard extractIMessageSender behavior, centralized here.
export function cleanSenderLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cut = raw.split(/[(,—]|\s-\s/)[0]?.trim();
  return cut && cut.length > 0 ? cut : null;
}

// Parse an inbound channel marker at the start of a message. Returns the
// channel + a cleaned sender (null when the marker carries none, e.g. an
// email/SMS notification). This is the ONE inbound parser; it covers all
// five channels (the dashboard previously badged only iMessage + phone).
export function parseInboundChannel(content: string): InboundChannelMatch | null {
  const c = content.trimStart();
  for (const { channel, re } of INBOUND_CHANNEL_RES) {
    const m = c.match(re);
    if (m) return { channel, sender: cleanSenderLabel(m[1] ?? null) };
  }
  return null;
}

// Strip a leading inbound channel marker (and the phone call-context
// trailer) so the bubble shows just what the sender wrote.
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

// Parse an outbound routing marker (a standalone system message). Returns
// the channel + recipient where present. email markers carry no recipient.
export function parseOutboundRouting(content: string): OutboundRoutingMatch | null {
  const m = content.trim().match(OUTBOUND_ROUTING_RE);
  if (!m) return null;
  if (m[1] !== undefined) {
    // Legacy [SENT VIA IMESSAGE to X]
    return { channel: 'imessage', recipient: m[1].trim() || null };
  }
  const raw = (m[2] || 'imessage').toLowerCase();
  const channel: ChannelKind =
    raw === 'teams' ? 'teams' : raw === 'email' ? 'email' : raw === 'phone call' ? 'phone' : 'imessage';
  const tail = m[3] || '';
  let recipient: string | null = null;
  if (channel === 'imessage') recipient = tail.match(/to (.+)$/i)?.[1]?.trim() || null;
  else if (channel === 'teams') recipient = tail.match(/to chat (.+)$/i)?.[1]?.trim() || null;
  else if (channel === 'phone') recipient = tail.match(/to (.+)$/i)?.[1]?.trim() || null;
  // email intentionally shows no recipient ("sent via email reply")
  return { channel, recipient };
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
  // Compaction dividers are agent-only (wordy); "New Session" etc. stay
  // user-visible. Anchored to the start, matching the dashboard's check.
  return { label, isMemoryCompaction: /^Memory Compacted/i.test(label) };
}

function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

// ════════════════════════════════════════
// Message-level classifier
//
// Replaces the scattered content.startsWith('[SOURCE:...') pile that lived
// in Chat.tsx / AgentDetail.tsx / TechniqueBuilder.tsx. Returns the tier
// (engine + dashboard agree on this) and a render kind (dashboard only).
// ════════════════════════════════════════

export function classifyMessageForDisplay(msg: DisplayMessageInput): DisplayClassification {
  const content = msg.content ?? '';
  const trimmed = content.trim();
  const origin = msg.origin;

  if (msg.role === 'tool') {
    return { tier: 'agent-only', kind: 'tool-result' };
  }

  if (msg.role === 'system') {
    if (isNoReplyClosedMarker(content)) {
      return { tier: 'never-shown', kind: 'no-reply-closed' };
    }
    const divider = parseDivider(content);
    if (divider) {
      return divider.isMemoryCompaction
        ? { tier: 'agent-only', kind: 'memory-compaction-divider' }
        : { tier: 'user-visible', kind: 'divider' };
    }
    if (parseOutboundRouting(content)) {
      // Raw marker is hidden; the render turns it into a user-visible badge
      // on the preceding assistant reply.
      return { tier: 'agent-only', kind: 'outbound-routing-marker' };
    }
    return { tier: 'agent-only', kind: 'system-other' };
  }

  if (msg.role === 'user') {
    // ── Structured path (Phase 6): the message's origin decides visibility,
    // not a regex over its content. A2A (kind='agent') and engine events
    // (kind='engine') are agent-only; a human on a real inbound channel is a
    // user-visible badge; the owner on dashboard/voice is plain user text.
    // This is the same call the row mapper makes (deriveOrigin), so legacy
    // rows still attribute correctly via the read-shim there.
    if (origin) {
      if (origin.kind === 'agent') {
        return { tier: 'agent-only', kind: 'a2a' };
      }
      if (origin.kind === 'engine') {
        // tracker assignments kept their 'engine-injection' render kind; every
        // other engine event is 'system-other'. Both are agent-only — the kind
        // is only a wordy-mode render hint (the dashboard gates on tier alone).
        const kind: DisplayKind =
          origin.intent && origin.intent.startsWith('tracker') ? 'engine-injection' : 'system-other';
        return { tier: 'agent-only', kind };
      }
      // origin.kind === 'user' (or 'self', not expected on a user row).
      if (isInboundChannel(origin.channel)) {
        return { tier: 'user-visible', kind: 'inbound-channel' };
      }
      return { tier: 'user-visible', kind: 'user-text' };
    }

    // ── Legacy fallback (origin-less inputs: local optimistic/streaming
    // bubbles). Retired in Phase 7 once every surface carries origin. Mirrors
    // the pre-redesign content-marker pile exactly so behavior is unchanged.
    if (parseInboundChannel(content)) {
      return { tier: 'user-visible', kind: 'inbound-channel' };
    }
    if (trimmed.startsWith('[A2A:') || trimmed.startsWith('[SOURCE: AGENT MESSAGE FROM')) {
      return { tier: 'agent-only', kind: 'a2a' };
    }
    if (trimmed.startsWith('[SOURCE:')) {
      const kind: DisplayKind = trimmed.startsWith('[SOURCE: TRACKER TASK')
        ? 'engine-injection'
        : 'system-other';
      return { tier: 'agent-only', kind };
    }
    if (startsWithAny(trimmed, ENGINE_INJECTION_PREFIXES)) {
      return { tier: 'agent-only', kind: 'engine-injection' };
    }
    if (startsWithAny(trimmed, HIDDEN_USER_CONTENT_PREFIXES)) {
      return { tier: 'agent-only', kind: 'system-other' };
    }
    return { tier: 'user-visible', kind: 'user-text' };
  }

  // assistant
  // A2A-turn output is entirely agent-only — both planning text and tool
  // badges — so an inter-agent turn never surfaces in regular mode. Wordy
  // mode still renders it. origin.channel==='a2a' is the structured signal;
  // msg.source==='a2a' covers streaming bubbles that predate the broadcast.
  if (origin?.channel === 'a2a' || msg.source === 'a2a') {
    return { tier: 'agent-only', kind: 'a2a' };
  }
  // Engine-emitted assistant fallback text (errors, continuity acks) is
  // hidden. deriveOrigin marks all assistant output kind='self', so origin
  // can't see this — the prefix match stays. (The agent's real words show.)
  if (startsWithAny(trimmed, ASSISTANT_FALLBACK_PREFIXES)) {
    return { tier: 'agent-only', kind: 'fallback' };
  }
  return { tier: 'user-visible', kind: 'agent-text' };
}

// ════════════════════════════════════════
// Tool classifier
//
// Four display classes (the RESULT of any tool is always agent-only; these
// govern only what shows in REGULAR mode):
//   effectful-action : did something in the world / sent something out -> badge.
//   retrieval        : read / searched, no world change -> subtle badge, data wordy.
//   bookkeeping      : internal machinery (memory, tracker, coordination) -> hidden.
//   delivery         : show_to_user, the one primitive that renders content visibly.
//
// Precedence: overrides, then bookkeeping membership, then retrieval verb,
// then effectful verb, then default to bookkeeping (safe: hidden). New
// tools classify automatically by verb; only genuine exceptions need an
// override. The split here matches DOJO-CHAT-VISIBILITY-PLAN.md §3a.
// ════════════════════════════════════════

export type ToolDisplayClass = 'effectful-action' | 'retrieval' | 'bookkeeping' | 'delivery';

// Exceptions the verb heuristic gets wrong.
const TOOL_OVERRIDES: Readonly<Record<string, ToolDisplayClass>> = {
  show_to_user: 'delivery',
  // a2a + sub-agent coordination: agent-only, never a user badge.
  send_to_agent: 'bookkeeping',
  broadcast_to_group: 'bookkeeping',
  spawn_agent: 'bookkeeping',
  kill_agent: 'bookkeeping',
  // internal conversion of the user's own input.
  transcribe_audio: 'bookkeeping',
  // effectful but the verb token is not in the list.
  exec: 'effectful-action',
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

// Tool-name prefixes that are always bookkeeping (internal stores,
// coordination, tracker, techniques, credentials, contacts, admin).
const BOOKKEEPING_PREFIXES: readonly string[] = [
  'scratchpad_',
  'vault_',
  'memory_',
  'recall_',
  'squad_',
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

// Technique tools that do not share a clean prefix.
const BOOKKEEPING_EXACT: ReadonlySet<string> = new Set([
  'use_technique',
  'save_technique',
  'list_techniques',
  'publish_technique',
  'update_technique',
  'submit_technique_for_review',
  'delete_technique',
]);

// Verb tokens (after splitting the name on '_'). Effectful checked before
// retrieval so that a world-changing act wins when both appear.
const EFFECTFUL_VERBS: ReadonlySet<string> = new Set([
  'send', 'reply', 'forward',
  'create', 'write', 'edit', 'append', 'insert', 'replace', 'update',
  'delete', 'remove', 'patch',
  'upload', 'share', 'move',
  'add', 'set', 'populate', 'duplicate', 'reorder', 'resize', 'rename',
  'layout', 'style',
  'call', 'run', 'finalize',
  'respond', 'accept', 'subscribe', 'unsubscribe',
  'start', 'stop', 'restart', 'end',
]);

const RETRIEVAL_VERBS: ReadonlySet<string> = new Set([
  'read', 'list', 'search', 'get', 'inbox', 'agenda', 'fetch', 'browse', 'outline',
]);

export function classifyTool(name: string): ToolDisplayClass {
  const override = TOOL_OVERRIDES[name];
  if (override) return override;

  if (BOOKKEEPING_EXACT.has(name)) return 'bookkeeping';
  if (BOOKKEEPING_PREFIXES.some((p) => name.startsWith(p))) return 'bookkeeping';

  const tokens = name.split('_');
  // Retrieval first: an explicit read verb (get/read/list/search/...) wins over
  // a soft mutation token, so e.g. slides_get_style reads (retrieval) while
  // slides_set_style / slides_style_text_range mutate (effectful).
  if (tokens.some((t) => RETRIEVAL_VERBS.has(t))) return 'retrieval';
  if (tokens.some((t) => EFFECTFUL_VERBS.has(t))) return 'effectful-action';

  // Unknown / verb-less: hide it (safe default). V5 adds a test that every
  // tool in tools/categories.ts classifies, flagging anything that lands here.
  return 'bookkeeping';
}

// The tier a tool's BADGE occupies in regular mode. (The tool's raw call +
// result are always agent-only / wordy regardless.)
export function toolBadgeTier(cls: ToolDisplayClass): VisibilityTier {
  // effectful-action, retrieval, and delivery all surface something in
  // regular mode; bookkeeping is hidden.
  return cls === 'bookkeeping' ? 'agent-only' : 'user-visible';
}

// Map a channel-send tool to its channel kind, for the outbound badge.
export function channelOfSendTool(name: string): ChannelKind | null {
  if (name === 'imessage_send') return 'imessage';
  if (name === 'teams_send_message') return 'teams';
  if (name === 'sms_send') return 'sms';
  if (name === 'gmail_send' || name === 'gmail_reply' || name === 'gmail_forward') return 'email';
  if (name === 'outlook_send' || name === 'outlook_reply' || name === 'outlook_forward') return 'email';
  if (name === 'voice_call') return 'phone';
  return null;
}
