import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { connectOfferSentence } from '../lib/report-edits';
import { connectLabel, problemText, CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK } from '../lib/github-card';

// Connect GitHub, offered on the report card itself (v3.4 E2, owner decision 16).
//
// A box with no GitHub connection can only hand a report over by paste. Connecting turns the same
// Post button into a filed issue with nothing to copy. This is the EXISTING device flow
// (`api.connectGithub`, the same one Settings uses): the owner types a short code at GitHub and
// the server polls until GitHub answers. Nothing here posts, decides or stores anything; when the
// connection lands the card refetches and its consent sentence changes by itself.
//
// The sentence about what the sign-in grants lives in `lib/report-edits.ts` so the server's
// suite can read it. It must not be copied into this file.
export const ReportConnectOffer = ({ github, onChanged }: {
  github: api.GithubStatus | null; onChanged: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  // The card hands a fresh function each render; the subscriptions read it through a ref so they
  // are made once and not torn down and rebuilt on every paint.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    const unsubs = [
      subscribe('github:device_code', () => { setProblem(null); changed.current(); }),
      subscribe('github:connected', () => { setProblem(null); changed.current(); }),
      subscribe('github:connect_failed', (msg: unknown) => {
        setProblem(problemText((msg as { error?: string }).error, CONNECT_FAILED_FALLBACK));
        changed.current();
      }),
      subscribe('github:disconnected', () => { changed.current(); }),
    ];
    return () => { unsubs.forEach(u => u()); };
  }, [subscribe]);

  // Nothing to offer on a connected box, or one with no GitHub app configured (the sign-in
  // could not start, and a button that always fails is worse than none).
  if (!github || github.connected || !github.clientIdConfigured) return null;

  const start = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const result = await api.connectGithub();
    setBusy(false);
    if (!result.ok) setProblem(problemText(result.error, CONNECT_REFUSED_FALLBACK));
    onChanged();
  };
  const cancel = async (): Promise<void> => {
    setBusy(true);
    await api.cancelGithubConnect();
    setBusy(false);
    onChanged();
  };

  return (
    <div className="space-y-2 rounded-lg border border-ui/10 p-2">
      {problem && <div className="text-xs text-cp-coral">{problem}</div>}
      {github.loginInProgress ? (
        <>
          <p className="text-xs text-ui/80">Open this page and type the code. This card updates on its own.</p>
          <div className="font-mono text-xl tracking-widest text-ui/90 select-all">{github.userCode}</div>
          <a
            href={github.verificationUri ?? undefined} target="_blank" rel="noopener noreferrer"
            className="text-xs text-cp-teal underline break-all"
          >{github.verificationUri}</a>
          <div>
            <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={() => { void cancel(); }} disabled={busy}>
              Cancel sign-in
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-ui/70">{connectOfferSentence()}</p>
          <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={() => { void start(); }} disabled={busy}>
            {connectLabel(github)}
          </button>
        </>
      )}
    </div>
  );
};
