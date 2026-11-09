import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { formatDateShort } from '../lib/dates';
import { githubCardState, connectLabel, describeScope, connectedAs, scopeRequestSentence,
  problemText, CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK } from '../lib/github-card';

// Settings -> Integrations -> GitHub: a problem report stops being a file you paste by hand
// and becomes an issue your agent opens AS YOU. Device flow (no redirect, no callback: the
// user types a short code at github.com/login/device and the server polls), which is why
// this card works through a tunnel while the Google/Microsoft ones above it do not.
// Doctrine (`memory/integration-status-lane.ts`): NEVER AN INVENTED FRESHNESS. This card never
// probes GitHub to look fresher than it is; every fact is one the engine stored or measured,
// and `GET /api/github/status` makes no outbound request (a test holds that). The rules where
// being wrong would be a LIE ABOUT A CONNECTION live in `lib/github-card.ts`, driven from the
// server's suite; what is left here is JSX and the text of the last failed sign-in, which is
// on the wire and in no ledger. The title string `GitHub` is load-bearing: `open_settings`
// deep-links by `?section=<text>` matched against `.scard__title`.

export const GitHubSettings = () => {
  const [status, setStatus] = useState<api.GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The last sign-in that did not finish, from the `github:connect_failed` frame or a
  // refused POST /connect. It is an event, not a state, with no ledger behind it, so it
  // is cleared the moment a new attempt starts.
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const loadedRef = useRef(false);

  // REFETCH ON EVENT, never a partial merge: a frame says "something changed", and the answer
  // to what is now true comes from the door that owns it.
  // Only the newest answer is applied: a slow older one must not put an old screen back.
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const loadStatus = async () => {
    const seq = ++loadSeq.current;
    const result = await api.getGithubStatus();
    if (seq !== loadSeq.current) return;
    if (result.ok) { setLoadError(null); setStatus(result.data); } else setLoadError(result.error);
  };

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadStatus();
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe('github:device_code', () => { setProblem(null); loadStatus(); }),
      subscribe('github:connected', (msg: unknown) => {
        const m = msg as { login?: string | null };
        setProblem(null);
        toast.info(`GitHub connected${m.login ? ` as ${m.login}` : ''}.`);
        loadStatus();
      }),
      subscribe('github:connect_failed', (msg: unknown) => {
        const m = msg as { error?: string };
        setProblem(problemText(m.error, CONNECT_FAILED_FALLBACK));
        loadStatus();
      }),
      subscribe('github:disconnected', () => { setProblem(null); loadStatus(); }),
    ];
    return () => { unsubs.forEach(u => u()); };
  }, [subscribe, toast]);

  const handleConnect = async () => {
    setBusy(true);
    setProblem(null);
    const result = await api.connectGithub();
    setBusy(false);
    // An unconfigured or unreachable box answers 400 with a SENTENCE; render it, do not
    // sit on a spinner that never resolves.
    if (!result.ok) setProblem(problemText(result.error, CONNECT_REFUSED_FALLBACK));
    loadStatus();
  };

  const handleCancel = async () => {
    setBusy(true);
    const result = await api.cancelGithubConnect();
    setBusy(false);
    setProblem(result.ok ? null : problemText(result.error, CONNECT_REFUSED_FALLBACK));
    loadStatus();
  };

  const handleDisconnect = async () => {
    setBusy(true);
    const result = await api.disconnectGithub();
    setBusy(false);
    if (!result.ok) {
      toast.error(`Disconnect failed: ${result.error}`);
      return;
    }
    toast.info('GitHub disconnected.');
    loadStatus();
  };

  // The title renders even while loading, so the agent's deep-link can find the card.
  if (!status) {
    return (
      <div className="tile">
        <h3 className="scard__title">GitHub</h3>
        {loadError ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-ui/55">Could not load GitHub status: {loadError}</p>
            <button className="btn btn--sm" onClick={loadStatus}>Retry</button>
          </div>
        ) : <p className="text-xs text-ui/40 mt-2">Loading…</p>}
      </div>
    );
  }

  const state = githubCardState(status);

  return (
    <div className="tile space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="scard__title">GitHub</h3>
        {state === 'connected' && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-cp-teal/20 text-cp-teal">
            {connectedAs(status.login)}
          </span>
        )}
      </div>

      {problem && <div className="note--warn">{problem}</div>}

      {state === 'unconfigured' && (
        <p className="text-xs text-ui/55">
          GitHub isn&apos;t set up on this box yet. Problem reports will be saved as a file you
          can paste into an issue yourself.
        </p>
      )}

      {state === 'disconnected' && (
        <>
          {status.reauthRequired && (
            <div className="note--warn">
              Your GitHub connection stopped working{status.login ? ` (${status.login})` : ''}.
              Reports will be saved as a file until you reconnect. Nothing else is affected.
            </div>
          )}
          <p className="text-xs text-ui/55">
            Your agent can file problem reports as issues on the Dojo&apos;s public issue
            tracker, posted as you.
          </p>
          {/* Derived from GITHUB_EXPECTED_SCOPE, never retyped here: a hardcoded copy would
              be a claim about the user's private code that no component test could judge. */}
          <p className="text-xs text-ui/40">{scopeRequestSentence()}</p>
          <button className="btn btn--primary btn--sm" onClick={handleConnect} disabled={busy}>
            {connectLabel(status)}
          </button>
        </>
      )}

      {state === 'connecting' && (
        <>
          <p className="text-xs text-ui/55">
            Open that page and type this code. This window will update on its own.
          </p>
          <div className="font-mono text-2xl tracking-widest text-ui/90 select-all">
            {status.userCode}
          </div>
          <a
            href={status.verificationUri ?? undefined} target="_blank" rel="noopener noreferrer"
            className="text-xs text-cp-teal hover:text-cp-teal/80 underline break-all"
          >{status.verificationUri}</a>
          <div>
            <button className="btn btn--sm" onClick={handleCancel} disabled={busy}>Cancel</button>
          </div>
        </>
      )}

      {state === 'connected' && (
        <>
          {/* Described from what GitHub GRANTED, never from what we asked for. */}
          <p className="text-xs text-ui/40">{describeScope(status.scope)}</p>
          {status.lastOkAt && (
            <p className="text-xs text-ui/40">
              Last successful post {formatDateShort(status.lastOkAt)}
            </p>
          )}
          {status.lastError && <div className="note--warn">{status.lastError}</div>}
          <div>
            <button className="btn btn--sm btn--danger" onClick={handleDisconnect} disabled={busy}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
};
