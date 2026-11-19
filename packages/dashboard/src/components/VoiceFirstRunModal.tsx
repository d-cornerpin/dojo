/**
 * Shown the FIRST time the user toggles voice mode if the models the saved
 * engines need (the server's `missing` list) aren't on disk.
 *
 *   - Lists what needs to download and the total size.
 *   - Refuses if free disk space is under 2 GB.
 *   - Kicks off the install via /api/voice/models/:kind/:id.
 *   - Progress bars driven by voice:model_download WS broadcasts.
 *   - "Run in background" hides the modal but lets the install keep going.
 *   - On all-complete, auto-dismisses and signals the parent to start voice.
 */

import { noteVoiceInstallFailure } from '../lib/voice-install-failures';
import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

interface VoiceFirstRunModalProps {
  /** Called when all required models are installed (or user dismisses). */
  onComplete: () => void;
  /** Called when the user cancels the setup without installing. */
  onCancel: () => void;
}

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const MIN_FREE_GB = 2;

export const VoiceFirstRunModal = ({ onComplete, onCancel }: VoiceFirstRunModalProps) => {
  const ws = useWebSocket();
  const [models, setModels] = useState<api.VoiceModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, { downloaded: number; total: number }>>({});
  const [minimized, setMinimized] = useState(false);

  // Load model status once on mount.
  useEffect(() => {
    let cancelled = false;
    void api.getVoiceModels().then((res) => {
      if (cancelled) return;
      if (res.ok) setModels(res.data);
      else setError(res.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to download progress broadcasts.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_download', (event) => {
      if (event.type !== 'voice:model_download') return;
      const { kind, modelId, bytesDownloaded, bytesTotal } = event.data;
      setDownloads((prev) => ({
        ...prev,
        [`${kind}/${modelId}`]: { downloaded: bytesDownloaded, total: bytesTotal },
      }));
    });
    return unsub;
  }, [ws]);

  // Surface a failed download/install: otherwise the bar and "Downloading"
  // state stay stuck (auto-close only fires on all-complete). Clear and report.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_install_error', (event) => {
      if (event.type !== 'voice:model_install_error') return;
      const { kind, modelId, error: reason } = event.data;
      noteVoiceInstallFailure(kind, modelId, reason);
      setError(`${kind} download failed: ${reason}`);
      setInstalling(false);
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[`${kind}/${modelId}`];
        return next;
      });
    });
    return unsub;
  }, [ws]);

  // What needs to download: the server's list for the saved engines, as read when the panel opened.
  const missing = models?.missing ?? null;

  // Auto-close once all required items finished downloading.
  useEffect(() => {
    if (!installing || !missing || missing.length === 0) return;
    const allDone = missing.every((m) => {
      const dl = downloads[`${m.kind}/${m.id}`];
      return dl && dl.total > 0 && dl.downloaded >= dl.total;
    });
    if (allDone) {
      // Small delay so the final 100% bar is visible.
      setTimeout(() => onComplete(), 800);
    }
  }, [installing, missing, downloads, onComplete]);

  const totalBytes = useMemo(
    () => (missing ?? []).reduce((s, m) => s + (m.approxBytes ?? 0), 0),
    [missing],
  );

  const freeGb = models && models.freeDiskMb >= 0 ? models.freeDiskMb / 1024 : null;
  const lowDisk = freeGb !== null && freeGb < MIN_FREE_GB;

  const handleInstall = async () => {
    if (!missing) return;
    setInstalling(true);
    setError(null);
    // Seed progress so the bars appear immediately.
    setDownloads((prev) => {
      const next = { ...prev };
      for (const m of missing) {
        next[`${m.kind}/${m.id}`] = { downloaded: 0, total: m.approxBytes ?? 1 };
      }
      return next;
    });
    const res = await api.installMissingVoiceModels(missing);
    if (!res.ok) { setError(res.error); setInstalling(false); }
  };

  // Anchored to the bottom of the chat-input wrapper: upstream CSS transforms
  // contain `position: fixed`, so viewport-fixed positioning renders offscreen.
  // `inset-x-2` keeps a phone gutter; the card scrolls internally so a tall
  // modal on a short viewport never pushes its top above the screen.
  const anchorClasses = 'absolute bottom-full inset-x-2 sm:inset-x-0 mb-3 z-30';
  const cardMaxH = 'max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain';

  if (loading || !models || !missing) {
    return (
      <div className={anchorClasses}>
        <div className={`glass-modal-bg rounded-2xl p-4 mx-auto max-w-md text-ui shadow-xl ${cardMaxH}`}>
          <div className="text-sm">Checking voice models…</div>
        </div>
      </div>
    );
  }

  // Nothing to install: defer to caller (shouldn't normally render at all).
  if (missing.length === 0) {
    setTimeout(onComplete, 0);
    return null;
  }

  // Minimized pill: still anchored above the chat input, just compact.
  if (minimized) {
    const totalDone = missing.reduce((s, m) => {
      const dl = downloads[`${m.kind}/${m.id}`];
      return s + (dl?.downloaded ?? 0);
    }, 0);
    const pct = totalBytes > 0 ? Math.min(100, (totalDone / totalBytes) * 100) : 0;
    return (
      <div className={anchorClasses}>
        <div className="glass-modal-bg rounded-full px-3 sm:px-4 py-2 mx-auto w-fit max-w-full shadow-lg flex items-center gap-2 sm:gap-3 text-ui">
          <div className="w-2.5 h-2.5 rounded-full bg-cp-teal animate-pulse shrink-0" />
          <span className="text-[11px] sm:text-xs truncate">Voice models downloading… {pct.toFixed(0)}%</span>
          <button onClick={() => setMinimized(false)} className="text-[11px] sm:text-xs text-cp-teal hover:underline shrink-0">show</button>
        </div>
      </div>
    );
  }

  return (
    <div className={anchorClasses}>
      <div className={`glass-modal-bg rounded-2xl p-4 sm:p-6 mx-auto max-w-md text-ui space-y-3 sm:space-y-4 shadow-xl ${cardMaxH}`}>
        <div>
          <h2 className="text-base sm:text-lg font-semibold">Set up voice mode</h2>
          <p className="text-[11px] sm:text-xs text-ui/55 mt-1 leading-relaxed">
            Voice mode runs entirely on this machine, no data leaves the box. We need to
            download the speech recognition + text-to-speech models the first time you use it.
          </p>
        </div>

        {/* What's about to download */}
        <div className="glass-nested rounded-lg p-3 space-y-2">
          {missing.map((m) => {
            const dl = downloads[`${m.kind}/${m.id}`];
            const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
            return (
              <div key={`${m.kind}/${m.id}`} className="space-y-1">
                {/* Stack label + size on phones (avoids overflow with long whisper ids); inline on sm+ */}
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline text-xs gap-0.5 sm:gap-2">
                  <span className="text-ui min-w-0 break-words">{m.label}</span>
                  <span className="text-ui/40 sm:ml-2 shrink-0 tabular-nums">
                    {dl ? `${formatBytes(dl.downloaded)} / ${formatBytes(dl.total)}` : (m.approxBytes ? `~${formatBytes(m.approxBytes)}` : 'unknown')}
                  </span>
                </div>
                {installing && (
                  <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex justify-between text-xs pt-2 border-t border-ui/[0.06]">
            <span className="text-ui/55">Total</span>
            <span className="text-ui tabular-nums">~{formatBytes(totalBytes)}</span>
          </div>
          {freeGb !== null && (
            <div className="flex justify-between text-xs">
              <span className="text-ui/55">Free disk</span>
              <span className={`${lowDisk ? 'text-cp-coral' : 'text-ui/55'} tabular-nums`}>{freeGb.toFixed(1)} GB</span>
            </div>
          )}
        </div>

        {lowDisk && (
          <div className="text-xs text-cp-coral">
            Not enough free disk. Voice models need at least {MIN_FREE_GB}&nbsp;GB of headroom.
          </div>
        )}

        {error && <div className="text-xs text-cp-coral break-words">{error}</div>}

        <div className="flex justify-between items-center gap-2 pt-2">
          {!installing ? (
            <>
              {/* Bigger tap targets on mobile (iOS guideline ≥44pt). */}
              <button
                onClick={onCancel}
                className="px-3 py-2.5 sm:py-1.5 text-xs text-ui/55 hover:text-ui min-h-[40px] sm:min-h-0"
              >
                Not now
              </button>
              <button
                onClick={() => void handleInstall()}
                disabled={lowDisk}
                className="px-4 py-2.5 sm:py-2 glass-btn-primary text-sm font-medium rounded-lg disabled:opacity-40 min-h-[40px] sm:min-h-0"
              >
                Download &amp; enable
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setMinimized(true)}
                className="px-3 py-2.5 sm:py-1.5 text-xs text-ui/55 hover:text-ui min-h-[40px] sm:min-h-0"
              >
                Run in background
              </button>
              <div className="px-4 py-2 text-xs text-ui/55">Downloading…</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
