import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Message } from '@dojo/shared';
import type { ChatChunkEvent, ChatMessageEvent, ChatToolCallEvent, ChatToolResultEvent, ChatErrorEvent, WsEvent } from '@dojo/shared';
import * as api from '../lib/api';
import { formatDate } from '../lib/dates';
import type { AttachmentInfo } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { ToolCallBlock, ToolCallCard, ToolResultBlock } from '../components/ToolCallBlock';
import { stripVoiceMarkers, stripVoiceMarkersForStream } from '../lib/voice-markers';
import { stripAttachmentTags } from '../lib/attachment-tags';
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
  // DeepSeek native thinking-mode / OpenRouter unified reasoning stream.
  // Populated by the chat:reasoning_chunk subscription; rendered in the
  // collapsible "Thinking…" panel inside AssistantBubble.
  reasoningContent?: string;
  isReasoningStreaming?: boolean;
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
  // v2.7.8 — the previous version embedded the FULL current TECHNIQUE.md
  // inside this wrapper. For a 11K-char technique the wrapper alone was
  // 11K+ chars, and the assembler's per-message cap (8K) was truncating
  // the combined message INSIDE the embedded markdown — which meant the
  // user's actual request (appended at the bottom) never reached the
  // agent. Real failure: user said "replace these two files," wrapper
  // pushed past the cap, agent received the wrapper sans user prompt
  // and spent the whole turn searching memory_grep for the missing
  // instructions while looping on its own tool-call echoes.
  //
  // The current TECHNIQUE.md is now referenced rather than embedded.
  // The agent reads it on demand via technique_read / file_read — both
  // tools they already have. The user's actual prompt always fits.
  const lineCount = instructions ? instructions.split('\n').length : 0;
  const charCount = instructions?.length ?? 0;
  return `I want to edit an existing technique in the dojo called "${name}".

Description (currently): ${description || '(none)'}

Current TECHNIQUE.md is loaded on disk (${charCount.toLocaleString()} chars, ${lineCount} lines). Read it the moment you need it:
  • technique_read(name="${name}", action="outline") — section list + line ranges, never truncates
  • technique_read(name="${name}", action="section", section_name="…") — read one section
  • technique_read(name="${name}", action="search", query="…") — grep across TECHNIQUE.md and supporting files

I can see the technique mat on my screen with the current content. When we're done, use update_technique to save the changes. What I'd like changed is below.`;
}

// Setup context — fired the first time the user opens the training mat for
// an imported technique that's still in needs_setup state. Tells Yoshi
// where to find the staged IMPORT_MANIFEST.json + README.md and how to
// walk the user through filling in any {{NEEDS_FROM_USER:LABEL}}
// placeholders before finalizing.
function getSetupContext(name: string, slug: string, directoryPath: string | null): string {
  const dirHint = directoryPath ? ` It lives in: \`${directoryPath}\`.` : '';
  return `I just imported a shared technique called "${name}" (slug: ${slug}) and it landed in needs_setup state.${dirHint}

Please help me finish setting it up:

1. Read \`IMPORT_MANIFEST.json\` and \`README.md\` in the technique directory using file_read so you understand what came in the package and what setup steps the original author documented.
2. Look at the manifest's \`placeholders\` list — each one is a {{NEEDS_FROM_USER:LABEL}} marker that the exporting Dojo redacted because it was a secret or per-install value. Ask me for each placeholder ONE AT A TIME, in plain language, using the hint from the manifest to explain what it is.
3. As I give you each value, call technique_set_placeholder({technique: "${slug}", label: "...", value: "..."}) to write it into the technique files.
4. After every placeholder is filled, call technique_finalize({technique: "${slug}"}) — that flips the technique out of needs_setup and into draft state so I can review it or publish it.

If the README mentions manual setup steps that AREN'T placeholders (e.g. granting an OAuth scope, installing a CLI), call them out so I know to handle them before finalizing.

Ready when you are — start by reading the manifest and the README.`;
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

// v2.5.18 — The first user message of a builder/edit session has the
// builder context prepended (BUILDER_CONTEXT or getEditContext output)
// followed by the user's actual text. The trainer agent needs to see the
// context, but the USER doesn't want it cluttering the chat — they only
// want to see their prompt.
//
// The v2.5.17 approach used "\n\n---\n\n" as the boundary, but that
// collides with markdown horizontal rules inside the technique's own
// instructions — if the embedded TECHNIQUE.md contained any "---" block,
// the strip would chop at the wrong place (or fail to chop at all,
// depending on which way it went).
//
// v2.5.18 fix: wrap the user's prompt in a unique sentinel marker so the
// strip is unambiguous. The LLM sees the marker but it's clearly labeled,
// so it doesn't confuse the trainer. Falls back to the old "\n\n---\n\n"
// pattern via lastIndexOf for messages stored under v2.5.17.
export const USER_PROMPT_MARKER_OPEN = '\n\n════════════════════════════════════════\nUSER MESSAGE BELOW (the rest above is build/edit context for you):\n════════════════════════════════════════\n\n';

function stripBuilderContext(content: string): string {
  // Preferred: unique sentinel marker emitted by v2.5.18+ handleSend.
  const markerIdx = content.indexOf(USER_PROMPT_MARKER_OPEN);
  if (markerIdx >= 0) {
    return content.slice(markerIdx + USER_PROMPT_MARKER_OPEN.length);
  }
  // Backwards-compat: detect the v2.5.17 builder/edit/refresh context
  // headers and use lastIndexOf so a "---" inside the technique's own
  // markdown doesn't trigger an early match. The outer separator is
  // always the LAST occurrence because user content is appended at the
  // very end.
  const startsWithBuilder = content.startsWith('I want to build a new technique for the dojo');
  const startsWithEdit = content.startsWith('I want to edit an existing technique in the dojo called');
  const startsWithRefresh = content.startsWith('[Technique state refresh');
  if (!startsWithBuilder && !startsWithEdit && !startsWithRefresh) return content;
  const sepIdx = content.lastIndexOf('\n\n---\n\n');
  if (sepIdx === -1) return content;
  return content.slice(sepIdx + '\n\n---\n\n'.length);
}

// Mirror Chat.tsx / AgentDetail.tsx stripper. Removes server-injected
// attachment framing so the user only sees their typed text + the chip.
// stripAttachmentTags moved to ../lib/attachment-tags (shared; now covers
// Image + PDF too, which this page's old copy missed).

const UserBubble = ({ msg }: { msg: ChatMessage }) => {
  const stripped = stripBuilderContext(msg.content);
  const displayContent = msg.attachments?.length ? stripAttachmentTags(stripped) : stripped;

  return (
    <div className="flex justify-end">
      <div className="bubble-user max-w-[85%] px-4 py-3 text-ui">
        {displayContent && (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed break-words">
            {displayContent}
          </pre>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <AttachmentChips attachments={msg.attachments} />
        )}
        <div className="text-[10px] mt-2 text-tertiary">
          {formatDate(msg.createdAt)}
        </div>
      </div>
    </div>
  );
};

const AssistantBubble = ({ msg, wordyMode = true }: { msg: ChatMessage; wordyMode?: boolean }) => {
  const { text: rawText, blocks } = parseMessageContent(msg.content);
  const text = rawText?.trim() || '';
  // Hide cloud voice-mode markers ((deliver: ...)), [pause], [long pause]
  // from regular chat. Wordy mode shows them so you can debug agent output.
  const displayText = wordyMode
    ? text
    : (msg.isStreaming ? stripVoiceMarkersForStream(text) : stripVoiceMarkers(text));
  const hasToolUse = blocks?.some((b) => b.type === 'tool_use');
  const hasReasoning = !!(msg.reasoningContent && msg.reasoningContent.length > 0);

  // Auto-expand "Thinking…" while it's actively streaming OR while no
  // answer text has arrived yet. Auto-collapse once the final answer
  // text is rendering. Mirrors Chat.tsx:166-174.
  const reasoningOpenDefault = hasReasoning && (msg.isReasoningStreaming || text.length === 0);
  const [reasoningOpen, setReasoningOpen] = useState(reasoningOpenDefault);
  useEffect(() => {
    if (!msg.isReasoningStreaming && text.length > 0) setReasoningOpen(false);
  }, [msg.isReasoningStreaming, text.length]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {/* Reasoning / "Thinking…" panel — DeepSeek native thinking-mode
            and OpenRouter unified reasoning stream arrive via
            chat:reasoning_chunk. Without this the trainer mat showed
            NOTHING for the model's pre-answer reasoning, even in wordy
            mode. Live-streams, then collapses once the final answer
            text starts arriving. */}
        {hasReasoning && wordyMode && (
          <div className="mb-1.5 rounded-lg border border-ui/[0.06] bg-ui/[0.03] overflow-hidden">
            <button
              type="button"
              onClick={() => setReasoningOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-ui/40 hover:text-ui/70 transition-colors"
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
              <div className="px-3 pb-2.5 pt-0.5 text-xs text-ui/55 whitespace-pre-wrap font-mono leading-relaxed border-t border-ui/[0.06]">
                {msg.reasoningContent}
              </div>
            )}
          </div>
        )}

        {displayText && (
          <div className="bubble-assistant px-4 py-3 whitespace-pre-wrap">
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

        {!text && msg.isStreaming && (
          <div className="bubble-assistant px-4 py-3">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-cp-amber animate-bounce" style={{ animationDelay: '300ms' }} />
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
          <div className="text-[10px] mt-1 px-1 text-tertiary">
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
      <div className="shrink-0 px-4 py-3 border-b border-ui/[0.06]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ui/70">Technique Mat</h2>
          <span className="glass-badge glass-badge-amber text-[10px]">Draft — not yet published</span>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-xs text-ui/40 block mb-1">Technique Name</label>
          <input
            value={canvas.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            placeholder="e.g. Git Branch Cleanup"
            className="glass-input w-full px-3 py-2 text-sm"
          />
        </div>

        {/* Slug */}
        <div>
          <label className="text-xs text-ui/40 block mb-1">Slug (directory name)</label>
          <input
            value={canvas.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. git-branch-cleanup"
            className="glass-input w-full px-3 py-2 text-xs font-mono"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-ui/40 block mb-1">Description</label>
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
          <label className="text-xs text-ui/40 block mb-1">Tags</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {canvas.tags.map(tag => (
              <span key={tag} className="glass-badge glass-badge-blue text-xs flex items-center gap-1">
                {tag}
                <button onClick={() => removeTag(tag)} className="text-ui/40 hover:text-ui ml-0.5">&times;</button>
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
          <label className="text-xs text-ui/40 block mb-1">TECHNIQUE.md (Instructions)</label>
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
          <label className="text-xs text-ui/40 block mb-1">Supporting Files ({canvas.files.length})</label>
          <div className="glass-card p-3 space-y-1.5">
            {canvas.files.map((f, i) => (
              <div key={i} className="text-xs text-ui/55 flex items-center justify-between group">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-ui/25 shrink-0">{'\u{1F4C4}'}</span>
                  <span className="font-mono truncate">{f.path}</span>
                </div>
                <button
                  onClick={() => onChange({ files: canvas.files.filter((_, idx) => idx !== i) })}
                  className="text-ui/25 hover:text-cp-coral transition-colors shrink-0 ml-2 text-sm opacity-0 group-hover:opacity-100"
                  title="Remove file"
                >
                  &times;
                </button>
              </div>
            ))}

            {/* Drop zone / upload area */}
            <label
              className="block mt-2 border border-dashed border-ui/[0.10] hover:border-ui/[0.15] rounded-lg p-3 text-center cursor-pointer transition-colors"
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
              <span className="text-xs text-ui/25">Drop files here or click to upload</span>
            </label>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 p-4 border-t border-ui/[0.06] flex gap-2">
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
  // v2.5.17 — wordy-mode parity with Chat.tsx and AgentDetail.tsx. Shares
  // the same localStorage key so toggling wordy mode anywhere on the
  // dashboard sticks across all chat surfaces.
  const [wordyMode, setWordyMode] = useState(() => {
    const stored = localStorage.getItem('dojo_wordy_mode');
    return stored === null ? true : stored === 'true';
  });
  // Tracks when the technique was last touched on disk and when the trainer
  // last saw it in this conversation. If the user manually edits between
  // sessions, the trainer would be working from stale context — when these
  // diverge, the next user message gets a "current state" refresh prepended
  // so the trainer doesn't suggest changes that overwrite recent edits.
  const [techniqueUpdatedAt, setTechniqueUpdatedAt] = useState<string | null>(null);
  const [lastTrainerActivityAt, setLastTrainerActivityAt] = useState<string | null>(null);
  // Tracks the technique's server-side state so we can pick the right
  // first-message context for the trainer. needs_setup techniques (post-import)
  // get the setup walkthrough instead of the generic edit context.
  const [techniqueState, setTechniqueState] = useState<string | null>(null);
  const [techniqueDirectoryPath, setTechniqueDirectoryPath] = useState<string | null>(null);
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

  // Load existing technique in edit mode. Extracted so we can also call it
  // from the technique:updated WS subscription below to keep the canvas in
  // sync with disk after the trainer commits a change via update_technique.
  const loadTechniqueFromDisk = useCallback(async (id: string) => {
    const token = localStorage.getItem('dojo_token');
    const res = await fetch(`/api/techniques/${id}`, {
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
      if (typeof data.data.updatedAt === 'string') {
        setTechniqueUpdatedAt(data.data.updatedAt);
      }
      if (typeof data.data.state === 'string') {
        setTechniqueState(data.data.state);
      }
      if (typeof data.data.directoryPath === 'string') {
        setTechniqueDirectoryPath(data.data.directoryPath);
      }
    }
  }, []);

  useEffect(() => {
    if (!editId) return;
    loadTechniqueFromDisk(editId);
  }, [editId, loadTechniqueFromDisk]);

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
            // Persisted reasoning_content is included so the "Thought"
            // panel renders on resumed sessions, not just live streams.
            reasoningContent: m.reasoningContent ?? undefined,
          })),
        );
        // Most recent message becomes the "trainer last saw the technique
        // at" timestamp. Used in handleSend to decide whether to prepend
        // a state refresh on the next user message.
        const latestMsg = result.data[result.data.length - 1] as Message | undefined;
        if (latestMsg?.createdAt) setLastTrainerActivityAt(latestMsg.createdAt);
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

  // Pre-2026-05-06: this effect auto-sent the entire technique to the
  // trainer the instant the edit screen opened, burning a full model
  // turn even when the user only meant to skim or make a manual edit.
  // Now we just mark the screen ready; the context message gets prepended
  // to the user's FIRST chat message inside handleSend, so the trainer
  // is only invoked when the user actually engages the chat.
  useEffect(() => {
    if (!AGENT_ID || !sessionCleared || contextSent) return;
    if (isEditMode && !canvas.displayName) return;
    setLoading(false);
  }, [AGENT_ID, sessionCleared, contextSent, isEditMode, canvas.displayName]);

  // Watch for save_technique / update_technique tool calls so the canvas
  // mirrors what the trainer just wrote to disk. Without this, the canvas
  // stays stale and the next "Save Draft" / "Publish" click overwrites the
  // trainer's fresh writes with the stale canvas state.
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
    } else if (toolName === 'update_technique') {
      // update_technique only includes the fields the agent is changing.
      // Merge: only overwrite a canvas field if the agent provided it.
      setCanvas(prev => ({
        ...prev,
        instructions: typeof args.instructions === 'string' ? (args.instructions as string) : prev.instructions,
        files: Array.isArray(args.files)
          ? [
              // Replace any existing file at the same path, append new ones
              ...prev.files.filter(p => !(args.files as Array<{ path: string }>).some(nf => nf.path === p.path)),
              ...(args.files as Array<{ path: string; content?: string }>),
            ]
          : prev.files,
      }));
    }
  }, []);

  // Subscribe to WebSocket events
  useEffect(() => {
    // Engine-agnostic backstop for stuck "thinking" dots — see Chat.tsx
    // for the full rationale. Drops empty streaming bubbles and clears
    // the flag on bubbles that already have content.
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

      // v2.5.22 — see Chat.tsx for rationale.
      const toolCallsSnapshot = e.done && currentToolCallsRef.current.length > 0
        ? [...currentToolCallsRef.current]
        : null;
      if (e.done) currentToolCallsRef.current = [];

      setMessages((prev) => {
        // Find the streaming bubble for THIS messageId anywhere in the
        // list, not just the tail. The old "only check last" rule broke
        // whenever a non-streaming message (tool_result, system divider,
        // an empty-content broadcast from the runtime's no-reply
        // sentinel) landed at the tail between chunks — every subsequent
        // chunk created a fresh empty bubble, producing the "long row of
        // empty timestamps + the same line repeated 40 times" symptom in
        // the trainer mat after a save_technique retry storm.
        const matchIdx = prev.findIndex(
          (m) => m.id === e.messageId && (m.role === 'assistant' || m.role === 'tool'),
        );
        if (matchIdx >= 0) {
          const existing = prev[matchIdx];
          const updated: ChatMessage = {
            ...existing,
            content: existing.content + e.content,
          };
          if (e.done) {
            updated.isStreaming = false;
            updated.toolCalls = toolCallsSnapshot ?? existing.toolCalls;
            updated.createdAt = new Date().toISOString();
            setIsWorking(false);
          } else if (existing.isStreaming === false) {
            // Late chunk arriving for a bubble we already closed — keep
            // it closed (avoid resurrecting a finalized message).
            updated.isStreaming = false;
          }
          const copy = [...prev];
          copy[matchIdx] = updated;
          return copy;
        }
        // No bubble for this id yet — create one. If the chunk is
        // already `done` with no content, drop it on the floor instead
        // of spawning an empty-timestamp row.
        if (e.done && !e.content) {
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
      });
    });

    // chat:reasoning_chunk — DeepSeek native thinking-mode / OpenRouter
    // unified reasoning stream. Without this subscription the trainer mat
    // shows NOTHING for the model's pre-answer reasoning, even in wordy
    // mode (the user reported "I feel like the model is doing something
    // but I am not seeing it"). Mirrors Chat.tsx:619-649.
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
        // Reasoning arrived before any chat:chunk — create the bubble
        // shell with empty answer content. The answer chunks for this
        // same messageId will populate `content` later.
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
      // Phase 8 F1 fix: don't show info-severity events (AGENT_RECOVERED,
      // HEALER_DISPATCHED, dedup) as errors in the technique builder UI.
      // Recovered → clear isWorking but don't pin a red error banner.
      if (e.severity === 'info') {
        if (e.code === 'AGENT_RECOVERED') {
          setIsWorking(false);
          reconcileStreamingBubbles();
        }
        return;
      }
      setError(e.error);
      setIsWorking(false);
      reconcileStreamingBubbles();
    });

    const unsubMessage = subscribe('chat:message', (event: WsEvent) => {
      const e = event as ChatMessageEvent;
      if (e.agentId !== agentIdRef.current) return;

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === e.message.id);
        if (idx >= 0) {
          // Empty-content broadcast is a "drop this bubble" signal from
          // the runtime. Fires from at least two places: the [no-reply]
          // sentinel (v2/loop.ts:1494) and the close-out gate suppression
          // path (v2/loop.ts:1791) that deletes the agent's just-persisted
          // assistant message when it generated user-facing text it
          // wasn't supposed to. Without this filter every such broadcast
          // left a bare-timestamp "5/22/2026, 11:51:01 AM" row in the
          // trainer mat. Mirrors Chat.tsx:706-715.
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
            // Clear the streaming-collected toolCalls — the canonical
            // JSON content is now the source of truth.
            toolCalls: undefined,
            isStreaming: false,
          };
          // v2.5.21 — Removed v2.5.20 move-to-tail. See Chat.tsx.
          return updated;
        }

        // For user messages, reconcile with the optimistic temp- bubble that
        // handleSend pushed locally. The temp id never matches the real DB
        // id, so without this the user prompt appears twice — once from the
        // local push, once from the server broadcast. Mirrors Chat.tsx.
        // Compare on typed-text core (stripAttachmentTags) so messages with
        // file attachments dedup correctly.
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
          },
        ];
      });
    });

    // Listen for technique:updated broadcasts (fired by updateTechniqueInstructions
    // on disk write). When the trainer commits a change to THIS technique, refetch
    // from disk so the canvas reflects the authoritative state. Without this, a
    // tool_call event missed by the dashboard (network blip, page refresh) would
    // leave the canvas stale and the next save would overwrite the trainer's work.
    // Mirror the agent:status backstop the other chat pages have so a
    // trainer turn that ends without firing chat:chunk done:true (model
    // error, recovery cascade, etc.) doesn't leave dots stuck on screen.
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

    const unsubTechUpdated = subscribe('technique:updated', (event: WsEvent) => {
      const e = event as { type: 'technique:updated'; data: { id: string } };
      const currentId = createdTechniqueId || editId;
      if (!currentId || e.data?.id !== currentId) return;
      // The trainer just committed a change. Reload disk state, AND
      // advance the trainer-saw-it marker to "now" so we don't trigger a
      // stale-state refresh on the next user message — the trainer is
      // the one that made this change, it doesn't need to be told.
      loadTechniqueFromDisk(currentId)
        .then(() => setLastTrainerActivityAt(new Date().toISOString()))
        .catch(() => { /* best effort */ });
    });

    return () => {
      unsubStatus();
      unsubChunk();
      unsubReasoning();
      unsubToolCall();
      unsubToolResult();
      unsubError();
      unsubMessage();
      unsubTechUpdated();
    };
  }, [subscribe, AGENT_ID, handleToolCallForCanvas, createdTechniqueId, editId, loadTechniqueFromDisk]);

  const handleSend = async (content: string, attachments?: AttachmentInfo[]) => {
    setError(null);

    // First message of this edit/build session — prepend the technique
    // (or build-mode) context so the trainer has the working set without
    // us needing to fire a separate model turn just to deliver it.
    let outgoing = content;
    const isFirstMessage = !contextSent;
    let staleRefreshFired = false;
    if (isFirstMessage) {
      const isSetupMode = isEditMode && techniqueState === 'needs_setup';
      const contextMessage = isSetupMode
        ? getSetupContext(canvas.displayName, canvas.name, techniqueDirectoryPath)
        : isEditMode
          ? getEditContext(canvas.displayName, canvas.description, canvas.instructions)
          : BUILDER_CONTEXT;
      // v2.5.18 — Use the unique USER_PROMPT_MARKER_OPEN sentinel so the
      // chat-side strip is unambiguous even when the embedded technique
      // contains markdown horizontal rules.
      outgoing = `${contextMessage}${USER_PROMPT_MARKER_OPEN}${content}`;
      setContextSent(true);
    } else if (
      isEditMode &&
      techniqueUpdatedAt &&
      lastTrainerActivityAt &&
      techniqueUpdatedAt > lastTrainerActivityAt
    ) {
      // Resumed conversation, but the technique has been edited (manually
      // by the user, or by another agent) since the trainer's last
      // activity in this thread. Prepend a current-state refresh so the
      // trainer doesn't suggest changes that would overwrite the edits.
      const refresh =
        `[Technique state refresh — the technique has been edited since our last conversation. ` +
        `Treat THIS as the source of truth, not earlier messages in this thread.]\n\n` +
        getEditContext(canvas.displayName, canvas.description, canvas.instructions);
      outgoing = `${refresh}${USER_PROMPT_MARKER_OPEN}${content}`;
      staleRefreshFired = true;
    }

    const userMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: outgoing,
      createdAt: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsWorking(true);

    const result = await api.sendMessage(AGENT_ID, outgoing, attachments);
    if (!result.ok) {
      // Roll the gate back so a retry resends the context with the next attempt.
      if (isFirstMessage) setContextSent(false);
      if (result.error.includes('busy')) {
        setError('Agent is mid-mission — your message will be delivered when they finish.');
      } else {
        setError(result.error);
      }
      setIsWorking(false);
    } else if (isFirstMessage || staleRefreshFired) {
      // Advance the "trainer last saw it" marker so subsequent messages
      // don't keep re-prepending context. We use the technique's current
      // updatedAt rather than now() so a manual edit DURING an in-flight
      // turn still triggers a refresh on the next user message.
      if (techniqueUpdatedAt) setLastTrainerActivityAt(techniqueUpdatedAt);
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
        // Upload any newly-added supporting files BEFORE the instructions
        // PUT. canvas.files entries that came from disk on initial load
        // have no `content` field (loadTechniqueFromDisk drops it); only
        // entries the user just dropped into the box carry content, so
        // those are the ones we need to persist. Has to run before the
        // instructions PUT because that broadcasts technique:updated,
        // which triggers a disk reload that strips `content` off
        // canvas.files mid-save.
        const filesToUpload = canvas.files.filter(f => typeof f.content === 'string');
        for (const file of filesToUpload) {
          await fetch(`/api/techniques/${existingId}/files/${file.path}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ content: file.content }),
          });
        }
        // Update instructions (creates a version)
        if (canvas.instructions.trim()) {
          await fetch(`/api/techniques/${existingId}/instructions`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ content: canvas.instructions.trim(), changeSummary: 'Updated from Technique Trainer' }),
          });
        }
        // Update metadata. Pre-2026-05-06 we omitted displayName from this
        // payload, so the user's renamed technique silently kept its
        // original name. Now we include it so the rename actually persists.
        const metaRes = await fetch(`/api/techniques/${existingId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            displayName: canvas.displayName.trim(),
            description: canvas.description.trim(),
            tags: canvas.tags,
            ...(publish ? { state: 'published' } : {}),
          }),
        });
        const metaData = await metaRes.json().catch(() => null);
        if (!metaRes.ok || metaData?.ok === false) {
          throw new Error(metaData?.error || 'Failed to update technique metadata');
        }
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
        <div className="shrink-0 px-3 sm:px-4 py-2 sm:py-3 border-b border-ui/[0.06] flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => navigate(isEditMode ? `/techniques/${editId}` : '/techniques')}
            className="text-xs text-ui/40 hover:text-ui/70"
          >
            {'\u2190'} Back
          </button>
          <h1 className="text-sm font-semibold text-ui/70">Technique Trainer</h1>
          <span className="text-xs text-ui/25">{isEditMode ? `Edit technique with ${agentName || 'your agent'}` : `Train ${agentName || 'your agent'} on a new technique`}</span>
        </div>

        {/* Messages */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="flex-1 flex items-center justify-center h-full">
              <div className="text-center animate-fade-up max-w-sm px-4">
                <div className="text-3xl mb-3">{'\u{1F3AF}'}</div>
                <h2 className="text-lg font-semibold text-ui/70 mb-1">Technique Trainer</h2>
                <p className="text-xs text-secondary">
                  {techniqueState === 'needs_setup'
                    ? `This technique was imported and needs setup. Send any message to ${agentName || 'the trainer'} (e.g. "let's begin") and they'll walk you through filling in the placeholders.`
                    : isEditMode
                    ? `Edit the mat directly — or message ${agentName || 'the trainer'} for help. The current technique will be sent along with your first message.`
                    : `Tell ${agentName || 'the trainer'} what you want to build. The build prompt is sent with your first message.`}
                </p>
              </div>
            </div>
          )}

          {/* v2.5.19 — See Chat.tsx: reverted the v2.5.17 render-time sort
              because it was hiding new user temp bubbles on the other chat
              surfaces. Mirroring the revert here for consistency. */}
          {messages.map((msg) => {
            if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
            // Hide tool results entirely outside wordy mode — same UX as
            // the other chat surfaces. Assistant bubbles still appear,
            // but tool-call/result detail is gated.
            if (msg.role === 'tool') {
              if (!wordyMode) return null;
              return <ToolResultBubble key={msg.id} msg={msg} />;
            }
            return <AssistantBubble key={msg.id} msg={msg} wordyMode={wordyMode} />;
          })}
          {isWorking && !messages.some(m => m.isStreaming) && <ThinkingBubble />}
          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="shrink-0 mx-4 mb-2 glass-toast glass-toast-error px-4 py-3 text-sm flex items-center justify-between text-cp-coral">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:opacity-70 ml-2 shrink-0">&times;</button>
          </div>
        )}

        {/* Input */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <ChatInput
              agentId={AGENT_ID}
              onSend={handleSend}
              variant="agent"
              wordyMode={wordyMode}
              onToggleWordyMode={() => {
                const next = !wordyMode;
                setWordyMode(next);
                localStorage.setItem('dojo_wordy_mode', String(next));
              }}
              onNewSession={async () => {
                if (!confirm('Start a new session with the trainer? The current conversation will be cleared.')) return;
                const token = localStorage.getItem('dojo_token');
                const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
                const csrf = csrfMatch ? csrfMatch[1] : null;
                try {
                  await fetch('/api/techniques/clear-session', {
                    method: 'POST',
                    headers: {
                      ...(token ? { Authorization: `Bearer ${token}` } : {}),
                      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
                    },
                  });
                  // Wipe the chat history and reset the context-injection gate
                  // so the next user message re-prepends the builder/edit
                  // context for the trainer.
                  setMessages([]);
                  setContextSent(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              isWorking={isWorking}
              onStop={async () => {
                await api.stopAgent(AGENT_ID);
                setIsWorking(false);
              }}
            />
          </div>
          {/* Mobile toggle for canvas panel */}
          <button
            onClick={() => setCanvasOpen(!canvasOpen)}
            className="md:hidden shrink-0 px-3 py-2 mr-2 mb-1 text-xs bg-ui/[0.08] border border-ui/[0.10] rounded-lg text-ui/55 hover:text-ui/90"
          >
            {canvasOpen ? 'Chat' : 'Mat'}
          </button>
        </div>
      </div>

      {/* Divider — desktop only */}
      <div className="hidden md:block shrink-0 glass-divider-v" />

      {/* Right Panel — Canvas (40% on desktop, flyout on mobile) */}
      <div className={`
        min-h-0
        ${canvasOpen
          ? 'fixed inset-0 z-40 md:relative md:inset-auto md:z-auto'
          : 'hidden md:block'
        }
      `} style={{ width: canvasOpen && window.innerWidth < 768 ? '100%' : '40%', background: 'rgb(var(--cp-bg-ch) / 0.3)' }}>
        {/* Mobile close button */}
        {canvasOpen && (
          <button
            onClick={() => setCanvasOpen(false)}
            className="md:hidden absolute top-3 right-3 z-50 px-3 py-1.5 bg-ui/[0.12] rounded-lg text-xs text-ui/70 hover:text-ui"
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
