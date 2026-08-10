import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { Message } from '@dojo/shared';
import type { ChatChunkEvent, ChatMessageEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, ChatWorkingNoteEvent, WsEvent } from '@dojo/shared';
import { classifyMessageForDisplay, classifyTool, parseInboundChannel, stripInboundChannelMarker, parseOutboundRouting, channelOfSendTool } from '@dojo/shared';
import type { MessageOrigin } from '@dojo/shared';
import { summarizeToolTurn, deriveChipLabel, type ToolTurnSummary } from '../lib/tool-display';
import { inboundBadge, outboundBadge } from '../lib/channel-display';
import { ToolBadgeGroup, type ToolChipData } from '../components/ToolBadge';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';
import { formatDate } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';
import { ToolCallBlock, ToolCallCard, ToolResultBlock } from '../components/ToolCallBlock';
import { stripVoiceMarkers, stripVoiceMarkersForStream, parseMoodMarker } from '../lib/voice-markers';
import { useDojoOrb } from '../components/orb/OrbProvider';
import type { OrbEmotionName } from '../components/orb/dojoOrbEngine';
import { stripAttachmentTags } from '../lib/attachment-tags';
import { parseMailboxEvent } from '../lib/mailbox-event';
import { Markdown } from '../components/Markdown';
import { Dojo3Composer } from '../components/Dojo3Composer';
import { useActiveAgent } from '../components/ActiveAgentProvider';
import { useTechniqueSession, stripBuilderContext } from '../components/TechniqueSessionProvider';
import { useToast } from '../hooks/useToast';
import { AttachmentChips } from '../components/AttachmentChips';
import { ThinkingBubble } from '../components/ThinkingBubble';
import { Dojo3Stage } from '../components/Dojo3Stage';
import { PresenceProvider } from '../components/PresenceProvider';

// ── Orb mood ──
// Map a model-emitted `((mood: NAME))` marker to one of the orb's emotions.
// Accept the canonical names plus a few natural synonyms; ignore anything else.
const VALID_EMOTIONS = new Set<OrbEmotionName>([
  'startled', 'joyous', 'working', 'mad', 'calm', 'sleepy', 'confused',
  'success', 'sheepish', 'curious', 'sympathetic', 'excited', 'waiting', 'alert',
]);
const EMOTION_SYNONYMS: Record<string, OrbEmotionName> = {
  happy: 'joyous', glad: 'joyous', delighted: 'joyous',
  sad: 'sympathetic', concerned: 'sympathetic', sorry: 'sympathetic',
  angry: 'mad', annoyed: 'mad', frustrated: 'mad',
  surprised: 'startled', shocked: 'startled',
  proud: 'success', done: 'success',
  embarrassed: 'sheepish', apologetic: 'sheepish',
  interested: 'curious', thinking: 'curious', intrigued: 'curious',
  relaxed: 'calm', neutral: 'calm',
  thrilled: 'excited', eager: 'excited',
};
function moodToEmotion(raw: string | null): OrbEmotionName | null {
  if (!raw) return null;
  if (VALID_EMOTIONS.has(raw as OrbEmotionName)) return raw as OrbEmotionName;
  return EMOTION_SYNONYMS[raw] ?? null;
}

// ── Types ──

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface ToolCallData {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;        // raw content from DB (may be JSON)
  blocks?: ContentBlock[]; // parsed content blocks (if JSON array)
  createdAt: string;
  modelId?: string | null;
  toolCalls?: ToolCallData[];
  isStreaming?: boolean;
  /** Streamed thinking from providers like DeepSeek v4-pro. Rendered as
   *  a collapsible panel above the assistant text — auto-expanded while
   *  streaming, auto-collapsed once the final answer starts arriving. */
  reasoningContent?: string | null;
  isReasoningStreaming?: boolean;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string; openInCanvas?: boolean; screenShare?: boolean }>;
  /** Where this message came from. 'voice' = dictated via voice mode;
   *  'a2a' = produced on a dedicated inter-agent turn (hidden in regular mode). */
  source?: 'voice' | 'a2a' | null;
  /** Canonical attribution from the server (deriveOrigin). The visibility
   *  classifier reads this to decide what shows in regular mode. */
  origin?: MessageOrigin;
  /** The conversation this turn served, stamped on the agent's own
   *  assistant/tool rows (migration 076 / loop C15). A human conversation key
   *  ('owner', 'imessage:…', …) means the user triggered the turn; null means a
   *  background/engine run (scheduler sync, watcher, tracker-driven surface).
   *  Regular mode hides background-run tool CHIPS by keying on this; the
   *  surfaced text of a background turn still renders. Absent on local
   *  optimistic/streaming bubbles (treated as user-visible). */
  conversationId?: string | null;
  /** The row's stored display classification (`messages.display_kind`). SWEEP CORE-2 item 7:
   *  an ASSISTANT row stamped `working-note` is drafting the turn's own ledger key did not
   *  name as the answer — re-classified at the turn boundary, content untouched. Read here
   *  rather than re-derived from the text, because the text is deliberately unchanged. */
  displayKind?: string | null;
}


// ── Parse DB message content into structured blocks ──

function parseMessageContent(raw: string): { text: string; blocks?: ContentBlock[] } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Extract plain text from text blocks for display
      const textParts = parsed
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text)
        .join('\n\n');
      return { text: textParts, blocks: parsed };
    }
  } catch {
    // Not JSON — plain text
  }
  return { text: raw };
}

// ── Owner-alert system notes ──
//
// Default (non-wordy) chat hides generic role='system' rows by design. A small
// allowlist is the exception: deliberate, plain-language heads-ups the engine
// posts into the primary chat FOR THE OWNER (a scheduled item failed for good,
// an approval request expired, a project fell short). These render even in
// default mode; everything else non-allowlisted stays hidden.
//
// CONTRACT: each server write site prefixes its note with one of these exact
// strings. Keep the prefix if you reword the note (matching contract comments
// live at the three write sites: scheduler/runner.ts failed-final-run heads-up,
// agent/destructive-gate.ts approval-expiry note, tracker/tools.ts fail-open
// project_needs_attention notice). The tracker notice reaches the feed wrapped
// by notifyPrimaryAgent's "[SOURCE: TRACKER TASK UPDATE ...]" envelope, so the
// match strips a leading SOURCE envelope before the start-anchored prefix test.
// (The validation-escalation "[VALIDATION CHECK]" sweep is intentionally NOT
// allowlisted: it embeds raw task ids + a "**Primary agent**: call ..." tool
// instruction, and FA-S3 documents it currently mis-fires on engine-owned
// pauses. It stays wordy-mode-only until that is fixed and the copy is split.)
const OWNER_ALERT_SYSTEM_PREFIXES = [
  'Heads up:',                         // scheduler failed-final-run + approval-expiry notes
  '[tracker:project_needs_attention]', // project fell short (fail-open notice)
] as const;

// Strip notifyPrimaryAgent's automated-update envelope so the owner-alert
// marker is start-anchored. Only tracker system notes carry it; the completion
// (success) lines it also wraps do not start with an allowlisted prefix, so
// they still stay hidden.
const stripSourceEnvelope = (content: string): string =>
  content.replace(/^\[SOURCE:[^\]]*\]\s*/, '');

const isOwnerAlertSystemNote = (content: string): boolean => {
  const body = stripSourceEnvelope(content.trim());
  return OWNER_ALERT_SYSTEM_PREFIXES.some((prefix) => body.startsWith(prefix));
};

// Clean owner-facing text: drop the SOURCE envelope and the internal
// [tracker:project_needs_attention] tag (jargon a non-technical owner should
// not see). The plain-language "Heads up:" notes carry no such framing and are
// returned unchanged.
// ── Working notes (demoted mid-work narration) ──
//
// Assistant text that rides in the same model response as tool calls is
// Lane-2 process narration, never a message to the user; the engine persists
// it as a `[working-note]` system row instead of a conversation message
// (loop.ts, owner request 2026-07-10). Because that text streamed live before
// the classification landed, the old behavior deleted the bubble in front of
// the user. It now demotes: the bubble converts in place (chat:workingnote
// event live; this prefix check on reload) into a dimmed, collapsed note.
const WORKING_NOTE_PREFIX = '[working-note] ';
// RC-9: internal working notes are demoted narration from a ROUTED-channel human turn
// (iMessage / SMS / Teams / email). Exactly one string was delivered to that channel
// while the dashboard live-mirrors every iteration, so an internal note was NOT sent to
// the channel and would read as a second, contradictory reply. Hidden by default; shown
// only in wordy/verbose mode.
const INTERNAL_WORKING_NOTE_PREFIX = '[working-note:internal] ';
const workingNote = (content: string): { text: string; internal: boolean } | null => {
  if (content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)) {
    return { text: content.slice(INTERNAL_WORKING_NOTE_PREFIX.length), internal: true };
  }
  if (content.startsWith(WORKING_NOTE_PREFIX)) {
    return { text: content.slice(WORKING_NOTE_PREFIX.length), internal: false };
  }
  return null;
};

const ownerAlertDisplayText = (content: string): string =>
  stripSourceEnvelope(content.trim())
    .replace(/^\[tracker:project_needs_attention\]\s*/, '')
    .trim();

// Dimmed, collapsed rendering for a demoted working note. Styling copied from
// the owner-alert system-note bubble (nearest analog) with quieter text and an
// expand-on-click, mirroring the tool-chip interaction users already know.
const WorkingNoteBubble = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const collapsed = oneLine.length > 96 ? `${oneLine.slice(0, 96)}…` : oneLine;
  return (
    <div className="flex justify-start my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="max-w-[92%] sm:max-w-[75%] rounded-lg border border-ui/[0.06] bg-ui/[0.03] px-3 py-1.5 text-left text-[11px] sm:text-xs text-ui/35 italic leading-relaxed"
      >
        {open ? <span className="whitespace-pre-wrap">{text}</span> : collapsed}
      </button>
    </div>
  );
};

// ── Message Bubble Renderers ──

// Inbound channel framing (the [SOURCE: IMESSAGE/PHONE/SMS/TEAMS/EMAIL ...]
// header + the phone Call SID trailer) is parsed and stripped by the canonical
// helpers in @dojo/shared (parseInboundChannel / stripInboundChannelMarker); the
// badge wording lives in ../lib/channel-display (inboundBadge). UserBubble uses
// them so every channel is handled and the logic cannot drift across chat pages.
// Attachment-pointer stripping is in ../lib/attachment-tags.

const UserBubble = ({ msg, wordyMode = false }: { msg: ChatMessage; wordyMode?: boolean }) => {
  // Inbound channel (iMessage / phone / SMS / Teams / email): show ONE clean
  // badge and strip the [SOURCE: ...] framing (+ phone trailer). Driven by the
  // canonical parser (@dojo/shared) so all chat pages agree and every channel is
  // covered (V3). Wordy mode shows the raw content (markers included) for debug.
  const inbound = parseInboundChannel(msg.content);
  const fromVoice = msg.source === 'voice';
  const badge = inbound ? inboundBadge(inbound.channel, inbound.sender) : null;

  let displayContent = msg.content;
  // Strip injected technique build/edit context (no-op for normal messages) so
  // the user bubble shows only what they typed during a technique session.
  displayContent = stripBuilderContext(displayContent);
  if (!wordyMode) {
    if (inbound) displayContent = stripInboundChannelMarker(displayContent);
    // Strip the engine attachment-pointer blocks (chips render the files).
    if (msg.attachments?.length) displayContent = stripAttachmentTags(displayContent);
  }

  // Engine inbox-watcher notifications render as a clean email card in non-wordy
  // mode (the raw [MAILBOX EVENT] framing + Message ID + tool hint are hidden;
  // the account header replaces the generic "via email" badge).
  const mailbox = !wordyMode ? parseMailboxEvent(msg.content) : null;

  return (
    <div className="flex flex-col items-end">
      {badge && !mailbox && (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 mr-1">
          <span className="text-ui/40">{badge.emoji}</span>
          <span>{badge.label}</span>
        </div>
      )}
      {fromVoice && !badge && (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cp-teal/10 text-cp-teal text-[10px] font-mono mb-1 mr-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          <span>via voice</span>
        </div>
      )}
      <div className="bubble-user max-w-[92%] sm:max-w-[75%] px-3 py-2 sm:px-4 sm:py-3 text-ui">
        {mailbox ? (
          <div className="text-xs sm:text-sm leading-relaxed break-words space-y-1">
            <div className="flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] text-tertiary mb-0.5">
              <span>{'✉️'}</span>
              <span>Email{mailbox.account ? ` · ${mailbox.account}` : ''}</span>
            </div>
            {mailbox.from && (
              <div><span className="text-tertiary">From: </span>{mailbox.from}</div>
            )}
            {mailbox.subject && (
              <div><span className="text-tertiary">Subject: </span>{mailbox.subject}</div>
            )}
            {mailbox.body && (
              <pre className="whitespace-pre-wrap font-sans break-words mt-1 opacity-80">{mailbox.body}</pre>
            )}
          </div>
        ) : (
          displayContent && (
            <pre className="whitespace-pre-wrap font-sans text-xs sm:text-sm leading-relaxed break-words">
              {displayContent}
            </pre>
          )
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-[9px] sm:text-[10px] mt-1.5 sm:mt-2 text-tertiary">
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

/**
 * Routing info attached to an assistant message by a follow-on system
 * marker like `[Reply routed via iMessage to NAME]`. The standalone
 * marker is hidden from the feed and the badge renders above the
 * assistant bubble instead (mirror of the user-side "from X" badge).
 */
interface OutboundChannelInfo {
  label: string;  // e.g. "to the owner via iMessage"
  emoji: string;
}

const AssistantBubble = ({
  msg, wordyMode = true, modelNames = {}, outboundChannel,
}: {
  msg: ChatMessage; wordyMode?: boolean; modelNames?: Record<string, string>;
  outboundChannel?: OutboundChannelInfo | null;
}) => {
  const { text: rawText, blocks } = parseMessageContent(msg.content);
  const text = rawText?.trim() || '';
  // Hide cloud voice-mode markers ((deliver: ...)), [pause], [long pause]
  // from regular chat. Wordy mode shows them so you can debug agent output.
  const displayText = wordyMode
    ? text
    : (msg.isStreaming ? stripVoiceMarkersForStream(text) : stripVoiceMarkers(text));
  const spokenAloud = msg.source === 'voice';
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
  const hasReasoning = !!(msg.reasoningContent && msg.reasoningContent.length > 0);
  // Auto-expand while reasoning is actively streaming OR while no answer
  // text has arrived yet. Auto-collapse once the final answer is showing.
  const reasoningOpenDefault = hasReasoning && (msg.isReasoningStreaming || text.length === 0);
  const [reasoningOpen, setReasoningOpen] = useState(reasoningOpenDefault);
  // Re-sync when streaming flips off so the panel collapses once answer
  // content takes over the bubble.
  useEffect(() => {
    if (!msg.isReasoningStreaming && text.length > 0) {
      setReasoningOpen(false);
    }
  }, [msg.isReasoningStreaming, text.length]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[75%]">
        {/* Outbound channel routing badge — left-aligned mirror of the
            inbound "from X via iMessage" badge on user bubbles. Set when
            the engine auto-routed this reply to iMessage / Teams /
            email. The standalone routing-marker system message is
            hidden in the feed; the info rides this bubble instead. */}
        {outboundChannel && (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 ml-1">
            <span className="text-ui/40">{outboundChannel.emoji}</span>
            <span>{outboundChannel.label}</span>
          </div>
        )}
        {/* "via voice" badge — left-aligned mirror of the user-side badge,
            stamped by the server when voice-mode TTS routes this message
            through Kokoro or Hume. */}
        {spokenAloud && (
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cp-teal/10 text-cp-teal text-[10px] font-mono mb-1 ml-1">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
            </svg>
            <span>via voice</span>
          </div>
        )}
        {/* Reasoning / "Thinking…" panel — appears above the answer text.
            Live-streams while the model is thinking, collapses when the
            final answer starts arriving. Click header to toggle later.
            Wordy-mode only: in regular chat we just see the standard
            three bouncing dots from the streaming bubble below. */}
        {hasReasoning && wordyMode && (
          <div className="mb-1.5 rounded-lg border border-ui/[0.06] bg-ui/[0.03] overflow-hidden">
            <button
              type="button"
              onClick={() => setReasoningOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] sm:text-[11px] text-ui/40 hover:text-ui/70 transition-colors"
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{msg.isReasoningStreaming ? 'Thinking…' : 'Thought'}</span>
                {msg.isReasoningStreaming && (
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-ui/[0.12] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 rounded-full bg-ui/[0.12] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1 h-1 rounded-full bg-ui/[0.12] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                )}
              </span>
              <span className="text-ui/25">{reasoningOpen ? '▾' : '▸'}</span>
            </button>
            {reasoningOpen && (
              <div className="px-3 pb-2.5 pt-0.5 text-[11px] sm:text-xs text-ui/55 whitespace-pre-wrap font-mono leading-relaxed border-t border-ui/[0.06]">
                {msg.reasoningContent}
              </div>
            )}
          </div>
        )}

        {/* Text content */}
        {displayText && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3 whitespace-pre-wrap text-xs sm:text-sm">
            {wordyMode && msg.modelId && (
              <div className="text-[9px] sm:text-[10px] text-ui/25 mb-1">{modelNames[msg.modelId] ?? msg.modelId}</div>
            )}
            <Markdown content={displayText} />
            {msg.isStreaming && (
              <span className="inline-flex gap-1 ml-1 align-middle">
                <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        )}

        {/* Streaming cursor when no text yet */}
        {!text && msg.isStreaming && (
          <div className="bubble-assistant px-4 py-3">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </div>
        )}

        {/* Tool use blocks from DB history */}
        {wordyMode && hasToolUse && (
          <div className="mt-1">
            {blocks!
              .filter((b) => b.type === 'tool_use')
              .map((b) => (
                <ToolCallCard
                  key={b.id}
                  name={b.name!}
                  input={(b.input as Record<string, unknown>) ?? {}}
                />
              ))}
          </div>
        )}

        {/* v2.5.23 — Removed the msg.toolCalls render path. Tool_use blocks
            for an assistant message render via the hasToolUse path above,
            reading from the canonical JSON content set by chat:message.
            msg.toolCalls was a leftover live-streaming mechanism that
            became leaky because chat:tool_call events on the server fire
            AFTER chat:chunk done — so an iteration's tool calls would
            accumulate in currentToolCallsRef and then attach themselves
            to the NEXT iteration's streaming bubble's done event,
            producing the "tool calls below the final response" duplicate.
            With this path removed, the chat:tool_call broadcasts still
            accumulate in the ref but are never rendered; the ref is
            effectively dead and could be removed entirely (left in place
            to keep the diff minimal). */}

        {/* Image / PDF attachments (e.g. Imaginer-generated images). In the
            dojo3 chat these render as prototype .media cards (poster + meta);
            audio and non-previewable files stay as the existing chips. */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="mt-2">
            <AttachmentChips attachments={msg.attachments} variant="media" />
          </div>
        )}

        {/* Timestamp */}
        {!msg.isStreaming && (
          <div className="text-[10px] mt-1 px-1 text-tertiary">
            {formatDate(msg.createdAt)}
          </div>
        )}
      </div>
    </div>
  );
};

// Tool-only assistant turns render as class-aware badges (V2b): effectful action
// vs retrieval vs hidden bookkeeping. The badge atom + the wrap row live in the
// shared components/ToolBadge so the style cannot drift across chat pages; this
// helper turns a run of messages into the {id, summary} items it takes, dropping
// bookkeeping-only turns (summarizeToolTurn returns null for them).
const toolBadgeItems = (
  msgs: ChatMessage[],
  resultById: Map<string, ToolResultInfo>,
  wordyMode: boolean,
): Array<{ id: string; summary: ToolTurnSummary }> =>
  msgs
    .map((m) => {
      // Background/engine run: drop its badge in regular mode (chips-only rule;
      // its surfaced text still renders). Wordy mode keeps everything.
      if (!wordyMode && isBackgroundTurnRow(m)) return null;
      const names = (parseMessageContent(m.content).blocks ?? [])
        .filter((b) => b.type === 'tool_use')
        .filter((b) => wordyMode || !isErroredToolResult(b.id ? resultById.get(b.id) : undefined))
        .map((b) => b.name ?? '');
      const summary = summarizeToolTurn(names);
      return summary ? { id: m.id, summary } : null;
    })
    .filter((x): x is { id: string; summary: ToolTurnSummary } => x !== null);

// dojo3 chat only: turn a run of tool-only turns into one chip-tool pill per
// visible (non-bookkeeping) tool, carrying its raw input plus any matching
// tool_result so each chip can expand into the canonical ToolCallCard /
// ToolResultBlock detail. Bookkeeping tools are dropped to mirror the badge
// path (summarizeToolTurn hides them); if a group surfaces no visible tool the
// chips list is empty and ToolBadgeGroup falls back to the summary items.
interface ToolResultInfo { content: string; isError: boolean }

// A tool call whose result errored — the exact same `isError` flag the UI uses
// to render the chip red. The engine surfaces and recovers from these itself
// (it typically retries), so outside Wordy mode the failed chip is just noise
// that makes the agent look like it's repeating itself. Hide it in the clean
// view; Wordy mode still shows every step. (Replaces an older text-regex that
// only caught missing-param errors and could over-match a legit "is required".)
const isErroredToolResult = (info?: ToolResultInfo): boolean => !!info?.isError;

// A tool chip is user-visible in REGULAR mode only when its row was produced
// serving a HUMAN conversation. The turn's conv_key is the structural signal:
// a user-triggered turn stamps its own assistant/tool rows with the human
// conversation (`conversations.id`); a background / engine turn (scheduler sync, watcher,
// tracker-driven surface) leaves them null because the turn had no waiting human
// (chosenConversationId null, so the teardown stamp is a no-op). Verified against the live
// DB: `null` IS the background marker on a chip row.
// PHASE-2 T4: the 'park:'/'relayed:' sentinels are GONE (a delegated question is parent/child
// rows in `work` and nothing rewrites conv_key to hold join state), so the clauses testing for
// them are deleted rather than left reading a dead namespace.
// This hides only the CHIP; a background turn's surfaced TEXT is a separate assistant row and
// still renders. Wordy mode shows every chip. Absent conversationId (undefined, e.g. a local
// optimistic bubble) defaults to user-visible so a live user turn never loses its own chips.
// NOTE: legacy rows written before conversation stamping are null too, so their chips are
// hidden in regular mode and only appear in wordy mode (bounded history tradeoff). Migration
// `147` backfilled the ones whose old `conv_key` named a resolvable conversation, so this
// tradeoff covers strictly fewer rows than it did.
// ── PHASE-2 T10I: the signal is `conversationId`, and the sentinel clause is GONE ──
// The three `'engine…'` values this used to test for were FAKE CONVERSATION KEYS the engine
// wrote onto the identity column, and the comment above records what they actually were: they
// only ever landed on a role='user' TRIGGER row, never on the agent's own output — so on a
// CHIP row (assistant/tool) they were unreachable and the `null` branch was doing all the
// work. `conversation_id` cannot hold a sentinel at all (an events-lane rider has no
// conversation), so testing for one would be testing for a value the schema can no longer
// produce, which is worse than deleting the clause: it would read as a live guard.
// requirement preserved, unchanged: an own-output row with NO conversation belongs to a
// background/engine turn and its CHIP is hidden in regular mode; a row that belongs to a real
// conversation shows. `undefined` still means "no signal" (a local optimistic bubble) and
// still shows, so a live user turn never loses its own chips.
const isBackgroundTurnRow = (m: ChatMessage): boolean => {
  const cid = m.conversationId;
  if (cid === undefined) return false;     // no signal → show (safety for live user turns)
  if (cid === null || cid === '') return true;
  return false;                            // a real conversation → show
};

const toolChips = (
  msgs: ChatMessage[],
  resultById: Map<string, ToolResultInfo>,
  wordyMode: boolean,
  // Mid-run in-flight cutoff (2026-07-23, owner report: chips vanish on a
  // mid-run refresh, return after the run). `conversation_id` is stamped on own output at
  // turn TEARDOWN, so a REST reload during an active turn sees the turn's own
  // rows as conversationId null and the background test hides their chips. While
  // the agent is working, rows created at/after the current trigger are the
  // live turn's; exempt them. Once the run ends the stamp governs again.
  liveCutoff: string | null = null,
): ToolChipData[] =>
  msgs.flatMap((m) =>
    // Background/engine run: drop its tool chips in regular mode (only the chips
    // are hidden; the turn's surfaced text is a separate row that still renders).
    (!wordyMode && isBackgroundTurnRow(m) && !(liveCutoff && m.createdAt >= liveCutoff))
      ? []
    : (parseMessageContent(m.content).blocks ?? [])
      .filter((b) => b.type === 'tool_use' && b.name && classifyTool(b.name) !== 'bookkeeping')
      .filter((b) => wordyMode || !isErroredToolResult(b.id ? resultById.get(b.id) : undefined))
      .map((b, i): ToolChipData => {
        const res = b.id ? resultById.get(b.id) : undefined;
        const input = (b.input as Record<string, unknown>) ?? {};
        return {
          key: `${m.id}-${b.id ?? i}`,
          name: b.name ?? '',
          label: deriveChipLabel(b.name ?? '', input),
          input,
          result: res?.content,
          isError: res?.isError,
        };
      }),
  );

// v2.7.23 — render channel-send tool calls as outbound message bubbles with a
// RECIPIENT-bearing channel pill ("to X via iMessage"), not a generic gear icon
// and not a bare "sent via iMessage" (the observed defect: with two
// conversations interleaved in one stream the owner could not tell who a bubble
// went to). The pill wording is the SAME outboundBadge the resolver-routed
// replies use, so the two outbound paths cannot drift; the recipient is read
// cheaply from the tool's own arguments (raw handle/number as the honest
// fallback when no display name is available client-side).
//
// DERIVED, not a hand list (2026-07-08 defect-class sweep): a tool renders a
// message bubble iff it is a real human-channel send (channelOfSendTool knows
// them all: iMessage/Teams/SMS/Gmail+Outlook send+reply+FORWARD) AND it carries
// a body. Only voice_call is bodiless, so it is the single exclusion. The old
// hand Set had silently dropped gmail_forward / outlook_forward (both carry a
// note); deriving from the canonical map fixes that and can never fall behind a
// new send channel again.
const isChannelSendBubbleTool = (name: string): boolean =>
  channelOfSendTool(name) !== null && name !== 'voice_call';

// The recipient the send targeted, pulled from the tool's own arguments. Replies
// target the inbound thread and carry no explicit recipient, so they return null
// and the badge falls back to channel-only wording.
const sendToolRecipient = (name: string, input: Record<string, unknown>): string | null => {
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (name) {
    case 'imessage_send': return s(input.to) ?? s(input.recipient) ?? s(input.handle);
    case 'sms_send': return s(input.to) ?? s(input.number) ?? s(input.recipient);
    case 'teams_send_message': {
      // A Teams chat id is a long GUID, not a display name, and resolving it to
      // one needs a network call the dashboard must not make. Show the same
      // truncated id the resolver's Teams marker uses so the two paths match.
      const chat = s(input.chat_id) ?? s(input.chatId);
      return chat ? `${chat.slice(0, 8)}…` : null;
    }
    case 'gmail_send':
    case 'outlook_send': return s(input.to);
    default: return null; // replies: inbound thread, no explicit recipient in input
  }
};

const ChannelSendBubble = ({ msg, toolUse, serverBadge }: { msg: ChatMessage; toolUse: ContentBlock; serverBadge?: OutboundChannelInfo | null }) => {
  const name = toolUse.name ?? '';
  const channel = channelOfSendTool(name);
  if (!channel || !isChannelSendBubbleTool(name)) return null;
  // imessage_send / teams_send_message use `message`; outlook/gmail use `body`.
  const messageText = typeof toolUse.input?.message === 'string'
    ? toolUse.input.message
    : typeof toolUse.input?.body === 'string'
      ? toolUse.input.body
      : typeof toolUse.input?.text === 'string'
        ? toolUse.input.text
        : '';
  if (!messageText) return null;
  // Prefer the server-resolved outbound badge: the engine writes a persisted
  // routing marker for this send carrying the recipient's display name resolved
  // from the contacts store / safe-sender registry (parsed into serverBadge by
  // the outboundChannelByAssistantId walk). Only when no marker is attached
  // (older messages, or a reply with no explicit recipient) do we fall back to
  // reading the raw handle from the tool input — the honest handle-only
  // fallback, never a second label on top of the server one.
  const badge = serverBadge ?? outboundBadge(channel, sendToolRecipient(name, (toolUse.input as Record<string, unknown>) ?? {}));
  return (
    <div className="flex flex-col items-start">
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 ml-1">
        <span className="text-ui/40">{badge.emoji}</span>
        <span>{badge.label}</span>
      </div>
      <div className="bubble-assistant max-w-[75%] px-4 py-3 text-ui">
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed break-words">
          {messageText}
        </pre>
        <div className="text-xs mt-2 text-tertiary">
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

const ToolResultBubble = ({ msg }: { msg: ChatMessage }) => {
  const { blocks } = parseMessageContent(msg.content);

  if (!blocks) {
    // Fallback for non-JSON tool messages
    return (
      <div className="flex justify-start">
        <div className="max-w-[75%]">
          <ToolResultBlock toolUseId="" content={msg.content} isError={false} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[75%]">
        {blocks
          .filter((b) => b.type === 'tool_result')
          .map((b, i) => {
            // content can be a string OR an array of content blocks
            // (e.g., file_read on an image returns [{type:'text',...},{type:'image',...}]).
            // Extract text for display; images are shown as placeholders.
            let displayContent: string;
            const rawContent = b.content as unknown;
            if (typeof rawContent === 'string') {
              displayContent = rawContent;
            } else if (Array.isArray(rawContent)) {
              displayContent = (rawContent as Array<Record<string, unknown>>)
                .map((block: Record<string, unknown>) => {
                  if (block.type === 'text') return block.text as string;
                  if (block.type === 'image') return '[Image content — visible to model via vision]';
                  if (block.type === 'document') return `[PDF: ${(block.title as string) ?? 'document'}]`;
                  return '';
                })
                .filter(Boolean)
                .join('\n');
            } else {
              displayContent = JSON.stringify(rawContent);
            }
            return (
              <ToolResultBlock
                key={`${msg.id}-result-${i}`}
                toolUseId={b.tool_use_id ?? ''}
                content={displayContent}
                isError={!!b.is_error}
              />
            );
          })}
      </div>
    </div>
  );
};

// ── Main Chat Component ──

interface ChatProps {
  panel?: {
    title?: string;
    meta?: string;
    content: ReactNode;
  } | null;
}

export const Chat = ({ panel = null }: ChatProps) => {
  // The active agent drives the whole stage. Defaults to the primary
  // ("dojo master", shown as DOJO); selecting an agent swaps the chat,
  // composer target, orb, and labels to that agent.
  const { agentId: activeAgentId, agentName: selectedAgentName } = useActiveAgent();
  // While a technique-build session is active, the chat BECOMES the trainer
  // conversation: it targets the trainer agent, prepends build/edit context on
  // the first message, and the Technique Mat docks on the right. With no
  // session this is fully inert and the chat behaves exactly as before.
  const techSession = useTechniqueSession();
  const AGENT_ID = techSession.active ? techSession.trainerAgentId : activeAgentId;
  const activeAgentName = techSession.active
    ? (techSession.trainerName || 'Trainer')
    : selectedAgentName;
  const agentIdRef = useRef(AGENT_ID);
  agentIdRef.current = AGENT_ID; // always up to date for closures

  const [agentName, setAgentName] = useState('');
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  // Kind of the current working turn, from agent:status. 'a2a' = the agent is
  // only talking to another agent; we keep the composer quiet for those (no
  // thinking dots / stop button) unless wordy mode is on.
  const [turnKind, setTurnKind] = useState<'user' | 'a2a'>('user');
  // UX-REPAIR T7. What the LAST working frame said about serving a human, kept as its own
  // three-state value: `true` / `false` / `undefined` for a bare legacy frame that carried
  // no such field. It is deliberately NOT folded into `turnKind`: a background scheduler /
  // PM-poke / watcher turn is `turnKind:'user'` AND `userFacing:false`, so the two facts
  // disagree on exactly the frames this guard is for.
  const [turnUserFacing, setTurnUserFacing] = useState<boolean | undefined>(undefined);
  // The user has a request in flight (sent a message, no completion yet). Drives
  // the working UI (thinking dots + stop button) so it stays visible for the
  // WHOLE request — even when the agent dips into agent-to-agent (a2a)
  // coordination to fulfill it. Those a2a sub-turns are turnKind:'a2a', which on
  // its own would hide the UI and make the agent look dead mid-task (regression:
  // a user asked the agent to SSH somewhere and saw no dots/stop while it worked
  // because the work ran over a2a). Set on send, cleared when the agent goes
  // idle (request done). Background a2a churn never sets this, so the UI still
  // stays quiet for PURE inter-agent work with no user waiting.
  const [awaitingUserReply, setAwaitingUserReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const toast = useToast();
  const [wordyMode, setWordyMode] = useState(() => {
    const stored = localStorage.getItem('dojo_wordy_mode');
    return stored === 'true';
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // "Stick to bottom" behaviour (Claude-style). Pinned = the view follows new
  // content. When the user scrolls up to read history we UNPIN: auto-scroll
  // stops (so agent activity no longer yanks them down) and a "jump to latest"
  // button appears above the composer. Re-pin only when they click it or scroll
  // back to the bottom. The ref mirrors the state so the WS handlers + the
  // messages effect (set up once / not in deps) read the live value.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const pinnedToBottomRef = useRef(true);
  // True while a "jump to latest" is in flight: the scroll handler must not
  // un-pin (and re-show the button) on the intermediate positions of a multi-
  // frame jump, or a deep jump that lands on a partial layout would flip back.
  const jumpingRef = useRef(false);
  const NEAR_BOTTOM_PX = 80; // within this of the bottom counts as "at the bottom"

  useEffect(() => {
    api.getSetting('primary_agent_name').then(r => {
      if (r.ok && r.data.value) setAgentName(r.data.value);
    });
  }, []);
  const { subscribe } = useWebSocket();
  const currentToolCallsRef = useRef<ToolCallData[]>([]);

  // ── Orb mood ──
  // The active agent can lead a reply with a `((mood: NAME))` marker; we read it
  // out of its (streaming) text and emote the orb. Scoped to the active agent
  // because this Chat is bound to it. Per-message accumulator drives a live
  // reaction as the reply starts; lastMoodRef de-dupes repeat sets.
  const dojoOrb = useDojoOrb();
  // Mirror turnKind / wordyMode into refs so the WS handler closures (set up
  // once) read the CURRENT value. Used to suppress live streaming bubbles on
  // inter-agent (a2a) turns: those messages are hidden on reload (source='a2a'),
  // but a streaming bubble is created with no origin/source, so it bypasses the
  // render-time visibility filter and flashes the agent-to-agent text, tool
  // badges, and thinking dots into the user's chat until reconcile. Gating the
  // bubble creation here is the uniform fix (covers content AND reasoning chunks).
  const turnKindRef = useRef(turnKind);
  turnKindRef.current = turnKind;
  const wordyModeRef = useRef(wordyMode);
  wordyModeRef.current = wordyMode;
  // True when the current turn's streamed output must NOT render in the user's
  // chat (inter-agent turn, wordy mode off). Wordy mode deliberately surfaces
  // inter-agent activity, so it streams normally there.
  const suppressStreamForTurn = () => turnKindRef.current === 'a2a' && !wordyModeRef.current;
  const streamTextRef = useRef<Map<string, string>>(new Map());
  // De-dupe per (message, emotion): streaming chunks of the SAME message don't
  // re-fire, but a NEW message re-fires even the same mood (so two angry
  // replies both flare). Emotions auto-release via their `hold`, so each is a
  // momentary burst that settles back to rest.
  const lastEmotionKeyRef = useRef<string | null>(null);
  const applyMood = useCallback((msgId: string, text: string) => {
    const emotion = moodToEmotion(parseMoodMarker(text));
    if (!emotion) return;
    const key = `${msgId}:${emotion}`;
    if (key === lastEmotionKeyRef.current) return;
    lastEmotionKeyRef.current = key;
    dojoOrb.setEmotion(emotion);
  }, [dojoOrb]);

  // Reset mood tracking when the active agent changes (a new agent starts
  // neutral; its own next reply re-drives the orb).
  useEffect(() => {
    lastEmotionKeyRef.current = null;
    streamTextRef.current.clear();
  }, [AGENT_ID]);

  // Auto-scroll — fires on (a) new message appended and (b) the last
  // message growing during streaming. Streaming-chunk scrolls only fire
  // when the user is already near the bottom, so we don't yank them
  // down if they scrolled up to read history. v2.5.45.
  const lastMessageIdRef = useRef<string | null>(null);
  const lastMessageSigRef = useRef<string | null>(null);
  const scrollToBottom = useCallback((instant?: boolean) => {
    if (instant) {
      // Instant scroll — used on initial load and during streaming chunks
      // (smooth-animating every chunk would queue jank).
      const container = messagesContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // Reliable "jump to the true bottom" for the jump-to-latest button. A single
  // scrollTop=scrollHeight lands on a stale/partial height when the user has
  // scrolled far up and paginated older messages in — the layout below hasn't
  // settled yet, so it stops on a random "floor" (worse on mobile). Re-assert the
  // bottom across several frames + a couple of timeouts (same belt-and-braces the
  // initial load uses, which is why a refresh always lands at the bottom). The
  // jumpingRef keeps the scroll handler from un-pinning on the way down.
  const jumpToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    jumpingRef.current = true;
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);
    const go = () => { const c = messagesContainerRef.current; if (c) c.scrollTop = c.scrollHeight; };
    go();
    requestAnimationFrame(go);
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 90);
    setTimeout(() => { go(); jumpingRef.current = false; }, 320);
  }, []);

  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!last) return;
    // Signature combines id + content length, so a streaming bubble whose
    // id stays the same but whose content grows still triggers a re-scroll.
    const sig = `${last.id}:${last.content?.length ?? 0}`;
    if (sig === lastMessageSigRef.current) return;
    const isNewMessage = last.id !== lastMessageIdRef.current;
    lastMessageIdRef.current = last.id;
    lastMessageSigRef.current = sig;
    if (isNewMessage) {
      // Only follow new messages when pinned. If the user scrolled up to read
      // history, a new agent message (thinking/work/system) must NOT yank them
      // back down — that was the annoyance. They stay put; the jump-to-latest
      // button is already showing.
      if (pinnedToBottomRef.current) scrollToBottom();
    } else {
      // Same message growing (streaming chunk): only follow if user is
      // near the bottom. ~80px slack so a slight scroll-up doesn't break
      // the follow behavior, but reading older history isn't disturbed.
      const container = messagesContainerRef.current;
      if (container) {
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
        if (nearBottom) scrollToBottom(true);
      }
    }
  }, [messages, scrollToBottom]);

  // Load chat history
  useEffect(() => {
    // During a technique session, wait until the resume-vs-clear decision has
    // resolved so we don't load a stale trainer conversation that's about to be
    // wiped (or render before a resumed one is confirmed). Clear the prior
    // agent's messages immediately so the previous conversation doesn't bleed
    // through while the trainer history loads.
    if (techSession.active && !techSession.ready) {
      setMessages([]);
      setLoading(true);
      return;
    }
    const loadHistory = async () => {
      // Check if agent is currently working (e.g. user navigated away and came back)
      const agentResult = await api.getAgent(AGENT_ID);
      if (agentResult.ok && agentResult.data.status === 'working') {
        setIsWorking(true);
      }

      // Load model name lookup for wordy mode display
      const modelsResult = await api.getModels();
      if (modelsResult.ok) {
        const lookup: Record<string, string> = {};
        for (const m of modelsResult.data) {
          lookup[m.id] = m.name;
        }
        setModelNames(lookup);
      }

      const result = await api.getChatHistory(AGENT_ID, 200, undefined, wordyMode);
      if (result.ok) {
        let loaded: Message[] = result.data;
        // AUTO-BACKFILL (incident 2026-07-06, the blank-chat guarantee): the
        // serving contract stays raw pages + client-side visibility, but a page
        // can legitimately contain ZERO renderable rows when machine traffic
        // (agent coordination) sits on top of the conversation. In that case do
        // exactly what a user scrolling up would do, keep fetching older pages
        // until real conversation renders (or history ends). Wordy mode renders
        // every row, so its first page always satisfies the floor immediately.
        // Bounded: 60 extra pages of 200 covers a pathological 12k-row pileup
        // in a few seconds of background fetches; past that, the scroll-up path
        // continues as always. After a user updates, this makes "open the chat,
        // see nothing" impossible, their conversation is always dug up.
        const rendersInRegular = (m: Message) =>
          m.role === 'system'
            ? false
            : (m.role !== 'user' && m.role !== 'assistant')
              ? false
              : classifyMessageForDisplay(m).tier === 'user-visible';
        const renderableCount = () =>
          wordyMode ? loaded.length : loaded.filter(rendersInRegular).length;
        let backfills = 0;
        while (renderableCount() < 15 && loaded.length > 0 && backfills < 60) {
          const oldest = loaded[0]?.id;
          if (!oldest) break;
          const older = await api.getChatHistory(AGENT_ID, 200, oldest, wordyMode);
          if (!older.ok || older.data.length === 0) break;
          loaded = [...older.data, ...loaded];
          backfills++;
        }
        setMessages(
          loaded.map((m: Message) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            modelId: m.modelId,
            attachments: m.attachments,
            source: m.source ?? null,
            origin: m.origin,
            conversationId: m.conversationId,
            displayKind: m.displayKind ?? null,
          })),
        );
        setHasMore(result.data.length >= 50);
        // Fresh conversation load starts pinned to the bottom.
        pinnedToBottomRef.current = true;
        setPinnedToBottom(true);
        // Scroll to bottom on initial load — use instant (not smooth).
        // Multiple fallbacks because DOM layout isn't always complete
        // after a single rAF (long message lists, images, attachments).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToBottom(true);
          });
        });
        // Fallback: catch any remaining layout shifts (lazy images, etc.)
        setTimeout(() => scrollToBottom(true), 150);
        setTimeout(() => scrollToBottom(true), 500);
      }
      setLoading(false);
    };
    loadHistory();
    // wordyMode is a dep: the two modes are now different SERVER queries (wordy
    // adds the store's own-output rows), so toggling wordy must refetch history
    // rather than re-filter a single feed client-side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AGENT_ID, techSession.active, techSession.ready, wordyMode]);

  // Load older messages when scrolling to top
  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;

    setLoadingMore(true);
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    const result = await api.getChatHistory(AGENT_ID, 50, oldestId, wordyMode);
    if (result.ok && result.data.length > 0) {
      const older = result.data.map((m: Message) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        attachments: m.attachments,
        source: m.source ?? null,
        origin: m.origin,
        conversationId: m.conversationId,
        displayKind: m.displayKind ?? null,
      }));
      setMessages(prev => [...older, ...prev]);
      setHasMore(result.data.length >= 50);

      // Maintain scroll position after prepending
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        }
      });
    } else {
      setHasMore(false);
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore, messages, AGENT_ID, wordyMode]);

  // Detect scroll to top
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Track pin state: at/near the bottom → pinned (follow new content);
      // scrolled up → unpinned (stop following, show the jump-to-latest button).
      // Only commit a React state change when the value actually flips, so this
      // hot scroll handler doesn't re-render on every pixel.
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
      // While a jump-to-latest is settling, don't un-pin on an intermediate
      // (still-above-bottom) position — that's what made a deep jump bounce to a
      // partial floor and the button flicker back.
      if (!jumpingRef.current && nearBottom !== pinnedToBottomRef.current) {
        pinnedToBottomRef.current = nearBottom;
        setPinnedToBottom(nearBottom);
      }
      if (container.scrollTop < 100 && hasMore && !loadingMore) {
        loadOlderMessages();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, loadOlderMessages]);

  // Subscribe to WebSocket events
  useEffect(() => {
    // Hoisted at the top of the effect so every handler below can use it.
    // See the call sites for the full reasoning — short version: when the
    // agent reaches a terminal state via any code path, drop empty
    // streaming bubbles (ghost dots) and stop the dots on bubbles that
    // already have content. Engine-agnostic backstop for the "agent is
    // done but the dots are still bouncing" class of bug.
    const reconcileStreamingBubbles = () => {
      setMessages((prev) =>
        prev
          .filter((m) => !(m.isStreaming && (!m.content || m.content.length === 0)))
          .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
      );
    };

    const unsubWorkingNote = subscribe('chat:workingnote', (event: WsEvent) => {
      const e = event as ChatWorkingNoteEvent;
      if (e.agentId !== agentIdRef.current) return;
      setMessages((prev) => {
        // ── SWEEP CORE-2 item 7 — THE RE-CLASSIFICATION ARM ──
        // The turn ended, the ledger named a different bubble as the answer, and THIS row
        // moved into the working-note lane. It is a real, persisted assistant row: it keeps
        // its id, its role and every byte of its content (the cache law), and only its stored
        // `display_kind` changed. So the client must convert IN PLACE by stamping the same
        // kind — fabricating a `[working-note]`-prefixed system row here would make the live
        // view disagree with the reload that serves the row as it actually is, which is the
        // exact divergence this event was built to close.
        if (e.reclassified) {
          const at = prev.findIndex((m) => m.id === e.messageId);
          if (at < 0) return prev;
          const out = [...prev];
          out[at] = { ...out[at], displayKind: 'working-note', isStreaming: false };
          return out;
        }
        // RC-9: carry the internal flag through the persisted content prefix so the
        // render-time filter hides an internal note (routed-channel human turn) outside
        // wordy mode, identically live and on reload.
        const note: ChatMessage = {
          id: e.noteId,
          role: 'system',
          content: `${e.internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX}${e.content}`,
          createdAt: new Date().toISOString(),
        };
        // Convert the streamed bubble in place so the text never vanishes; if
        // it was never streamed (or already reconciled away), append instead.
        const idx = prev.findIndex((m) => m.id === e.messageId);
        if (idx >= 0) {
          const out = [...prev];
          out[idx] = note;
          return out;
        }
        if (prev.some((m) => m.id === e.noteId)) return prev; // reconnect dupe
        return [...prev, note];
      });
    });
    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentIdRef.current) return;
      // Inter-agent turn (wordy off): never build a streaming bubble. The bubble
      // has no origin/source so the render-time visibility filter can't hide it —
      // it would flash the agent-to-agent reply (text, tool badges, thinking
      // dots) into the chat until reconcile. The finalized message is hidden on
      // reload via source='a2a'; this keeps it hidden live too.
      if (suppressStreamForTurn()) return;

      // Orb mood: accumulate this message's streamed text and emote the orb as
      // soon as a `((mood: NAME))` marker appears (it leads the reply).
      const accum = (streamTextRef.current.get(e.messageId) ?? '') + e.content;
      streamTextRef.current.set(e.messageId, accum);
      applyMood(e.messageId, accum);
      if (e.done) streamTextRef.current.delete(e.messageId);

      // v2.5.22 — On every done event, snapshot the tool-call ref and clear
      // it BEFORE entering the state updater. Previously the clear was only
      // inside the idx>=0 branch, which meant a tool-only iteration (no
      // streaming bubble was ever created because the assistant message
      // had no text) would leave currentToolCallsRef populated. The NEXT
      // iteration's streaming bubble's done event then picked up those
      // stale tool calls and attached them as the new bubble's toolCalls.
      // That triggered the "duplicate tool calls below the response" bug:
      // the tool_use blocks already render via the JSON content's
      // hasToolUse path inside iter1's bubble, AND a second time via
      // msg.toolCalls inside iter2's plain-text bubble (where hasToolUse
      // is false, so the toolCalls-render branch activates).
      const toolCallsSnapshot = e.done && currentToolCallsRef.current.length > 0
        ? [...currentToolCallsRef.current]
        : null;
      if (e.done) currentToolCallsRef.current = [];

      setMessages((prev) => {
        // Look up by messageId rather than just the tail — when a reasoning
        // bubble was created first, the answer chunks need to update THAT
        // bubble (not append a new one at the end).
        const idx = prev.findIndex((m) => m.id === e.messageId && m.isStreaming);
        if (idx >= 0) {
          const existing = prev[idx];
          const updated = {
            ...existing,
            content: existing.content + e.content,
            // Once answer text starts arriving, reasoning is done streaming.
            isReasoningStreaming: false,
          };
          if (e.done) {
            updated.isStreaming = false;
            updated.modelId = (e as any).modelId ?? null;
            updated.toolCalls = toolCallsSnapshot ?? undefined;
            if (pinnedToBottomRef.current) requestAnimationFrame(() => scrollToBottom());
          }
          const out = [...prev];
          out[idx] = updated;
          return out;
        } else if (prev.some((m) => m.id === e.messageId)) {
          // Already have this message (finalized) -- skip duplicate from reconnect
          return prev;
        } else {
          // New streaming message — but skip if it's empty and already done (ghost bubble)
          if (e.done && (!e.content || e.content.trim().length === 0)) {
            return prev;
          }
          return [
            ...prev,
            {
              id: e.messageId,
              role: 'assistant' as const,
              content: e.content,
              createdAt: new Date().toISOString(),
              modelId: (e as any).modelId ?? null,
              isStreaming: !e.done,
            },
          ];
        }
      });
    });

    // Reasoning / thinking deltas (DeepSeek native, OpenRouter unified).
    // Either updates the existing streaming bubble (if one already exists
    // for this messageId) or creates a fresh one with reasoning but no
    // answer text yet — the eventual chat:chunk for the same messageId
    // will then start filling in the answer.
    const unsubReasoning = subscribe('chat:reasoning_chunk', (event: WsEvent) => {
      const e = event as { type: 'chat:reasoning_chunk'; agentId: string; messageId: string; content: string; done: boolean };
      if (e.agentId !== agentIdRef.current) return;
      // Same as chat:chunk — inter-agent reasoning must not create a live bubble.
      if (suppressStreamForTurn()) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.messageId);
        if (idx >= 0) {
          const existing = prev[idx];
          const out = [...prev];
          out[idx] = {
            ...existing,
            reasoningContent: (existing.reasoningContent ?? '') + e.content,
            isReasoningStreaming: !e.done,
          };
          return out;
        }
        // Reasoning arrived before any chat:chunk — create the bubble shell
        // with empty content, the answer chunks will populate it later.
        return [
          ...prev,
          {
            id: e.messageId,
            role: 'assistant' as const,
            content: '',
            createdAt: new Date().toISOString(),
            isStreaming: true,
            reasoningContent: e.content,
            isReasoningStreaming: !e.done,
          },
        ];
      });
    });

    const unsubToolCall = subscribe('chat:tool_call', (event: WsEvent) => {
      const e = event as ChatToolCallEvent;
      if (e.agentId !== agentIdRef.current) return;
      // LIVE = RELOAD (incident 2026-07-06): tool badges from an inter-agent turn
      // must obey the same suppression the text stream does. Without this, an
      // agent-coordination turn painted a wall of EXEC/FILE_READ pills into
      // regular-mode chat live, which then vanished on refresh (the persisted
      // rows are source='a2a' and reload hides them).
      if (suppressStreamForTurn()) return;
      currentToolCallsRef.current.push({
        name: e.tool,
        args: e.args,
      });
    });

    const unsubToolResult = subscribe('chat:tool_result', (event: WsEvent) => {
      const e = event as ChatToolResultEvent;
      if (e.agentId !== agentIdRef.current) return;
      if (suppressStreamForTurn()) return;
      const tc = currentToolCallsRef.current.find((t) => t.name === e.tool && !t.result);
      if (tc) {
        tc.result = e.result;
      }
    });

    const unsubError = subscribe('chat:error', (event: WsEvent) => {
      const e = event as ChatErrorEvent;
      if (e.agentId !== agentIdRef.current) return;
      // Phase 8 F1 fix: honor the severity field. Was hardcoding "rate limits
      // are warnings, everything else is a persistent red error" — which left
      // recovered agents and the engine's info-level events (HEALER_DISPATCHED,
      // AGENT_RECOVERED, SEMANTIC_DUPLICATE dedup) showing as red errors.
      const isRateLimit = e.code === 'RATE_LIMITED' || e.error.includes('429') || e.error.toLowerCase().includes('rate_limit') || e.error.toLowerCase().includes('overloaded');
      const sev: 'info' | 'warning' | 'error' = e.severity ?? (isRateLimit ? 'warning' : 'error');
      if (sev === 'info') {
        toast.success(e.error);
        // Recovered → clear isWorking lock so UI re-enables input.
        if (e.code === 'AGENT_RECOVERED') {
          setIsWorking(false);
          reconcileStreamingBubbles();
        }
      } else if (sev === 'warning') {
        toast.warning(e.error);
      } else {
        toast.error(e.error); // stays until dismissed
        setIsWorking(false);
        reconcileStreamingBubbles();
      }
    });

    // Subscribe to full message events (tool results, system messages, etc.)
    // When the canonical assistant message arrives for a streaming bubble we
    // REPLACE the bubble's content with the JSON payload (which has the
    // tool_use blocks the chunked plain-text version is missing). Pre-2026-
    // 04-30 this skipped on id match, so tool-call cards in wordy mode only
    // appeared after a page reload.
    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentIdRef.current) return;

      // Orb mood from the canonical message (covers non-streamed replies and
      // any marker the stream parse missed).
      if (e.message.role === 'assistant') applyMood(e.message.id, e.message.content);

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.message.id);
        if (idx >= 0) {
          const existing = prev[idx];
          const updated = [...prev];
          updated[idx] = {
            ...existing,
            content: e.message.content,
            attachments: e.message.attachments ?? existing.attachments,
            createdAt: e.message.createdAt ?? existing.createdAt,
            // Clear the streaming-collected toolCalls — the JSON content is
            // now the source of truth. If the canonical has tool_use blocks
            // AssistantBubble renders them via the hasToolUse path; if not,
            // the live toolCalls were just a streaming artifact.
            toolCalls: undefined,
            isStreaming: false,
            // Carry the turn's conversation key so a finalized tool-only row's
            // chips get the same background-vs-user discrimination live as on
            // reload (null = background run, chips hidden in regular mode).
            conversationId: e.message.conversationId ?? existing.conversationId,
          };
          // v2.5.21 — Removed the v2.5.20 move-to-tail. It fired when
          // chat:message arrived for a streaming bubble AND the bubble
          // wasn't at the array tail. The intended trigger: tool messages
          // got appended after the streaming bubble during the turn, so
          // move the response to the bottom on finalization. The unintended
          // trigger: user sends a new message DURING streaming, that user
          // temp bubble gets appended after the streaming bubble, then
          // chat:message arrives and the agent's response jumps PAST the
          // user's new message — which the user sees as "my new message
          // appears above the agent's previous response." Way worse than
          // the chronology issue it was trying to fix.
          return updated;
        }

        // For user messages, reconcile with any optimistic temp- bubble that
        // handleSend pushed locally. Without this the same user message
        // appears twice — once from the optimistic insert, once from the
        // server's broadcast — because the temp id never matches the real one.
        if (e.message.role === 'user') {
          // Compare on the typed-text core, not the full content. The
          // server appends [File attached: ...] tags to the broadcast
          // payload but the optimistic temp bubble only has what the
          // user typed — without normalizing, every message-with-attachment
          // failed dedup and rendered twice.
          // Strip injected technique build/edit context too: the broadcast
          // carries the full wire message (context + marker + typed) but the
          // optimistic temp bubble only has the typed text.
          const broadcastCore = stripBuilderContext(stripAttachmentTags(e.message.content));
          const tempIdx = prev.findIndex(
            (m) => m.role === 'user' && m.id.startsWith('temp-') &&
                   stripBuilderContext(stripAttachmentTags(m.content)) === broadcastCore,
          );
          if (tempIdx >= 0) {
            const updated = [...prev];
            updated[tempIdx] = {
              ...updated[tempIdx],
              id: e.message.id,
              createdAt: e.message.createdAt,
              attachments: e.message.attachments ?? updated[tempIdx].attachments,
            };
            return updated;
          }
        }

        return [
          ...prev,
          {
            id: e.message.id,
            role: e.message.role,
            content: e.message.content,
            createdAt: e.message.createdAt,
            // Carry attachments through from the WS payload so thumbnails
            // render immediately for iMessage-sourced messages (previously
            // only hydrated on page reload via the HTTP GET).
            attachments: e.message.attachments,
            source: e.message.source ?? null,
            origin: e.message.origin,
            conversationId: e.message.conversationId,
          },
        ];
      });
    });

    // PHASE-1 T9 — an explicit retraction replaces the empty-chat:message hack.
    //
    // The engine sometimes decides a bubble that already streamed should not become a
    // message: a bare [no-reply], a redundant closeout, a ghosted work ask. It used to say
    // so by broadcasting a chat:message with EMPTY content, and the handler above read
    // "empty" as "delete". Two things were wrong with that. The event named "here is a
    // message" carried its own opposite, so "every broadcast has a persisted row" could
    // never be stated (those three deliberately had none). And when NO bubble existed for
    // the id, the empty message fell through to the append branch and rendered as a bare
    // timestamp — the stray-blank-bubble bug (research 17 §4 item 1).
    //
    // A retraction is its own event now. Dropping a bubble that is not there is a no-op,
    // which is what it always should have been.
    const unsubRetract = subscribe('chat:retract', (event: WsEvent) => {
      const e = event as { agentId: string; messageId: string };
      if (e.agentId !== agentIdRef.current) return;
      setMessages((prev) => prev.filter((m) => m.id !== e.messageId));
    });

    // Track the agent's working state from agent:status events. This
    // covers external triggers (iMessage, scheduled runs, agent-to-agent
    // messaging) where the user never called handleSend locally — the
    // thinking dots and the send→stop button swap need to react live
    // without requiring a page reload to pick up the backend state.
    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string; turnKind?: 'user' | 'a2a'; userFacing?: boolean };
      if (e.agentId !== agentIdRef.current) return;
      if (e.status === 'working') {
        setIsWorking(true);
        const kind = e.turnKind ?? 'user';
        setTurnKind(kind);
        // UX-REPAIR T7: record the frame's OWN answer, including "it did not say"
        // (undefined). Since the server stopped fabricating `turnKind`, this is the only
        // field frame 1 of a background turn has to keep the composer quiet with.
        setTurnUserFacing(e.userFacing);
        // A user-FACING working status means the agent is on a turn serving a human
        // conversation (dashboard / iMessage / voice). Latch it (the same flag
        // handleSend sets) so the working UI (dots + stop) stays up for the WHOLE
        // turn, even during an early phase that only ran tool activity (which renders
        // nothing in regular mode) and even if the agent later dips into a2a
        // coordination (which flips turnKind to 'a2a'). handleSend covers dashboard
        // sends; this covers externally-triggered user turns (iMessage / voice) where
        // handleSend never ran. userFacing (not just turnKind==='user') is required so
        // a BACKGROUND engine turn (scheduler / PM poke / watcher, also turnKind
        // 'user' but userFacing:false) does NOT latch, which would otherwise leave the
        // latch stuck on after background noise. Pure background a2a is turnKind 'a2a'
        // and stays quiet regardless.
        if (kind === 'user' && e.userFacing === true) setAwaitingUserReply(true);
      } else if (e.status === 'idle' || e.status === 'error') {
        setIsWorking(false);
        // Clear the "a user request is unanswered" latch ONLY when the turn that
        // just ended was user-facing. A pure background a2a / engine turn's idle
        // (userFacing:false) must NOT wipe the latch a still-unanswered dashboard
        // send set: on a busy box the send queues behind the background turn, and
        // the background idle used to clear the latch before the queued user turn
        // even started, killing the dots + stop button (the busy-box race). A legacy
        // / raw status with no userFacing field keeps the old clear-on-idle behavior
        // (undefined !== false) so unrelated idle broadcasts still resolve the UI.
        if (e.userFacing !== false) setAwaitingUserReply(false);
        reconcileStreamingBubbles();
      }
    });

    const unsubTerminated = subscribe('agent:terminated', (event: WsEvent) => {
      const e = event as { agentId: string; reason: string };
      if (e.agentId !== agentIdRef.current) return;
      toast.error(`Agent terminated: ${e.reason}`);
      setIsWorking(false);
      setAwaitingUserReply(false);
      reconcileStreamingBubbles();
    });

    // Server stamps assistant messages as voice-delivered when voice mode
    // routes their content through TTS, then broadcasts this event so the
    // local bubble can update its source and render the "via voice" badge
    // without a refetch.
    const unsubSource = subscribe('chat:source_updated', (event: WsEvent) => {
      const e = event as { agentId: string; messageId: string; source: 'voice' | null };
      if (e.agentId !== agentIdRef.current) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.messageId);
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], source: e.source };
        return updated;
      });
    });

    return () => {
      unsubWorkingNote();
      unsubChunk();
      unsubReasoning();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubMessage();
      unsubRetract();
      unsubStatus();
      unsubTerminated();
      unsubSource();
    };
  }, [subscribe, AGENT_ID, applyMood]);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setIsWorking(true);
    setAwaitingUserReply(true); // user is now waiting on a reply — keep the working UI up through any a2a sub-work
    // Sending re-pins: the user wants to see their message and the reply.
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);

    // Technique session: prepend build/edit/setup/refresh context to the wire
    // message. The bubble still shows only what the user typed (UserBubble
    // strips the context); commit/rollback advances the one-shot context gate.
    const plan = techSession.active ? techSession.prepareOutgoing(content) : null;
    const outgoing = plan ? plan.outgoing : content;

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, userMsg]);

    const result = await api.sendMessage(AGENT_ID, outgoing, attachments);
    if (!result.ok) {
      plan?.rollback();
      setIsWorking(false);
      if (result.error.includes('busy')) {
        toast.info(`${agentName || 'Agent'} is mid-mission — your message will be delivered when they finish.`);
      } else {
        toast.error(result.error);
      }
    } else {
      plan?.commit();
    }
  };

  // v2.7.25 — tool_use_id → is_error lookup so the ChannelSendBubble can
  // hide itself when its underlying tool was refused. Mirrors the same
  // logic in AgentDetail.tsx; see that file for the longer rationale.
  //
  // v2.7.26 — MUST sit ABOVE the `if (loading) return ...` early exit.
  // React hook order has to be identical across every render of the
  // component. Placing the useMemo below the early return meant it
  // didn't run on the first (loading=true) render but ran once loading
  // flipped, producing React error #310 ("Rendered more hooks than
  // during the previous render") and a blank chat page.
  const toolResultErrorById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (!Array.isArray(parsed)) continue;
        for (const block of parsed) {
          if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            m.set(block.tool_use_id, block.is_error === true);
          }
        }
      } catch { /* not JSON */ }
    }
    return m;
  }, [messages]);

  // tool_use_id → { content, isError } for the dojo3 chip-tool expansion. Mirrors
  // ToolResultBubble's content extraction (string OR array of content blocks) so a
  // collapsed chip can reveal the same result text wordy mode shows in its cards.
  const toolResultById = useMemo(() => {
    const m = new Map<string, ToolResultInfo>();
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      try {
        const parsed = JSON.parse(msg.content);
        if (!Array.isArray(parsed)) continue;
        for (const block of parsed) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const raw = block.content as unknown;
          let content: string;
          if (typeof raw === 'string') {
            content = raw;
          } else if (Array.isArray(raw)) {
            content = (raw as Array<Record<string, unknown>>)
              .map((b) => {
                if (b.type === 'text') return b.text as string;
                if (b.type === 'image') return '[Image content — visible to model via vision]';
                if (b.type === 'document') return `[PDF: ${(b.title as string) ?? 'document'}]`;
                return '';
              })
              .filter(Boolean)
              .join('\n');
          } else {
            content = JSON.stringify(raw);
          }
          m.set(block.tool_use_id, { content, isError: block.is_error === true });
        }
      } catch { /* not JSON */ }
    }
    return m;
  }, [messages]);

  // Group adjacent tool-only assistant messages so their pills render
  // in one horizontal flex-wrap row instead of stacking vertically.
  // role='tool' rows are filtered to null in non-wordy mode, so they
  // don't break a visual run between two consecutive tool-only
  // assistant messages - the walk below skips them. Anything else
  // that renders visibly (user bubble, response bubble, divider,
  // routing marker) closes the current group.
  const toolPillGrouping = useMemo(() => {
    const groupByFirstId = new Map<string, ChatMessage[]>();
    const skipIds = new Set<string>();
    if (wordyMode) return { groupByFirstId, skipIds };
    // Classify each message for the grouping walk (V2b):
    //   'visible' = tool-only turn with at least one non-bookkeeping tool
    //               (renders a badge; group it),
    //   'hidden'  = tool-only turn that is ALL bookkeeping (hidden in regular
    //               mode, so skip it like a role='tool' row without breaking a
    //               run of adjacent visible tool badges),
    //   null      = anything that renders real content, which closes the group.
    // A non-errored channel-send renders as a ChannelSendBubble (real content),
    // so it returns null and breaks the group.
    const toolOnlyKind = (msg: ChatMessage): 'visible' | 'hidden' | null => {
      if (msg.role !== 'assistant') return null;
      // A turn carrying delivered files/images (drained pending attachments from
      // show_to_user / image_create) is a DELIVERABLE bubble, not a tool pill:
      // it must render via AssistantBubble so the chips show. Keep it out of the
      // pill grouping (V2d).
      if (msg.attachments && msg.attachments.length > 0) return null;
      const { text, blocks } = parseMessageContent(msg.content);
      if (text) return null;
      const toolUses = (blocks ?? []).filter(b => b.type === 'tool_use');
      if (toolUses.length === 0) return null;
      const channelSend = toolUses.find(b => b.name && isChannelSendBubbleTool(b.name));
      const channelSendErrored = channelSend?.id
        ? toolResultErrorById.get(channelSend.id) === true
        : false;
      if (channelSend && !channelSendErrored) return null;
      return summarizeToolTurn(toolUses.map(b => b.name ?? '')) ? 'visible' : 'hidden';
    };
    let currentGroup: ChatMessage[] = [];
    const closeGroup = () => {
      if (currentGroup.length > 1) {
        groupByFirstId.set(currentGroup[0].id, [...currentGroup]);
        for (let i = 1; i < currentGroup.length; i++) {
          skipIds.add(currentGroup[i].id);
        }
      }
      currentGroup = [];
    };
    for (const msg of messages) {
      if (msg.role === 'tool') continue;
      const kind = toolOnlyKind(msg);
      if (kind === 'visible') currentGroup.push(msg);
      else if (kind === 'hidden') continue; // hidden bookkeeping turn: skip, keep the run
      else closeGroup();
    }
    closeGroup();
    return { groupByFirstId, skipIds };
  }, [messages, wordyMode, toolResultErrorById]);

  // Channel routing markers ([Reply routed via iMessage to NAME], etc.)
  // arrive as standalone system messages AFTER the assistant reply they
  // describe. The old rendering left those as their own right-aligned
  // badge row, which read as a disjoint "to X via iMessage" floating
  // below and to the right of the agent bubble. The fix: walk the list
  // once, attach each routing marker to its preceding assistant message,
  // and hide the standalone marker from the feed. AssistantBubble then
  // renders the badge LEFT-aligned above the bubble — symmetric with
  // the inbound "from X via iMessage" badge on user bubbles.
  // v2.9.23 — `phone call to X` added to the marker family. The engine
  // emits `[Reply routed via phone call to NAME]` after a TTS reply on
  // an inbound call so the assistant bubble can show a symmetric
  // "to NAME via phone call" badge, mirroring the user-side badge.
  const { outboundChannelByAssistantId, hiddenRoutingMarkerIds } = useMemo(() => {
    const byAssistant = new Map<string, OutboundChannelInfo>();
    const hidden = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'system') continue;
      // Outbound routing marker ([Reply routed via X to NAME] / legacy [SENT VIA
      // IMESSAGE to NAME]) parsed by the canonical helper, so iMessage / phone /
      // Teams / email all resolve recipient + badge consistently (V3).
      const routed = parseOutboundRouting(m.content);
      if (!routed) continue;
      // Walk backwards through any interleaved tool / system rows to
      // find the assistant message this marker belongs to.
      let assistantId: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === 'assistant') { assistantId = prev.id; break; }
        if (prev.role !== 'tool' && prev.role !== 'system') break;
      }
      if (!assistantId) continue;
      byAssistant.set(assistantId, outboundBadge(routed.channel, routed.recipient));
      hidden.add(m.id);
    }
    return { outboundChannelByAssistantId: byAssistant, hiddenRoutingMarkerIds: hidden };
  }, [messages]);

  // NOTE: no early `if (loading) return` here. Returning a bare loading div
  // above the main render unmounts the entire Dojo3Stage (orb, composer,
  // background) on every agent switch — that full blow-away IS the jarring
  // "cut" between agents. Instead the stage stays mounted and the message
  // column shows a brief in-stage loader, then scroll-rises the new agent's
  // chat in (dojo3-agentSwitchIn). (All hooks are declared above this point,
  // so dropping the early return doesn't change hook order.)

  // The agent is "working" for the UI's thinking dots + stop button only when
  // it's a normal user turn — OR any turn while wordy mode is on. On a pure
  // agent-to-agent (A2A) turn with wordy off, the composer stays calm.
  // Show the working UI (dots + stop) whenever the agent is working AND either:
  // it's a user-facing turn, wordy mode is on, OR the user has a request in flight
  // (awaitingUserReply). The awaitingUserReply latch is set both on a local send
  // (handleSend) AND on any user-kind agent:status 'working' event, so an
  // externally-triggered user turn (iMessage / voice) and any a2a sub-turn of a
  // user-initiated task both keep the UI visible for the whole turn. It hides
  // ONLY for pure background a2a (another agent working, no user waiting): then
  // turnKind==='a2a', awaitingUserReply===false, wordy off → hidden.
  // UX-REPAIR T7 adds ONE clause: a frame that EXPLICITLY says `userFacing:false` never
  // lights the working UI in regular mode. Before the seam was fixed, frame 1 of a
  // background turn arrived with a fabricated `turnKind:'user'` and no `userFacing`, so
  // `turnKind !== 'a2a'` alone let it through. The three shapes the clause is written
  // against, all preserved:
  //   · WORDY MODE — exempt, unchanged: wordy shows everything.
  //   · A REQUEST IN FLIGHT (`awaitingUserReply`) — exempt, and that is `e0acf31`'s
  //     busy-box race: a queued dashboard send must keep its dots while a BACKGROUND turn
  //     runs in front of it. Suppressing on that turn's `userFacing:false` would reopen
  //     exactly the defect the latch exists to close.
  //   · A BARE LEGACY FRAME (no field at all — `tools/cat/media.ts` holds the dots up during
  //     image generation) — `undefined !== false`, so it behaves exactly as today.
  const showWorkingUi = isWorking
    && (wordyMode || awaitingUserReply || (turnKind !== 'a2a' && turnUserFacing !== false));
  // In-flight turn cutoff for the chip background test (see toolChips): while
  // working, rows at/after the last user trigger belong to the live turn.
  const liveTurnCutoff = isWorking
    ? ([...messages].reverse().find((m) => m.role === 'user')?.createdAt ?? null)
    : null;

  const composer = (
    <Dojo3Composer
      agentId={AGENT_ID}
      onSend={handleSend}
      isWorking={showWorkingUi}
      placeholder={activeAgentName ? `Message ${activeAgentName}` : undefined}
      onStop={async () => {
        await api.stopAgent(AGENT_ID);
        setIsWorking(false);
      }}
    />
  );

  // Jump-to-latest button — shown only when the user has scrolled up off the
  // bottom. Rendered at the stage level (not inside .dojo3-chat, which is a
  // z-index:1 stacking context below the composer) so it floats ABOVE the
  // composer. Clicking re-pins the view to the newest messages.
  const jumpToLatest = !pinnedToBottom ? (
    <button
      type="button"
      className="dojo3-jump-latest"
      aria-label="Jump to latest messages"
      title="Jump to latest"
      onClick={jumpToBottom}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  ) : null;

  const toggleWordyMode = () => {
    const next = !wordyMode;
    setWordyMode(next);
    localStorage.setItem('dojo_wordy_mode', String(next));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom(true);
      });
    });
  };

  const startNewSession = async () => {
    const res = await api.request<{ archiveId: string; sessionStartedAt: string }>(`/chat/${AGENT_ID}/new-session`, { method: 'POST' });
    if (res.ok) {
      // wordyMode rides along: the two modes are different server queries, and
      // this refetch replaces the whole pane (a wordy-blind fetch here would
      // drop the store's own-output rows until the next natural reload).
      const result = await api.getChatHistory(AGENT_ID, 200, undefined, wordyMode);
      if (result.ok) {
        setMessages(result.data.map((m: Message) => ({ ...m, isStreaming: false })));
      }
    }
  };

  return (
    <PresenceProvider>
    <Dojo3Stage
      composer={composer}
      jumpToLatest={jumpToLatest}
      agentName={activeAgentName || agentName}
      isWorking={showWorkingUi}
      wordyMode={wordyMode}
      onToggleWordyMode={toggleWordyMode}
      onNewSession={startNewSession}
      panel={panel}
    >
      {/* Messages */}
      <div ref={messagesContainerRef} className="dojo3-chat-scroll px-2 sm:px-4 md:px-6 py-3 sm:py-6 space-y-2 sm:space-y-4">
        {loadingMore && (
          <div className="text-center py-2">
            <span className="text-xs text-ui/25">Loading older messages...</span>
          </div>
        )}
        {/* Brief in-stage loader while the switched-to agent's history loads.
            The orb + composer stay put (no full-stage unmount), so the switch
            reads as a transition, not a cut. */}
        {loading && (
          <div className="flex-1 flex items-center justify-center h-full">
            <span className="text-xs text-ui/25 animate-pulse">Loading…</span>
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center animate-fade-up">
              <div className="text-4xl mb-4">{'\u{1F4AC}'}</div>
              <h2 className="text-xl font-semibold text-ui/70 mb-2">Chat with {agentName || 'your agent'}</h2>
              <p className="text-sm text-secondary">Send a message to get started.</p>
            </div>
          </div>
        )}

        {/* Keyed on the agent id so switching agents replays the motion-blur
            scroll-in (dojo3-agentSwitchIn) instead of a hard cut. */}
        {!loading && (
        <div key={AGENT_ID} className="dojo3-agent-enter space-y-2 sm:space-y-4">
        {messages.map((msg) => {
          // Group-render: subsequent members of a tool-pill group are
          // skipped here; the group renders at the first member below.
          if (toolPillGrouping.skipIds.has(msg.id)) return null;
          // Hide inter-agent / coordination / engine messages (user role) and
          // engine fallback text (assistant role) in regular mode. The decision
          // now comes from the canonical classifier (classifyMessageForDisplay,
          // @dojo/shared) so every chat surface agrees and the prefix list cannot
          // drift. Byte-identical to the prior inline pile for real traffic: the
          // classifier's user-role agent-only set is the same 12 prefixes (the
          // engine-injection prefixes it also covers are context-only, never
          // persisted to the feed) and its assistant fallback set is the same
          // four engine strings. It is start-anchored + trimmed where the old
          // pile used substring includes; that only diverges on a user message
          // that quotes a [SOURCE: ...] marker mid-text, which the old code
          // wrongly hid. Channel-sourced inbound (iMessage / phone / etc.) stays
          // user-visible and is badged by UserBubble below; system messages keep
          // their own divider / routing / no-reply handling further down.
          if (!wordyMode && (msg.role === 'user' || msg.role === 'assistant')
              && classifyMessageForDisplay(msg).tier !== 'user-visible') {
            return null;
          }
          // ── SWEEP CORE-2 item 7 — DRAFTS ARE NOT ANSWERS ──
          // An ASSISTANT row the engine re-classified at the turn boundary: the turn's own
          // ledger key (`turns.answer_message_id`) named a DIFFERENT bubble as the answer, so
          // this one was the agent drafting on its way there. It renders as the same dimmed,
          // expandable note the mid-turn demotion has produced since 2026-07-10 — nothing is
          // suppressed, every byte is still here, and the answer beside it now reads as the
          // answer instead of as one more box in a stack of identical boxes.
          //
          // Keyed on the STORED kind and never on the text: the content is deliberately
          // byte-unchanged, so there is nothing in it to key on and nothing in it that could
          // drift. It renders in both modes, exactly as a plain working note does.
          if (msg.role === 'assistant' && msg.displayKind === 'working-note') {
            const { text: noteText } = parseMessageContent(msg.content);
            return <WorkingNoteBubble key={msg.id} text={noteText || msg.content} />;
          }
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} wordyMode={wordyMode} />;
          if (msg.role === 'tool') {
            if (!wordyMode) return null; // Hide tool results in non-wordy mode
            return <ToolResultBubble key={msg.id} msg={msg} />;
          }
          if (msg.role === 'system') {
            const trimmedSys = msg.content.trim();
            // Suppress the no-reply / silent-turn marker entirely. It's
            // persisted only so the agent's next turn knows the prior turn
            // ended silently — there's no user-facing value in showing
            // "[Agent ended turn without replying — conversation closed]"
            // as a chat bubble. Hide in both wordy and non-wordy modes.
            if (trimmedSys === '[Agent ended turn without replying — conversation closed]') {
              return null;
            }
            // Demoted working note: a plain note renders in BOTH modes (the narration
            // was visible live in both). RC-9: an INTERNAL note (from a routed-channel
            // human turn, never delivered to that channel) is hidden outside wordy mode
            // so it can't read as a second, contradictory reply.
            const note = workingNote(trimmedSys);
            if (note) {
              if (note.internal && !wordyMode) return null;
              return <WorkingNoteBubble key={msg.id} text={note.text} />;
            }
            // Divider-style markers: any system message shaped "── label ──"
            // renders as a horizontal divider with the label centered.
            // "Memory Compacted" dividers are wordy-mode-only — they're
            // diagnostic chrome, not user-facing chronology. "New Session"
            // and similar markers stay always-visible.
            const dividerMatch = trimmedSys.match(/^──\s*(.+?)\s*──$/);
            if (dividerMatch) {
              const isCompactionDivider = /^Memory Compacted/.test(dividerMatch[1]);
              if (isCompactionDivider && !wordyMode) return null;
              return (
                <div key={msg.id} className="dojo3-divider flex items-center gap-3 my-4 px-4">
                  <div className="dojo3-divider__rule dojo3-divider__rule--l flex-1 h-px bg-ui/[0.12]" />
                  <span className="dojo3-divider__label text-xs text-ui/25 shrink-0">{dividerMatch[1]}</span>
                  <div className="dojo3-divider__rule dojo3-divider__rule--r flex-1 h-px bg-ui/[0.12]" />
                </div>
              );
            }
            // Channel routing markers ([Reply routed via ...]) used to
            // render as their own right-aligned badge row here. They now
            // attach to the preceding assistant bubble as a left-aligned
            // "to X via iMessage" badge above it (see
            // outboundChannelByAssistantId useMemo). If this marker is
            // one of those attached ones, skip rendering it. Markers we
            // couldn't attach (e.g. no preceding assistant) still get
            // shown so the channel info isn't lost.
            if (hiddenRoutingMarkerIds.has(msg.id)) return null;
            // Standalone routing marker we could not attach to a preceding
            // assistant bubble: render it as its own badge so the channel info is
            // not lost. Same canonical parser + badge as the attached path, so
            // phone / Teams / email resolve correctly (the old inline copy here
            // had no phone branch and mis-emoji'd it).
            const routed = parseOutboundRouting(msg.content);
            if (routed) {
              const badge = outboundBadge(routed.channel, routed.recipient);
              return (
                <div key={msg.id} className="flex justify-start my-1 px-1">
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono">
                    <span className="text-ui/40">{badge.emoji}</span>
                    <span>{badge.label}</span>
                  </div>
                </div>
              );
            }
            // Owner-alert system notes (see OWNER_ALERT_SYSTEM_PREFIXES) are the
            // one class of system rows that render in default mode: a muted
            // system-note bubble so the owner sees the heads-up without turning
            // on wordy mode. Wordy mode is unchanged (these fall through below to
            // the same rendering every other system row gets there).
            if (!wordyMode && isOwnerAlertSystemNote(trimmedSys)) {
              return (
                <div key={msg.id} className="flex justify-start my-1">
                  <div className="max-w-[92%] sm:max-w-[75%] rounded-lg border border-ui/[0.06] bg-ui/[0.03] px-3 py-2 text-[11px] sm:text-xs text-ui/55 whitespace-pre-wrap leading-relaxed">
                    {ownerAlertDisplayText(trimmedSys)}
                  </div>
                </div>
              );
            }
            if (!wordyMode) return null; // Hide other system messages in non-wordy mode
          }
          // For assistant messages, replace tool-only turns with a compact pill
          // in non-wordy mode. Pre-2026-04-30 this returned null which hid the
          // turn entirely — users saw long silences when the agent was actually
          // running tools (e.g., building a slide deck). The pill keeps the feed
          // honest without dumping the full tool-call cards.
          if (msg.role === 'assistant' && !wordyMode) {
            const { text, blocks } = parseMessageContent(msg.content);
            const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
            // v2.7.23 — render channel-send tool calls as outbound bubbles
            // (the user sees what was sent, not just a "⚙ imessage_send" gear).
            const channelSend = blocks?.find(
              (b) => b.type === 'tool_use' && b.name && isChannelSendBubbleTool(b.name),
            );
            // v2.7.25 — hide the outbound bubble when the underlying tool
            // call was refused. See AgentDetail.tsx for the longer rationale.
            const channelSendErrored = channelSend?.id
              ? toolResultErrorById.get(channelSend.id) === true
              : false;
            if (channelSend && !channelSendErrored) {
              // The outbound badge (if any) describes the SEND, so it rides on
              // the ChannelSendBubble, not the accompanying dashboard-facing
              // text. Passing it to BOTH would double-label; the text stays a
              // plain dashboard bubble (outboundChannel=null).
              const sendBadge = outboundChannelByAssistantId.get(msg.id) ?? null;
              return (
                <div key={msg.id} className="flex flex-col gap-2">
                  {text && (
                    <AssistantBubble msg={{ ...msg, content: text }} wordyMode={wordyMode} modelNames={modelNames} outboundChannel={null} />
                  )}
                  <ChannelSendBubble msg={msg} toolUse={channelSend} serverBadge={sendBadge} />
                </div>
              );
            }
            // v2.7.25 — channel send errored with nothing else in this
            // message: render nothing so the user doesn't see a blocked
            // attempt. Recovery text (if any) renders separately.
            if (channelSendErrored && !text) {
              const otherToolUses = (blocks ?? []).filter(
                (b) => b.type === 'tool_use' && b !== channelSend,
              );
              if (otherToolUses.length === 0) return null;
            }
            // Tool-only turn with NO delivered attachments: render the compact
            // class-aware badge (or grouped row). A tool-only turn that DOES
            // carry attachments is a deliverable: fall through to AssistantBubble
            // so the image/file chips render in regular mode (V2d).
            if (!text && hasToolUse && !(msg.attachments && msg.attachments.length > 0)) {
              const group = toolPillGrouping.groupByFirstId.get(msg.id);
              const members = group ?? [msg];
              return (
                <ToolBadgeGroup
                  key={msg.id}
                  items={toolBadgeItems(members, toolResultById, wordyMode)}
                  chips={toolChips(members, toolResultById, wordyMode, liveTurnCutoff)}
                />
              );
            }
          }
          return <AssistantBubble key={msg.id} msg={msg} wordyMode={wordyMode} modelNames={modelNames} outboundChannel={outboundChannelByAssistantId.get(msg.id) ?? null} />;
        })}
        </div>
        )}
        {showWorkingUi && !messages.some(m => m.isStreaming) && <ThinkingBubble />}
        <div ref={messagesEndRef} />
      </div>
    </Dojo3Stage>
    </PresenceProvider>
  );
};
