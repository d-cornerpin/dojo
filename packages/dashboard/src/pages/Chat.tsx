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
        .join('');
      return { text: textParts, blocks: parsed };
    }
  } catch {
    // Not JSON — plain text
  }
  return { text: raw };
}

// ── Message Bubble Renderers ──

const UserBubble = ({ msg }: { msg: ChatMessage }) => {
  // Strip === File: === blocks from display text (they're shown as chips instead)
  const displayContent = msg.attachments?.length
    ? msg.content.replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '').trim()
    : msg.content;

  return (
    <div className="flex justify-end">
      <div className="bubble-user max-w-[92%] sm:max-w-[75%] px-3 py-2 sm:px-4 sm:py-3 text-white">
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-xs sm:text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-[9px] sm:text-[10px] mt-1.5 sm:mt-2" style={{ color: 'var(--text-tertiary)' }}>
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

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[75%]">
        {/* Text content */}
        {text && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3 whitespace-pre-wrap text-xs sm:text-sm">
            {wordyMode && msg.modelId && (
              <div className="text-[9px] sm:text-[10px] text-white/25 mb-1">{modelNames[msg.modelId] ?? msg.modelId}</div>
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
          <div className="text-[10px] mt-1 px-1" style={{ color: 'var(--text-tertiary)' }}>
            {formatDate(msg.createdAt)}
          </div>
        )}
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
          .map((b, i) => (
            <ToolResultBlock
              key={`${msg.id}-result-${i}`}
              toolUseId={b.tool_use_id ?? ''}
              content={b.content ?? ''}
              isError={!!b.is_error}
            />
          ))}
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
        // Scroll to bottom on initial load — use instant (not smooth)
        // and a double-frame delay to ensure the DOM is fully painted
        // after the mobile padding/layout settles.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToBottom(true);
          });
        });
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
    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentIdRef.current) return;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming && last.id === e.messageId) {
          // Append chunk to existing streaming message
          const updated = { ...last, content: last.content + e.content };
          if (e.done) {
            updated.isStreaming = false;
            updated.modelId = (e as any).modelId ?? null;
            updated.toolCalls = currentToolCallsRef.current.length > 0
              ? [...currentToolCallsRef.current]
              : undefined;
            currentToolCallsRef.current = [];
            setIsWorking(false);
            // Ensure we're scrolled to the bottom after streaming completes
            requestAnimationFrame(() => scrollToBottom());
          }
          return [...prev.slice(0, -1), updated];
        } else if (prev.some((m) => m.id === e.messageId)) {
          // Already have this message (finalized) -- skip duplicate from reconnect
          return prev;
        } else {
          // New streaming message — but skip if it's empty and already done (ghost bubble)
          if (e.done && (!e.content || e.content.trim().length === 0)) {
            setIsWorking(false);
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
      const isRateLimit = e.code === 'RATE_LIMITED' || e.error.includes('429') || e.error.toLowerCase().includes('rate_limit') || e.error.toLowerCase().includes('overloaded');
      if (isRateLimit) {
        toast.warning(e.error);
      } else {
        toast.error(e.error); // stays until dismissed
        setIsWorking(false);
      }
    });

    // Subscribe to full message events (tool results, system messages, etc.)
    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentIdRef.current) return;

      setMessages((prev) => {
        // Don't add if we already have this message (from streaming or optimistic add)
        if (prev.some((m) => m.id === e.message.id)) return prev;
        // Don't add if there's a streaming message in progress with the same ID
        const last = prev[prev.length - 1];
        if (last?.isStreaming && last.id === e.message.id) return prev;

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
      }
    });

    const unsubTerminated = subscribe('agent:terminated', (event: WsEvent) => {
      const e = event as { agentId: string; reason: string };
      if (e.agentId !== agentIdRef.current) return;
      toast.error(`Agent terminated: ${e.reason}`);
      setIsWorking(false);
    });

    return () => {
      unsubChunk();
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
            <span className="text-xs white/30">Loading older messages...</span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center animate-fade-up">
              <div className="text-4xl mb-4">{'\u{1F4AC}'}</div>
              <h2 className="text-xl font-semibold text-white/80 mb-2">Chat with {agentName || 'your agent'}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Send a message to get started.</p>
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
            msg.content.startsWith('Tracker review --')
          )) return null;
          // Hide system-generated fallback messages from the agent
          if (!wordyMode && msg.role === 'assistant' && (
            msg.content.startsWith('I got stuck on that') ||
            msg.content.startsWith("I'm sorry — I'm having trouble")
          )) return null;
          if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
          if (msg.role === 'tool') {
            if (!wordyMode) return null; // Hide tool results in non-wordy mode
            return <ToolResultBubble key={msg.id} msg={msg} />;
          }
          if (msg.role === 'system') {
            // Always show session dividers
            if (msg.content.includes('New Session')) {
              return (
                <div key={msg.id} className="flex items-center gap-3 my-4 px-4">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-white/30 shrink-0">New Session</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
              );
            }
            if (!wordyMode) return null; // Hide other system messages in non-wordy mode
          }
          // For assistant messages, hide tool-only messages in non-wordy mode
          if (msg.role === 'assistant' && !wordyMode) {
            const { text, blocks } = parseMessageContent(msg.content);
            const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
            // If the message has ONLY tool calls and no text, skip it
            if (!text && hasToolUse) return null;
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
