import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { AgentDetail as AgentDetailType, Message, AgentMessage, Model, PermissionManifest } from '@dojo/shared';
import type { ChatChunkEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, WsEvent } from '@dojo/shared';
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
  ronin: { bg: 'bg-blue-500/20', text: 'text-cp-blue', label: 'Ronin' },
  apprentice: { bg: 'bg-white/[0.08]', text: 'white/55', label: 'Apprentice' },
};

const getClassification = (agent: AgentDetailType) => {
  return classificationStyles[agent.classification] ?? classificationStyles.apprentice;
};

// PermissionsView removed — replaced by PermissionsEditor component

// ── Message Bubbles (same pattern as Chat.tsx) ──

const UserBubble = ({ msg }: { msg: ChatMessage }) => {
  const displayContent = msg.attachments?.length
    ? msg.content.replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '').trim()
    : msg.content;

  return (
    <div className="flex justify-end">
      <div className="bubble-user max-w-[75%] px-4 py-3 text-white">
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-xs mt-2 text-blue-200">
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

const AssistantBubble = ({ msg, wordyMode = true }: { msg: ChatMessage; wordyMode?: boolean }) => {
  const { text, blocks } = parseMessageContent(msg.content);
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] sm:max-w-[75%]">
        {text && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3 whitespace-pre-wrap text-xs sm:text-sm">
            <Markdown content={text} />
            {msg.isStreaming && (
              <span className="inline-flex gap-1 ml-1 align-middle">
                <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        )}
        {!text && msg.isStreaming && (
          <div className="bubble-assistant px-3 py-2 sm:px-4 sm:py-3">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
        {!msg.isStreaming && (
          <div className="text-xs mt-1 white/40 px-1">
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
          })),
        );
        setHasMore(result.data.length >= 50);
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
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
    const unsubChunk = subscribe('chat:chunk', (event: WsEvent) => {
      const e = event as ChatChunkEvent;
      if (e.agentId !== agentId) return;

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
        } else if (prev.some((m) => m.id === e.messageId)) {
          // Already have this message -- skip duplicate from reconnect
          return prev;
        } else {
          // Skip empty done events (ghost bubbles)
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
              isStreaming: !e.done,
            },
          ];
        }
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
      const isRateLimit = (e as { code?: string }).code === 'RATE_LIMITED' || e.error.includes('429') || e.error.toLowerCase().includes('rate_limit');
      if (isRateLimit) {
        toast.warning(e.error);
      } else {
        toast.error(e.error);
        setIsWorking(false);
      }
    });

    const unsubStatus = subscribe('agent:status', (event: WsEvent) => {
      const e = event as { agentId: string; status: string };
      if (e.agentId !== agentId) return;
      if (e.status === 'working') setIsWorking(true);
      else if (e.status === 'idle' || e.status === 'error') setIsWorking(false);
    });

    return () => {
      unsubChunk();
      unsubToolCall();
      unsubToolResult();
      unsubError();
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
        setMessages(result.data.map((m: Message) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, attachments: m.attachments })));
      }
      toast.success('Session reset — conversation archived to vault.');
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="white/40">Loading chat...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-2 sm:px-4 md:px-6 py-3 sm:py-6 space-y-2 sm:space-y-4">
        {loadingMore && (
          <div className="text-center py-2">
            <span className="text-xs white/30">Loading older messages...</span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center">
              <h2 className="text-xl font-semibold white/55 mb-2">Chat with this agent</h2>
              <p className="text-sm white/30">Send a message to get started.</p>
            </div>
          </div>
        )}
        {messages.map((msg) => {
          // Hide inter-agent and system messages unless wordy mode is on
          if (!wordyMode && msg.role === 'user' && (
            msg.content.includes('[SOURCE:') ||
            msg.content.startsWith('[System:') ||
            msg.content.startsWith('Tracker review --')
          )) return null;
          if (msg.role === 'tool' && !wordyMode) return null;
          if (msg.role === 'system' && !wordyMode) {
            if (msg.content.includes('New Session')) {
              return (
                <div key={msg.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-white/30 shrink-0">New Session</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
              );
            }
            return null;
          }
          if (!wordyMode && msg.role === 'assistant') {
            if (msg.content.startsWith('I got stuck on that') || msg.content.startsWith("I'm sorry — I'm having trouble")) return null;
            // Hide tool-only messages
            const parsed = parseMessageContent(msg.content);
            const hasToolUse = parsed.blocks?.some((b) => b.type === 'tool_use');
            if (!parsed.text && hasToolUse) return null;
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
      <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Equipped Techniques</h3>
      <div className="glass-nested rounded-xl p-4">
        <TechniqueSelector selected={equipped} onChange={handleChange} />
      </div>
    </div>
  );
};

// ── Config Tab ──

const SaveToast = ({ message }: { message: string | null }) => {
  if (!message) return null;
  return (
    <div className="fixed bottom-6 right-6 px-4 py-2 bg-green-600 text-white text-sm rounded-lg shadow-lg z-50 animate-pulse">
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
        <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Name</h3>
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
              className="px-3 py-2 text-sm glass-btn-blue rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
          {agent.classification === 'sensei' && (
            <p className="text-xs text-white/30 mt-2">Changing a Sensei's name updates the platform config.</p>
          )}
        </div>
      </div>

      {/* Model */}
      <div>
        <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Model</h3>
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
              className="px-3 py-2 text-sm glass-btn-blue rounded-lg transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Classification */}
      <div>
        <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Classification</h3>
        <div className="glass-nested rounded-xl p-4">
          {agent.classification === 'sensei' ? (
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 rounded text-xs font-bold bg-cp-amber/20 text-cp-amber">Sensei</span>
              <span className="text-sm white/40">Cannot be dismissed or deleted. Set programmatically.</span>
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
              <span className="text-xs white/40">
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
          <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Group</h3>
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
        <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">
          System Prompt {isPrimary && <span className="text-xs white/30 normal-case">(SOUL.md)</span>}
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
              className="px-3 py-1.5 text-sm glass-btn-blue rounded-lg transition-colors"
            >
              Save Prompt
            </button>
          </div>
        </div>
      </div>

      {/* Permissions + Tools — unified toggle UI */}
      <div>
        <h3 className="text-sm font-semibold white/55 uppercase tracking-wide mb-2">Permissions</h3>
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
            <div className="flex justify-end mt-4 pt-3 border-t white/[0.08]">
              <button
                onClick={savePermissions}
                className="px-4 py-2 text-sm glass-btn-blue rounded-lg transition-colors font-medium"
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
        <p className="white/40">Loading history...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {messages.length === 0 ? (
        <p className="white/40 text-center py-8">No message history.</p>
      ) : (
        <div className="space-y-2">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3 text-sm">
              <span className={`shrink-0 w-16 text-right font-mono text-xs py-1 ${
                msg.role === 'user' ? 'text-cp-blue' :
                msg.role === 'assistant' ? 'text-cp-teal' :
                msg.role === 'tool' ? 'text-cp-amber' :
                'white/40'
              }`}>
                {msg.role}
              </span>
              <div className="flex-1 min-w-0">
                <pre className="white/70 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                  {(() => {
                    const { text } = parseMessageContent(msg.content);
                    return text || '[structured content]';
                  })()}
                </pre>
                <div className="text-xs white/30 mt-0.5">
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
  status: { bg: 'bg-white/[0.08]', text: 'white/55' },
  chat: { bg: 'bg-purple-500/20', text: 'text-purple-400' },
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
        <p className="white/40">Loading messages...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {messages.length === 0 ? (
        <p className="white/40 text-center py-8">No inter-agent messages.</p>
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
                  <span className="text-xs white/40 ml-auto">
                    {formatDate(msg.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs white/40 mb-2">
                  <span>{msg.fromAgent}</span>
                  <span className="white/30">-&gt;</span>
                  <span>{msg.toAgent}</span>
                </div>
                <pre className="text-sm white/70 whitespace-pre-wrap break-words font-sans">
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
        <h3 className="text-lg font-semibold text-white mb-2">Dismiss Agent</h3>
        <p className="text-sm white/55 mb-6">
          {classification === 'ronin'
            ? <>This is a <strong className="text-cp-blue">Ronin</strong> agent. Are you sure you want to dismiss <strong className="text-white">{agentName}</strong> from the dojo?</>
            : <>Are you sure you want to dismiss <strong className="text-white">{agentName}</strong> from the dojo? This action cannot be undone.</>
          }
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm white/55 hover:white/90 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
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
        <p className="white/40">Loading agent...</p>
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
      <div className="shrink-0 border-b white/[0.06] px-6 py-4">
        <div className="flex items-center gap-2 text-sm white/40 mb-2">
          <Link to="/agents" className="hover:white/70 transition-colors">Agents</Link>
          <span>/</span>
          <span className="white/70">{agent.name}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white">{agent.name}</h1>
            <StatusBadge status={agent.status} />
            <span className={`text-xs px-1.5 py-0.5 rounded ${cls.bg} ${cls.text}`}>
              {cls.label}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-sm white/55 flex items-center gap-4">
              <span>Model: <span className="white/90">{agent.modelId === 'auto' ? 'Auto (Smart Router)' : (agent.model?.name || 'None')}</span></span>
              <span>Uptime: <span className="white/90">{formatUptime(agent.uptime)}</span></span>
              {agent.parentAgent && (
                <span>
                  Parent:{' '}
                  <Link to={`/agents/${agent.parentAgent}`} className="text-cp-blue hover:text-cp-blue/80">
                    {agent.parentAgent}
                  </Link>
                </span>
              )}
              {agent.spawnDepth > 0 && (
                <span>Depth: <span className="white/90">{agent.spawnDepth}</span></span>
              )}
              {agent.timeoutAt && (
                <span className="text-orange-400">
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
                  ? 'bg-white/[0.05] text-white'
                  : 'white/40 hover:white/70 hover:white/[0.03]'
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
