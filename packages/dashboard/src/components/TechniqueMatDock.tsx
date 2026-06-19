import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTechniqueSession, type CanvasState } from './TechniqueSessionProvider';
import { useRightDock } from './RightDockProvider';

/*
 * The Technique Mat, rendered inside the right dock while a technique-build
 * session is active. It reads the canvas + handlers from the session provider,
 * so trainer edits (via tools) and the user's manual edits stay in sync. UI
 * ported from the old TechniqueBuilder's inline Mat; only the data source
 * (props -> context) and the close affordance changed.
 */
export function TechniqueMatDock() {
  const { canvas, handleCanvasChange, saveTechnique, saving, error } = useTechniqueSession();
  const { close } = useRightDock();
  const navigate = useNavigate();
  const [tagInput, setTagInput] = useState('');

  const onChange = (updates: Partial<CanvasState>) => handleCanvasChange(updates);

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !canvas.tags.includes(tag)) onChange({ tags: [...canvas.tags, tag] });
    setTagInput('');
  };
  const removeTag = (tag: string) => onChange({ tags: canvas.tags.filter((t) => t !== tag) });

  const canPublish = canvas.displayName.trim() && canvas.description.trim() && canvas.instructions.trim();

  const handleFileUpload = (files: File[]) => {
    const readers = files.map((file) => new Promise<{ path: string; content: string }>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ path: file.name, content: reader.result as string });
      reader.onerror = () => resolve({ path: file.name, content: `(failed to read ${file.name})` });
      reader.readAsText(file);
    }));
    Promise.all(readers).then((newFiles) => {
      const existingPaths = new Set(newFiles.map((f) => f.path));
      const kept = canvas.files.filter((f) => !existingPaths.has(f.path));
      onChange({ files: [...kept, ...newFiles] });
    });
  };

  const closeMat = () => {
    close();
    navigate('/techniques');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-ui/[0.06]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ui/70">Technique Mat</h2>
          <div className="flex items-center gap-2">
            <span className="glass-badge glass-badge-amber text-[10px]">Draft — not yet published</span>
            <button
              type="button"
              onClick={closeMat}
              className="text-ui/40 hover:text-ui transition-colors"
              title="Close"
              aria-label="Close technique mat"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="shrink-0 mx-4 mt-3 px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/30 text-cp-coral text-xs">
          {error}
        </div>
      )}

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="text-xs text-ui/40 block mb-1">Technique Name</label>
          <input
            value={canvas.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            placeholder="e.g. Git Branch Cleanup"
            className="glass-input w-full px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-ui/40 block mb-1">Slug (directory name)</label>
          <input
            value={canvas.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. git-branch-cleanup"
            className="glass-input w-full px-3 py-2 text-xs font-mono"
          />
        </div>

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

        <div>
          <label className="text-xs text-ui/40 block mb-1">Tags</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {canvas.tags.map((tag) => (
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

            <label
              className="block mt-2 border border-dashed border-ui/[0.10] hover:border-ui/[0.15] rounded-lg p-3 text-center cursor-pointer transition-colors"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-cp-amber/40', 'bg-cp-amber/5'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('border-cp-amber/40', 'bg-cp-amber/5'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-cp-amber/40', 'bg-cp-amber/5');
                handleFileUpload(Array.from(e.dataTransfer.files));
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
          onClick={() => saveTechnique(false)}
          disabled={saving || !canvas.displayName.trim()}
          className="glass-btn glass-btn-secondary text-sm flex-1"
        >
          {saving ? 'Saving...' : 'Save Draft'}
        </button>
        <button
          onClick={() => saveTechnique(true)}
          disabled={saving || !canPublish}
          className="glass-btn glass-btn-primary text-sm flex-1"
        >
          {saving ? 'Publishing...' : 'Publish'}
        </button>
      </div>
    </div>
  );
}
