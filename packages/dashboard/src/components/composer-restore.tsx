import { useEffect, useRef, useState } from 'react';
import type { AttachmentInfo } from '../lib/api';

// When the server refuses a message the chat hands it back here: the text goes back into the
// box and the already-uploaded attachments are held beside it for the next send. Anything the
// owner has typed or staged since is never overwritten.
export interface RefusedDraft {
  id: number;
  agentId: string;
  text: string;
  attachments?: AttachmentInfo[];
  /** Told whether the draft was put back (true) or the composer was busy and kept its own work. */
  done: (restored: boolean) => void;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateName(name: string): string {
  return name.length > 26 ? `${name.slice(0, 24)}…` : name;
}

export function useRestoredDraft(
  agentId: string, refused: RefusedDraft | undefined, input: string, stagedCount: number, setInput: (v: string) => void,
) {
  const [kept, setKept] = useState<AttachmentInfo[]>([]);
  const handled = useRef(0);
  useEffect(() => {
    if (!refused || refused.id === handled.current) return;
    handled.current = refused.id;
    const free = refused.agentId === agentId && input.trim() === '' && stagedCount === 0 && kept.length === 0;
    if (free) { setInput(refused.text); setKept(refused.attachments ?? []); }
    refused.done(free);
  }, [refused, agentId, input, stagedCount, kept.length, setInput]);
  const node = kept.length > 0 ? (
    <div className="composer__thumbs" aria-label="Attached files kept from the unsent message">
      {kept.map((a, i) => (
        <div className="composer__thumb" key={`kept-${i}`} title={a.filename}>
          <span className="composer__thumb-doc"><span className="composer__thumb-ext">{truncateName(a.filename)}</span></span>
          <button type="button" className="composer__thumb-x" aria-label={`Remove ${a.filename}`}
            onClick={() => setKept((k) => k.filter((_, j) => j !== i))}>{'×'}</button>
        </div>
      ))}
    </div>
  ) : null;
  return { kept, clearKept: () => setKept([]), node };
}
