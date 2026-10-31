import { useState } from 'react';
import { copyTextToClipboard } from '../lib/clipboard';

// A report too long for the link: ONE click copies it and opens GitHub, then one paste finishes the job.
// Both happen inside the same click (the copy starts first, the page opens without waiting for it) so the
// browser allows the new tab. If the copy is refused the page still opens and the text is shown to select.
export const CopyAndOpenButton = ({ text, url }: { text: string; url: string }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const go = async (): Promise<void> => {
    const copying = copyTextToClipboard(text);
    window.open(url, '_blank', 'noopener,noreferrer');
    setState((await copying) ? 'copied' : 'failed');
  };
  return (
    <div className="space-y-2">
      <button className="px-3 py-1 text-xs rounded glass-btn-primary" onClick={() => { void go(); }}>
        Copy the report and open GitHub
      </button>
      {state === 'copied' && <p className="text-xs text-cp-teal">The report is copied. Paste it into the new issue.</p>}
      {state === 'failed' && (
        <>
          <p className="text-xs text-cp-coral">Your browser would not copy it. Select the text below and copy it yourself.</p>
          <textarea readOnly rows={6} value={text} className="glass-textarea w-full text-[11px]" onFocus={e => e.currentTarget.select()} />
        </>
      )}
    </div>
  );
};
