import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { formatDateShort } from '../lib/dates';
import { githubCardState, connectLabel, describeScope, connectedAs } from '../lib/github-card';

// ── Settings → Integrations → GitHub (DOJO-REPORT T5) ──
// Connecting GitHub turns a problem report from a file you paste by hand into an issue your
// agent opens AS YOU. Device flow, so there is no redirect and no callback: the user types a
// short code at github.com/login/device and the server polls until GitHub answers — which is
// why this card works through a tunnel while the Google/Microsoft ones on the tab above do not.
//
// ── THE DOCTRINE THIS CARD SERVES (`memory/integration-status-lane.ts`, the ".24" rule) ──
// *"The agent must never have to trust a notebook entry saying a connection is broken. The
// PLATFORM'S LIVE TRUTH sits in front of it every turn and OUTRANKS memory."* And the
// discipline that keeps that honest: ledger-backed, NEVER AN INVENTED FRESHNESS. So this card
// never probes GitHub to look fresher than it is. Every fact on it is one the engine stored or
// measured: whether a sealed token is here and opens, who it connected as, what GitHub actually
// granted, and the LAST LIVE OUTCOME of a real call (`lastOkAt` / `lastError`, written by the
// poster and by nothing else). `GET /api/github/status` makes no outbound request, and a test
// holds that as behaviour rather than as this paragraph.
//
// ── WHY THE DECISIONS ARE NOT IN THIS FILE ──
// `packages/dashboard` has no test runner. Every rule where being wrong is a LIE ABOUT A
// CONNECTION — which of the four states to draw, how to describe the permission GitHub actually
// granted, how to render a grant with no name — lives in `lib/github-card.ts` and is driven
// from the server's suite against the real doors. What is left here is JSX, the four
// subscriptions, and the text of the last failed sign-in, which is on the wire and in no ledger.
//
// The title string `GitHub` is load-bearing: `open_settings` deep-links by `?section=<text>`
// matched against `.scard__title`, so an agent can say "open Settings → Integrations → GitHub".

export const GitHubSettings = () => {
  const [status, setStatus] = useState<api.GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The last sign-in that did not finish, from the `github:connect_failed` frame or from a
  // refused POST /connect. This is the one thing on the card with no ledger behind it — it is
  // an event, not a state — so it is cleared the moment a new attempt starts.
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const { subscribe } = useWebSocket();
  const loadedRef = useRef(false);

  // REFETCH ON EVENT, never a partial merge: a frame says "something changed", and the answer
  // to what is now true comes from the door that owns it.
  const loadStatus = async () => {
    const result = await api.getGithubStatus();
    if (result.ok) setStatus(result.data);
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
        setProblem(m.error ?? 'The GitHub sign-in stopped without connecting.');
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
    // An unconfigured or unreachable box answers 400 with a SENTENCE. Render it — a spinner
    // that never resolves is the shape this replaces.
    if (!result.ok) setProblem(result.error ?? 'GitHub would not start a sign-in.');
    loadStatus();
  };

  const handleCancel = async () => {
    setBusy(true);
    await api.cancelGithubConnect();
    setBusy(false);
    setProblem(null);
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
        <p className="text-xs text-ui/40 mt-2">Loading…</p>
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
          <p className="text-xs text-ui/40">
            It asks for one permission: creating issues on public repositories. It can&apos;t
            read your private repos.
          </p>
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
