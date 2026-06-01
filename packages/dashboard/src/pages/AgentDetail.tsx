import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { AgentDetail as AgentDetailType, Message, AgentMessage, Model, PermissionManifest } from '@dojo/shared';
import type { ChatChunkEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, ChatMessageEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { formatDate } from '../lib/dates';
import { StatusBadge } from '../components/StatusBadge';
import { ToolCallBlock, ToolCallCard } from '../components/ToolCallBlock';
import { Markdown } from '../components/Markdown';
import { PermissionsEditor } from '../components/PermissionsEditor';
import { ChatInput } from '../components/ChatInput';
import { AttachmentChips } from '../components/AttachmentChips';
import { TechniqueSelector } from '../components/TechniqueSelector';
import { ThinkingBubble } from '../components/ThinkingBubble';
import { useToast } from '../hooks/useToast';

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
  content: string;
  blocks?: ContentBlock[];
  createdAt: string;
  toolCalls?: ToolCallData[];
  isStreaming?: boolean;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string }>;
  source?: 'voice' | null;
  // DeepSeek native thinking-mode / OpenRouter unified reasoning stream.
  // Populated by the chat:reasoning_chunk subscription and from persisted
  // reasoning_content on history reload.
  reasoningContent?: string;
  isReasoningStreaming?: boolean;
}

type Tab = 'chat' | 'config' | 'history' | 'inter-agent';

// ── Helpers ──

const formatUptime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
};

const formatTimeRemaining = (timeoutAt: string): string => {
  const remaining = Math.max(0, Math.floor((new Date(timeoutAt).getTime() - Date.now()) / 1000));
  if (remaining === 0) return 'Expired';
  if (remaining < 60) return `${remaining}s`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
  return `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`;
};

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
    // Not JSON
  }
  return { text: raw };
}

const classificationStyles: Record<string, { bg: string; text: string; label: string }> = {
  sensei: { bg: 'bg-cp-amber/20', text: 'text-cp-amber', label: 'Sensei' },
  ronin: { bg: 'bg-cp-blue/20', text: 'text-cp-blue', label: 'Ronin' },
  apprentice: { bg: 'bg-ui/[0.08]', text: 'text-ui/55', label: 'Apprentice' },
};

const getClassification = (agent: AgentDetailType) => {
  return classificationStyles[agent.classification] ?? classificationStyles.apprentice;
};

// PermissionsView removed — replaced by PermissionsEditor component

// ── Message Bubbles (same pattern as Chat.tsx) ──

// Compact pill shown in non-wordy mode when an assistant turn was tool-calls only.
const ToolOnlyPill = ({ msg }: { msg: ChatMessage }) => {
  const { blocks } = parseMessageContent(msg.content);
  const toolUses = (blocks ?? []).filter(b => b.type === 'tool_use');
  if (toolUses.length === 0) return null;
  const label = toolUses.length === 1
    ? toolUses[0].name ?? 'tool'
    : `${toolUses.length} tools`;
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[11px] font-mono">
        <span className="text-ui/40">⚙</span>
        <span>{label}</span>
      </div>
    </div>
  );
};

// v2.7.23 — when the agent calls a channel-send tool directly (imessage_send,
// teams_send_message), render the outbound message content + channel pill
// rather than the generic tool-only pill. Mirrors the inbound channel
// rendering so user and agent sides have symmetric "via iMessage" treatment.
// In non-wordy mode this is what the user sees instead of a "⚙ imessage_send"
// gear icon — they see the actual text the agent sent.
const CHANNEL_SEND_TOOLS: Record<string, { label: string; emoji: string }> = {
  imessage_send: { label: 'sent via iMessage', emoji: '\u{1F4AC}' },
  teams_send_message: { label: 'sent via Teams', emoji: '\u{1F4DD}' },
  outlook_reply: { label: 'sent via email reply', emoji: '\u{2709}\u{FE0F}' },
  gmail_reply: { label: 'sent via email reply', emoji: '\u{2709}\u{FE0F}' },
  outlook_send: { label: 'sent via email', emoji: '\u{2709}\u{FE0F}' },
  gmail_send: { label: 'sent via email', emoji: '\u{2709}\u{FE0F}' },
};

const ChannelSendBubble = ({ msg, toolUse }: { msg: ChatMessage; toolUse: ContentBlock }) => {
  const meta = CHANNEL_SEND_TOOLS[toolUse.name ?? ''];
  if (!meta) return null;
  // imessage_send / teams_send_message use `message`; outlook/gmail use `body`.
  const messageText = typeof toolUse.input?.message === 'string'
    ? toolUse.input.message
    : typeof toolUse.input?.body === 'string'
      ? toolUse.input.body
      : typeof toolUse.input?.text === 'string'
        ? toolUse.input.text
        : '';
  if (!messageText) return null;
  return (
    <div className="flex flex-col items-start">
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 ml-1">
        <span className="text-ui/40">{meta.emoji}</span>
        <span>{meta.label}</span>
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

// v2.3.16 — strip the iMessage source framing (engine-injected routing
// wrapper) and surface a small "via iMessage" badge instead. Mirrors the
// treatment in Chat.tsx so the channel-vs-conversation distinction is
// consistent everywhere.
const IMESSAGE_SOURCE_RE = /^\[SOURCE: IMESSAGE FROM [^\]]+\]\s*/;

// Mirrors Chat.tsx's stripper. See chat.ts buildContentWithAttachments
// for the source of these tags. Exported for the temp-bubble dedup so
// the comparison ignores server-injected attachment framing.
function stripAttachmentTags(content: string): string {
  return content
    .replace(/\n\[File attached:[^\]]+\]\nPath:[^\n]+\nUse file_read with this path to read the file contents\.?/g, '')
    .replace(/\n\[Office file attached:[^\]]+\][^\n]*/g, '')
    .replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '')
    .trim();
}

const UserBubble = ({ msg }: { msg: ChatMessage }) => {
  const fromIMessage = IMESSAGE_SOURCE_RE.test(msg.content);
  const fromVoice = msg.source === 'voice';
  const stripped = fromIMessage ? msg.content.replace(IMESSAGE_SOURCE_RE, '') : msg.content;
  const displayContent = msg.attachments?.length ? stripAttachmentTags(stripped) : stripped;

  return (
    <div className="flex flex-col items-end">
      {fromIMessage && (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 mr-1">
          <span className="text-ui/40">{'\u{1F4AC}'}</span>
          <span>via iMessage</span>
        </div>
      )}
      {fromVoice && !fromIMessage && (
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
      <div className="bubble-user max-w-[75%] px-4 py-3 text-ui">
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-xs mt-2 text-cp-blue-light">
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

const AssistantBubble = ({ msg, wordyMode = true }: { msg: ChatMessage; wordyMode?: boolean }) => {
  const { text: rawText, blocks } = parseMessageContent(msg.content);
  const text = rawText?.trim() || '';
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
  const hasReasoning = !!(msg.reasoningContent && msg.reasoningContent.length > 0);
  const reasoningOpenDefault = hasReasoning && (msg.isReasoningStreaming || text.length === 0);
  const [reasoningOpen, setReasoningOpen] = useState(reasoningOpenDefault);
  useEffect(() => {
    if (!msg.isReasoningStreaming && text.length > 0) setReasoningOpen(false);
  }, [msg.isReasoningStreaming, text.length]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[75%]">
        {/* Reasoning / "Thinking…" panel — DeepSeek native + OpenRouter
            unified reasoning stream. Without this the chat showed nothing
            for the model's pre-answer thinking. */}
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

        {text && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3 whitespace-pre-wrap text-xs sm:text-sm">
            <Markdown content={text} />
            {msg.isStreaming && (
              <span className="inline-flex gap-1 ml-1 align-middle">
                <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        )}
        {!text && msg.isStreaming && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-ui/[0.12] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </div>
        )}
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
        {/* v2.5.23 — removed msg.toolCalls render path. See Chat.tsx for rationale. */}
        {!msg.isStreaming && (text || hasToolUse || hasReasoning) && (
          <div className="text-xs mt-1 text-ui/40 px-1">
            {formatDate(msg.createdAt)}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Chat Tab ──

const ChatTab = ({ agentId }: { agentId: string }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isWorking, setIsWorking] = useState(false);
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
  const { subscribe } = useWebSocket();
  const currentToolCallsRef = useRef<ToolCallData[]>([]);

  const lastMessageIdRef = useRef<string | null>(null);
  const scrollToBottom = useCallback((instant?: boolean) => {
    if (instant) {
      const container = messagesEndRef.current?.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // v2.5.45 — auto-scroll fires on (a) new message and (b) the last
  // message growing during streaming. Streaming chunks only follow if
  // the user is already near the bottom, so reading older history isn't
  // disturbed.
  const lastMessageSigRef = useRef<string | null>(null);
  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!last) return;
    const sig = `${last.id}:${last.content?.length ?? 0}`;
    if (sig === lastMessageSigRef.current) return;
    const isNewMessage = last.id !== lastMessageIdRef.current;
    lastMessageIdRef.current = last.id;
    lastMessageSigRef.current = sig;
    if (isNewMessage) {
      scrollToBottom();
    } else {
      const container = messagesContainerRef.current;
      if (container) {
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (nearBottom) scrollToBottom(true);
      }
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    const loadHistory = async () => {
      const result = await api.getAgentHistory(agentId, 200);
      if (result.ok) {
        setMessages(
          result.data.map((m: Message) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            attachments: m.attachments,
            source: m.source ?? null,
            reasoningContent: m.reasoningContent ?? undefined,
          })),
        );
        setHasMore(result.data.length >= 50);
        // Scroll to bottom on initial load — instant, with fallbacks
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToBottom(true);
          });
        });
        setTimeout(() => scrollToBottom(true), 150);
        setTimeout(() => scrollToBottom(true), 500);
      }
      setLoading(false);
    };
    loadHistory();
  }, [agentId]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;

    setLoadingMore(true);
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    const result = await api.getChatHistory(agentId, 50, oldestId);
    if (result.ok && result.data.length > 0) {
      const older = result.data.map((m: Message) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        attachments: m.attachments,
        source: m.source ?? null,
      }));
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
  }, [loadingMore, hasMore, messages, agentId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (container.scrollTop < 100 && hasMore && !loadingMore) {
        loadOlderMessages();
      }
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, loadOlderMessages]);

  useEffect(() => {
    // Engine-agnostic backstop for stuck "thinking" dots: when the agent
    // reaches a terminal state via any code path (model error, MAX_TOOL_LOOPS,
    // compaction-block, network drop, etc.) and chat:chunk done:true never
    // fires, the streaming bubble's isStreaming flag stays true and its dots
    // bounce forever. Reconciling on agent:status idle/error/terminated
    // drops empty bubbles (ghost dots) and clears the flag on non-empty
    // ones (stale dots).
    const reconcileStreamingBubbles = () => {
      setMessages((prev) =>
        prev
          .filter((m) => !(m.isStreaming && (!m.content || m.content.length === 0)))
          .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
      );
    };

    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentId) return;

      // v2.5.22 — see Chat.tsx for rationale. Snapshot + clear the tool-call
      // ref on every done event so a tool-only iteration doesn't leak its
      // tool calls into the next iteration's text-only bubble.
      const toolCallsSnapshot = e.done && currentToolCallsRef.current.length > 0
        ? [...currentToolCallsRef.current]
        : null;
      if (e.done) currentToolCallsRef.current = [];

      setMessages((prev) => {
        // Look up the streaming bubble by messageId anywhere in the
        // list, not just the tail. The old "only check last" rule broke
        // whenever a non-streaming message (tool_result, system divider,
        // an empty-content runtime broadcast) landed between chunks —
        // every subsequent chunk created a fresh bubble. Also makes the
        // reasoning-before-answer flow work: a chat:reasoning_chunk
        // creates the bubble shell first, then chat:chunk fills in the
        // answer text on the same bubble. Mirrors Chat.tsx:569-611.
        const idx = prev.findIndex((m) => m.id === e.messageId && m.isStreaming);
        if (idx >= 0) {
          const existing = prev[idx];
          const updated = {
            ...existing,
            content: existing.content + e.content,
            // Answer text arriving means reasoning is no longer streaming.
            isReasoningStreaming: false,
          };
          if (e.done) {
            updated.isStreaming = false;
            updated.toolCalls = toolCallsSnapshot ?? undefined;
            // Do NOT setIsWorking(false) — chat:chunk done fires mid-tool-loop.
            // Let agent:status idle/error clear isWorking.
          }
          const out = [...prev];
          out[idx] = updated;
          return out;
        } else if (prev.some((m) => m.id === e.messageId)) {
          // Already have this message (finalized) — skip duplicate from reconnect.
          return prev;
        } else {
          // Skip empty done events (ghost bubbles).
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
              isStreaming: !e.done,
            },
          ];
        }
      });
    });

    // Reasoning / thinking deltas (DeepSeek native, OpenRouter unified).
    // Either updates the existing streaming bubble for this messageId or
    // creates a fresh shell with reasoning but no answer text yet —
    // chat:chunk for the same id will then populate the answer. Mirrors
    // Chat.tsx:619-649.
    const unsubReasoning = subscribe('chat:reasoning_chunk', (event: WsEvent) => {
      const e = event as { type: 'chat:reasoning_chunk'; agentId: string; messageId: string; content: string; done: boolean };
      if (e.agentId !== agentId) return;
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
      if (e.agentId !== agentId) return;
      currentToolCallsRef.current.push({ name: e.tool, args: e.args });
    });

    const unsubToolResult = subscribe('chat:tool_result', (event: WsEvent) => {
      const e = event as ChatToolResultEvent;
      if (e.agentId !== agentId) return;
      const tc = currentToolCallsRef.current.find((t) => t.name === e.tool && !t.result);
      if (tc) tc.result = e.result;
    });

    const unsubError = subscribe('chat:error', (event: WsEvent) => {
      const e = event as ChatErrorEvent;
      if (e.agentId !== agentId) return;
      // Phase 8 F1 fix: honor the severity field — see Chat.tsx for the
      // same fix and rationale.
      const isRateLimit = (e as { code?: string }).code === 'RATE_LIMITED' || e.error.includes('429') || e.error.toLowerCase().includes('rate_limit');
      const sev: 'info' | 'warning' | 'error' = e.severity ?? (isRateLimit ? 'warning' : 'error');
      if (sev === 'info') {
        toast.success(e.error);
        if (e.code === 'AGENT_RECOVERED') {
          setIsWorking(false);
          reconcileStreamingBubbles();
        }
      } else if (sev === 'warning') {
        toast.warning(e.error);
      } else {
        toast.error(e.error);
        setIsWorking(false);
        reconcileStreamingBubbles();
      }
    });

    // chat:message — canonical persisted messages (tool result rows, system
    // notes, and the finalized assistant message with full tool_use blocks).
    // Pre-2026-04-30 this page didn't subscribe at all, which is why mid-turn
    // tool calls and results would stop appearing live and only show up after
    // navigating away and back (the DB fetch picks them up). Mirrors the
    // handler in Chat.tsx, with one difference: when the incoming message
    // matches an existing bubble (e.g., the streaming assistant bubble), we
    // REPLACE its content with the canonical JSON instead of skipping. That
    // lets wordy-mode render tool_use cards live, since the streamed plain
    // text doesn't carry tool_use block metadata.
    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.message.id);
        if (idx >= 0) {
          // No-reply path: empty assistant broadcast = drop the bubble.
          if (
            e.message.role === 'assistant' &&
            (!e.message.content || e.message.content.length === 0)
          ) {
            return prev.filter((_, i) => i !== idx);
          }
          const existing = prev[idx];
          const updated = [...prev];
          updated[idx] = {
            ...existing,
            content: e.message.content,
            attachments: e.message.attachments ?? existing.attachments,
            createdAt: e.message.createdAt ?? existing.createdAt,
            toolCalls: undefined,
          };
          // v2.5.21 — Removed the v2.5.20 move-to-tail. See Chat.tsx.
          return updated;
        }
        // Reconcile optimistic temp- user bubble (see Chat.tsx for context).
        // Compare on typed-text core (stripAttachmentTags) so messages with
        // file attachments dedup correctly — server appends [File attached:]
        // tags the temp bubble doesn't have.
        if (e.message.role === 'user') {
          const broadcastCore = stripAttachmentTags(e.message.content);
          const tempIdx = prev.findIndex(
            (m) => m.role === 'user' && m.id.startsWith('temp-') &&
                   stripAttachmentTags(m.content) === broadcastCore,
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
            attachments: e.message.attachments,
            source: e.message.source ?? null,
          },
        ];
      });
    });

    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string };
      if (e.agentId !== agentId) return;
      if (e.status === 'working') setIsWorking(true);
      else if (e.status === 'idle' || e.status === 'error') {
        setIsWorking(false);
        reconcileStreamingBubbles();
      }
    });

    return () => {
      unsubChunk();
      unsubReasoning();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubMessage();
      unsubStatus();
    };
  }, [subscribe, agentId]);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setIsWorking(true);
    currentToolCallsRef.current = [];

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const result = await api.sendAgentMessage(agentId, content, attachments);
    if (!result.ok) {
      if (result.error.includes('busy')) {
        toast.info('Agent is mid-task — your message will be delivered when it finishes.');
      } else {
        toast.error(result.error);
      }
      setIsWorking(false);
    }
  };

  const handleStop = async () => {
    try {
      await api.request(`/agents/${agentId}/stop`, { method: 'POST' });
    } catch { /* best effort */ }
  };

  const handleNewSession = async () => {
    if (!confirm('Start a new session? The current conversation will be archived to the vault.')) return;
    const res = await api.request<{ archiveId: string; sessionStartedAt: string }>(`/chat/${agentId}/new-session`, { method: 'POST' });
    if (res.ok) {
      const result = await api.getAgentHistory(agentId, 200);
      if (result.ok) {
        setMessages(result.data.map((m: Message) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, attachments: m.attachments, source: m.source ?? null, reasoningContent: m.reasoningContent ?? undefined })));
      }
      toast.success('Session reset — conversation archived to vault.');
    }
  };

  // v2.7.25 — build a tool_use_id → is_error lookup so the channel-send
  // bubble can hide itself when its underlying tool call was refused.
  // Tool results live in subsequent role='tool' messages; each block in
  // the JSON-array content has tool_use_id + is_error. Without this map,
  // a blocked imessage_send would still render "sent via iMessage" + the
  // message text in non-wordy mode (the tool result is hidden), making
  // the user think a message was delivered when it wasn't.
  //
  // v2.7.26 — MUST sit ABOVE the `if (loading) return ...` early exit.
  // React hook order has to be identical across every render. Placing
  // the useMemo below the early return meant it didn't run on the first
  // (loading=true) render but ran once loading flipped — producing
  // React error #310 ("Rendered more hooks than during the previous
  // render") and a blank agent-detail page.
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ui/40">Loading chat...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-2 sm:px-4 md:px-6 py-3 sm:py-6 space-y-2 sm:space-y-4">
        {loadingMore && (
          <div className="text-center py-2">
            <span className="text-xs text-ui/25">Loading older messages...</span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-ui/55 mb-2">Chat with this agent</h2>
              <p className="text-sm text-ui/25">Send a message to get started.</p>
            </div>
          </div>
        )}
        {/* v2.7.25 — map tool_use_id → was-error so the channel-send
            bubble can hide itself when the underlying tool was refused
            (e.g. engine blocked imessage_send to primary user while
            they were active on dashboard). Without this, the bubble
            would falsely render "sent via iMessage" + the message text
            even though nothing was actually delivered. */}
        {messages.map((msg) => {
          // Hide inter-agent and system messages unless wordy mode is on.
          // iMessage-sourced user messages stay visible (they're a real
          // channel, not internal routing) — UserBubble strips the framing
          // and surfaces a "via iMessage" badge.
          if (!wordyMode && msg.role === 'user' && (
            msg.content.startsWith('[A2A:') ||
            (msg.content.includes('[SOURCE:') && !msg.content.startsWith('[SOURCE: IMESSAGE FROM')) ||
            msg.content.startsWith('[System:') ||
            msg.content.startsWith('Tracker review --')
          )) return null;
          if (msg.role === 'tool' && !wordyMode) return null;
          if (msg.role === 'system') {
            // Divider-style markers: any system message shaped "── label ──"
            // becomes a horizontal divider. "Memory Compacted" dividers are
            // wordy-mode-only (diagnostic chrome); other dividers like
            // "New Session" stay always-visible.
            const dividerMatch = msg.content.trim().match(/^──\s*(.+?)\s*──$/);
            if (dividerMatch) {
              const isCompactionDivider = /^Memory Compacted/.test(dividerMatch[1]);
              if (isCompactionDivider && !wordyMode) return null;
              return (
                <div key={msg.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-ui/[0.12]" />
                  <span className="text-xs text-ui/25 shrink-0">{dividerMatch[1]}</span>
                  <div className="flex-1 h-px bg-ui/[0.12]" />
                </div>
              );
            }
            // v2.7.24 — channel routing delivery marker. Matches:
            //   - Legacy `[SENT VIA IMESSAGE to X]`
            //   - `[Reply routed via iMessage to X]` (v2.7.23)
            //   - `[Reply routed via Teams to chat X]` (v2.7.24)
            //   - `[Reply routed via email reply (thread: "X")]` (v2.7.24)
            const routingMatch = msg.content.trim().match(/^\[(?:SENT VIA IMESSAGE to .+|Reply routed via (iMessage|Teams|email)[^\]]*)\]$/);
            if (routingMatch) {
              const channel = routingMatch[1] ?? 'iMessage';
              const channelLabel = channel.toLowerCase() === 'email'
                ? 'sent via email reply'
                : `sent via ${channel}`;
              const channelEmoji = channel.toLowerCase() === 'email'
                ? '\u{2709}\u{FE0F}'
                : channel === 'Teams' ? '\u{1F4DD}' : '\u{1F4AC}';
              return (
                <div key={msg.id} className="flex justify-end my-1 px-1">
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono">
                    <span className="text-ui/40">{channelEmoji}</span>
                    <span>{channelLabel}</span>
                  </div>
                </div>
              );
            }
            if (!wordyMode) return null;
          }
          if (!wordyMode && msg.role === 'assistant') {
            if (msg.content.startsWith('I got stuck on that') || msg.content.startsWith("I'm sorry — I'm having trouble")) return null;
            // v2.7.23 — when the assistant's tool calls include a channel-
            // send (imessage_send / teams_send_message), render the
            // outbound message content + channel pill instead of the
            // generic "⚙ imessage_send" tool icon. The user wants the same
            // symmetry as inbound: see what was sent, not just that
            // something was sent.
            const parsed = parseMessageContent(msg.content);
            const hasToolUse = parsed.blocks?.some((b) => b.type === 'tool_use');
            const channelSend = parsed.blocks?.find(
              (b) => b.type === 'tool_use' && b.name && CHANNEL_SEND_TOOLS[b.name],
            );
            // v2.7.25 — if the channel-send tool was refused (engine guard,
            // bridge off, allowlist miss, etc.), hide the outbound bubble.
            // Falsely rendering it as "sent via iMessage" with the message
            // text would tell the user a message was delivered that wasn't.
            const channelSendErrored = channelSend?.id
              ? toolResultErrorById.get(channelSend.id) === true
              : false;
            if (channelSend && !channelSendErrored) {
              return (
                <div key={msg.id} className="flex flex-col gap-2">
                  {parsed.text && (
                    <AssistantBubble msg={{ ...msg, content: parsed.text }} wordyMode={wordyMode} />
                  )}
                  <ChannelSendBubble msg={msg} toolUse={channelSend} />
                </div>
              );
            }
            // v2.7.25 — channel send errored and it's the only thing in
            // this assistant message: render nothing. The agent's recovery
            // text (if any) lives in a subsequent assistant message and
            // will render through the normal path on its own iteration.
            if (channelSendErrored && !parsed.text) {
              const otherToolUses = (parsed.blocks ?? []).filter(
                (b) => b.type === 'tool_use' && b !== channelSend,
              );
              if (otherToolUses.length === 0) return null;
            }
            // Tool-only turns become a compact pill (rather than disappearing)
            // so the user still sees that the agent did something.
            if (!parsed.text && hasToolUse) return <ToolOnlyPill key={msg.id} msg={msg} />;
          }
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
          return <AssistantBubble key={msg.id} msg={msg} wordyMode={wordyMode} />;
        })}
        {isWorking && !messages.some(m => m.isStreaming) && <ThinkingBubble />}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput
        agentId={agentId}
        onSend={handleSend}
        variant="primary"
        wordyMode={wordyMode}
        onToggleWordyMode={() => {
          const next = !wordyMode;
          setWordyMode(next);
          localStorage.setItem('dojo_wordy_mode', String(next));
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToBottom(true);
            });
          });
        }}
        onNewSession={handleNewSession}
        isWorking={isWorking}
        onStop={handleStop}
      />
    </div>
  );
};

// ── Equipped Techniques Section ──

const EquippedTechniquesSection = ({ agent, onUpdated, showToast }: { agent: AgentDetailType; onUpdated: () => void; showToast: (msg: string) => void }) => {
  const [equipped, setEquipped] = useState<string[]>(agent.equippedTechniques ?? []);

  useEffect(() => {
    setEquipped(agent.equippedTechniques ?? []);
  }, [agent.equippedTechniques]);

  const handleChange = async (updated: string[]) => {
    setEquipped(updated);
    const result = await api.updateAgentConfig(agent.id, { equippedTechniques: updated } as Record<string, unknown>);
    if (result.ok) {
      showToast('Techniques updated');
      onUpdated();
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Equipped Techniques</h3>
      <div className="glass-nested rounded-xl p-4">
        <TechniqueSelector selected={equipped} onChange={handleChange} />
      </div>
    </div>
  );
};

// ── Config Tab ──

// ── Dreamer Ignore Toggle ──
//
// Switches the agent's dreamer_ignore flag. When ON, the vault archive
// layer skips this agent entirely — Dreamer never sees this agent's
// conversations and never extracts memories from them. Useful for
// ephemeral test agents and junk-prone sub-agents whose chatter would
// just clog the nightly Dreamer cycle without producing useful long-term
// memory.

const DreamerIgnoreToggle = ({ agentId, initial, onSaved }: { agentId: string; initial: boolean; onSaved: () => void }) => {
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => { setEnabled(initial); }, [initial]);

  const toggle = async () => {
    if (saving) return;
    const next = !enabled;
    setSaving(true);
    setEnabled(next);
    const result = await api.updateAgentConfig(agentId, { dreamerIgnore: next });
    setSaving(false);
    if (result.ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } else {
      // Roll back on error
      setEnabled(!next);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-sm font-medium text-ui/90">Skip in Dreamer cycle</div>
        <p className="text-xs text-ui/40 mt-1 max-w-2xl">
          When on, this agent's conversations are NOT archived for the Dreamer to process.
          Useful for ephemeral test agents and any agent whose chatter you don't want extracted into long-term memory.
          The agent's own memory and chat history are unaffected — only the nightly Dreamer cycle is bypassed.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {savedFlash && <span className="text-xs text-cp-teal">Saved</span>}
        <button
          onClick={toggle}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            enabled ? 'bg-cp-teal' : 'bg-ui/[0.12]'
          } ${saving ? 'opacity-60' : ''}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-ui transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  );
};

const SaveToast = ({ message }: { message: string | null }) => {
  if (!message) return null;
  return (
    <div className="fixed bottom-6 right-6 px-4 py-2 bg-cp-teal text-[var(--btn-success-text)] text-sm rounded-lg shadow-lg z-50 animate-pulse">
      {message}
    </div>
  );
};

const ConfigTab = ({ agent, onUpdated }: { agent: AgentDetailType; onUpdated: () => void }) => {
  const [models, setModels] = useState<Model[]>([]);
  const [providerNameById, setProviderNameById] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedModelId, setSelectedModelId] = useState(
    agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''),
  );
  const [editedPerms, setEditedPerms] = useState<Partial<PermissionManifest>>(agent.permissions as Partial<PermissionManifest>);
  const [editedToolsPolicy, setEditedToolsPolicy] = useState<{ allow: string[]; deny: string[] }>(
    (agent.toolsPolicy as { allow: string[]; deny: string[] }) ?? { allow: [], deny: [] },
  );
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isPrimary = agent.classification === 'sensei';

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  const [groups, setGroups] = useState<api.AgentGroup[]>([]);

  useEffect(() => {
    const load = async () => {
      const [promptResult, modelsResult, groupsResult, providersResult] = await Promise.all([
        api.getAgentSystemPrompt(agent.id),
        api.getModels(),
        api.getGroups(),
        api.getProviders(),
      ]);
      if (promptResult.ok) setSystemPrompt(promptResult.data.content);
      if (modelsResult.ok) setModels(modelsResult.data.filter((m: Model) => m.isEnabled));
      if (groupsResult.ok) setGroups(groupsResult.data);
      if (providersResult.ok) {
        const map: Record<string, string> = {};
        for (const p of providersResult.data) map[p.id] = p.name;
        setProviderNameById(map);
      }
      setLoading(false);
    };
    load();
  }, [agent.id]);

  const saveSystemPrompt = async () => {
    const result = await api.updateAgentConfig(agent.id, { systemPrompt });
    if (result.ok) { showToast('System prompt saved'); onUpdated(); }
  };

  const saveModel = async () => {
    if (!selectedModelId) return;
    const result = await api.updateAgentConfig(agent.id, { modelId: selectedModelId });
    if (result.ok) { showToast('Model updated'); onUpdated(); }
  };

  const savePermissions = async () => {
    // Merge shareUserProfile into agent config
    const existingConfig = (agent.config as Record<string, unknown>) ?? {};
    const updatedConfig = { ...existingConfig, shareUserProfile: editedShareProfile };

    const result = await api.updateAgentConfig(agent.id, {
      permissions: editedPerms as Record<string, unknown>,
      toolsPolicy: editedToolsPolicy,
      config: updatedConfig,
    } as Record<string, unknown>);
    if (result.ok) { showToast('Permissions saved'); onUpdated(); }
  };

  const [editedShareProfile, setEditedShareProfile] = useState<boolean>(
    (agent.config as Record<string, unknown>)?.shareUserProfile === true,
  );

  const handlePermsChange = (perms: Partial<PermissionManifest>, tools: { allow: string[]; deny: string[] }, shareProfile: boolean) => {
    setEditedPerms(perms);
    setEditedToolsPolicy(tools);
    setEditedShareProfile(shareProfile);
  };

  const [editedName, setEditedName] = useState(agent.name);

  const saveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === agent.name) return;
    const result = await api.updateAgentConfig(agent.id, { name: trimmed } as Record<string, unknown>);
    if (result.ok) {
      // For sensei agents, also update the platform config setting
      if (agent.classification === 'sensei') {
        // Determine which setting to update by comparing agent ID to config
        const primaryResult = await api.getSetting('primary_agent_id');
        const pmResult = await api.getSetting('pm_agent_id');
        const trainerResult = await api.getSetting('trainer_agent_id');

        if (primaryResult.ok && primaryResult.data.value === agent.id) {
          await api.setSetting('primary_agent_name', trimmed);
        } else if (pmResult.ok && pmResult.data.value === agent.id) {
          await api.setSetting('pm_agent_name', trimmed);
        } else if (trainerResult.ok && trainerResult.data.value === agent.id) {
          await api.setSetting('trainer_agent_name', trimmed);
        }
      }
      showToast('Name updated');
      onUpdated();
    }
  };

  if (loading) return <div className="flex-1 loading-state">Loading...</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <SaveToast message={toast} />

      {/* Name */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Name</h3>
        <div className="glass-nested rounded-xl p-4">
          <div className="flex items-center gap-3">
            <input
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              className="glass-input flex-1"
            />
            <button
              onClick={saveName}
              disabled={!editedName.trim() || editedName.trim() === agent.name}
              className="px-3 py-2 text-sm glass-btn-primary rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
          {agent.classification === 'sensei' && (
            <p className="text-xs text-ui/25 mt-2">Changing a Sensei's name updates the platform config.</p>
          )}
        </div>
      </div>

      {/* Model */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Model</h3>
        <div className="glass-nested rounded-xl p-4">
          <div className="flex items-center gap-3">
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              className="glass-select flex-1"
            >
              <option value="">No model selected</option>
              <option value="auto">Auto (Smart Router)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {providerNameById[m.providerId] ? ` (${providerNameById[m.providerId]})` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={saveModel}
              disabled={selectedModelId === (agent.modelId === 'auto' ? 'auto' : (agent.modelId ?? ''))}
              className="px-3 py-2 text-sm glass-btn-primary rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Classification */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Classification</h3>
        <div className="glass-nested rounded-xl p-4">
          {agent.classification === 'sensei' ? (
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 rounded text-xs font-bold bg-cp-amber/20 text-cp-amber">Sensei</span>
              <span className="text-sm text-ui/40">Cannot be dismissed or deleted. Set programmatically.</span>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <select
                value={agent.classification}
                onChange={async (e) => {
                  const result = await api.updateAgentConfig(agent.id, { classification: e.target.value } as Record<string, unknown>);
                  if (result.ok) { showToast('Classification updated'); onUpdated(); }
                }}
                className="glass-select"
              >
                <option value="apprentice">Apprentice</option>
                <option value="ronin">Ronin</option>
              </select>
              <span className="text-xs text-ui/40">
                {agent.classification === 'ronin'
                  ? 'Persists across restarts. Only you can dismiss from the dashboard.'
                  : 'Can be dismissed by other agents. Subject to timeouts.'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Group */}
      {!isPrimary && groups.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Group</h3>
          <div className="glass-nested rounded-xl p-4">
            <select
              value={agent.groupId ?? ''}
              onChange={async (e) => {
                const gid = e.target.value || null;
                const result = await api.assignAgentToGroupApi(agent.id, gid);
                if (result.ok) { showToast(gid ? 'Added to group' : 'Removed from group'); onUpdated(); }
              }}
              className="glass-select w-full"
            >
              <option value="">No group (ungrouped)</option>
              {groups.filter(g => g.id !== 'system-group').map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Equipped Techniques */}
      <EquippedTechniquesSection agent={agent} onUpdated={onUpdated} showToast={showToast} />

      {/* System Prompt */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">
          System Prompt {isPrimary && <span className="text-xs text-ui/25 normal-case">(SOUL.md)</span>}
        </h3>
        <div className="glass-nested rounded-xl p-4">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={12}
            className="glass-textarea w-full font-mono resize-y"
          />
          <div className="flex justify-end mt-2">
            <button
              onClick={saveSystemPrompt}
              className="px-3 py-1.5 text-sm glass-btn-primary rounded-lg transition-colors"
            >
              Save Prompt
            </button>
          </div>
        </div>
      </div>

      {/* Memory — Dreamer ignore toggle */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Memory</h3>
        <div className="glass-nested rounded-xl p-4">
          <DreamerIgnoreToggle
            agentId={agent.id}
            initial={agent.dreamerIgnore === true}
            onSaved={onUpdated}
          />
        </div>
      </div>

      {/* Permissions + Tools — unified toggle UI */}
      <div>
        <h3 className="text-sm font-semibold text-ui/55 uppercase tracking-wide mb-2">Permissions</h3>
        {isPrimary ? (
          <div className="glass-nested rounded-xl p-4">
            <p className="text-sm text-cp-teal">This Sensei agent has full access to all files, commands, tools, and system controls.</p>
          </div>
        ) : (
          <div className="glass-nested rounded-xl p-4">
            <PermissionsEditor
              permissions={agent.permissions as Partial<PermissionManifest>}
              toolsPolicy={(agent.toolsPolicy as { allow: string[]; deny: string[] }) ?? undefined}
              shareUserProfile={(agent.config as Record<string, unknown>)?.shareUserProfile === true}
              onChange={handlePermsChange}
            />
            <div className="flex justify-end mt-4 pt-3 border-t border-ui/[0.10]">
              <button
                onClick={savePermissions}
                className="px-4 py-2 text-sm glass-btn-primary rounded-lg transition-colors font-medium"
              >
                Save Permissions
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── History Tab ──

const HistoryTab = ({ agentId }: { agentId: string }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const result = await api.getAgentHistory(agentId, 200);
      if (result.ok) {
        setMessages(result.data);
      }
      setLoading(false);
    };
    load();
  }, [agentId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ui/40">Loading history...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {messages.length === 0 ? (
        <p className="text-ui/40 text-center py-8">No message history.</p>
      ) : (
        <div className="space-y-2">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3 text-sm">
              <span className={`shrink-0 w-16 text-right font-mono text-xs py-1 ${
                msg.role === 'user' ? 'text-cp-blue' :
                msg.role === 'assistant' ? 'text-cp-teal' :
                msg.role === 'tool' ? 'text-cp-amber' :
                'text-ui/40'
              }`}>
                {msg.role}
              </span>
              <div className="flex-1 min-w-0">
                <pre className="text-ui/70 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                  {(() => {
                    const { text } = parseMessageContent(msg.content);
                    return text || '[structured content]';
                  })()}
                </pre>
                <div className="text-xs text-ui/25 mt-0.5">
                  {formatDate(msg.createdAt)}
                  {msg.tokenCount ? ` | ${msg.tokenCount} tokens` : ''}
                  {msg.cost ? ` | $${msg.cost.toFixed(4)}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Inter-Agent Tab ──

const messageTypeBadgeColors: Record<string, { bg: string; text: string }> = {
  task: { bg: 'bg-cp-blue/20', text: 'text-cp-blue' },
  result: { bg: 'bg-cp-teal/20', text: 'text-cp-teal' },
  poke: { bg: 'bg-cp-amber/20', text: 'text-cp-amber' },
  status: { bg: 'bg-ui/[0.08]', text: 'text-ui/55' },
  chat: { bg: 'bg-cp-purple/20', text: 'text-cp-purple' },
};

const InterAgentTab = ({ agentId }: { agentId: string }) => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    const load = async () => {
      const result = await api.getAgentInterMessages(agentId, undefined, 100);
      if (result.ok) {
        setMessages(result.data);
      }
      setLoading(false);
    };
    load();
  }, [agentId]);

  useEffect(() => {
    const unsub = subscribe('agent:message', (event: WsEvent) => {
      const e = event as { type: 'agent:message'; data: AgentMessage };
      if (e.data.fromAgent === agentId || e.data.toAgent === agentId) {
        setMessages((prev) => [e.data, ...prev]);
      }
    });
    return unsub;
  }, [subscribe, agentId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ui/40">Loading messages...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {messages.length === 0 ? (
        <p className="text-ui/40 text-center py-8">No inter-agent messages.</p>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => {
            const isSent = msg.fromAgent === agentId;
            const badge = messageTypeBadgeColors[msg.messageType] || messageTypeBadgeColors.chat;

            return (
              <div key={msg.id} className="glass-nested rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${isSent ? 'bg-cp-blue/20 text-cp-blue' : 'bg-cp-teal/20 text-cp-teal'}`}>
                    {isSent ? 'Sent' : 'Received'}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${badge.bg} ${badge.text} capitalize`}>
                    {msg.messageType}
                  </span>
                  <span className="text-xs text-ui/40 ml-auto">
                    {formatDate(msg.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs text-ui/40 mb-2">
                  <span>{msg.fromAgent}</span>
                  <span className="text-ui/25">-&gt;</span>
                  <span>{msg.toAgent}</span>
                </div>
                <pre className="text-sm text-ui/70 whitespace-pre-wrap break-words font-sans">
                  {msg.content}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Terminate Confirmation Dialog ──

const TerminateDialog = ({
  agentName,
  classification,
  onConfirm,
  onCancel,
}: {
  agentName: string;
  classification: string;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  return (
    <div className="glass-modal-backdrop">
      <div className="glass-modal p-6 max-w-sm w-full mx-4">
        <h3 className="text-lg font-semibold text-ui mb-2">Dismiss Agent</h3>
        <p className="text-sm text-ui/55 mb-6">
          {classification === 'ronin'
            ? <>This is a <strong className="text-cp-blue">Ronin</strong> agent. Are you sure you want to dismiss <strong className="text-ui">{agentName}</strong> from the dojo?</>
            : <>Are you sure you want to dismiss <strong className="text-ui">{agentName}</strong> from the dojo? This action cannot be undone.</>
          }
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-ui/55 hover:text-ui/90 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-cp-coral hover:bg-cp-coral/80 text-[var(--btn-primary-text)] rounded-lg transition-colors"
          >
            Dismiss from the dojo
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main Component ──

export const AgentDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [showTerminate, setShowTerminate] = useState(false);
  const { subscribe } = useWebSocket();

  const loadAgent = useCallback(async () => {
    if (!id) return;
    const result = await api.getAgent(id);
    if (result.ok) {
      setAgent(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  // Subscribe to status updates for this agent
  useEffect(() => {
    if (!id) return;
    const unsub = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { type: 'agent:status'; agentId: string; status: string };
      if (e.agentId === id) {
        setAgent((prev) => prev ? { ...prev, status: e.status as AgentDetailType['status'] } : prev);
      }
    });
    return unsub;
  }, [subscribe, id]);

  const handleTerminate = async () => {
    if (!id) return;
    const result = await api.terminateAgent(id);
    if (result.ok) {
      setShowTerminate(false);
      loadAgent();
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ui/40">Loading agent...</p>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-cp-coral">{error || 'Agent not found'}</p>
      </div>
    );
  }

  const cls = getClassification(agent);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'config', label: 'Config' },
    { key: 'history', label: 'History' },
    { key: 'inter-agent', label: 'Inter-Agent' },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 border-b border-ui/[0.06] px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-ui/40 mb-2">
          <Link to="/agents" className="hover:text-ui/70 transition-colors">Agents</Link>
          <span>/</span>
          <span className="text-ui/70">{agent.name}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-ui">{agent.name}</h1>
            <StatusBadge status={agent.status} />
            <span className={`text-xs px-1.5 py-0.5 rounded ${cls.bg} ${cls.text}`}>
              {cls.label}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-sm text-ui/55 flex items-center gap-4">
              <span>Model: <span className="text-ui/90">{agent.modelId === 'auto' ? 'Auto (Smart Router)' : (agent.model?.name || 'None')}</span></span>
              <span>Uptime: <span className="text-ui/90">{formatUptime(agent.uptime)}</span></span>
              {agent.parentAgent && (
                <span>
                  Parent:{' '}
                  <Link to={`/agents/${agent.parentAgent}`} className="text-cp-blue hover:text-cp-blue/80">
                    {agent.parentAgent}
                  </Link>
                </span>
              )}
              {agent.spawnDepth > 0 && (
                <span>Depth: <span className="text-ui/90">{agent.spawnDepth}</span></span>
              )}
              {agent.timeoutAt && (
                <span className="text-cp-amber-light">
                  Timeout: {formatTimeRemaining(agent.timeoutAt)}
                </span>
              )}
            </div>

            {agent.status !== 'terminated' && agent.classification !== 'sensei' && (
              <button
                onClick={() => setShowTerminate(true)}
                className="px-3 py-1.5 text-sm bg-cp-coral/20 text-cp-coral hover:bg-cp-coral/30 rounded-lg transition-colors"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                activeTab === tab.key
                  ? 'bg-ui/[0.05] text-ui'
                  : 'text-ui/40 hover:text-ui/70 hover:text-ui/25'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'chat' && <ChatTab agentId={agent.id} />}
      {activeTab === 'config' && <ConfigTab agent={agent} onUpdated={loadAgent} />}
      {activeTab === 'history' && <HistoryTab agentId={agent.id} />}
      {activeTab === 'inter-agent' && <InterAgentTab agentId={agent.id} />}

      {/* Terminate Dialog */}
      {showTerminate && (
        <TerminateDialog
          agentName={agent.name}
          classification={agent.classification}
          onConfirm={handleTerminate}
          onCancel={() => setShowTerminate(false)}
        />
      )}
    </div>
  );
};
