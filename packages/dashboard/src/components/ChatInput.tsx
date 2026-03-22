import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent } from 'react';
import * as api from '../lib/api';
import type { AttachmentInfo } from '../lib/api';

const ACCEPTED_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.pptx,.js,.ts,.tsx,.jsx,.py,.html,.css,.sh,.yaml,.yml,.toml,.env,.sql,.rs,.go,.java,.rb,.php,.swift,.kt,.c,.cpp,.h';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB total

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface PendingFile {
  file: File;
  previewUrl?: string; // For image thumbnails
}

interface ChatInputProps {
  agentId: string;
  onSend: (content: string, attachments?: AttachmentInfo[]) => void;
  disabled?: boolean;
  placeholder?: string;
  variant?: 'primary' | 'agent'; // primary = main chat page, agent = agent detail
  wordyMode?: boolean;
  onToggleWordyMode?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const ChatInput = ({ agentId, onSend, disabled, placeholder, variant = 'primary', wordyMode, onToggleWordyMode }: ChatInputProps) => {
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    }
  }, [input]);

  // Validate and add files
  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const newPending: PendingFile[] = [];
    let totalSize = pendingFiles.reduce((sum, pf) => sum + pf.file.size, 0);

    for (const file of fileArray) {
      if (file.size > MAX_FILE_SIZE) {
        setError(`"${file.name}" exceeds the 10MB file size limit.`);
        continue;
      }
      totalSize += file.size;
      if (totalSize > MAX_TOTAL_SIZE) {
        setError('Total file size exceeds 20MB limit.');
        break;
      }

      const pf: PendingFile = { file };
      if (IMAGE_TYPES.has(file.type)) {
        pf.previewUrl = URL.createObjectURL(file);
      }
      newPending.push(pf);
    }

    setPendingFiles(prev => [...prev, ...newPending]);
  }, [pendingFiles]);

  // Remove a pending file
  const removeFile = useCallback((index: number) => {
    setPendingFiles(prev => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingFiles.forEach(pf => {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      });
    };
  }, []);

  // Handle send
  const handleSend = async () => {
    const content = input.trim();
    if (!content && pendingFiles.length === 0) return;
    if (disabled || uploading) return;

    setError(null);

    let attachments: AttachmentInfo[] | undefined;

    // Upload pending files first
    if (pendingFiles.length > 0) {
      setUploading(true);
      const result = await api.uploadFiles(agentId, pendingFiles.map(pf => pf.file));
      setUploading(false);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      attachments = result.data;

      // Clean up preview URLs
      pendingFiles.forEach(pf => {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      });
      setPendingFiles([]);
    }

    setInput('');
    onSend(content || '(attached files)', attachments);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // File picker
  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = ''; // Reset so same file can be selected again
    }
  };

  // Drag and drop
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  // Paste support (images from clipboard)
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      addFiles(imageFiles);
    }
  };

  const isPrimary = variant === 'primary';

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`shrink-0 ${dragOver ? 'ring-2 ring-cp-amber/40' : ''}`}
      style={isPrimary ? {
        background: 'rgba(255,255,255,0.08)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        padding: '16px 24px',
      } : {
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.04)',
        padding: '12px 16px',
      }}
    >
      {/* Error */}
      {error && (
        <div className="mb-2 px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:opacity-70">&times;</button>
        </div>
      )}

      {/* Attachment previews */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((pf, i) => (
            <div key={i} className="glass-nested rounded-lg px-2.5 py-1.5 flex items-center gap-2 text-xs max-w-[200px]">
              {pf.previewUrl ? (
                <img src={pf.previewUrl} alt={pf.file.name} className="w-10 h-10 rounded object-cover shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-white/[0.08] flex items-center justify-center text-white/40 shrink-0 text-[10px] font-mono">
                  {pf.file.name.split('.').pop()?.toUpperCase() || '?'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-white/80 truncate">{pf.file.name}</div>
                <div className="text-white/30">{formatFileSize(pf.file.size)}</div>
              </div>
              <button
                onClick={() => removeFile(i)}
                className="text-white/30 hover:text-cp-coral shrink-0 text-sm"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 max-w-4xl mx-auto">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Text input with embedded + button */}
        <div className="flex-1 relative flex items-center">
          <button
            onClick={handleFileSelect}
            disabled={disabled || uploading}
            className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/[0.08] transition-all disabled:opacity-30 z-10"
            title="Attach files"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={uploading ? 'Uploading files...' : placeholder ?? 'Send a message... (Shift+Enter for newline)'}
            disabled={disabled || uploading}
            rows={1}
            className={isPrimary
              ? 'glass-input w-full resize-none py-3.5 pr-5 text-[15px] scrollbar-hide'
              : 'w-full py-2.5 pr-4 bg-white/[0.05] border border-white/[0.08] rounded-xl text-white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none disabled:opacity-50 scrollbar-hide'
            }
            style={isPrimary
              ? { minHeight: '50px', borderRadius: '16px', paddingLeft: '44px' }
              : { paddingLeft: '40px' }
            }
          />
        </div>

        {/* Send button */}
        {isPrimary ? (
          <button
            onClick={handleSend}
            disabled={disabled || uploading || (!input.trim() && pendingFiles.length === 0)}
            className="shrink-0 flex items-center justify-center text-xl font-bold transition-all disabled:opacity-30"
            style={{ background: '#F5A623', color: '#0B0F1A', borderRadius: '50%', width: '44px', height: '44px' }}
            onMouseEnter={(e) => { if (input.trim() || pendingFiles.length > 0) { e.currentTarget.style.background = '#FFBA42'; e.currentTarget.style.boxShadow = '0 0 16px rgba(245,166,35,0.3)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#F5A623'; e.currentTarget.style.boxShadow = 'none'; }}
          >
            {uploading ? '\u23F3' : '\u2191'}
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || uploading || (!input.trim() && pendingFiles.length === 0)}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-white/[0.08] disabled:text-white/40 text-white font-medium rounded-xl transition-colors shrink-0"
          >
            {uploading ? 'Uploading...' : 'Send'}
          </button>
        )}

        {/* Wordy Mode toggle */}
        {onToggleWordyMode && (
          <button
            onClick={onToggleWordyMode}
            title={wordyMode ? 'Wordy Mode: ON (showing tool calls)' : 'Wordy Mode: OFF (chat only)'}
            className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition-all ${
              wordyMode
                ? 'bg-purple-500/20 text-purple-400'
                : 'bg-white/[0.06] text-white/25 hover:text-white/50'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
        )}
      </div>

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 bg-cp-amber/5 border-2 border-dashed border-cp-amber/30 rounded-xl flex items-center justify-center pointer-events-none z-10">
          <span className="text-cp-amber text-sm font-medium">Drop files here</span>
        </div>
      )}
    </div>
  );
};
