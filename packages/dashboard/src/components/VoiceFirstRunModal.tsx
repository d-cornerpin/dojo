/**
 * Shown the FIRST time the user toggles voice mode if the required models
 * (Kokoro TTS + the currently-selected Whisper STT model) aren't on disk.
 *
 *   - Lists what needs to download and the total size.
 *   - Refuses if free disk space is under 2 GB.
 *   - Kicks off the install via /api/voice/models/:kind/:id.
 *   - Progress bars driven by voice:model_download WS broadcasts.
 *   - "Run in background" hides the modal but lets the install keep going.
 *   - On all-complete, auto-dismisses and signals the parent to start voice.
 */

import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

interface VoiceFirstRunModalProps {
  /** Whisper STT model id the user has selected as Default. */
  whisperModelId: string;
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

export const VoiceFirstRunModal = ({ whisperModelId, onComplete, onCancel }: VoiceFirstRunModalProps) => {
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

  // Figure out what actually needs to download.
  const missing = useMemo(() => {
    if (!models) return null;
    const items: Array<{ kind: 'whisper' | 'kokoro'; id: string; label: string; approxBytes: number | null }> = [];
    if (!models.kokoro?.installed) {
      items.push({
        kind: 'kokoro',
        id: models.kokoro?.id ?? 'onnx-community/Kokoro-82M-v1.0-ONNX',
        label: 'Kokoro voice synthesis',
        // Actual on-disk size for the q8 quantized model_quantized.onnx we use
        // (≈96 MB). The Kokoro paper's "330 MB" number refers to the fp32
        // variant which is much larger.
        approxBytes: 96 * 1024 * 1024,
      });
    }
    const whisper = models.whisper.find((m) => m.id === whisperModelId);
    if (whisper && !whisper.installed) {
      items.push({
        kind: 'whisper',
        id: whisper.id,
        label: `Whisper speech recognition (${whisper.id})`,
        approxBytes: whisper.approxBytes ?? null,
      });
    }
    return items;
  }, [models, whisperModelId]);

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
    // Install Kokoro FIRST and serially. Running it in parallel with the
    // whisper download (~570 MB raw stream) contends for fetch sockets in a
    // way that crashes transformers.js's FS-cache layer with
    // "Unable to get model file path or buffer." (2026-05-19 — reproduces
    // every time in the dev server, never in a standalone process). Kokoro's
    // multi-file fetch via @huggingface/transformers seems sensitive to the
    // single-large-fetch saturation; serializing them dodges the issue.
    const kokoro = missing.find((m) => m.kind === 'kokoro');
    const whisper = missing.find((m) => m.kind === 'whisper');
    if (kokoro) {
      const res = await api.installVoiceModel(kokoro.kind, kokoro.id);
      if (!res.ok) { setError(res.error); return; }
    }
    if (whisper) {
      const res = await api.installVoiceModel(whisper.kind, whisper.id);
      if (!res.ok) setError(res.error);
    }
  };

  // Anchored to the BOTTOM of the chat-input wrapper so the modal sits
  // directly above the message box. Using fixed/viewport positioning was
  // unreliable — the chat tree has CSS transforms upstream (sidebar transitions,
  // glass blur layers) which contain `position: fixed`, so it ended up
  // rendering offscreen below the input.
  //
  // Mobile layout:
  //   - `inset-x-2 sm:inset-x-0` gives an 8px gutter on phones so the card
  //     never touches the screen edges (the desktop layout has the chat input's
  //     own padding handle this).
  //   - The inner card uses `max-h-[calc(100dvh-7rem)] overflow-y-auto` so a
  //     tall modal on a short viewport (phone with keyboard open, ~250px of
  //     space) scrolls internally instead of pushing the top above the
  //     viewport where the user can't see / scroll to it.
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

  // Nothing to install — defer to caller (shouldn't normally render at all in this case).
  if (missing.length === 0) {
    setTimeout(onComplete, 0);
    return null;
  }

  // Minimized pill — stays anchored above the chat input too, just compact.
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
            Voice mode runs entirely on this machine — no data leaves the box. We need to
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
