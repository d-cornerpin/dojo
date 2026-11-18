import { useFollowGrowth } from '../hooks/useFollowGrowth';
import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { Message } from '@dojo/shared';
import type { ChatChunkEvent, ChatReasoningChunkEvent, ChatMessageEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, ChatWorkingNoteEvent, WsEvent } from '@dojo/shared';
import { classifyMessageForDisplay, classifyTool, parseInboundChannel, stripInboundChannelMarker, parseOutboundRouting, channelOfSendTool, parseWorkingNote, isOwnerAlertSystemNote, stripSourceEnvelope, OWNER_ALERT_PROJECT_ATTENTION_PREFIX, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX, NO_REPLY_CLOSED_MARKER } from '@dojo/shared';
import type { MessageOrigin } from '@dojo/shared';
import { summarizeToolTurn, deriveChipLabel, type ToolTurnSummary } from '../lib/tool-display';
import { inboundBadge, inboundSenderName, outboundBadge, withoutFence } from '../lib/channel-display';
import { ToolBadgeGroup, type ToolChipData } from '../components/ToolBadge';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';
import { formatDate } from '../lib/dates';
// Whether a demoted note is dimmed, gone, or the reply itself: four rules, shared with the server.
import { renderWorkingNote } from '../lib/working-note-visibility';
import { useWebSocket } from '../hooks/useWebSocket';
import { ToolCallCard, ToolResultBlock } from '../components/ToolCallBlock';
import { stripVoiceMarkers, stripVoiceMarkersForStream, parseMoodMarker } from '../lib/voice-markers';
import { useDojoOrb } from '../components/orb/OrbProvider';
import type { OrbEmotionName } from '../components/orb/dojoOrbEngine';
import { stripAttachmentTags } from '../lib/attachment-tags';
import { parseMailboxEvent } from '../lib/mailbox-event';
import { Markdown } from '../components/Markdown';
import { Dojo3Composer } from '../components/Dojo3Composer';
import type { RefusedDraft } from '../components/composer-restore';
import { useActiveAgent } from '../components/ActiveAgentProvider';
import { useTechniqueSession, stripBuilderContext } from '../components/TechniqueSessionProvider';
import { useToast } from '../hooks/useToast';
import { AttachmentChips } from '../components/AttachmentChips';
import { ThinkingBubble } from '../components/ThinkingBubble';
import { Dojo3Stage } from '../components/Dojo3Stage';
import { PresenceProvider } from '../components/PresenceProvider';
import { useAgentState } from '../hooks/useAgentScopedState';
import { useChatCatchUp, toMessage } from '../hooks/useChatCatchUp';
import { backfillUntilRenderable } from '../lib/chat-history-backfill';

// Map a model-emitted `((mood: NAME))` marker to one of the orb's emotions.
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
  /** Streamed thinking from providers like DeepSeek. A collapsible panel above the text. */
  reasoningContent?: string | null;
  isReasoningStreaming?: boolean;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string; openInCanvas?: boolean; screenShare?: boolean }>;
  /** Where this message came from: 'voice' = dictated, 'a2a' = inter-agent turn (hidden in regular mode). */
  source?: 'voice' | 'a2a' | null;
  /** Canonical attribution from the server (deriveOrigin), read by the visibility classifier. */
  origin?: MessageOrigin;
  inboundMeta?: string | null;   // the stored routing record (the Teams badge's name)
  /** The conversation this turn served: a human key = user trigger, null = a background run. */
  conversationId?: string | null;
  /** Stored display kind (`messages.display_kind`): `working-note` means drafting, not the answer. */
  displayKind?: string | null;
}

function parseMessageContent(raw: string): { text: string; blocks?: ContentBlock[] } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const textParts = parsed
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text)
        .join('\n\n');
      return { text: textParts, blocks: parsed };
    }
  } catch {
  }
  return { text: raw };
}

// Owner-facing text: drop the SOURCE envelope and internal tracker tag; plain notes pass through.
const ownerAlertDisplayText = (content: string): string => {
  const body = stripSourceEnvelope(content.trim());
  return (body.startsWith(OWNER_ALERT_PROJECT_ATTENTION_PREFIX) ? body.slice(OWNER_ALERT_PROJECT_ATTENTION_PREFIX.length) : body).trim();
};

// Dimmed, collapsed rendering for a demoted note: quieter than the owner-alert bubble, expands on click.
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

// Inbound framing is stripped by the canonical @dojo/shared helpers; badges live in ../lib/channel-display.

const UserBubble = ({ msg, wordyMode = false }: { msg: ChatMessage; wordyMode?: boolean }) => {
  // ONE clean inbound badge; the canonical parser strips [SOURCE: …] framing, wordy shows raw content.
  const inbound = parseInboundChannel(msg.content);
  const fromVoice = msg.source === 'voice';
  const badge = inbound ? inboundBadge(inbound.channel, inboundSenderName(msg.inboundMeta, inbound.sender)) : null;

  // The owner sees other people's text as it arrived, without the agent's fence lines.
  let displayContent = withoutFence(msg.content);
  // Strip injected technique build/edit context (no-op for normal messages) from the user bubble.
  displayContent = stripBuilderContext(displayContent);
  if (!wordyMode) {
    if (inbound) displayContent = stripInboundChannelMarker(displayContent);
    // Strip the engine attachment-pointer blocks (chips render the files).
    if (msg.attachments?.length) displayContent = stripAttachmentTags(displayContent);
  }

  // Engine inbox-watcher notifications become a clean email card in non-wordy mode: raw
  // framing hidden, the account header replaces the generic "via email" badge.
  const mailbox = !wordyMode ? parseMailboxEvent(withoutFence(msg.content)) : null;

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

/** Routing info from a follow-on system marker like '[Reply routed via iMessage to NAME]'. */
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
  // Hide cloud voice markers ((deliver: ...), [pause], [long pause]) from regular chat; wordy shows them.
  const displayText = wordyMode
    ? text
    : (msg.isStreaming ? stripVoiceMarkersForStream(text) : stripVoiceMarkers(text));
  const spokenAloud = msg.source === 'voice';
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
  const hasReasoning = !!(msg.reasoningContent && msg.reasoningContent.length > 0);
  // The panel starts closed and opens only on the reader's click: auto-open plus
  // collapse-on-first-answer made multi-hop turns paint answer-shaped drafts that vanished.
  const [reasoningOpen, setReasoningOpen] = useState(false);

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[75%]">
        {/* Outbound channel routing badge, left-aligned mirror of the
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
        {/* "via voice" badge, left-aligned mirror of the user-side badge,
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
        {/* Reasoning / "Thinking…" panel, appears above the answer text.
            The HEADER announces that thinking is happening (pulsing dots while it
            streams); the BODY stays closed until the reader asks for it, and stays
            open once they have. Wordy-mode only: in regular chat we just see the
            standard three bouncing dots from the streaming bubble below. */}
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

        {/* No msg.toolCalls render path: tool_use blocks render via the hasToolUse path
            above, so live-streamed calls cannot attach to the next bubble (the duplicate). */}

        {/* Image / PDF attachments (e.g. generated images). In the
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
// The verdict lives in `lib/working-note-visibility.ts`; this renders via `AssistantBubble` whole.
const NoteAsAnswer = ({ msg, text, wordyMode, modelNames }: {
  msg: ChatMessage; text: string; wordyMode: boolean; modelNames: Record<string, string>;
}) => (
  <AssistantBubble
    msg={{ ...msg, role: 'assistant', content: text }}
    wordyMode={wordyMode} modelNames={modelNames} outboundChannel={null}
  />
);

// Shared components/ToolBadge renders it (no style drift); this builds its {id, summary} items.
const toolBadgeItems = (
  msgs: ChatMessage[],
  resultById: Map<string, ToolResultInfo>,
  wordyMode: boolean,
): Array<{ id: string; summary: ToolTurnSummary }> =>
  msgs
    .map((m) => {
      // Background/engine run: drop the badge in regular mode (text still renders); wordy keeps everything.
      if (!wordyMode && isBackgroundTurnRow(m)) return null;
      const calls = (parseMessageContent(m.content).blocks ?? [])
        .filter((b) => b.type === 'tool_use')
        .filter((b) => wordyMode || !isErroredToolResult(b.id ? resultById.get(b.id) : undefined))
        .map((b) => ({ name: b.name ?? '', input: b.input }));
      const summary = summarizeToolTurn(calls);
      return summary ? { id: m.id, summary } : null;
    })
    .filter((x): x is { id: string; summary: ToolTurnSummary } => x !== null);

// dojo3: tool-only turns become one chip pill per visible tool (input + result); bookkeeping tools drop.
interface ToolResultInfo { content: string; isError: boolean }

// A tool call whose result errored: the engine self-recovers, so a failed chip is noise outside Wordy mode.
const isErroredToolResult = (info?: ToolResultInfo): boolean => !!info?.isError;

// A chip shows in regular mode only when its row served a HUMAN conversation; wordy shows all.
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
  // Mid-run cutoff: the stamp lands at teardown; rows at/after the current trigger stay, then it governs.
  liveCutoff: string | null = null,
): ToolChipData[] =>
  msgs.flatMap((m) =>
    (!wordyMode && isBackgroundTurnRow(m) && !(liveCutoff && m.createdAt >= liveCutoff))
      ? []
    : (parseMessageContent(m.content).blocks ?? [])
      // Args are passed too; the @dojo/shared row-tier fold must pass them as well, or the row drops first.
      .filter((b) => b.type === 'tool_use' && b.name && classifyTool(b.name, b.input) !== 'bookkeeping')
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

// Derived, not hand-listed: any real human-channel send except bodiless voice_call (forwards included).
const isChannelSendBubbleTool = (name: string): boolean =>
  channelOfSendTool(name) !== null && name !== 'voice_call';

// The recipient the send targeted, from the tool's arguments; replies (no explicit one) return null.
const sendToolRecipient = (name: string, input: Record<string, unknown>): string | null => {
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (name) {
    case 'imessage_send': return s(input.to) ?? s(input.recipient) ?? s(input.handle);
    case 'sms_send': return s(input.to) ?? s(input.number) ?? s(input.recipient);
    case 'teams_send_message': {
      // A Teams chat id is a GUID, not a name; resolving it needs a call the dashboard must not make.
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
  // Prefer the server-resolved badge (carries the display name); fall back to the raw handle, never both.
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
            let displayContent: string;
            const rawContent = b.content as unknown;
            if (typeof rawContent === 'string') {
              displayContent = rawContent;
            } else if (Array.isArray(rawContent)) {
              displayContent = (rawContent as Array<Record<string, unknown>>)
                .map((block: Record<string, unknown>) => {
                  if (block.type === 'text') return block.text as string;
                  if (block.type === 'image') return '[Image content, visible to model via vision]';
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


interface ChatProps {
  panel?: {
    title?: string;
    meta?: string;
    content: ReactNode;
  } | null;
}

export const Chat = ({ panel = null }: ChatProps) => {
  // The active agent drives the whole stage; selecting one swaps the chat, composer target, orb, labels.
  const { agentId: activeAgentId, agentName: selectedAgentName } = useActiveAgent();
  // During a technique session the chat becomes the trainer conversation (target, context, docked Mat).
  const techSession = useTechniqueSession();
  const AGENT_ID = techSession.active ? techSession.trainerAgentId : activeAgentId;
  const activeAgentName = techSession.active
    ? (techSession.trainerName || 'Trainer')
    : selectedAgentName;
  const agentIdRef = useRef(AGENT_ID);
  agentIdRef.current = AGENT_ID; // always up to date for closures

  const [agentName, setAgentName] = useState('');
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [messages, setMessages] = useAgentState<ChatMessage[]>(AGENT_ID, []);
  const [isWorking, setIsWorking] = useAgentState(AGENT_ID, false);
  // Turn kind from agent:status; 'a2a' turns stay composer-quiet (no dots/stop) unless wordy is on.
  const [turnKind, setTurnKind] = useAgentState<'user' | 'a2a'>(AGENT_ID, 'user');
  // What the LAST working frame said about serving a human; a background turn is 'user' kind AND false.
  const [turnUserFacing, setTurnUserFacing] = useAgentState<boolean | undefined>(AGENT_ID, undefined);
  // A request is in flight (sent, not completed): drives dots + stop for the whole request, even a2a.
  const [awaitingUserReply, setAwaitingUserReply] = useAgentState(AGENT_ID, false);
  // Work that outlives the turn, no `agent:status` frame describes it; `stoppable` is the SERVER's answer.
  const [backgroundStoppable, setBackgroundStoppable] = useAgentState(AGENT_ID, false);
  const [loading, setLoading] = useAgentState(AGENT_ID, true);
  const [loadingMore, setLoadingMore] = useAgentState(AGENT_ID, false);
  const [hasMore, setHasMore] = useAgentState(AGENT_ID, true);
  const toast = useToast();
  const [wordyMode, setWordyMode] = useState(() => {
    const stored = localStorage.getItem('dojo_wordy_mode');
    return stored === 'true';
  });
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // "Stick to bottom": pinned follows new content; scrolling up unpins (no yanking) and shows a
  // jump-to-latest button. The ref mirrors it so once-set-up WS handlers read the live value.
  const [pinnedToBottom, setPinnedToBottom] = useAgentState(AGENT_ID, true);
  const pinnedToBottomRef = useRef(true);
  // True while a "jump to latest" is in flight: the scroll handler must not un-pin on its intermediate steps.
  const jumpingRef = useRef(false);
  // Where our own last scroll landed: an event reporting exactly that is an echo, not the owner scrolling up.
  const programmaticTopRef = useRef<number | null>(null);
  const NEAR_BOTTOM_PX = 80; // within this of the bottom counts as "at the bottom"

  useEffect(() => {
    api.getSetting('primary_agent_name').then(r => {
      if (r.ok && r.data.value) setAgentName(r.data.value);
    });
  }, []);
  const { subscribe, reconnectCount } = useWebSocket();
  const currentToolCallsRef = useRef<ToolCallData[]>([]);
  const statusFrameSeqRef = useRef(0); // frames heard for this agent: lets a load tell if its answer is stale

  // The agent can lead a reply with a `((mood: NAME))` marker; we read it and emote the orb.
  const dojoOrb = useDojoOrb();
  // wordyMode mirrors into a ref so once-set-up WS closures read the CURRENT value.
  const wordyModeRef = useRef(wordyMode);
  wordyModeRef.current = wordyMode;
  // Which conversation (agent + feed mode) is on screen now: a slow older page checks it on return.
  const viewKeyRef = useRef('');
  viewKeyRef.current = `${AGENT_ID}:${wordyMode}`;
  // True when a stream frame belongs to an inter-agent turn and the owner has wordy off.
  const hiddenStreamFrame = (e: { turnKind?: string }) => e.turnKind === 'a2a' && !wordyModeRef.current;
  const streamTextRef = useRef<Map<string, string>>(new Map());
  // De-dupe per (message, emotion): same-message chunks don't re-fire; a new message re-fires the mood.
  const lastEmotionKeyRef = useRef<string | null>(null);
  const applyMood = useCallback((msgId: string, text: string) => {
    const emotion = moodToEmotion(parseMoodMarker(text));
    if (!emotion) return;
    const key = `${msgId}:${emotion}`;
    if (key === lastEmotionKeyRef.current) return;
    lastEmotionKeyRef.current = key;
    dojoOrb.setEmotion(emotion);
  }, [dojoOrb]);

  // Reset mood tracking and every other per-agent ref when the agent changes (a new agent starts neutral).
  useEffect(() => {
    lastEmotionKeyRef.current = null;
    streamTextRef.current.clear();
    currentToolCallsRef.current = [];
    lastMessageIdRef.current = null;
    lastMessageSigRef.current = null;
    pinnedToBottomRef.current = true;
    jumpingRef.current = false;
    programmaticTopRef.current = null;
  }, [AGENT_ID]);

  // Auto-scroll on a new message or a growing last message, only while pinned to the bottom.
  const lastMessageIdRef = useRef<string | null>(null);
  const lastMessageSigRef = useRef<string | null>(null);
  // Follows are instant: smooth `scrollIntoView` reports each step and lands where the bottom was.
  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    programmaticTopRef.current = container.scrollTop; // read back: the browser clamps it
  }, []);

  // Jump-to-bottom re-asserts across frames: one write lands on a stale height while layout settles.
  const jumpToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    jumpingRef.current = true;
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);
    const go = () => scrollToBottom();
    go();
    requestAnimationFrame(go);
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 90);
    setTimeout(() => { go(); jumpingRef.current = false; }, 320);
  }, [scrollToBottom]);

  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!last) return;
    // Signature combines id + content length: a streaming bubble with a stable id still re-scrolls.
    const sig = `${last.id}:${last.content?.length ?? 0}`;
    if (sig === lastMessageSigRef.current) return;
    const isNewMessage = last.id !== lastMessageIdRef.current;
    lastMessageIdRef.current = last.id;
    lastMessageSigRef.current = sig;
    if (isNewMessage) {
      if (pinnedToBottomRef.current) scrollToBottom();
    } else {
      // Same message growing: follow while pinned; a second distance test would miss big chunks.
      if (pinnedToBottomRef.current) scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  const messagesContentRef = useRef<HTMLDivElement>(null);
  useFollowGrowth(messagesContentRef, !loading, () => pinnedToBottomRef.current, scrollToBottom, AGENT_ID);

  useChatCatchUp<ChatMessage>({
    reconnectCount, agentId: AGENT_ID, agentIdRef, wordyMode, ready: !(techSession.active && !techSession.ready),
    statusFrameSeqRef, setMessages, setIsWorking, setBackgroundStoppable, toChat: toMessage,
  });

  useEffect(() => {
    // Before loading, wait for the resume-vs-clear decision so no stale trainer chat bleeds through.
    if (techSession.active && !techSession.ready) {
      setMessages([]);
      setLoading(true);
      return;
    }
    // The cancel token: a load belongs to the agent (and mode) that started it.
    let active = true;
    const loadHistory = async () => {
      // Ask the server if this agent is working: an idle agent sends no frame; a newer status frame stands.
      const seq = statusFrameSeqRef.current;
      const agentResult = await api.getAgent(AGENT_ID);
      if (!active) return;
      if (agentResult.ok && statusFrameSeqRef.current === seq) {
        setIsWorking(agentResult.data.status === 'working');
      }
      // Ask on the way in too (a returner mid-render beats the next lifecycle edge); background
      // half only: turns never emit `agent:jobs` (the latch's clearing edge); a turn latch strands Stop.
      if (agentResult.ok) {
        const f = agentResult.data.inFlight;
        setBackgroundStoppable(!!f && f.background > 0);
      }

      const modelsResult = await api.getModels();
      if (!active) return;
      if (modelsResult.ok) {
        const lookup: Record<string, string> = {};
        for (const m of modelsResult.data) {
          lookup[m.id] = m.name;
        }
        setModelNames(lookup);
      }

      const result = await api.getChatHistory(AGENT_ID, 200, undefined, wordyMode);
      if (!active) return;
      if (result.ok) {
        // Dig up older pages until real conversation renders (the blank-chat guarantee).
        const loaded = await backfillUntilRenderable(result.data, wordyMode,
          (oldest) => api.getChatHistory(AGENT_ID, 200, oldest, wordyMode), () => active);
        if (!loaded) return;
        setMessages(
          loaded.map(toMessage),
        );
        setHasMore(result.data.length >= 50);
        pinnedToBottomRef.current = true;
        setPinnedToBottom(true);
        // Land at the bottom once laid out; later growth is followed by useFollowGrowth while pinned.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToBottom();
          });
        });
      }
      setLoading(false);
    };
    loadHistory();
    return () => { active = false; };
    // wordyMode is a dep: wordy adds own-output SERVER rows, so toggling must refetch history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AGENT_ID, techSession.active, techSession.ready, wordyMode]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;

    setLoadingMore(true);
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    const startedFor = `${AGENT_ID}:${wordyMode}`;
    const result = await api.getChatHistory(AGENT_ID, 50, oldestId, wordyMode);
    if (viewKeyRef.current !== startedFor) { setLoadingMore(false); return; }
    if (!result.ok) {
      // A failed request says nothing about history: leave hasMore so the next scroll retries.
    } else if (result.data.length > 0) {
      const older = result.data.map(toMessage);
      setMessages(prev => [...older, ...prev]);
      setHasMore(result.data.length >= 50);

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

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Track pin state: near-bottom pins, scrolling up unpins; React state commits only on a flip.
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
      const ownEcho = programmaticTopRef.current !== null
        && Math.abs(container.scrollTop - programmaticTopRef.current) <= 1;
      programmaticTopRef.current = null; // one scroll, one event: whatever this was, it is spent
      if (!jumpingRef.current && !ownEcho && nearBottom !== pinnedToBottomRef.current) {
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

  useEffect(() => {
    // Backstop: on any terminal state, drop empty streaming bubbles, stop dots on ones with content.
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
        // Re-class arm: only `display_kind` changed, so stamp it in place; live must match reload.
        if (e.reclassified) {
          const at = prev.findIndex((m) => m.id === e.messageId);
          if (at < 0) return prev;
          const out = [...prev];
          out[at] = { ...out[at], displayKind: 'working-note', isStreaming: false };
          return out;
        }
        // Carry the internal flag through the persisted prefix: the filter hides it live AND on reload.
        const note: ChatMessage = {
          id: e.noteId,
          role: 'system',
          content: `${e.internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX}${e.content}`,
          createdAt: new Date().toISOString(),
        };
        // Convert the streamed bubble in place so the text never vanishes; append if never streamed.
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
      // Inter-agent turn (wordy off): no bubble; with no origin the filter would flash a2a text.
      if (hiddenStreamFrame(e)) return;

      const accum = (streamTextRef.current.get(e.messageId) ?? '') + e.content;
      streamTextRef.current.set(e.messageId, accum);
      applyMood(e.messageId, accum);
      if (e.done) streamTextRef.current.delete(e.messageId);

      // Snapshot and clear the tool-call ref on every done event BEFORE the updater, never per-branch.
      const toolCallsSnapshot = e.done && currentToolCallsRef.current.length > 0
        ? [...currentToolCallsRef.current]
        : null;
      if (e.done) currentToolCallsRef.current = [];

      setMessages((prev) => {
        // Look up by messageId, not the tail: answer chunks must update the reasoning bubble created first.
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
            updated.modelId = e.modelId ?? null;
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
          // New streaming message; skip if it's empty and already done (ghost bubble)
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
              modelId: e.modelId ?? null,
              isStreaming: !e.done,
            },
          ];
        }
      });
    });

    // Reasoning deltas (DeepSeek, OpenRouter): update the streaming bubble or create a shell.
    const unsubReasoning = subscribe('chat:reasoning_chunk', (event: WsEvent) => {
      const e = event as ChatReasoningChunkEvent;
      if (e.agentId !== agentIdRef.current) return;
      // Same as chat:chunk, inter-agent reasoning must not create a live bubble.
      if (hiddenStreamFrame(e)) return;
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
        // Reasoning before any chat:chunk: create the shell with empty content; chunks fill it later.
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
      // LIVE = RELOAD: inter-agent badges follow the text's suppression (else pills flash, reload hides).
      if (hiddenStreamFrame(e)) return;
      currentToolCallsRef.current.push({
        name: e.tool,
        args: e.args,
      });
    });

    const unsubToolResult = subscribe('chat:tool_result', (event: WsEvent) => {
      const e = event as ChatToolResultEvent;
      if (e.agentId !== agentIdRef.current) return;
      if (hiddenStreamFrame(e)) return;
      const tc = currentToolCallsRef.current.find((t) => t.name === e.tool && !t.result);
      if (tc) {
        tc.result = e.result;
      }
    });

    const unsubError = subscribe('chat:error', (event: WsEvent) => {
      const e = event as ChatErrorEvent;
      if (e.agentId !== agentIdRef.current) return;
      // Honor the severity field: the engine's info-level events must not read as red errors.
      const isRateLimit = e.code === 'RATE_LIMITED' || e.error.includes('429') || e.error.toLowerCase().includes('rate_limit') || e.error.toLowerCase().includes('overloaded');
      const declared: 'info' | 'warning' | 'error' = e.severity ?? (isRateLimit ? 'warning' : 'error');
      // Sticky red means the owner must act (`cardClass: 'action'`); anything else leaves by itself.
      const sev: 'info' | 'warning' | 'error' = declared === 'error' && e.cardClass !== 'action' ? 'warning' : declared;
      if (sev === 'info') {
        toast.success(e.error);
        // Recovered → clear isWorking lock so UI re-enables input.
        if (e.code === 'AGENT_RECOVERED') {
          setIsWorking(false);
          reconcileStreamingBubbles();
        }
      } else if (sev === 'warning') {
        toast.warning(e.error);
        if (declared === 'error') { setIsWorking(false); reconcileStreamingBubbles(); }   // the turn ended either way
      } else {
        toast.error(e.error); // stays until dismissed
        setIsWorking(false);
        reconcileStreamingBubbles();
      }
    });

    // chat:message: the canonical JSON replaces a streaming bubble's content: it carries the tool_use blocks.
    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentIdRef.current) return;

      // Orb mood from the canonical message: non-streamed replies, markers the stream parse missed.
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
            // JSON content is now truth: tool_use renders via hasToolUse, so drop streaming toolCalls.
            toolCalls: undefined,
            isStreaming: false,
            // Carry the turn's conversation key so a finalized tool-only row's chips
            // read background-vs-user live exactly as on reload (null = background run).
            conversationId: e.message.conversationId ?? existing.conversationId,
          };
          // Never tail-move a finalized bubble: a mid-stream user message would sit above its response.
          return updated;
        }

        // Reconcile with handleSend's optimistic temp- bubble: temp ids never match, so no doubling.
        if (e.message.role === 'user') {
          // Compare on the typed-text core: the broadcast carries attachment tags and
          // injected technique context the optimistic bubble never had, so an un-normalized
          // compare fails dedup and renders every enriched message twice.
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
              // Carry the frame's conversation: the optimistic bubble has none (only the server
              // resolves one), and an anchor without it fails the visibility R4 test live, so
              // the owner's reply stays collapsed until a refresh.
              conversationId: e.message.conversationId ?? updated[tempIdx].conversationId,
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
            // Carry attachments from the WS payload so thumbnails render now,
            // not only after a reload via the HTTP GET.
            attachments: e.message.attachments,
            source: e.message.source ?? null,
            origin: e.message.origin,
            inboundMeta: e.message.inboundMeta ?? null,
            conversationId: e.message.conversationId,
          },
        ];
      });
    });

    // A retraction is its own event: dropping a bubble that isn't there is a no-op.
    // The old empty-content chat:message carried "delete" inside a "message" event.
    const unsubRetract = subscribe('chat:retract', (event: WsEvent) => {
      const e = event as { agentId: string; messageId: string };
      if (e.agentId !== agentIdRef.current) return;
      setMessages((prev) => prev.filter((m) => m.id !== e.messageId));
    });

    // Track working state from agent:status: externally-triggered turns (iMessage,
    // scheduled runs, a2a) never ran handleSend, so the dots and stop swap need this.
    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string; turnKind?: 'user' | 'a2a'; userFacing?: boolean; stopping?: boolean };
      if (e.agentId !== agentIdRef.current) return;
      statusFrameSeqRef.current++;
      // `working` + `stopping: true` is the engine being honest: the run is still unwinding
      // (a forced compaction measured at 285 s) and keeps saying so. Read it here as "no
      // longer accepting" so a stop already pressed doesn't re-raise the dots; the status
      // field keeps telling every other reader the truth.
      if (e.stopping === true) {
        setIsWorking(false);
        setAwaitingUserReply(false);
        return;
      }
      if (e.status === 'working') {
        setIsWorking(true);
        const kind = e.turnKind ?? 'user';
        setTurnKind(kind);
        // Record the frame's own answer, including "it did not say" (undefined): with no
        // fabricated turnKind this is all frame 1 of a background turn has to stay quiet on.
        setTurnUserFacing(e.userFacing);
        // Latch on a user-facing working status (same flag handleSend sets) so the working
        // UI stays up for the whole turn, through tool-only phases and a2a dips. This covers
        // externally-triggered turns where handleSend never ran. userFacing is required so a
        // background engine turn (scheduler/PM poke, also 'user' kind) never latches it on.
        if (kind === 'user' && e.userFacing === true) setAwaitingUserReply(true);
      } else if (e.status === 'idle' || e.status === 'error' || e.status === 'paused') {   // paused = parked after an honest stop; no idle follows
        setIsWorking(false);
        // Clear the unanswered-request latch only for a user-facing turn: a background
        // idle must not wipe the latch a queued dashboard send set (the busy-box race).
        // A legacy frame with no userFacing field still clears on idle (undefined !== false).
        if (e.userFacing !== false) setAwaitingUserReply(false);
        reconcileStreamingBubbles();
      }
    });

    // The only frame that speaks AFTER a turn's `idle`, which is the window the
    // defect lived in. Read the flag, never re-derive it from the counts.
    const unsubJobs = subscribe('agent:jobs', (event: WsEvent) => {
      const e = event as { agentId: string; stoppable: boolean };
      if (e.agentId !== agentIdRef.current) return;
      setBackgroundStoppable(e.stoppable === true);
    });

    const unsubTerminated = subscribe('agent:terminated', (event: WsEvent) => {
      const e = event as { agentId: string; reason: string };
      if (e.agentId !== agentIdRef.current) return;
      toast.info('This agent has ended, so it will not answer here any more.');
      setIsWorking(false);
      setAwaitingUserReply(false);
      reconcileStreamingBubbles();
    });

    // Voice-delivered stamping broadcast: update the local bubble's source and show
    // the "via voice" badge without a refetch.
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
      unsubJobs();
      unsubTerminated();
      unsubSource();
    };
  }, [subscribe, AGENT_ID, applyMood]);

  const [refused, setRefused] = useState<RefusedDraft>();
  const refusedSeq = useRef(0);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setIsWorking(true);
    setAwaitingUserReply(true); // user is now waiting on a reply, keep the working UI up through any a2a sub-work
    // Sending re-pins: the user wants to see their message and the reply.
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);

    // Technique session: prepend build/edit/setup/refresh context to the wire
    // message. The bubble still shows only what the user typed (UserBubble
    // strips the context); commit/rollback advances the one-shot context gate.
    const plan = techSession.active ? techSession.prepareOutgoing(content) : null;
    const outgoing = plan ? plan.outgoing : content;

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
      // The server refused it: take the bubble back out and put the text (and attachments) back in the
      // composer. If he has typed something new since, keep his work and show a short preview instead.
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      setRefused({ id: ++refusedSeq.current, agentId: AGENT_ID, text: content, attachments, done: (restored) => toast.error(restored
        ? `${result.error} Your message was not sent. It is back in the box so you can edit and resend.`
        : `${result.error} Your message was not sent: "${content.slice(0, 80)}${content.length > 80 ? '…' : ''}"`) });
    } else {
      plan?.commit();
    }
  };

  // tool_use_id → is_error lookup so the ChannelSendBubble hides when its tool
  // was refused. MUST sit above any early return: hook order must be identical
  // across renders, and a hook below the exit throws React error #310 on flip.
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
                if (b.type === 'image') return '[Image content, visible to model via vision]';
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

  // Group adjacent tool-only assistant messages so their pills share one horizontal
  // row. Invisible rows (role='tool' in non-wordy mode) don't break a run; anything
  // that renders visibly (user/response bubble, divider, routing marker) closes a group.
  const toolPillGrouping = useMemo(() => {
    const groupByFirstId = new Map<string, ChatMessage[]>();
    const skipIds = new Set<string>();
    if (wordyMode) return { groupByFirstId, skipIds };
    // Classify for the walk: 'visible' = tool-only with a non-bookkeeping tool
    // (renders a badge, group it); 'hidden' = all-bookkeeping (skip without breaking
    // the run); null = anything rendering real content, which closes the group.
    // A non-errored channel-send renders a bubble, so it is null and breaks the group.
    const toolOnlyKind = (msg: ChatMessage): 'visible' | 'hidden' | null => {
      if (msg.role !== 'assistant') return null;
      // A turn carrying delivered files/images is a deliverable bubble, not a tool
      // pill: it renders via AssistantBubble so the chips show, so it stays out of grouping.
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
      return summarizeToolTurn(toolUses.map(b => ({ name: b.name ?? '', input: b.input }))) ? 'visible' : 'hidden';
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

  // Channel routing markers arrive as standalone system messages AFTER the assistant
  // reply they describe. Walk once: attach each marker to its preceding assistant
  // message and hide the standalone row, so the badge renders left-aligned above the
  // bubble, symmetric with the inbound "from X via iMessage" badge on user bubbles.
  const { outboundChannelByAssistantId, hiddenRoutingMarkerIds } = useMemo(() => {
    const byAssistant = new Map<string, OutboundChannelInfo>();
    const hidden = new Set<string>();
    // Replies still sending, per recipient, oldest first: a later verdict row is that reply's newest state.
    const sending = new Map<string, string[]>();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'system') continue;
      // Route markers parsed by the canonical helper, so iMessage / phone / Teams /
      // email all resolve recipient + badge consistently.
      const routed = parseOutboundRouting(m.content);
      if (!routed) continue;
      const key = `${routed.channel}|${routed.recipient}`;
      // A verdict belongs to the oldest reply still sending to that recipient; otherwise walk backwards
      // through any interleaved tool / system rows to find the assistant message this marker belongs to.
      let assistantId: string | null = routed.state?.kind === 'sending' ? null : sending.get(key)?.shift() ?? null;
      for (let j = i - 1; j >= 0 && !assistantId; j--) {
        const prev = messages[j];
        if (prev.role === 'assistant') { assistantId = prev.id; break; }
        if (prev.role !== 'tool' && prev.role !== 'system') break;
      }
      if (!assistantId) continue;
      if (routed.state?.kind === 'sending') sending.set(key, [...(sending.get(key) ?? []), assistantId]);
      byAssistant.set(assistantId, outboundBadge(routed.channel, routed.recipient, routed.state));
      hidden.add(m.id);
    }
    return { outboundChannelByAssistantId: byAssistant, hiddenRoutingMarkerIds: hidden };
  }, [messages]);

  // NOTE: no early `if (loading) return` here. A bare loading div unmounts the whole
  // Dojo3Stage (orb, composer, background) on every agent switch, the jarring "cut".
  // The stage stays mounted with an in-stage loader. All hooks are declared above.

  // Working UI (dots + stop) shows when the agent is working AND: user-facing turn,
  // wordy mode, or a request in flight (awaitingUserReply, set by handleSend and by
  // user-kind status frames, so external user turns and their a2a sub-turns stay lit).
  // Only pure background a2a (no user waiting, wordy off) stays calm.
  // One clause: a frame that explicitly says `userFacing:false` never lights the working
  // UI in regular mode. Three shapes stay exempt: wordy mode shows everything; a request
  // in flight keeps its dots while a background turn runs in front (the busy-box race);
  // a bare legacy frame with no field (undefined !== false) behaves as before.
  const showWorkingUi = isWorking
    && (wordyMode || awaitingUserReply || (turnKind !== 'a2a' && turnUserFacing !== false));
  // ── The stop control and the thinking dots come apart here ──
  // showWorkingUi drives the dots/orb and must stay false for a background render, but
  // there IS something to stop, so the stop control uses the wider question. The `||` can
  // only ADD the background case; `lib/stop-affordance.ts` holds the argument.
  const canStop = showWorkingUi || backgroundStoppable;
  // In-flight turn cutoff for the chip background test (see toolChips): while
  // working, rows at/after the last user trigger belong to the live turn.
  const liveTurnCutoff = isWorking
    ? ([...messages].reverse().find((m) => m.role === 'user')?.createdAt ?? null)
    : null;

  const composer = (
    <Dojo3Composer
      agentId={AGENT_ID}
      onSend={handleSend}
      refused={refused}
      isWorking={showWorkingUi}
      canStop={canStop}
      placeholder={activeAgentName ? `Message ${activeAgentName}` : undefined}
      onStop={async () => {
        const res = await api.stopAgent(AGENT_ID);
        if (!res.ok) {
          // A refused stop is not a finished one: the agent is still running, so the
          // working state stays and the refusal is named, not swallowed.
          toast.error(res.error ?? 'The stop did not go through. The agent is still working.');
          return;
        }
        setIsWorking(false);
        // The press settles BOTH halves: the control never outlives its own click waiting for
        // the route's zero frame. The stop is idempotent, so a later frame costs nothing.
        setBackgroundStoppable(false);
      }}
    />
  );

  // Jump-to-latest: shown when scrolled up; rendered at stage level (above the
  // composer's stacking context); clicking re-pins to the newest messages.
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
        scrollToBottom();
      });
    });
  };

  const startNewSession = async () => {
    const res = await api.request<{ archiveId: string; sessionStartedAt: string }>(`/chat/${AGENT_ID}/new-session`, { method: 'POST' });
    if (res.ok) {
      // wordyMode rides along: the modes are different server queries and this
      // refetch replaces the whole pane, so a wordy-blind fetch drops own-output rows.
      const result = await api.getChatHistory(AGENT_ID, 200, undefined, wordyMode);
      if (result.ok) {
        setMessages(result.data.map((m: Message) => ({ ...m, isStreaming: false })));
      } else {
        toast.error('The new conversation started but the page could not reload it. Refresh the page.');
      }
    } else {
      toast.error(res.error);
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
        <div key={AGENT_ID} ref={messagesContentRef} className="dojo3-agent-enter space-y-2 sm:space-y-4">
        {messages.map((msg, msgIndex) => {
          // Group-render: subsequent members of a tool-pill group are
          // skipped here; the group renders at the first member below.
          if (toolPillGrouping.skipIds.has(msg.id)) return null;
          // Hide inter-agent / coordination / engine content in regular mode via the
          // canonical classifier (classifyMessageForDisplay, @dojo/shared) so every chat
          // surface agrees and the prefix list cannot drift. Channel-sourced inbound stays
          // user-visible (badged by UserBubble); system rows keep their own handling below.
          if (!wordyMode && (msg.role === 'user' || msg.role === 'assistant')
              && classifyMessageForDisplay(msg).tier !== 'user-visible') {
            return null;
          }
          // ── Drafts are not answers ──
          // An assistant row re-classified at the turn boundary: the turn's answer key
          // named another bubble, so this is the agent drafting; it renders as a dimmed
          // expandable note (keyed on the stored kind, the text is byte-unchanged). The
          // visibility lane makes an already-on-screen duplicate wordy-only.
          if (msg.role === 'assistant' && msg.displayKind === 'working-note') {
            const how = renderWorkingNote(messages, msgIndex, wordyMode);
            if (how === 'hide') return null;
            const { text: noteText } = parseMessageContent(msg.content);
            if (how === 'answer') return <NoteAsAnswer key={msg.id} msg={msg} text={noteText || msg.content} wordyMode={wordyMode} modelNames={modelNames} />;
            return <WorkingNoteBubble key={msg.id} text={noteText || msg.content} />;
          }
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} wordyMode={wordyMode} />;
          if (msg.role === 'tool') {
            if (!wordyMode) return null; // Hide tool results in non-wordy mode
            return <ToolResultBubble key={msg.id} msg={msg} />;
          }
          if (msg.role === 'system') {
            const trimmedSys = msg.content.trim();
            // The no-reply marker persists only so the next turn knows this one ended
            // silently; showing it as a bubble has no value. Hidden in both modes.
            if (trimmedSys === NO_REPLY_CLOSED_MARKER) {
              return null;
            }
            // Demoted working note: a plain note renders in BOTH modes. An internal note
            // (routed-channel turn, never delivered there) hides while a real answer sits
            // on screen beside it; when it is the only thing said, hiding would make the
            // turn silent, so it stays dimmed. The verdict lives in `working-note-visibility.ts`.
            const note = parseWorkingNote(trimmedSys);
            if (note) {
              const how = renderWorkingNote(messages, msgIndex, wordyMode);
              if (how === 'hide') return null;
              if (how === 'answer') return <NoteAsAnswer key={msg.id} msg={msg} text={note.text} wordyMode={wordyMode} modelNames={modelNames} />;
              return <WorkingNoteBubble key={msg.id} text={note.text} />;
            }
            // Divider-style markers: any system message shaped "── label ──" renders as a
            // divider with the label centered. "Memory Compacted" is diagnostic chrome,
            // wordy-only; "New Session" and the like stay always-visible.
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
            // Routing markers were attached to their assistant bubble earlier; skip the
            // standalone row when attached, show it when not, so no channel info is lost.
            if (hiddenRoutingMarkerIds.has(msg.id)) return null;
            // Unattached routing marker: render its own badge. Same canonical parser +
            // badge as the attached path, so phone / Teams / email resolve correctly.
            const routed = parseOutboundRouting(msg.content);
            if (routed) {
              const badge = outboundBadge(routed.channel, routed.recipient, routed.state);
              return (
                <div key={msg.id} className="flex justify-start my-1 px-1">
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono">
                    <span className="text-ui/40">{badge.emoji}</span>
                    <span>{badge.label}</span>
                  </div>
                </div>
              );
            }
            // Owner-alert system notes are the one class of system rows that render in
            // default mode: a muted bubble so the owner sees the heads-up; wordy mode
            // falls through to the standard system rendering.
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
          // Replace tool-only assistant turns with a compact pill in non-wordy mode: the
          // pill keeps the feed honest without dumping the full tool-call cards.
          if (msg.role === 'assistant' && !wordyMode) {
            const { text, blocks } = parseMessageContent(msg.content);
            const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
            // Render channel-send tool calls as outbound bubbles: the user sees what
            // was sent, not just a "⚙ imessage_send" gear.
            const channelSend = blocks?.find(
              (b) => b.type === 'tool_use' && b.name && isChannelSendBubbleTool(b.name),
            );
            // Hide the outbound bubble when the underlying tool call was refused;
            // `toolResultErrorById` above carries that verdict.
            const channelSendErrored = channelSend?.id
              ? toolResultErrorById.get(channelSend.id) === true
              : false;
            if (channelSend && !channelSendErrored) {
              // The badge describes the SEND, so it rides on the ChannelSendBubble only:
              // passing it to the text too would double-label (it stays outboundChannel=null).
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
            // Errored send with nothing else in this message: render nothing, so the
            // user doesn't see a blocked attempt; recovery text renders separately.
            if (channelSendErrored && !text) {
              const otherToolUses = (blocks ?? []).filter(
                (b) => b.type === 'tool_use' && b !== channelSend,
              );
              if (otherToolUses.length === 0) return null;
            }
            // Tool-only turn with no attachments: compact class-aware badge (or grouped
            // row). One that carries attachments is a deliverable: fall through to
            // AssistantBubble so the image/file chips render in regular mode.
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
      </div>
    </Dojo3Stage>
    </PresenceProvider>
  );
};
