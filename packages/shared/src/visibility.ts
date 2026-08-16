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
import type { MessageOrigin } from './origin.js';

import { A2A_ENVELOPE_PREFIX, A2A_INBOUND_RE, ENGINE_INJECTION_PREFIXES,
  SOURCE_ENVELOPE_PREFIXES } from './markers.js';

export const DISPLAY_TIERS = ['user-visible', 'agent-only', 'never-shown'] as const;
export type VisibilityTier = (typeof DISPLAY_TIERS)[number];

// PHASE-1 T8 — the storage vocabulary of 17 §C1, and the ONLY one.
//
// This list is what `messages.display_kind` may hold; migration 132 CHECKs the column
// against it. It is deliberately SMALLER than the render-kind list it replaces, because
// four of those values restated a fact the row already carries in its own column and a
// fifth restated the tier:
//
//   inbound-channel            -> `channel` already says which channel it arrived on.
//   memory-compaction-divider  -> the TIER already says a compaction divider is agent-only.
//   tool-result vs tool-turn   -> `role` already says which end of the tool call this is.
//   engine-injection           -> `origin_intent` already names the subsystem that wrote it.
//
// A second column holding the same fact is the duplication this rebuild exists to remove,
// so each of those was folded rather than carried. Nothing read the kind when this landed
// (measured at 2f54de3: every `classifyMessageForDisplay` call site read `.tier` alone), so
// the fold changed no answer, and the six values already in the live table are all still
// legal — no historical row was reclassified and no content byte moved.
//
// `unclassified` is the column's DEFAULT and exists for R1 alone: a legacy-form
// `INSERT OR IGNORE` that reaches the table without going through the writer must still
// PERSIST rather than be silently dropped. The writer never produces it.
export const DISPLAY_KINDS = [
  'user-text',        // a person speaking, on any channel
  'agent-text',       // the agent's own reply
  'tool-turn',        // an assistant row of tool_use blocks, or its role='tool' result
  'working-note',     // demoted mid-work narration ([working-note] / :internal)
  'divider',          // a lifecycle divider, "── label ──"
  'routing-marker',   // [Reply routed via ...] — raw hidden, rendered as a badge
  'owner-alert',      // an allowlisted plain-language heads-up FOR THE OWNER
  'engine-note',      // platform coordination: steers, [SOURCE:] envelopes, engine events
  'a2a',              // peer traffic, either direction
  'no-reply-marker',  // the silent-turn close marker
  'fallback',         // text the ENGINE composed and signed as the agent (OR2 / Phase 4)
  'unclassified',     // R1 fail-open default; never written by the writer module
] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];

/** The lane a row was stamped with at ingest (OR4). Owned here so the write side, the read
 *  side and the schema all spell it the same way. */
export type MessageLane = 'owner' | 'a2a' | 'events';

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
   * The row's stored lane, when the caller has it. The WRITE side always does (it is
   * stamping it), which is why write-time classification never has to guess; the dashboard
   * does not yet pass it and falls through to the origin/content paths below exactly as
   * before. A lane can only ever LOWER visibility — see the fail-closed clamp at the end.
   */
  lane?: MessageLane;
  /**
   * `origin_intent` — the subsystem that produced the row. On an OWNER-lane ASSISTANT row
   * it means something narrower and load-bearing: the ENGINE composed those words and
   * signed them as the agent. That is ruling OR2's subject and PHASE 4 removes the
   * composers; T8's only job is to say so honestly, so such a row classifies `fallback`
   * while keeping the tier it has today.
   */
  originIntent?: string | null;
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

// PHASE-1 T8 — `isInboundChannel` was DELETED here, with the `inbound-channel` kind it
// existed to produce. STRIP; requirement preserved: "a human who arrived on a real channel
// is distinguishable from the owner typing locally" — carried by the `channel` COLUMN, which
// every reader already has and which the writer stamps at ingest (OR4). The helper was
// re-deriving from `origin.channel` a fact the row itself states, and the tier it produced
// was identical either way; the badge a renderer draws comes from `channel` + the inbound
// marker parser (parseInboundChannel), both of which are untouched.

// ════════════════════════════════════════
// Marker constants — the DISPLAY half. PHASE-3 T5 moved the ASSEMBLY families (inbound-A2A,
// platform envelopes, engine scaffolding, new-session, fresh-read) to `markers.ts`, where
// they have ONE owner; this header used to claim to be that owner and was not. What stays:
// display POLICY, and the markers that exist only for the chat surface.
// ════════════════════════════════════════

export type ChannelKind = 'imessage' | 'teams' | 'sms' | 'email' | 'phone';

// User-role content that is engine/coordination noise, hidden in regular
// mode. Inbound CHANNEL markers (iMessage/phone/Teams/SMS/email) are NOT
// in this list: they are user-visible (header stripped + a clean badge),
// handled by parseInboundChannel before these prefixes are checked.
// PHASE-3 T5: SHAPES from `markers.ts`, MEMBERSHIP here. `'[SOURCE: GROUP BROADCAST FROM'`
// was in neither shared module (research 06 §5), so a broadcast reached only the generic
// `'[SOURCE:'` arm and classified `engine-note` instead of `a2a` — never leaked (both
// tiers are agent-only) but OR4 makes the lane part of the record, not just the tier.
export const HIDDEN_USER_CONTENT_PREFIXES: readonly string[] = [
  ...SOURCE_ENVELOPE_PREFIXES,
  A2A_ENVELOPE_PREFIX,
  '[System:',
  '[CONTINUITY BRIEF',
  'Tracker review --',
];

// Engine injections that carry a visible-ish prefix. Hidden in regular.
export { ENGINE_INJECTION_PREFIXES };

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
//
// THE EM-DASH IS DATA. Until PHASE-1 T8 the engine wrote this line with a COMMA
// (`agent/v2/loop.ts`) while both matchers — this constant and the dashboard's inline copy —
// expected an em-dash, so the marker was invisible to its own reader and rendered raw in the
// owner's chat. Two spellings of one marker is what "one matcher per marker" exists to
// prevent, and the fix is not "pick the right character": it is that the WRITER now uses this
// constant, so there is only one character to pick. `src/__tests__/marker-ownership.test.ts`
// on the server side refuses a second copy of this string anywhere in the tree.
export const NO_REPLY_CLOSED_MARKER =
  '[Agent ended turn without replying — conversation closed]';

// ── The `[no-reply]` sentinel the AGENT emits ──
//
// Distinct from the closed marker above: this is the model's own escape hatch (taught by
// prompt/assembler.ts), swallowed by the engine so it never reaches a person. Three shapes,
// because the model produces three: the whole message, a tail after a real reply, and — the
// case that leaked — one that survived mid-text into a row that was already being persisted
// for another reason. Markdown wrappers are tolerated on all three: the weak model wraps it
// in backticks or asterisks about as often as it does not.
const NO_REPLY_SENTINEL_BODY = String.raw`[\`*_]*\s*\[no-reply\]\s*[\`*_]*`;
/** The entire message IS the sentinel. */
export const NO_REPLY_BARE_RE = new RegExp(`^\\s*${NO_REPLY_SENTINEL_BODY}\\s*$`, 'i');
/** The message ENDS with the sentinel after real text. */
export const NO_REPLY_TAIL_RE = new RegExp(`\\s*${NO_REPLY_SENTINEL_BODY}\\s*$`, 'i');

export function isBareNoReplySentinel(text: string): boolean {
  return NO_REPLY_BARE_RE.test(text ?? '');
}

/** Remove every sentinel occurrence. Dropped completely rather than replaced with a space —
 *  the model writes it on its own line or at end-of-message, and that is the same shape the
 *  dashboard's own stripper has always used. */
export function stripNoReplySentinel(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(`\\s*${NO_REPLY_SENTINEL_BODY}\\s*`, 'gi'), '').trim();
}

// ── The orb mood marker ──
//
// `((mood: NAME))` leads a reply and animates the on-screen orb. The prompt promises it is
// "invisible to the user (stripped before display, never spoken aloud)". It was stripped in
// exactly one of six renderers, so it printed raw in working notes, owner alerts and channel
// bubbles — and the same regex was written out FOUR times (engine, TTS sanitizer, dashboard
// marker lib, dashboard chat). One definition, here; 17 §C3 moves the value itself off the
// content and into `messages.mood`.
const MOOD_MARKER_SOURCE = String.raw`\(\(\s*mood\s*:\s*[a-z]+\s*\)\)`;

/** The LAST marker wins, so a mid-message shift takes over. Lower-cased; validation against
 *  the orb's known emotions is the renderer's job, not this one's. */
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

// ── Working notes (demoted mid-work narration) ──
//
// Assistant text that rides in the same model response as tool calls is process narration,
// never a message to the user. It already STREAMED live, so the engine demotes it in place to
// a dimmed system row rather than deleting the bubble in front of the owner.
export const WORKING_NOTE_PREFIX = '[working-note] ';
/** RC-9: narration from a ROUTED-channel human turn (iMessage / SMS / Teams / email). Exactly
 *  one string was delivered to that channel while the dashboard mirrors every iteration, so an
 *  internal note would read as a second, contradictory reply. Agent-only. */
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

// ── Owner alerts ──
//
// Default chat hides generic system rows by design. This allowlist is the exception:
// deliberate, plain-language heads-ups the engine posts into the primary chat FOR THE OWNER
// (a scheduled item failed for good, an approval request expired, a project fell short).
//
// CONTRACT: each server write site prefixes its note with one of these exact strings, and
// takes the string FROM HERE. Matching contract comments live at the write sites:
// scheduler/runner.ts (failed-final-run + skipped-reminder) and agent/destructive-gate.ts
// (approval expiry).
//
// PHASE-4 T6 (2026-08-02) — `OWNER_ALERT_PROJECT_ATTENTION_PREFIX` HAS NO WRITER ANY MORE,
// AND IT STAYS. T4 removed the third site (`tracker/tools.ts`'s fallen-project note) under
// the owner's 2026-07-30 ruling: the platform does not alert the owner directly about a
// project that ended with failed pieces — the AGENT is told, with the "if the user should
// know, please tell the user" nudge, and the agent decides and speaks. Verified at this
// HEAD: zero server writers (`git grep -n "OWNER_ALERT_PROJECT_ATTENTION_PREFIX\|tracker:
// project_needs_attention" -- packages/server/src packages/dashboard/src` returns only the
// dashboard's READERS and one comment recording this measurement).
//
// The constant survives because it is a CLASSIFIER KEY for history, not a template: a stable
// box carries nine of these rows already (measured live — `owner | system | owner-alert |
// user-visible | 9`), and `packages/dashboard/src/pages/Chat.tsx:145,192` allowlists and then
// strips the tag so the owner does not read jargon. Deleting the key would not delete the
// rows; it would make nine existing owner-visible notes render with a raw marker on them.
// #15: a deletion may not rest on "nobody writes it any more".
//
// The "[VALIDATION CHECK]" escalation sweep is intentionally NOT allowlisted: it embeds raw
// task ids and a "**Primary agent**: call ..." tool instruction, and it currently mis-fires on
// engine-owned pauses. It stays wordy-mode-only until that is fixed and the copy is split.
export const OWNER_ALERT_HEADS_UP_PREFIX = 'Heads up:';
export const OWNER_ALERT_PROJECT_ATTENTION_PREFIX = '[tracker:project_needs_attention]';
export const OWNER_ALERT_SYSTEM_PREFIXES: readonly string[] = [
  OWNER_ALERT_HEADS_UP_PREFIX,
  OWNER_ALERT_PROJECT_ATTENTION_PREFIX,
];

/** Strip notifyPrimaryAgent's automated-update envelope so the owner-alert marker is
 *  start-anchored. Only tracker system notes carry it; the completion (success) lines it also
 *  wraps do not start with an allowlisted prefix, so they still stay hidden. */
export function stripSourceEnvelope(content: string): string {
  return content.replace(/^\[SOURCE:[^\]]*\]\s*/, '');
}

export function isOwnerAlertSystemNote(content: string): boolean {
  const body = stripSourceEnvelope(content.trim());
  return OWNER_ALERT_SYSTEM_PREFIXES.some((prefix) => body.startsWith(prefix));
}

// ── Lifecycle dividers ──
//
// The engine persists these as a system row shaped "── label ──" (box-drawing U+2500). Six
// sites wrote the New Session form as a bare literal; the formatter and the constant below
// are what the parser at `parseDivider` answers to, so a writer cannot invent a shape its own
// reader will not recognise.
export function formatDivider(label: string): string {
  return `── ${label} ──`;
}
export const NEW_SESSION_DIVIDER_LABEL = 'New Session';
export const NEW_SESSION_DIVIDER = formatDivider(NEW_SESSION_DIVIDER_LABEL);

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
// Supports the current form ([Reply routed via <channel> to <recipient>]), the
// legacy iMessage form ([SENT VIA IMESSAGE to X]), and every channel the reply
// resolver and engine-ack path emit: iMessage, Teams, email, phone call, SMS.
// SMS was previously absent from this alternation, so SMS outbound markers went
// unparsed and rendered no badge at all; it is included now.
const OUTBOUND_ROUTING_RE =
  /^\[(?:SENT VIA IMESSAGE to (.+?)|Reply routed via (iMessage|Teams|email|phone call|SMS)([^\]]*))\]$/i;

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
  /**
   * RC-4/RC-8: the sender is itself another Dojo agent (a safe-sender flagged
   * `is_agent`). Stamped by the iMessage bridge so downstream engine gates (start-ack
   * suppression, courtesy damping) branch on data, not free-text description prose.
   * Absent/false = an ordinary human sender.
   */
  senderIsAgent?: boolean;
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

/** The one writer of the current-form marker (`agent/v2/loop.ts`'s persistRoutingMarker).
 *  `label` always carries the recipient the sender actually resolved — "iMessage to Sam",
 *  never a bare channel word — because that is what `parseOutboundRouting` above reads back
 *  out. Formatter and parser sit together so a writer cannot invent a shape its own reader
 *  will not match; the round trip is asserted in the taxonomy test. */
export function formatRoutingMarker(label: string): string {
  return `[Reply routed via ${label}]`;
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

// Parse an outbound routing marker (a standalone system message). Returns the
// channel + recipient where present. Every channel now carries the recipient
// the resolver/engine-ack path resolved; an email REPLY marker that carries a
// subject instead of an address (the "[Reply routed via email reply (thread:
// …)]" legacy form) has no "to <addr>" tail and so keeps recipient=null,
// falling back to the channel-only badge. Backward compatible: the legacy
// [SENT VIA IMESSAGE to X] form and the recipient-less phone/email forms all
// still parse exactly as before.
export function parseOutboundRouting(content: string): OutboundRoutingMatch | null {
  const m = content.trim().match(OUTBOUND_ROUTING_RE);
  if (!m) return null;
  if (m[1] !== undefined) {
    // Legacy [SENT VIA IMESSAGE to X]
    return { channel: 'imessage', recipient: m[1].trim() || null };
  }
  const raw = (m[2] || 'imessage').toLowerCase();
  const channel: ChannelKind =
    raw === 'teams' ? 'teams'
    : raw === 'email' ? 'email'
    : raw === 'phone call' ? 'phone'
    : raw === 'sms' ? 'sms'
    : 'imessage';
  const tail = m[3] || '';
  // Teams stamps "to chat <id>"; every other channel stamps "to <recipient>".
  // Anchor the non-Teams match to the tail start so a "to " that appears INSIDE
  // an email subject (the thread-form marker) is never mistaken for a recipient.
  const recipient =
    channel === 'teams'
      ? tail.match(/to chat (.+)$/i)?.[1]?.trim() || null
      : tail.match(/^\s*to (.+)$/i)?.[1]?.trim() || null;
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
// Message-level classifier — THE taxonomy (PHASE-1 T8, 17 §C1/§C5)
//
// Replaces the scattered content.startsWith('[SOURCE:...') pile that lived
// in Chat.tsx / AgentDetail.tsx / TechniqueBuilder.tsx, AND the write-side stub that T3
// left in memory/message-store.ts with a note saying T8 would come and take it.
//
// ONE function, because the two sides differ only in what they can tell it, never in what
// the answer should be:
//   * the WRITE side passes `lane` (+ `originIntent`) — facts it is stamping this instant,
//     so it never has to guess and never parses prose;
//   * the READ side passes `origin` (the projection deriveOrigin builds from those same
//     stored facts), or, for a locally-built streaming bubble that has neither, nothing at
//     all, and the content-marker path answers.
// All three paths reach the same kinds and the same tiers, which is the property "one
// matcher per marker" is actually for.
//
// PRECEDENCE, and why it is this order:
//   1. lane='a2a' / origin.channel='a2a' / source='a2a' — peer traffic is agent-only whatever
//      else it looks like. Strongest signal, no exceptions (OR4, NO_INTERAGENT_LEAK).
//   2. role='tool' — a tool result, whatever its bytes say.
//   3. role='system' — the engine's marker family, most specific first.
//   4. lane='events' — a platform row with no marker of its own.
//   5. role='user' / role='assistant'.
//   6. THE FAIL-CLOSED CLAMP: an events-lane row can never come out user-visible, whatever
//      kind it earned. Visibility is EARNED, which is the same rule the column's DEFAULT
//      ('agent-only') encodes at the database.
// ════════════════════════════════════════

export function classifyMessageForDisplay(msg: DisplayMessageInput): DisplayClassification {
  const out = classifyInner(msg);
  // Fail-closed clamp (6). The lane is a stamped fact and it only ever LOWERS visibility.
  if (msg.lane === 'events' && out.tier === 'user-visible') {
    return { tier: 'agent-only', kind: out.kind };
  }
  return out;
}

function classifyInner(msg: DisplayMessageInput): DisplayClassification {
  const content = msg.content ?? '';
  const trimmed = content.trim();
  const origin = msg.origin;

  // 1. Peer traffic, either direction, whatever the role.
  if (msg.lane === 'a2a' || origin?.channel === 'a2a' || msg.source === 'a2a') {
    return { tier: 'agent-only', kind: 'a2a' };
  }

  // 2. A tool result. `role` already says this is the result end of the call, so the kind
  //    does not restate it — `tool-turn` covers both ends and the tier splits them.
  if (msg.role === 'tool') {
    return { tier: 'agent-only', kind: 'tool-turn' };
  }

  if (msg.role === 'system') {
    if (isNoReplyClosedMarker(content)) {
      return { tier: 'never-shown', kind: 'no-reply-marker' };
    }
    const note = parseWorkingNote(trimmed);
    if (note) {
      // A plain note renders in BOTH modes (the narration was visible live in both); an
      // internal one is agent-only. Same kind, the tier carries the difference.
      return { tier: note.internal ? 'agent-only' : 'user-visible', kind: 'working-note' };
    }
    const divider = parseDivider(content);
    if (divider) {
      // Compaction dividers are diagnostic chrome, not user-facing chronology.
      return { tier: divider.isMemoryCompaction ? 'agent-only' : 'user-visible', kind: 'divider' };
    }
    if (parseOutboundRouting(content)) {
      // Raw marker is hidden; the render turns it into a user-visible badge
      // on the preceding assistant reply.
      return { tier: 'agent-only', kind: 'routing-marker' };
    }
    if (isOwnerAlertSystemNote(trimmed)) {
      return { tier: 'user-visible', kind: 'owner-alert' };
    }
    return { tier: 'agent-only', kind: 'engine-note' };
  }

  // 4. A platform row. Checked before the role branches because insertEngineEvent writes
  //    these with role='user' by default — the lane is the fact, the role is an artefact of
  //    how the model has to read it.
  //
  //    An owner-alert PREFIX on this lane does NOT make it an owner alert, and that is a
  //    measured distinction rather than a tidy one. `scheduler/runner.ts`'s failed-final-run
  //    note carries "Heads up:" and is posted through postAgentNotice deliberately — its own
  //    comment says a role='system' row would be stripped from the model context and the
  //    primary could never relay it. It is a brief TO THE MODEL. The two rows that really are
  //    owner alerts (runner.ts's skipped-reminder note, destructive-gate.ts's expiry note)
  //    are owner-lane role='system' rows and are classified as such above. The lane is what
  //    tells them apart, which is the whole point of stamping it.
  if (msg.lane === 'events') {
    return { tier: 'agent-only', kind: 'engine-note' };
  }

  if (msg.role === 'user') {
    // ── Structured path (Phase 6): the message's origin decides visibility,
    // not a regex over its content. Engine events (kind='engine') are
    // agent-only; a human on a real inbound channel is a user-visible badge;
    // the owner on dashboard/voice is plain user text. This is the same call
    // the row mapper makes (deriveOrigin), so legacy rows still attribute
    // correctly via the read-shim there.
    //
    // D-A step 7 (history retire): the user-role A2A branch (origin.kind ===
    // 'agent' -> agent-only 'a2a') is REMOVED. Requirement it encoded: hide
    // inbound peer-A2A rows that used to live in this chat table from human
    // chat. What satisfies it now: (1) the LANE separation — all inter-agent
    // traffic is stamped `lane='a2a'`/`'events'` at ingest and the human-facing
    // `chat_messages` view is `WHERE lane='owner'`. (This clause used to read
    // "lands in inter_agent_messages, never in `messages`"; PHASE-1 folded that
    // second table in and migration 133 dropped it, so the sentence was about to
    // become a false statement of where the protection lives.)
    // (2) the retire migration (102) marks the legacy pre-cutover A2A rows
    // retired_at, and the dashboard serving paths (chat history route +
    // agents.ts projection) filter retired_at IS NULL, so no user-role A2A row
    // is ever served to this classifier. The overlay is dead. (The ASSISTANT
    // A2A-turn branch below is KEPT: the agent's OWN A2A-turn output stays in
    // `messages` by design and is still hidden in regular mode.)
    if (origin) {
      if (origin.kind === 'engine') {
        // `origin_intent` already names the subsystem (tracker / scheduler / healer …), so
        // the kind does not restate it — that was the `engine-injection` vs `system-other`
        // split, and nothing ever read it (both were agent-only; the dashboard gates on tier).
        return { tier: 'agent-only', kind: 'engine-note' };
      }
      // origin.kind === 'user' (or 'self', not expected on a user row).
      // Unauthorized human inbound (a mailbox notification about the owner's inbox,
      // an unknown sender, a scam/promo email) is Lane-3 awareness, NOT a conversation
      // — the agent surfaces it to the owner only if it matters; the raw notification
      // never clutters the chat. `authorized` is load-bearing for display too, not
      // just the turn machine (the prime directive). It is still a PERSON speaking, which
      // is what the kind records; the tier is what it has not earned.
      if (origin.authorized === false) {
        return { tier: 'agent-only', kind: 'user-text' };
      }
      return { tier: 'user-visible', kind: 'user-text' };
    }

    // ── Legacy fallback (origin-less inputs: local optimistic/streaming
    // bubbles). Retired in Phase 7 once every surface carries origin. Mirrors
    // the pre-redesign content-marker pile exactly so behavior is unchanged.
    if (parseInboundChannel(content)) {
      return { tier: 'user-visible', kind: 'user-text' };
    }
    // PHASE-3 T5: was two of the four inbound forms. One matcher, all four.
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

  // ── assistant ──
  // (The a2a arm ran at step 1; it covers origin.channel and msg.source too.)
  //
  // Engine-emitted assistant fallback text (errors, continuity acks) is hidden. deriveOrigin
  // marks all assistant output kind='self', so origin can't see this — the prefix match
  // stays. (The agent's real words show.)
  if (startsWithAny(trimmed, ASSISTANT_FALLBACK_PREFIXES)) {
    return { tier: 'agent-only', kind: 'fallback' };
  }
  // Engine-composed text signed as the agent, named by `origin_intent` on an OWNER-lane
  // assistant row (the thrash notices and their kin).
  // This is ruling OR2's subject and PHASE 4 removes the composers. T8 records WHAT wrote
  // it and deliberately does NOT change what the owner sees — the tier stays user-visible,
  // because hiding these would be Phase 4's change made early and by the wrong task.
  //
  // ⚠ THE START-ACK IS NO LONGER ONE OF THESE, and the correction is UX-REPAIR T2's
  // (2026-08-09). This comment named it from the era when the engine COMPOSED it; PHASE-4 T4
  // converted the lane to the model's own opening words pushed early
  // (`v2/steps/preflight/turn-closures.ts` records the conversion), so `agent-text` — not
  // `fallback` — is the truthful class for that row.
  //
  // THE ARM IS NOT NARROWED FOR IT. This classifier is a leaf and takes no exceptions: the
  // WRITER declares what its row is, through the override carrier `NewMessage.displayKind`
  // (`memory/message-store.ts`, applied as `m.displayKind ?? display.kind`), and the start-ack
  // is the one writer that passes it. Every other stamped intent — and an unstamped
  // `engine_start_ack` row, should one ever be written — still classifies exactly as it did
  // before, which is asserted rather than assumed
  // (`memory/__tests__/display-taxonomy.test.ts`, and the CONTROL clause in
  // `v2/steps/post-call-classify/__tests__/the-stamped-start-ack-keeps-its-readers-honest.test.ts`).
  if (msg.originIntent) {
    return { tier: 'user-visible', kind: 'fallback' };
  }
  // An assistant row whose content is the model's tool_use blocks rather than prose. The
  // dashboard renders these as chips; `role` and the blocks say which end of the call this
  // is, so the kind is the same one a role='tool' row gets.
  //
  // UX-REPAIR T5 (2026-08-09): the TIER is folded per block instead of asserted per row.
  // It used to be a flat `user-visible` for every tool-bearing row, which made the stored
  // column disagree with the screen on every bookkeeping-only turn — see `toolTurnTier`.
  if (trimmed.startsWith('[{') && trimmed.includes('"tool_use"')) {
    return { tier: toolTurnTier(trimmed), kind: 'tool-turn' };
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

// ── PHASE-2 T8V: the sliver of work-verb knowledge this leaf needs ──
// `@dojo/shared` cannot import the server's tools/work-verbs.ts (the dependency
// runs the other way), so the ONE discriminator that changes a display class is
// read here. The full matcher stays single-sourced server-side; this reads the
// same `kind` argument and the same `what`/`when` shape fallback.
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
  // UX-REPAIR T54(a) (owner ruling 6, 2026-08-16): `shell` is `exec`'s own half — the two
  // split from ONE door at PHASE-5 T3 and sensei-policy.ts still says so. It runs arbitrary
  // zsh and drew NOTHING for one reason: "exec" had an override here and "shell" is in no
  // verb set. A vocabulary accident, flagged with evidence by T5/W3 and ruled FIX. Note this
  // class is read by five ENGINE sites too (loop thrash-progress, promise-floor,
  // going-idle's countsAsTaskWork + its side-effect hint, execute/post-result), so a shell
  // call now counts as real work in each, exactly as an exec call always has — that IS the
  // parity, said out loud rather than discovered later.
  shell: 'effectful-action',
  // UX-REPAIR T54(b)+(c): the right-dock view surfaces, both hidden until now (118 stored
  // canvas_render rows on the worn-in box drew nothing; open_browser has 0 rows, so (c) is
  // correctness with no observed impact — recorded, not glossed).
  //
  // WHY `delivery` AND NOT `effectful-action`: the class means "renders content visibly",
  // which is precisely what these two do, and W3's evidence already named canvas_render the
  // nearest neighbour of its only member. It is user-visible at the badge tier and read by
  // ZERO engine sites (the only server-side `'delivery'` comparisons belong to an unrelated
  // SettlementMoment string), whereas `effectful-action` would have made showing the user a
  // document count as task work in the five gates above — a change nobody ruled on.
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

// Tool-name prefixes that are always bookkeeping (internal stores,
// coordination, tracker, techniques, credentials, contacts, admin).
const BOOKKEEPING_PREFIXES: readonly string[] = [
  'scratchpad_',
  'vault_',
  'memory_',
  'recall_',
  'squad_',
  // PHASE-2 T8V: `work_` is the live surface. This entry is load-bearing, not
  // cosmetic: without it `work_update` tokenises to the effectful verb "update"
  // and every board write would flip from hidden bookkeeping to a user-visible
  // badge AND start counting as effectful work in four separate loop gates
  // (thrash progress, countsAsTaskWork, the promise floor, workedATaskThisTurn).
  'work_',
  // `tracker_` STAYS, for HISTORY only. No live tool carries the prefix any
  // more, but every persisted tool_use block from before the collapse does, and
  // the dashboard re-classifies those rows on every render. Removing it would
  // silently re-render two years of chat, flipping past tracker calls from
  // hidden to user-visible. It costs nothing and is not a live-surface entry.
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

/**
 * PHASE-2 T8V — the ONE operation whose display class was not `bookkeeping`
 * before the collapse, kept by name.
 *
 * `reminder_create` had no override and no bookkeeping prefix, so the verb
 * heuristic classified it EFFECTFUL on the token "create" — meaning setting a
 * reminder showed the user a badge and counted as real work in the promise floor
 * and the task-work test. Folded into `work_open`, it would silently have become
 * bookkeeping like its 23 siblings. Measured, not assumed: this map is the
 * difference, and it is the reason `classifyTool` now accepts arguments.
 *
 * A caller with no arguments gets the safe answer (bookkeeping), which is what
 * 23 of the 24 retired verbs were.
 */
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

// ── UX-REPAIR T5: the row tier is the FOLD of its blocks, not an assertion about them ──
//
// THE DEFECT THIS CLOSES. `display_tier` was stamped `user-visible` on every assistant row
// whose content was tool_use JSON, regardless of which tools it held, while the
// substantive/bookkeeping line was drawn PER BLOCK by `classifyTool` on the client. One row,
// two rules, two answers — so a turn of six `work_*` and `load_tool_docs` calls was stored as
// "the user saw this" and drew nothing. The 2026-08-09 UX review read the column and reported
// a red error chip and five-to-seven badges that were never on screen. A column no renderer
// reads still lies to every machine that reads it, and this is the machine-readable half of
// the fix (the render half was already correct and is deliberately untouched).
//
// ONE RULE, NOT A SECOND COPY. This folds through `toolBadgeTier(classifyTool(name, input))`
// — the same two functions the dashboard's own filter uses. `toolBadgeTier` had zero callers
// and was dead; wiring it here is what makes the stored answer and the drawn answer
// impossible to edit apart.
//
// UX-REPAIR T54(d) (owner ruling 6, 2026-08-16) — THE ARGUMENTS NOW REACH BOTH SIDES. T5
// wrote this fold ARG-LESS and said why: all four dashboard sites were, so a tier computed
// WITH arguments would have re-opened the gap from the other side. It recorded the cost
// instead of hiding it — `WORK_OP_DISPLAY_CLASS`'s `work_open:reminder` promotion was
// unreachable, so setting a reminder drew nothing. The owner ruled the table is right; the
// four client sites now pass `b.input` and so does this fold. T5's rule is unchanged, only
// its inputs are complete. BOTH SIDES OR NEITHER is not a preference: the client re-derives
// the row tier with this very function (`Chat.tsx:975` backfill, `:1870` render), so an
// arg-aware chip filter over an arg-less tier draws nothing — the row is dropped one step
// before the filter runs.
//
// EVERY BLOCK, OR THE ROW KEEPS ITS TIER. A non-`tool_use` block (text, image, thinking) is
// something the chip filter does not govern, so its presence hands the row straight back to
// `user-visible`; only a row that is tool calls and NOTHING else can be folded away. Measured
// on the worn-in box: 0 of 9,309 stored assistant tool rows carry a text block (re-counted
// at T54), so this is a guard against a shape that does not exist yet, not a live branch.
//
// SERVING IS NOT TOUCHED. `gateway/routes/chat.ts:305-310` records why tier must never become
// a server-side WHERE clause; the served set is byte-identical after this change and the
// refusal stands.
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
    // The cast is safe for a malformed `input` of ANY shape: `workDisplayOp` reads it only
    // through `?.` plus a `typeof`, so a string/array/null yields the same bookkeeping answer
    // this fold gave every block before T54.
    const args = b.input as Record<string, unknown> | undefined;
    if (toolBadgeTier(classifyTool(b.name, args)) === 'user-visible') return 'user-visible';
  }
  return 'agent-only';
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
