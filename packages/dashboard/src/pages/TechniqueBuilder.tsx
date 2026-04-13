import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Message } from '@dojo/shared';
import type { ChatChunkEvent, ChatMessageEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import type { AttachmentInfo } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { ToolCallBlock, ToolCallCard, ToolResultBlock } from '../components/ToolCallBlock';
import { Markdown } from '../components/Markdown';
import { ChatInput } from '../components/ChatInput';
import { ThinkingBubble } from '../components/ThinkingBubble';
import { AttachmentChips } from '../components/AttachmentChips';

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
}

interface CanvasState {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  instructions: string;
  files: Array<{ path: string; content?: string }>;
}

// ── Builder context injected as the first user message ──

const BUILDER_CONTEXT = `I want to build a new technique for the dojo. Help me create it step by step.

When we have enough detail, use the save_technique tool to create it. I can see the technique canvas updating in real-time on my screen, so as you refine the technique, call save_technique to update the canvas.

Guide me through:
1. What should the technique be called? (a short slug name and a display name)
2. What does the technique do? (description)
3. What are the step-by-step instructions? (this becomes TECHNIQUE.md)
4. Any supporting files needed?
5. What tags should it have?

Let's start — what kind of technique would you like to create?`;

function getEditContext(name: string, description: string, instructions: string): string {
  return `I want to edit an existing technique in the dojo called "${name}".

Current description: ${description || '(none)'}

Current TECHNIQUE.md instructions:
\`\`\`
${instructions || '(empty)'}
\`\`\`

I can see the technique mat on my screen with the current content. Help me improve or modify this technique. When we're done, use update_technique to save the changes. What would you like to change?`;
}

// ── Trainer agent ID — loaded from settings ──

let _trainerAgentId: string | null = null;
function useTrainerAgentId(): string {
  const [id, setId] = useState(_trainerAgentId ?? 'trainer');
  useEffect(() => {
    if (_trainerAgentId) return;
    api.getSetting('trainer_agent_id').then(r => {
      if (r.ok && r.data.value) {
        _trainerAgentId = r.data.value;
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
  const displayContent = msg.attachments?.length
    ? msg.content.replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '').trim()
    : msg.content;

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] px-4 py-3 text-white"
        style={{ background: 'rgba(124, 58, 237, 0.25)', border: '1px solid rgba(124, 58, 237, 0.4)', borderRadius: '16px 16px 4px 16px', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)' }}>
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-[10px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

const AssistantBubble = ({ msg }: { msg: ChatMessage }) => {
  const { text, blocks } = parseMessageContent(msg.content);
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {text && (
          <div className="px-4 py-3 whitespace-pre-wrap" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '16px 16px 16px 4px', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', color: 'rgba(255,255,255,0.92)', boxShadow: '0 4px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)' }}>
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

        {!text && msg.isStreaming && (
          <div className="px-4 py-3" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '16px 16px 16px 4px', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)' }}>
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </div>
        )}

        {hasToolUse && (
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

        {msg.toolCalls && msg.toolCalls.length > 0 && !hasToolUse && (
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
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <ToolResultBlock toolUseId="" content={msg.content} isError={false} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
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

// ── Canvas Panel ──

const CanvasPanel = ({
  canvas,
  onChange,
  onPublish,
  onSaveDraft,
  saving,
}: {
  canvas: CanvasState;
  onChange: (updates: Partial<CanvasState>) => void;
  onPublish: () => void;
  onSaveDraft: () => void;
  saving: boolean;
}) => {
  const [tagInput, setTagInput] = useState('');

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !canvas.tags.includes(tag)) {
      onChange({ tags: [...canvas.tags, tag] });
    }
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    onChange({ tags: canvas.tags.filter(t => t !== tag) });
  };

  const canPublish = canvas.displayName.trim() && canvas.description.trim() && canvas.instructions.trim();

  const handleFileUpload = (files: File[]) => {
    const readers = files.map(file => {
      return new Promise<{ path: string; content: string }>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve({ path: file.name, content: reader.result as string });
        };
        reader.onerror = () => {
          resolve({ path: file.name, content: `(failed to read ${file.name})` });
        };
        reader.readAsText(file);
      });
    });

    Promise.all(readers).then(newFiles => {
      // Deduplicate by path — new files overwrite existing
      const existingPaths = new Set(newFiles.map(f => f.path));
      const kept = canvas.files.filter(f => !existingPaths.has(f.path));
      onChange({ files: [...kept, ...newFiles] });
    });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white/80">Technique Mat</h2>
          <span className="glass-badge glass-badge-amber text-[10px]">Draft — not yet published</span>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-xs text-white/40 block mb-1">Technique Name</label>
          <input
            value={canvas.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            placeholder="e.g. Git Branch Cleanup"
            className="glass-input w-full px-3 py-2 text-sm"
          />
        </div>

        {/* Slug */}
        <div>
          <label className="text-xs text-white/40 block mb-1">Slug (directory name)</label>
          <input
            value={canvas.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. git-branch-cleanup"
            className="glass-input w-full px-3 py-2 text-xs font-mono"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-white/40 block mb-1">Description</label>
          <textarea
            value={canvas.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="What does this technique do?"
            className="glass-input w-full px-3 py-2 text-sm resize-none"
            rows={3}
          />
        </div>

        {/* Tags */}
        <div>
          <label className="text-xs text-white/40 block mb-1">Tags</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {canvas.tags.map(tag => (
              <span key={tag} className="glass-badge glass-badge-blue text-xs flex items-center gap-1">
                {tag}
                <button onClick={() => removeTag(tag)} className="text-white/40 hover:text-white ml-0.5">&times;</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
              placeholder="Add tag..."
              className="glass-input px-3 py-1.5 text-xs flex-1"
            />
            <button onClick={addTag} className="glass-btn glass-btn-secondary text-xs">Add</button>
          </div>
        </div>

        {/* TECHNIQUE.md */}
        <div>
          <label className="text-xs text-white/40 block mb-1">TECHNIQUE.md (Instructions)</label>
          <textarea
            value={canvas.instructions}
            onChange={(e) => onChange({ instructions: e.target.value })}
            placeholder="# Technique Name&#10;&#10;## Purpose&#10;&#10;## Steps&#10;&#10;1. ..."
            className="glass-input w-full px-4 py-3 text-sm font-mono resize-y"
            rows={14}
            style={{ minHeight: '280px' }}
          />
        </div>

        {/* Files */}
        <div>
          <label className="text-xs text-white/40 block mb-1">Supporting Files ({canvas.files.length})</label>
          <div className="glass-card p-3 space-y-1.5">
            {canvas.files.map((f, i) => (
              <div key={i} className="text-xs text-white/60 flex items-center justify-between group">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-white/30 shrink-0">{'\u{1F4C4}'}</span>
                  <span className="font-mono truncate">{f.path}</span>
                </div>
                <button
                  onClick={() => onChange({ files: canvas.files.filter((_, idx) => idx !== i) })}
                  className="text-white/20 hover:text-cp-coral transition-colors shrink-0 ml-2 text-sm opacity-0 group-hover:opacity-100"
                  title="Remove file"
                >
                  &times;
                </button>
              </div>
            ))}

            {/* Drop zone / upload area */}
            <label
              className="block mt-2 border border-dashed border-white/[0.1] hover:border-white/[0.2] rounded-lg p-3 text-center cursor-pointer transition-colors"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-cp-amber/40', 'bg-cp-amber/5'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('border-cp-amber/40', 'bg-cp-amber/5'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-cp-amber/40', 'bg-cp-amber/5');
                const droppedFiles = Array.from(e.dataTransfer.files);
                handleFileUpload(droppedFiles);
              }}
            >
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleFileUpload(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <span className="text-xs text-white/30">Drop files here or click to upload</span>
            </label>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 p-4 border-t border-white/[0.06] flex gap-2">
        <button
          onClick={onSaveDraft}
          disabled={saving || !canvas.displayName.trim()}
          className="glass-btn glass-btn-secondary text-sm flex-1"
        >
          {saving ? 'Saving...' : 'Save Draft'}
        </button>
        <button
          onClick={onPublish}
          disabled={saving || !canPublish}
          className="glass-btn glass-btn-primary text-sm flex-1"
        >
          {saving ? 'Publishing...' : 'Publish'}
        </button>
      </div>
    </div>
  );
};

// ── Main TechniqueBuilder Component ──

export const TechniqueBuilder = () => {
  const { id: editId } = useParams<{ id?: string }>();
  const isEditMode = Boolean(editId);

  const AGENT_ID = useTrainerAgentId();
  const agentIdRef = useRef(AGENT_ID);
  agentIdRef.current = AGENT_ID;
  const [agentName, setAgentName] = useState('');
  const [sessionCleared, setSessionCleared] = useState(false);

  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createdTechniqueId, setCreatedTechniqueId] = useState<string | null>(editId ?? null);
  const [contextSent, setContextSent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const [canvas, setCanvas] = useState<CanvasState>({
    name: '',
    displayName: '',
    description: '',
    tags: [],
    instructions: '',
    files: [],
  });

  // Load existing technique in edit mode
  useEffect(() => {
    if (!editId) return;
    const loadTechnique = async () => {
      const token = localStorage.getItem('dojo_token');
      const res = await fetch(`/api/techniques/${editId}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const data = await res.json();
      if (data.ok) {
        setCanvas({
          name: data.data.id,
          displayName: data.data.name,
          description: data.data.description ?? '',
          tags: data.data.tags ?? [],
          instructions: data.data.instructions ?? '',
          files: (data.data.files ?? []).filter((f: { isDirectory: boolean }) => !f.isDirectory).map((f: { path: string }) => ({ path: f.path })),
        });
      }
    };
    loadTechnique();
  }, [editId]);

  const { subscribe } = useWebSocket();
  const currentToolCallsRef = useRef<ToolCallData[]>([]);

  // Auto-scroll
  const lastMessageIdRef = useRef<string | null>(null);
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastId && lastId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = lastId;
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  // Fetch trainer agent name and load existing conversation on mount
  useEffect(() => {
    api.getSetting('trainer_agent_name').then(r => {
      if (r.ok && r.data.value) setAgentName(r.data.value);
    });

    // Try to load existing conversation history instead of clearing the session.
    // Only resume if the conversation is about the SAME technique we're editing.
    // Otherwise clear and start fresh.
    const loadExisting = async () => {
      if (!AGENT_ID) { setSessionCleared(true); return; }
      const result = await api.getAgentHistory(AGENT_ID, 200);

      // Check if the existing conversation is about this specific technique
      let conversationMatchesTechnique = false;
      if (result.ok && result.data.length > 1) {
        // Look for the technique name in the first user message (the context message)
        const firstUserMsg = result.data.find((m: Message) => m.role === 'user');
        if (firstUserMsg) {
          if (isEditMode && canvas.displayName) {
            // Edit mode: check if the conversation mentions this technique
            conversationMatchesTechnique = firstUserMsg.content.includes(canvas.displayName) ||
              (!!canvas.name && firstUserMsg.content.includes(canvas.name));
          } else if (!isEditMode) {
            // New technique mode: check if it's a "build a new technique" conversation
            conversationMatchesTechnique = firstUserMsg.content.includes('build a new technique');
          }
        }
      }

      if (conversationMatchesTechnique && result.ok && result.data.length > 1) {
        // Existing conversation about this technique — resume it
        setMessages(
          result.data.map((m: Message) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            attachments: m.attachments,
          })),
        );
        setContextSent(true);
        setSessionCleared(true);
        setTimeout(() => scrollToBottom(), 200);
      } else {
        // Different technique or no conversation — clear session and start fresh
        const token = localStorage.getItem('dojo_token');
        const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
        const csrf = csrfMatch ? csrfMatch[1] : null;
        fetch('/api/techniques/clear-session', {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          },
        }).then(() => setSessionCleared(true)).catch(() => setSessionCleared(true));
      }
    };
    loadExisting();
  }, [AGENT_ID, canvas.displayName, canvas.name]);

  // Send builder context on mount — only if no existing conversation was loaded
  useEffect(() => {
    if (contextSent || !AGENT_ID || !sessionCleared) return;
    // In edit mode, wait until canvas is populated before sending context
    if (isEditMode && !canvas.displayName) return;
    setContextSent(true);

    const contextMessage = isEditMode
      ? getEditContext(canvas.displayName, canvas.description, canvas.instructions)
      : BUILDER_CONTEXT;

    const sendContext = async () => {
      setLoading(true);
      const userMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        role: 'user',
        content: contextMessage,
        createdAt: new Date().toISOString(),
      };
      setMessages([userMsg]);
      setIsWorking(true);

      const result = await api.sendMessage(AGENT_ID, contextMessage);
      if (!result.ok) {
        setError(result.error);
        setIsWorking(false);
      }
      setLoading(false);
    };
    sendContext();
  }, [AGENT_ID, contextSent, sessionCleared, canvas.displayName]);

  // Watch for save_technique tool calls to update canvas and track created ID
  const handleToolCallForCanvas = useCallback((toolName: string, args: Record<string, unknown>) => {
    if (toolName === 'save_technique') {
      const techName = (args.name as string) || '';
      const slug = techName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (slug) {
        setCreatedTechniqueId(slug);
      }
      setCanvas(prev => ({
        ...prev,
        name: techName || prev.name,
        displayName: (args.display_name as string) || (args.displayName as string) || prev.displayName,
        description: (args.description as string) || prev.description,
        instructions: (args.instructions as string) || prev.instructions,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : prev.tags,
        files: Array.isArray(args.files)
          ? (args.files as Array<{ path: string; content?: string }>)
          : prev.files,
      }));
    }
  }, []);

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentIdRef.current) return;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming && last.id === e.messageId) {
          const updated = { ...last, content: last.content + e.content };
          if (e.done) {
            updated.isStreaming = false;
            updated.toolCalls = currentToolCallsRef.current.length > 0
              ? [...currentToolCallsRef.current]
              : undefined;
            currentToolCallsRef.current = [];
            setIsWorking(false);
          }
          return [...prev.slice(0, -1), updated];
        } else {
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

    const unsubToolCall = subscribe('chat:tool_call', (event: WsEvent) => {
      const e = event as ChatToolCallEvent;
      if (e.agentId !== agentIdRef.current) return;
      currentToolCallsRef.current.push({
        name: e.tool,
        args: e.args,
      });
      // Update canvas when save_technique is called
      handleToolCallForCanvas(e.tool, e.args);
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
      setError(e.error);
      setIsWorking(false);
    });

    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentIdRef.current) return;

      setMessages((prev) => {
        if (prev.some((m) => m.id === e.message.id)) return prev;
        const last = prev[prev.length - 1];
        if (last?.isStreaming && last.id === e.message.id) return prev;

        return [
          ...prev,
          {
            id: e.message.id,
            role: e.message.role,
            content: e.message.content,
            createdAt: e.message.createdAt,
          },
        ];
      });
    });

    return () => {
      unsubChunk();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubMessage();
    };
  }, [subscribe, AGENT_ID, handleToolCallForCanvas]);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setError(null);

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsWorking(true);

    const result = await api.sendMessage(AGENT_ID, content, attachments);
    if (!result.ok) {
      if (result.error.includes('busy')) {
        setError('Agent is mid-mission — your message will be delivered when they finish.');
      } else {
        setError(result.error);
      }
      setIsWorking(false);
    }
  };

  const handleCanvasChange = (updates: Partial<CanvasState>) => {
    setCanvas(prev => ({ ...prev, ...updates }));
  };

  const getToken = (): string | null => localStorage.getItem('dojo_token');
  const getCsrf = (): string | null => { const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/); return m ? m[1] : null; };

  const saveTechnique = async (publish: boolean) => {
    if (!canvas.displayName.trim()) return;
    setSaving(true);

    const slug = canvas.name.trim() || canvas.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    try {
      const token = getToken();
      const csrf = getCsrf();
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      };

      // If the technique already exists (agent created it, or we're in edit mode), update it
      const existingId = createdTechniqueId || (isEditMode ? editId : null);
      if (existingId) {
        // Update instructions (creates a version)
        if (canvas.instructions.trim()) {
          await fetch(`/api/techniques/${existingId}/instructions`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ content: canvas.instructions.trim(), changeSummary: 'Updated from Technique Trainer' }),
          });
        }
        // Update metadata
        await fetch(`/api/techniques/${existingId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            description: canvas.description.trim(),
            tags: canvas.tags,
            ...(publish ? { state: 'published' } : {}),
          }),
        });
        // Publish if requested
        if (publish) {
          await fetch(`/api/techniques/${existingId}/publish`, { method: 'POST', headers });
        }
        navigate(`/techniques/${existingId}`);
      } else {
        // Create new technique
        const res = await fetch('/api/techniques', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: slug,
            displayName: canvas.displayName.trim(),
            description: canvas.description.trim(),
            instructions: canvas.instructions.trim() || '# ' + canvas.displayName.trim(),
            tags: canvas.tags,
            files: canvas.files.length > 0 ? canvas.files : undefined,
            publish,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          navigate(`/techniques/${data.data.id}`);
        } else {
          setError(data.error || 'Failed to save technique');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save technique');
    } finally {
      setSaving(false);
    }
  };

  const [canvasOpen, setCanvasOpen] = useState(false);

  return (
    <div className="flex-1 flex min-h-0 relative">
      {/* Left Panel — Chat (full width on mobile, 60% on desktop) */}
      <div className="flex flex-col min-h-0 w-full md:w-[60%]">
        {/* Chat header */}
        <div className="shrink-0 px-3 sm:px-4 py-2 sm:py-3 border-b border-white/[0.06] flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => navigate(isEditMode ? `/techniques/${editId}` : '/techniques')}
            className="text-xs text-white/40 hover:text-white/70"
          >
            {'\u2190'} Back
          </button>
          <h1 className="text-sm font-semibold text-white/80">Technique Trainer</h1>
          <span className="text-xs text-white/30">{isEditMode ? `Edit technique with ${agentName || 'your agent'}` : `Train ${agentName || 'your agent'} on a new technique`}</span>
        </div>

        {/* Messages */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center animate-fade-up">
                <div className="text-3xl mb-3">{'\u{1F3AF}'}</div>
                <h2 className="text-lg font-semibold text-white/80 mb-1">Technique Trainer</h2>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Initializing builder session...</p>
              </div>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
            if (msg.role === 'tool') return <ToolResultBubble key={msg.id} msg={msg} />;
            return <AssistantBubble key={msg.id} msg={msg} />;
          })}
          {isWorking && !messages.some(m => m.isStreaming) && <ThinkingBubble />}
          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="shrink-0 mx-4 mb-2 glass-toast glass-toast-error px-4 py-3 text-sm flex items-center justify-between" style={{ color: 'var(--cp-coral)' }}>
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:opacity-70 ml-2 shrink-0">&times;</button>
          </div>
        )}

        {/* Input */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <ChatInput agentId={AGENT_ID} onSend={handleSend} variant="agent" />
          </div>
          {/* Mobile toggle for canvas panel */}
          <button
            onClick={() => setCanvasOpen(!canvasOpen)}
            className="md:hidden shrink-0 px-3 py-2 mr-2 mb-1 text-xs bg-white/[0.06] border border-white/[0.08] rounded-lg text-white/60 hover:text-white/90"
          >
            {canvasOpen ? 'Chat' : 'Mat'}
          </button>
        </div>
      </div>

      {/* Divider — desktop only */}
      <div className="hidden md:block shrink-0 w-px" style={{ background: 'rgba(255,255,255,0.08)' }} />

      {/* Right Panel — Canvas (40% on desktop, flyout on mobile) */}
      <div className={`
        min-h-0
        ${canvasOpen
          ? 'fixed inset-0 z-40 md:relative md:inset-auto md:z-auto'
          : 'hidden md:block'
        }
      `} style={{ width: canvasOpen && window.innerWidth < 768 ? '100%' : '40%', background: 'rgba(0,0,0,0.15)' }}>
        {/* Mobile close button */}
        {canvasOpen && (
          <button
            onClick={() => setCanvasOpen(false)}
            className="md:hidden absolute top-3 right-3 z-50 px-3 py-1.5 bg-white/[0.1] rounded-lg text-xs text-white/70 hover:text-white"
          >
            ← Back to chat
          </button>
        )}
        <CanvasPanel
          canvas={canvas}
          onChange={handleCanvasChange}
          onPublish={() => saveTechnique(true)}
          onSaveDraft={() => saveTechnique(false)}
          saving={saving}
        />
      </div>
    </div>
  );
};
