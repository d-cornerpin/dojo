import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message } from '@dojo/shared';
import type { ChatChunkEvent, ChatMessageEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';
import { formatDate } from '../lib/dates';
import { useWebSocket } from '../hooks/useWebSocket';
import { ToolCallBlock, ToolCallCard, ToolResultBlock } from '../components/ToolCallBlock';
import { Markdown } from '../components/Markdown';
import { ChatInput } from '../components/ChatInput';
import { useToast } from '../hooks/useToast';
import { AttachmentChips } from '../components/AttachmentChips';
import { ThinkingBubble } from '../components/ThinkingBubble';

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
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string }>;
}

// Primary agent ID — loaded from settings
let _primaryAgentId: string | null = null;
function usePrimaryAgentId(): string {
  const [id, setId] = useState(_primaryAgentId ?? 'primary');
  useEffect(() => {
    if (_primaryAgentId) return;
    api.getSetting('primary_agent_id').then(r => {
      if (r.ok && r.data.value) {
        _primaryAgentId = r.data.value;
        setId(r.data.value);
      }
    });
  }, []);
  return id;
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

// ── Message Bubble Renderers ──

// Strip the engine-injected iMessage source framing so the dashboard shows
// the user's actual message, not the routing wrapper. v2.3.16: previously
// rendered verbatim and looked like noise. Treat iMessage as a channel —
// the badge tells you where it came from, the bubble shows what was sent.
const IMESSAGE_SOURCE_RE = /^\[SOURCE: IMESSAGE FROM [^\]]+\]\s*/;

const UserBubble = ({ msg }: { msg: ChatMessage }) => {
  const fromIMessage = IMESSAGE_SOURCE_RE.test(msg.content);
  const stripped = fromIMessage ? msg.content.replace(IMESSAGE_SOURCE_RE, '') : msg.content;
  // Strip === File: === blocks from display text (they're shown as chips instead)
  const displayContent = msg.attachments?.length
    ? stripped.replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '').trim()
    : stripped;

  return (
    <div className="flex flex-col items-end">
      {fromIMessage && (
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono mb-1 mr-1">
          <span className="text-ui/40">{'\u{1F4AC}'}</span>
          <span>via iMessage</span>
        </div>
      )}
      <div className="bubble-user max-w-[92%] sm:max-w-[75%] px-3 py-2 sm:px-4 sm:py-3 text-ui">
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-xs sm:text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
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

const AssistantBubble = ({ msg, wordyMode = true, modelNames = {} }: { msg: ChatMessage; wordyMode?: boolean; modelNames?: Record<string, string> }) => {
  const { text: rawText, blocks } = parseMessageContent(msg.content);
  const text = rawText?.trim() || '';
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
        {text && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3 whitespace-pre-wrap text-xs sm:text-sm">
            {wordyMode && msg.modelId && (
              <div className="text-[9px] sm:text-[10px] text-ui/25 mb-1">{modelNames[msg.modelId] ?? msg.modelId}</div>
            )}
            <Markdown content={text} />
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

        {/* Live streaming tool calls (from WS events, not yet persisted) */}
        {wordyMode && msg.toolCalls && msg.toolCalls.length > 0 && !hasToolUse && (
          <div className="mt-1">
            {msg.toolCalls.map((tc, i) => (
              <ToolCallBlock
                key={`${msg.id}-tool-${i}`}
                toolName={tc.name}
                args={tc.args}
                result={tc.result}
                isError={tc.isError}
              />
            ))}
          </div>
        )}

        {/* Image / PDF attachments (e.g. Imaginer-generated images) */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="mt-2">
            <AttachmentChips attachments={msg.attachments} />
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

// Compact pill shown in non-wordy mode when an assistant turn was tool-calls only
// (no text reply). Replaces what used to be a `return null` skip — that hid the
// fact that the agent did anything at all, which read as silence.
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

export const Chat = () => {
  const AGENT_ID = usePrimaryAgentId();
  const agentIdRef = useRef(AGENT_ID);
  agentIdRef.current = AGENT_ID; // always up to date for closures

  const [agentName, setAgentName] = useState('');
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
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

  useEffect(() => {
    api.getSetting('primary_agent_name').then(r => {
      if (r.ok && r.data.value) setAgentName(r.data.value);
    });
  }, []);
  const { subscribe } = useWebSocket();
  const currentToolCallsRef = useRef<ToolCallData[]>([]);

  // Auto-scroll — only when the last message changes (new message appended),
  // not when older messages are prepended at the top
  const lastMessageIdRef = useRef<string | null>(null);
  const scrollToBottom = useCallback((instant?: boolean) => {
    if (instant) {
      // Instant scroll — used on initial load where smooth animation
      // is distracting and scrollIntoView sometimes undershoots.
      const container = messagesContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastId && lastId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = lastId;
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Load chat history
  useEffect(() => {
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

      const result = await api.getChatHistory(AGENT_ID, 200);
      if (result.ok) {
        setMessages(
          result.data.map((m: Message) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            modelId: m.modelId,
            attachments: m.attachments,
          })),
        );
        setHasMore(result.data.length >= 50);
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
  }, [AGENT_ID]);

  // Load older messages when scrolling to top
  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;

    setLoadingMore(true);
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    const result = await api.getChatHistory(AGENT_ID, 50, oldestId);
    if (result.ok && result.data.length > 0) {
      const older = result.data.map((m: Message) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        attachments: m.attachments,
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
  }, [loadingMore, hasMore, messages, AGENT_ID]);

  // Detect scroll to top
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

    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentIdRef.current) return;

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
            updated.toolCalls = currentToolCallsRef.current.length > 0
              ? [...currentToolCallsRef.current]
              : undefined;
            currentToolCallsRef.current = [];
            requestAnimationFrame(() => scrollToBottom());
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
      currentToolCallsRef.current.push({
        name: e.tool,
        args: e.args,
      });
    });

    const unsubToolResult = subscribe('chat:tool_result', (event: WsEvent) => {
      const e = event as ChatToolResultEvent;
      if (e.agentId !== agentIdRef.current) return;
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

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.message.id);
        if (idx >= 0) {
          // No-reply path: server broadcasts an empty assistant message to
          // indicate "drop this bubble". Without this the bubble lingers as
          // either thinking dots or an empty row.
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
            // Clear the streaming-collected toolCalls — the JSON content is
            // now the source of truth. If the canonical has tool_use blocks
            // AssistantBubble renders them via the hasToolUse path; if not,
            // the live toolCalls were just a streaming artifact.
            toolCalls: undefined,
            isStreaming: false,
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
          const tempIdx = prev.findIndex(
            (m) => m.role === 'user' && m.id.startsWith('temp-') && m.content === e.message.content,
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
          },
        ];
      });
    });

    // Track the agent's working state from agent:status events. This
    // covers external triggers (iMessage, scheduled runs, agent-to-agent
    // messaging) where the user never called handleSend locally — the
    // thinking dots and the send→stop button swap need to react live
    // without requiring a page reload to pick up the backend state.
    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string };
      if (e.agentId !== agentIdRef.current) return;
      if (e.status === 'working') {
        setIsWorking(true);
      } else if (e.status === 'idle' || e.status === 'error') {
        setIsWorking(false);
        reconcileStreamingBubbles();
      }
    });

    const unsubTerminated = subscribe('agent:terminated', (event: WsEvent) => {
      const e = event as { agentId: string; reason: string };
      if (e.agentId !== agentIdRef.current) return;
      toast.error(`Agent terminated: ${e.reason}`);
      setIsWorking(false);
      reconcileStreamingBubbles();
    });

    return () => {
      unsubChunk();
      unsubReasoning();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubMessage();
      unsubStatus();
      unsubTerminated();
    };
  }, [subscribe, AGENT_ID]);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setIsWorking(true);

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, userMsg]);

    const result = await api.sendMessage(AGENT_ID, content, attachments);
    if (!result.ok) {
      setIsWorking(false);
      if (result.error.includes('busy')) {
        toast.info(`${agentName || 'Agent'} is mid-mission — your message will be delivered when they finish.`);
      } else {
        toast.error(result.error);
      }
    }
  };

  if (loading) return <div className="flex-1 loading-state">Loading...</div>;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-2 sm:px-4 md:px-6 py-3 sm:py-6 space-y-2 sm:space-y-4">
        {loadingMore && (
          <div className="text-center py-2">
            <span className="text-xs text-ui/25">Loading older messages...</span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center animate-fade-up">
              <div className="text-4xl mb-4">{'\u{1F4AC}'}</div>
              <h2 className="text-xl font-semibold text-ui/70 mb-2">Chat with {agentName || 'your agent'}</h2>
              <p className="text-sm text-secondary">Send a message to get started.</p>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          // Hide inter-agent messages and system nudges unless wordy mode is on
          if (!wordyMode && msg.role === 'user' && (
            msg.content.includes('[SOURCE: AGENT MESSAGE FROM') ||
            msg.content.includes('[SOURCE: PM AGENT POKE FROM') ||
            msg.content.includes('[SOURCE: TRACKER TASK') ||
            msg.content.includes('[SOURCE: SCHEDULER') ||
            msg.content.includes('[SOURCE: HEALER') ||
            msg.content.includes('[SOURCE: SUB-AGENT COMPLETION') ||
            msg.content.includes('[SOURCE: SYSTEM') ||
            msg.content.startsWith('[System:') ||
            msg.content.startsWith('[CONTINUITY BRIEF') ||
            msg.content.startsWith('Tracker review --')
          )) return null;
          // Hide system-generated fallback messages from the agent
          if (!wordyMode && msg.role === 'assistant' && (
            msg.content.startsWith('I got stuck on that') ||
            msg.content.startsWith("I'm sorry — I'm having trouble") ||
            msg.content.startsWith('Understood, I have reviewed the continuity brief') ||
            msg.content.startsWith('Understood, I have reviewed my background context')
          )) return null;
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
          if (msg.role === 'tool') {
            if (!wordyMode) return null; // Hide tool results in non-wordy mode
            return <ToolResultBubble key={msg.id} msg={msg} />;
          }
          if (msg.role === 'system') {
            // Always show divider-style markers: any system message shaped
            // "── label ──" renders as a horizontal divider with the label
            // centered. Used for New Session, Memory Compacted, and any
            // future inline timeline markers.
            const dividerMatch = msg.content.trim().match(/^──\s*(.+?)\s*──$/);
            if (dividerMatch) {
              return (
                <div key={msg.id} className="flex items-center gap-3 my-4 px-4">
                  <div className="flex-1 h-px bg-ui/[0.12]" />
                  <span className="text-xs text-ui/25 shrink-0">{dividerMatch[1]}</span>
                  <div className="flex-1 h-px bg-ui/[0.12]" />
                </div>
              );
            }
            // Always-show iMessage delivery marker: when the assistant's
            // reply went out via iMessage, show a thin right-aligned tag so
            // the user sees the channel without flipping wordy mode on.
            // v2.3.16 — was hidden in regular mode and left users guessing
            // whether the iMessage actually got sent.
            const imSentMatch = msg.content.trim().match(/^\[SENT VIA IMESSAGE to (.+?)\]$/);
            if (imSentMatch) {
              return (
                <div key={msg.id} className="flex justify-end my-1 px-1">
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-ui/[0.05] text-tertiary text-[10px] font-mono">
                    <span className="text-ui/40">{'\u{1F4AC}'}</span>
                    <span>sent via iMessage</span>
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
            if (!text && hasToolUse) return <ToolOnlyPill key={msg.id} msg={msg} />;
          }
          return <AssistantBubble key={msg.id} msg={msg} wordyMode={wordyMode} modelNames={modelNames} />;
        })}
        {isWorking && !messages.some(m => m.isStreaming) && <ThinkingBubble />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {/* Input */}
      <ChatInput
        agentId={AGENT_ID}
        onSend={handleSend}
        variant="primary"
        wordyMode={wordyMode}
        onToggleWordyMode={() => {
          const next = !wordyMode;
          setWordyMode(next);
          localStorage.setItem('dojo_wordy_mode', String(next));
          // Toggling shows/hides many messages (tool calls, system messages),
          // which changes content height drastically. Scroll to bottom after
          // React re-renders with the new message visibility.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToBottom(true);
            });
          });
        }}
        onNewSession={async () => {
          if (!confirm('Start a new session? The current conversation will be archived to the vault. Your agent won\'t lose any knowledge.')) return;
          const res = await api.request<{ archiveId: string; sessionStartedAt: string }>(`/chat/${AGENT_ID}/new-session`, { method: 'POST' });
          if (res.ok) {
            const result = await api.getChatHistory(AGENT_ID, 200);
            if (result.ok) {
              setMessages(result.data.map((m: Message) => ({ ...m, isStreaming: false })));
            }
          }
        }}
        isWorking={isWorking}
        onStop={async () => {
          await api.stopAgent(AGENT_ID);
          setIsWorking(false);
        }}
      />
    </div>
  );
};
