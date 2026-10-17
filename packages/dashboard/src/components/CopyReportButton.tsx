import { useState } from 'react';
import { copyTextToClipboard } from '../lib/clipboard';

// The Copy report button (v3.4 E2). It copies the full report text the server just handed back,
// which is byte-identical to the issue body the poster would send, so the owner approves one
// text and pastes that same text. It decides nothing and sends nothing.
//
// If the browser refuses the clipboard, the text is shown in a box ready to select, so a refused
// copy never leaves the owner with nothing.
export const CopyReportButton = ({ text }: { text: string }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (): Promise<void> => {
    setState((await copyTextToClipboard(text)) ? 'copied' : 'failed');
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button className="px-3 py-1 text-xs rounded glass-btn-primary" onClick={() => { void copy(); }}>
          Copy report
        </button>
        {state === 'copied' && <span className="text-xs text-cp-teal">Copied</span>}
        {state === 'failed' && <span className="text-xs text-cp-coral">Your browser would not copy it. Select the text below and copy it yourself.</span>}
      </div>
      {state === 'failed' && (
        <textarea
          readOnly rows={6} value={text} className="glass-textarea w-full text-[11px]"
          onFocus={e => e.currentTarget.select()}
        />
      )}
    </div>
  );
};
