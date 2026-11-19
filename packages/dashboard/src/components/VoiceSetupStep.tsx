/**
 * OOBE step that walks new users through voice-mode setup:
 *   1. Microphone permission
 *   2. Download voice models (~1 GB total, in background)
 *   3. Pick a voice (preview each)
 *   4. Optional "say hello" test
 *
 * Entirely skippable. Settings → Voice can do all of this later.
 */
import { noteVoiceInstallFailure } from '../lib/voice-install-failures';
import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type Status = 'idle' | 'granted' | 'denied' | 'unsupported';

export const VoiceSetupStep = () => {
  const ws = useWebSocket();
  const [micStatus, setMicStatus] = useState<Status>('idle');
  const [voices, setVoices] = useState<api.VoicePreset[]>([]);
  const [voice, setVoice] = useState('am_michael');
  const [models, setModels] = useState<api.VoiceModelsResponse | null>(null);
  const [downloads, setDownloads] = useState<Record<string, { downloaded: number; total: number }>>({});
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load: voices + model state + any saved preferred voice
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getVoicePresets(),
      api.getVoiceModels(),
      api.getSetting('voice.preferred_voice'),
    ]).then(([presetsRes, modelsRes, vSetting]) => {
      if (cancelled) return;
      if (presetsRes.ok) {
        setVoices(presetsRes.data.voices);
        setVoice(vSetting.ok && vSetting.data.value ? vSetting.data.value : presetsRes.data.defaultVoice);
      } else {
        setError('Could not load the voice list.');
      }
      if (modelsRes.ok) setModels(modelsRes.data);
    });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to download progress
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_download', (event) => {
      if (event.type !== 'voice:model_download') return;
      const { kind, modelId, bytesDownloaded, bytesTotal } = event.data;
      setDownloads((prev) => ({ ...prev, [`${kind}/${modelId}`]: { downloaded: bytesDownloaded, total: bytesTotal } }));
      // Refresh model state at the end so installed flag flips
      if (bytesTotal > 0 && bytesDownloaded >= bytesTotal) {
        void api.getVoiceModels().then((r) => { if (r.ok) setModels(r.data); });
      }
    });
    return unsub;
  }, [ws]);

  // Surface a failed download/install: without this the bar stays stuck at
  // whatever fraction it stalled on. Clear that model's progress, show the error.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_install_error', (event) => {
      if (event.type !== 'voice:model_install_error') return;
      const { kind, modelId, error: reason } = event.data;
      noteVoiceInstallFailure(kind, modelId, reason);
      setError(`${kind} download failed: ${reason}`);
      setDownloadStarted(false);
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[`${kind}/${modelId}`];
        return next;
      });
    });
    return unsub;
  }, [ws]);

  const requestMic = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  };

  const startDownload = async () => {
    if (!models) return;
    setDownloadStarted(true);
    setError(null);
    try {
      const res = await api.installMissingVoiceModels(models.missing);
      if (!res.ok) {
        setError(res.error);
        setDownloadStarted(false); // let the person try again
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDownloadStarted(false);
    }
  };

  const previewVoice = async (id: string) => {
    setPreviewing(true);
    let url: string | null = null;
    try {
      const blob = await api.fetchVoicePreview(id);
      const made = URL.createObjectURL(blob);
      url = made;
      const audio = new Audio(made);
      audio.onended = () => URL.revokeObjectURL(made);
      await audio.play();
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const saveVoice = async (id: string) => {
    const prev = voice;
    setVoice(id);
    try {
      const result = await api.setSetting('voice.preferred_voice', id);
      if (!result.ok) {
        setVoice(prev);
        setError(`Could not save the voice: ${result.error}`);
      }
    } catch (err) {
      setVoice(prev);
      setError(`Could not save the voice: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const kokoroDone = models?.kokoro?.installed === true;
  const allModelsDone = models?.missing.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-ui mb-1">Talk to your agents (optional)</h3>
        <p className="text-sm text-ui/55">
          Set up voice mode so you can have spoken conversations with your primary agent.
          Everything runs locally, no audio leaves your machine. You can skip this and turn it on later
          from Settings → Voice.
        </p>
      </div>

      {/* Step 1: Mic permission */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-ui">1. Microphone access</h4>
          {micStatus === 'granted' && <span className="text-xs text-cp-teal">✓ Granted</span>}
          {micStatus === 'denied' && <span className="text-xs text-cp-coral">Denied</span>}
        </div>
        <p className="text-xs text-ui/40">The browser will ask once. You can revoke it any time from your browser's site settings.</p>
        {micStatus === 'idle' && (
          <button onClick={() => void requestMic()} className="glass-btn-primary px-3 py-1.5 text-xs rounded-lg">
            Allow microphone
          </button>
        )}
        {micStatus === 'denied' && (
          <p className="text-xs text-cp-coral">
            Mic access denied. Re-allow it in your browser's site permissions and reload.
          </p>
        )}
        {micStatus === 'unsupported' && (
          <p className="text-xs text-cp-coral">
            Your browser doesn't support `getUserMedia`. Voice mode won't work here.
          </p>
        )}
      </div>

      {/* Step 2: Download */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-ui">2. Voice models</h4>
          {allModelsDone && <span className="text-xs text-cp-teal">✓ Installed</span>}
        </div>
        <p className="text-xs text-ui/40">
          The voice and the speech recognition models run on your machine. They download once.
        </p>

        {models && (
          <div className="space-y-2">
            {models.missing.map((item) => {
              const dl = downloads[`${item.kind}/${item.id}`];
              const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
              return (
                <div key={`${item.kind}/${item.id}`} className="text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-ui">{item.label}</span>
                    <span className="text-ui/40">
                      {dl ? `${formatBytes(dl.downloaded)} / ${formatBytes(dl.total)}` : `about ${formatBytes(item.approxBytes)}`}
                    </span>
                  </div>
                  {dl && (
                    <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                      <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!allModelsDone && !downloadStarted && (
          <button onClick={() => void startDownload()} className="glass-btn-primary px-3 py-1.5 text-xs rounded-lg">
            Download voice models
          </button>
        )}
        {error && <p className="text-xs text-cp-coral">{error}</p>}
      </div>

      {/* Step 3: Pick voice */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-ui">3. Pick a voice</h4>
        </div>
        <p className="text-xs text-ui/40">You can change this later. Preview to hear how each one sounds.</p>
        <div className="flex items-center gap-2">
          <select
            value={voice}
            onChange={(e) => void saveVoice(e.target.value)}
            className="glass-select flex-1"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.gender === 'Female' ? 'F' : 'M'} · {v.language}
              </option>
            ))}
          </select>
          <button
            onClick={() => void previewVoice(voice)}
            disabled={previewing || !kokoroDone}
            className="glass-btn-primary px-3 py-2 text-xs rounded-lg disabled:opacity-40"
            title={!kokoroDone ? 'Download Kokoro first to enable preview' : 'Preview this voice'}
          >
            {previewing ? '…' : 'Preview'}
          </button>
        </div>
      </div>

      <p className="text-xs text-ui/40 italic">
        You can finish setup now, voice mode will appear as a mic button in the chat input once enabled.
        If you skip, the Voice settings tab still has everything you need.
      </p>
    </div>
  );
};
