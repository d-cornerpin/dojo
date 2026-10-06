// ── Settings → The Voice tab. Its VAD options, STT labels and `formatBytes` travel with it — every call
// site is in this tab.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect, useRef } from 'react';
import * as api from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';
import { invalidateSavedVoiceSettings } from '../../hooks/useVoiceMode';


// ── Voice Tab ──

const VAD_OPTIONS: Array<{ id: 'quick' | 'normal' | 'patient'; label: string; hint: string }> = [
  { id: 'quick',   label: 'Quick',   hint: 'Jumps in fast — best for quick back-and-forth' },
  { id: 'normal',  label: 'Normal',  hint: 'Balanced — waits a beat for you to finish a thought' },
  { id: 'patient', label: 'Patient', hint: 'Waits longest — best for slow, thoughtful speech' },
];

const STT_LABELS: Record<string, string> = {
  'moonshine-base':  'Moonshine base · English only · fastest, no native deps (default)',
  'base.en':         'Whisper Base · English only · fast, lower quality',
  'small.en':        'Whisper Small · English only',
  'medium.en':       'Whisper Medium · English only',
  'large-v3-turbo':  'Whisper Large v3 Turbo · multilingual',
};

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const VoiceTab = () => {
  const ws = useWebSocket();
  const [voices, setVoices] = useState<api.VoicePreset[]>([]);
  const [defaultVoice, setDefaultVoice] = useState('am_michael');
  const [models, setModels] = useState<api.VoiceModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Settings (loaded from config table)
  const [voice, setVoice] = useState('am_michael');
  const [speed, setSpeed] = useState(1.0);
  const [vad, setVad] = useState<'quick' | 'normal' | 'patient'>('quick');
  const [sttModel, setSttModel] = useState('moonshine-base');
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakePhrase, setWakePhrase] = useState('');
  const [sleepPhrase, setSleepPhrase] = useState('stop listening');
  const [bargeInEnabled, setBargeInEnabled] = useState(false);
  const [soundEffectsEnabled, setSoundEffectsEnabled] = useState(true);
  // Primary agent name drives both the "Voice for X" header and the default
  // wake phrase ("hey <name>") so neither hardcodes a specific name.
  const [primaryAgentName, setPrimaryAgentName] = useState('Agent');
  const defaultWakePhrase = `hey ${primaryAgentName.toLowerCase()}`;

  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // key = `${kind}/${id}` → fraction 0..1 (null means no active download)
  const [downloads, setDownloads] = useState<Record<string, { downloaded: number; total: number }>>({});
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const refreshModels = async () => {
    const m = await api.getVoiceModels();
    if (m.ok) setModels(m.data);
  };

  const refreshVoices = async () => {
    const v = await api.getVoicePresets();
    if (v.ok) setVoices(v.data.voices);
  };

  // Custom voice import form state. Kept inside the component so the form
  // doesn't outlive a tab unmount.
  const [importName, setImportName] = useState('');
  const [importId, setImportId] = useState('');
  const [importLang, setImportLang] = useState<'en-us' | 'en-gb'>('en-us');
  const [importGender, setImportGender] = useState<'Male' | 'Female'>('Male');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ── Hume cloud TTS (Local | Cloud sub-tabs in the Voice card) ──
  // Sub-tab selection persisted as voice.tts_engine. Cloud tab is only
  // usable once a valid Hume key is on file.
  const [ttsTab, setTtsTab] = useState<'local' | 'cloud'>('local');
  const [humeKeySet, setHumeKeySet] = useState(false);
  const [humeKeyInput, setHumeKeyInput] = useState('');
  const [humeKeyBusy, setHumeKeyBusy] = useState(false);
  const [humeKeyMsg, setHumeKeyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [humeVoices, setHumeVoices] = useState<api.HumeVoiceInfo[]>([]);
  const [humeVoicesLoading, setHumeVoicesLoading] = useState(false);
  const [humeVoicesError, setHumeVoicesError] = useState<string | null>(null);
  const [cloudVoice, setCloudVoice] = useState('');
  const [cloudVoiceProvider, setCloudVoiceProvider] = useState<'HUME_AI' | 'CUSTOM_VOICE'>('HUME_AI');
  const [cloudDescription, setCloudDescription] = useState('');
  const [cloudSpeed, setCloudSpeed] = useState(1.0);

  const refreshHumeStatus = async () => {
    const r = await api.getHumeStatus();
    if (r.ok) setHumeKeySet(r.data.keySet);
  };

  const refreshHumeVoices = async () => {
    setHumeVoicesLoading(true);
    setHumeVoicesError(null);
    try {
      const r = await api.listHumeVoices();
      if (!r.ok) {
        setHumeVoicesError(r.error);
        setHumeVoices([]);
        return;
      }
      setHumeVoices(r.data.voices);
    } finally {
      setHumeVoicesLoading(false);
    }
  };

  const handleSetHumeKey = async () => {
    const k = humeKeyInput.trim();
    if (!k) {
      setHumeKeyMsg({ kind: 'err', text: 'Paste a Hume API key first.' });
      return;
    }
    setHumeKeyBusy(true);
    setHumeKeyMsg(null);
    try {
      const r = await api.setHumeKey(k);
      if (!r.ok) {
        setHumeKeyMsg({ kind: 'err', text: r.error });
        return;
      }
      setHumeKeySet(true);
      setHumeKeyInput('');
      setHumeKeyMsg({ kind: 'ok', text: 'Loading voices…' });
      await refreshHumeVoices();
      // Clear the flash message — the static "Key set." label takes
      // over the "key is configured" indication, so a duplicate flash
      // just clutters the row.
      setHumeKeyMsg(null);
    } finally {
      setHumeKeyBusy(false);
    }
  };

  const handleClearHumeKey = async () => {
    if (!confirm('Clear the stored Hume API key? Cloud TTS will stop until you re-add one.')) return;
    const r = await api.clearHumeKey();
    if (!r.ok) {
      setHumeKeyMsg({ kind: 'err', text: r.error });
      return;
    }
    setHumeKeySet(false);
    setHumeVoices([]);
    setHumeKeyMsg({ kind: 'ok', text: 'Key cleared.' });
    // If we were on the Cloud tab, snap back to Local — the engine
    // dropped out from under us.
    if (ttsTab === 'cloud') {
      setTtsTab('local');
      void saveSetting('voice.tts_engine', 'local', 'engine');
    }
  };

  const handleCloudPreview = async () => {
    if (!cloudVoice) {
      setPreviewError('Pick a Hume voice first.');
      return;
    }
    setPreviewError(null);
    setPreviewing(true);
    try {
      const blob = await api.fetchCloudVoicePreview({
        voice: cloudVoice,
        voiceProvider: cloudVoiceProvider,
        description: cloudDescription.trim() || undefined,
        speed: cloudSpeed,
      });
      if (previewAudioRef.current) {
        try { previewAudioRef.current.pause(); } catch { /* ignore */ }
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleSwitchTtsTab = async (next: 'local' | 'cloud') => {
    if (next === ttsTab) return;
    if (next === 'cloud' && !humeKeySet) {
      // Don't persist cloud as the engine when there's no key yet.
      // Show the Cloud tab anyway so the user can enter a key.
      setTtsTab('cloud');
      return;
    }
    setTtsTab(next);
    await saveSetting('voice.tts_engine', next, 'engine');
  };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const [
        presets, modelsRes, vSetting, sSetting, vadSetting, sttSetting,
        wakeEnabled, wakeP, sleepP, primaryName, bargeIn, sfx,
        ttsEngineSetting, cloudVoiceSetting, cloudVoiceProviderSetting,
        cloudDescriptionSetting, cloudSpeedSetting, humeStatus,
      ] = await Promise.all([
        api.getVoicePresets(),
        api.getVoiceModels(),
        api.getSetting('voice.preferred_voice'),
        api.getSetting('voice.playback_speed'),
        api.getSetting('voice.vad_sensitivity'),
        api.getSetting('voice.stt_model'),
        api.getSetting('voice.wake_word_enabled'),
        api.getSetting('voice.wake_phrase'),
        api.getSetting('voice.sleep_phrase'),
        api.getSetting('primary_agent_name'),
        api.getSetting('voice.barge_in_enabled'),
        api.getSetting('voice.sound_effects_enabled'),
        api.getSetting('voice.tts_engine'),
        api.getSetting('voice.cloud_voice'),
        api.getSetting('voice.cloud_voice_provider'),
        api.getSetting('voice.cloud_voice_description'),
        api.getSetting('voice.cloud_speed'),
        api.getHumeStatus(),
      ]);
      if (!mounted) return;
      if (presets.ok) {
        setVoices(presets.data.voices);
        setDefaultVoice(presets.data.defaultVoice);
        if (!vSetting.ok || !vSetting.data.value) setVoice(presets.data.defaultVoice);
      }
      if (modelsRes.ok) {
        setModels(modelsRes.data);
        // Prefer the server-reported defaultSttModel ('moonshine-base'). Fall
        // back to defaultWhisper for older builds that don't expose the new
        // key, so this code keeps working against an in-place upgrade.
        if (!sttSetting.ok || !sttSetting.data.value) {
          const fallback = (modelsRes.data as { defaultSttModel?: string }).defaultSttModel
            ?? modelsRes.data.defaultWhisper;
          setSttModel(fallback);
        }
      }
      if (vSetting.ok && vSetting.data.value) setVoice(vSetting.data.value);
      if (sSetting.ok && sSetting.data.value) {
        const n = Number(sSetting.data.value);
        if (Number.isFinite(n)) setSpeed(n);
      }
      if (vadSetting.ok && vadSetting.data.value === 'quick') setVad('quick');
      if (vadSetting.ok && vadSetting.data.value === 'normal') setVad('normal');
      if (vadSetting.ok && vadSetting.data.value === 'patient') setVad('patient');
      if (sttSetting.ok && sttSetting.data.value) setSttModel(sttSetting.data.value);
      if (wakeEnabled.ok && wakeEnabled.data.value === 'true') setWakeWordEnabled(true);
      if (wakeP.ok && wakeP.data.value) setWakePhrase(wakeP.data.value);
      if (sleepP.ok && sleepP.data.value) setSleepPhrase(sleepP.data.value);
      if (primaryName.ok && primaryName.data.value && primaryName.data.value.trim()) {
        setPrimaryAgentName(primaryName.data.value.trim());
      }
      if (bargeIn.ok && bargeIn.data.value === 'true') setBargeInEnabled(true);
      // sound effects default ON — only flip off when explicitly stored as 'false'
      if (sfx.ok && sfx.data.value === 'false') setSoundEffectsEnabled(false);
      // Hume cloud TTS state
      if (humeStatus.ok) setHumeKeySet(humeStatus.data.keySet);
      if (ttsEngineSetting.ok && ttsEngineSetting.data.value === 'cloud' && humeStatus.ok && humeStatus.data.keySet) {
        setTtsTab('cloud');
      }
      if (cloudVoiceSetting.ok && cloudVoiceSetting.data.value) setCloudVoice(cloudVoiceSetting.data.value);
      if (cloudVoiceProviderSetting.ok && cloudVoiceProviderSetting.data.value === 'CUSTOM_VOICE') {
        setCloudVoiceProvider('CUSTOM_VOICE');
      }
      if (cloudDescriptionSetting.ok && cloudDescriptionSetting.data.value) {
        setCloudDescription(cloudDescriptionSetting.data.value);
      }
      if (cloudSpeedSetting.ok && cloudSpeedSetting.data.value) {
        const n = Number(cloudSpeedSetting.data.value);
        if (Number.isFinite(n) && n >= 0.5 && n <= 2) setCloudSpeed(n);
      }
      // Pull Hume voices if the key is set; non-blocking.
      if (humeStatus.ok && humeStatus.data.keySet) {
        void refreshHumeVoices();
      }
      setLoading(false);
    };
    void load();
    return () => { mounted = false; };
  }, []);

  // Subscribe to download progress broadcasts. Multiple downloads can be
  // in flight (e.g. user picks a new STT model AND clicks Download on a
  // different one) — we key by `kind/id` so each row renders independently.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_download', (event) => {
      if (event.type !== 'voice:model_download') return;
      const { kind, modelId, bytesDownloaded, bytesTotal } = event.data;
      const key = `${kind}/${modelId}`;
      setDownloads((prev) => ({ ...prev, [key]: { downloaded: bytesDownloaded, total: bytesTotal } }));
      // Once complete, drop from active downloads after a short delay so the
      // "Saved!"-style fade happens, and refresh the on-disk list.
      if (bytesTotal > 0 && bytesDownloaded >= bytesTotal) {
        void refreshModels();
        setTimeout(() => {
          setDownloads((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }, 1500);
      }
    });
    return unsub;
  }, [ws]);

  // FA-DB3: a failed download/install broadcasts voice:model_install_error.
  // Without handling it the progress row stalls at its last fraction forever.
  // Surface the error, clear the stuck progress row, and drop the installing
  // state for that model so the Download button comes back.
  useEffect(() => {
    const unsub = ws.subscribe('voice:model_install_error', (event) => {
      if (event.type !== 'voice:model_install_error') return;
      const { kind, modelId, error: reason } = event.data;
      const key = `${kind}/${modelId}`;
      setInstallError(`${kind} download failed: ${reason}`);
      setInstalling((cur) => (cur === key ? null : cur));
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    });
    return unsub;
  }, [ws]);

  const flashSaved = (key: string) => {
    setSavedKey(key);
    setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1500);
  };

  const saveSetting = async (key: string, value: string, uiKey: string) => {
    const res = await api.setSetting(key, value);
    if (res.ok) flashSaved(uiKey);
  };

  const handlePreview = async (previewVoice: string) => {
    setPreviewError(null);
    setPreviewing(true);
    try {
      const blob = await api.fetchVoicePreview(previewVoice, speed);
      if (previewAudioRef.current) {
        try { previewAudioRef.current.pause(); } catch { /* ignore */ }
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const handleInstall = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string) => {
    setInstallError(null);
    setInstalling(`${kind}/${id}`);
    const res = await api.installVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
    setInstalling(null);
  };

  const handleDelete = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string) => {
    if (!confirm(`Delete ${kind}/${id}? You can re-download it from this page.`)) return;
    const res = await api.deleteVoiceModel(kind, id);
    if (!res.ok) setInstallError(res.error);
    await refreshModels();
  };

  // Build a candidate voice id from a display name. Kokoro convention:
  // first char = language (a=US, b=GB), second char = gender (f/m), then
  // underscore + slug. Returns '' if name is empty.
  const buildVoiceId = (name: string, lang: 'en-us' | 'en-gb', gender: 'Male' | 'Female'): string => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
    if (!slug) return '';
    const langChar = lang === 'en-gb' ? 'b' : 'a';
    const genderChar = gender === 'Female' ? 'f' : 'm';
    return `${langChar}${genderChar}_${slug}`;
  };

  const handleImportVoice = async () => {
    if (!importFile) {
      setImportMsg({ kind: 'err', text: 'Pick a voicepack .bin first.' });
      return;
    }
    const name = importName.trim();
    if (!name) {
      setImportMsg({ kind: 'err', text: 'Display name is required.' });
      return;
    }
    const id = (importId.trim() || buildVoiceId(name, importLang, importGender)).toLowerCase();
    setImportBusy(true);
    setImportMsg(null);
    try {
      const res = await api.importCustomVoice({
        id,
        name,
        language: importLang,
        gender: importGender,
        file: importFile,
      });
      if (!res.ok) {
        setImportMsg({ kind: 'err', text: res.error });
        return;
      }
      setImportMsg({ kind: 'ok', text: `Imported ${res.data.name}. Try it with Preview.` });
      setImportFile(null);
      setImportName('');
      setImportId('');
      await refreshVoices();
      // Auto-select the new voice and save so the user can hit Preview straight away.
      setVoice(res.data.id);
      void saveSetting('voice.preferred_voice', res.data.id, 'voice');
    } catch (err) {
      setImportMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setImportBusy(false);
    }
  };

  const handleDeleteCustomVoice = async (id: string, name: string) => {
    if (!confirm(`Delete custom voice "${name}"? You'll need the original .bin file to re-import it.`)) return;
    const res = await api.deleteCustomVoice(id);
    if (!res.ok) {
      setImportMsg({ kind: 'err', text: res.error });
      return;
    }
    await refreshVoices();
    // If the user was using the deleted voice, fall back to the default.
    if (voice === id) {
      setVoice(defaultVoice);
      void saveSetting('voice.preferred_voice', defaultVoice, 'voice');
    }
    setImportMsg({ kind: 'ok', text: `Deleted ${name}.` });
  };

  if (loading) return <div className="loading-state">Loading voice settings...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* TTS engine sub-tabs (Local Kokoro | Cloud Hume). The Cloud tab is
          selectable even without a key — picking it shows the key entry
          form. The engine setting (voice.tts_engine) only persists as
          'cloud' once a key is on file. */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ui/55">Text-to-speech:</span>
        {(['local', 'cloud'] as const).map((opt) => (
          <button
            key={opt}
            onClick={() => void handleSwitchTtsTab(opt)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              ttsTab === opt ? 'glass-btn-primary' : 'glass-btn'
            }`}
          >
            {opt === 'local' ? 'Local (Kokoro)' : 'Cloud (Hume)'}
          </button>
        ))}
        {savedKey === 'engine' && <span className="text-xs text-cp-teal">Saved!</span>}
        {ttsTab === 'cloud' && !humeKeySet && (
          <span className="text-xs text-cp-amber">key required</span>
        )}
      </div>

      {/* Two-column grid for the short config cards. STT and TTS model cards
          stay full-width below because they hold per-model rows + progress bars. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {ttsTab === 'local' && (<>
      {/* Voice picker */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Voice for {primaryAgentName}</h3>
        <p className="text-xs text-ui/40">
          The voice your primary agent uses when reading replies back to you in voice mode.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={voice}
            onChange={(e) => { setVoice(e.target.value); void saveSetting('voice.preferred_voice', e.target.value, 'voice'); }}
            className="glass-select flex-1"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.gender === 'Female' ? 'F' : 'M'} · {v.language}{v.id === defaultVoice ? ' (default)' : ''}{v.custom ? ' · custom' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={() => void handlePreview(voice)}
            disabled={previewing}
            className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {previewing ? 'Synthesizing…' : 'Preview'}
          </button>
          {savedKey === 'voice' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        {previewError && <p className="text-xs text-cp-coral">{previewError}</p>}
      </div>

      {/* Playback speed */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Playback speed</h3>
        <p className="text-xs text-ui/40">How fast {primaryAgentName}'s voice plays back. 1.0 is the natural Kokoro rate.</p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0.8} max={1.4} step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            onMouseUp={() => void saveSetting('voice.playback_speed', String(speed), 'speed')}
            onTouchEnd={() => void saveSetting('voice.playback_speed', String(speed), 'speed')}
            className="flex-1 accent-cp-teal"
          />
          <span className="text-sm font-mono text-ui w-12 text-right">{speed.toFixed(2)}x</span>
          {savedKey === 'speed' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* Custom voice imports — full-width inside the grid so the form has room
          to breathe. Visible even when no customs exist (the form is the main
          surface). It sits last in the Kokoro section. */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Custom voice imports</h3>
        <p className="text-xs text-ui/40">
          Import a Kokoro voicepack (a 522,240-byte <code className="px-1 rounded bg-ui/[0.06]">.bin</code> file
          produced by fine-tuning or shared from elsewhere). Imported voices show up in the picker
          above with a "custom" tag.
        </p>
        {voices.filter((v) => v.custom).length > 0 && (
          <div className="space-y-2 border-b border-ui/10 pb-3">
            {voices.filter((v) => v.custom).map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-ui">{v.name} <span className="text-ui/40">· {v.id}</span></span>
                <button
                  onClick={() => void handlePreview(v.id)}
                  disabled={previewing}
                  className="px-2 py-1 glass-btn text-xs rounded-lg disabled:opacity-50"
                >
                  Preview
                </button>
                <button
                  onClick={() => void handleDeleteCustomVoice(v.id, v.name)}
                  className="px-2 py-1 glass-btn-destructive text-xs rounded-lg"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Display name</span>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="My voice"
              className="glass-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Voice id <span className="text-ui/40">(optional — auto-derived from name)</span></span>
            <input
              type="text"
              value={importId}
              onChange={(e) => setImportId(e.target.value)}
              placeholder={importName ? buildVoiceId(importName, importLang, importGender) : 'am_myvoice'}
              className="glass-input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Language</span>
            <select
              value={importLang}
              onChange={(e) => setImportLang(e.target.value as 'en-us' | 'en-gb')}
              className="glass-select"
            >
              <option value="en-us">English (US)</option>
              <option value="en-gb">English (UK)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ui/60">
            <span>Gender</span>
            <select
              value={importGender}
              onChange={(e) => setImportGender(e.target.value as 'Male' | 'Female')}
              className="glass-select"
            >
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </label>
          <div className="md:col-span-2 flex flex-col gap-1 text-xs text-ui/60">
            <span>Voicepack file (.bin)</span>
            <div className="flex items-center gap-2">
              {/* Hide the native file input — the rest of the dashboard does
                  the same (Techniques.tsx, ImportWizard.tsx) and triggers
                  it via a styled button so themes stay consistent. */}
              <label className="px-3 py-2 glass-btn text-xs rounded-lg cursor-pointer">
                Choose file
                <input
                  type="file"
                  accept=".bin,application/octet-stream"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
              <span className="text-xs text-ui/55 truncate">
                {importFile ? importFile.name : 'no file selected'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => void handleImportVoice()}
            disabled={importBusy || !importFile || !importName.trim()}
            className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
          >
            {importBusy ? 'Importing…' : 'Import voice'}
          </button>
          {importMsg && (
            <span className={`text-xs ${importMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
              {importMsg.text}
            </span>
          )}
        </div>
      </div>

      </>)}

      {ttsTab === 'cloud' && (<>
      {/* Hume API key */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Hume API key</h3>
        <p className="text-xs text-ui/40">
          Cloud TTS uses Hume Octave. Grab a key from your Hume dashboard and paste it here.
          The key is stored on this machine only and is never sent to the browser after it's saved.
        </p>
        <p className="text-[11px] text-ui/40">
          <a
            href="https://platform.hume.ai/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cp-teal hover:text-cp-teal/80 underline"
          >
            Get a Hume API key ↗
          </a>{' '}
          · No account?{' '}
          <a
            href="https://platform.hume.ai/sign-up"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cp-teal hover:text-cp-teal/80 underline"
          >
            Sign up ↗
          </a>
        </p>
        {humeKeySet ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-cp-teal">Key set.</span>
            <button
              onClick={() => void handleClearHumeKey()}
              className="px-3 py-1.5 glass-btn-destructive text-xs rounded-lg"
            >
              Clear key
            </button>
            {humeKeyMsg && (
              <span className={`text-xs ${humeKeyMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
                {humeKeyMsg.text}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={humeKeyInput}
              onChange={(e) => setHumeKeyInput(e.target.value)}
              placeholder="Paste Hume API key"
              className="glass-input flex-1 font-mono text-sm"
            />
            <button
              onClick={() => void handleSetHumeKey()}
              disabled={humeKeyBusy || !humeKeyInput.trim()}
              className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
            >
              {humeKeyBusy ? 'Validating…' : 'Save key'}
            </button>
            {humeKeyMsg && (
              <span className={`text-xs ${humeKeyMsg.kind === 'ok' ? 'text-cp-teal' : 'text-cp-coral'}`}>
                {humeKeyMsg.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Hume voice picker */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Voice for {primaryAgentName}</h3>
        <p className="text-xs text-ui/40">
          Pulled live from Hume's Voice Library (HUME_AI provider) plus any custom voices saved
          to your account. The voice carries between turns within a session.
        </p>
        {!humeKeySet ? (
          <p className="text-xs text-ui/55">Set a Hume API key above to load the voice list.</p>
        ) : humeVoicesLoading ? (
          <p className="text-xs text-ui/55">Loading voices…</p>
        ) : humeVoicesError ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-cp-coral flex-1">{humeVoicesError}</span>
            <button
              onClick={() => void refreshHumeVoices()}
              className="px-2 py-1 glass-btn text-xs rounded-lg"
            >Retry</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={cloudVoice}
              onChange={(e) => {
                const selected = humeVoices.find((v) => v.id === e.target.value);
                setCloudVoice(e.target.value);
                if (selected) {
                  setCloudVoiceProvider(selected.provider);
                  void saveSetting('voice.cloud_voice_provider', selected.provider, 'cloud_voice');
                }
                void saveSetting('voice.cloud_voice', e.target.value, 'cloud_voice');
              }}
              className="glass-select flex-1"
            >
              <option value="">— pick a voice —</option>
              {humeVoices.map((v) => (
                <option key={`${v.provider}:${v.id}`} value={v.id}>
                  {v.name} {v.provider === 'CUSTOM_VOICE' ? '· custom' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleCloudPreview()}
              disabled={previewing || !cloudVoice}
              className="px-3 py-2 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
            >
              {previewing ? 'Synthesizing…' : 'Preview'}
            </button>
            {savedKey === 'cloud_voice' && <span className="text-xs text-cp-teal">Saved!</span>}
          </div>
        )}
        {previewError && <p className="text-xs text-cp-coral">{previewError}</p>}
      </div>

      {/* Baseline delivery description */}
      <div className="tile space-y-3 md:col-span-2">
        <h3 className="scard__title">Baseline delivery</h3>
        <p className="text-xs text-ui/40">
          Standing "acting instructions" Hume applies to every turn unless the agent overrides
          with a <code className="px-1 rounded bg-ui/[0.06]">((deliver: ...))</code> cue at the
          start of a reply. Keep it short and general ("Speak warmly and conversationally").
          Leave blank to let Octave's automatic emotion read do all the work.
        </p>
        <textarea
          value={cloudDescription}
          onChange={(e) => setCloudDescription(e.target.value.slice(0, 500))}
          onBlur={() => void saveSetting('voice.cloud_voice_description', cloudDescription, 'cloud_desc')}
          placeholder="Speak warmly and conversationally."
          rows={2}
          className="glass-input w-full text-sm"
        />
        <div className="flex items-center justify-between text-xs text-ui/40">
          <span>{cloudDescription.length} / 500</span>
          {savedKey === 'cloud_desc' && <span className="text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* Cloud playback speed */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Playback speed</h3>
        <p className="text-xs text-ui/40">Speed multiplier for cloud TTS. 1.0 is natural.</p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0.8} max={1.4} step={0.05}
            value={cloudSpeed}
            onChange={(e) => setCloudSpeed(Number(e.target.value))}
            onMouseUp={() => void saveSetting('voice.cloud_speed', String(cloudSpeed), 'cloud_speed')}
            onTouchEnd={() => void saveSetting('voice.cloud_speed', String(cloudSpeed), 'cloud_speed')}
            className="flex-1 accent-cp-teal"
          />
          <span className="text-sm font-mono text-ui w-12 text-right">{cloudSpeed.toFixed(2)}x</span>
          {savedKey === 'cloud_speed' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>
      </>)}

      {/* Turn-taking patience */}
      <div className="tile space-y-3">
        <h3 className="scard__title">Turn-taking patience</h3>
        <p className="text-xs text-ui/40">
          How long {primaryAgentName} waits for you to finish a thought when you pause mid-sentence.
          {primaryAgentName} uses semantic turn detection to tell a real pause from a finished turn;
          this dial sets how patient it is before responding.
        </p>
        <div className="flex flex-col gap-2">
          {VAD_OPTIONS.map((opt) => (
            <label key={opt.id} className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="vad"
                value={opt.id}
                checked={vad === opt.id}
                onChange={() => { setVad(opt.id); void saveSetting('voice.vad_sensitivity', opt.id, 'vad'); }}
                className="mt-1 accent-cp-teal"
              />
              <div>
                <div className="text-sm text-ui">{opt.label}</div>
                <div className="text-xs text-ui/40">{opt.hint}</div>
              </div>
            </label>
          ))}
          {savedKey === 'vad' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
      </div>

      {/* Voice interruption (barge-in) */}
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Voice interruption</h3>
          {savedKey === 'barge' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          When on, talking while {primaryAgentName} is speaking interrupts the reply so you can
          jump in mid-sentence. Heads up: on phone speakers (and some laptops), the mic picks up
          {' '}{primaryAgentName}'s own voice and false-triggers the interrupt within a word or
          two. Works reliably on headphones or with good speaker isolation. Off by default.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={bargeInEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setBargeInEnabled(next);
              void saveSetting('voice.barge_in_enabled', String(next), 'barge');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Allow voice to interrupt {primaryAgentName}</span>
        </label>
      </div>

      {/* Sound effects */}
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Sound effects</h3>
          {savedKey === 'sfx' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          Subtle chimes give you audible feedback during voice mode: a wake chime when the
          wake phrase is heard, a sleep chime when the sleep phrase is heard, and a
          message-sent chime once your prompt has been submitted to {primaryAgentName}.
          Turn off if you'd rather have silent voice mode.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={soundEffectsEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setSoundEffectsEnabled(next);
              void saveSetting('voice.sound_effects_enabled', String(next), 'sfx');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Play voice mode sound effects</span>
        </label>
      </div>

      {/* Hands-free wake word */}
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="scard__title">Hands-free wake word</h3>
          {savedKey === 'wake' && <span className="text-xs text-cp-teal">Saved!</span>}
        </div>
        <p className="text-xs text-ui/40">
          When enabled, voice mode stays in a passive listening state and only routes your speech
          to {primaryAgentName} after it hears the wake phrase. Say the sleep phrase to put it back to sleep.
          Phrase match is case-insensitive. Heads up: passive mode runs STT continuously, so it
          uses noticeably more CPU than push-to-talk voice mode.
        </p>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={wakeWordEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setWakeWordEnabled(next);
              void saveSetting('voice.wake_word_enabled', String(next), 'wake');
              invalidateSavedVoiceSettings();
            }}
            className="accent-cp-teal"
          />
          <span className="text-sm text-ui">Enable wake word</span>
        </label>

        <div className={`space-y-3 ${wakeWordEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="space-y-1">
            <label className="text-xs text-ui/60">Wake phrase</label>
            <input
              type="text"
              value={wakePhrase}
              onChange={(e) => setWakePhrase(e.target.value)}
              onBlur={() => {
                const trimmed = wakePhrase.trim() || defaultWakePhrase;
                if (trimmed !== wakePhrase) setWakePhrase(trimmed);
                void saveSetting('voice.wake_phrase', trimmed, 'wake');
                invalidateSavedVoiceSettings();
              }}
              placeholder={defaultWakePhrase}
              className="glass-input w-full text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-ui/60">Sleep phrase</label>
            <input
              type="text"
              value={sleepPhrase}
              onChange={(e) => setSleepPhrase(e.target.value)}
              onBlur={() => {
                const trimmed = sleepPhrase.trim() || 'stop listening';
                if (trimmed !== sleepPhrase) setSleepPhrase(trimmed);
                void saveSetting('voice.sleep_phrase', trimmed, 'wake');
                invalidateSavedVoiceSettings();
              }}
              placeholder="stop listening"
              className="glass-input w-full text-sm"
            />
          </div>
        </div>
      </div>

      </div>

      {/* Speech-to-text model (unified — pick active, download, delete, see disk) */}
      <div className="tile space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="scard__title">Speech-to-text model</h3>
          {models && (
            <span className="text-xs text-ui/40">
              {models.freeDiskMb >= 0 ? `${(models.freeDiskMb / 1024).toFixed(1)} GB free` : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-ui/40">
          Transcribes your voice when voice mode is on. Moonshine is the small,
          fast default and runs anywhere with no native dependencies. Whisper is
          available as an alternative when the whisper.cpp binary is installed.
          The model marked Default is what the dojo uses right now.
        </p>

        {/* Moonshine row (no native deps, default). */}
        {models?.moonshine && (() => {
          const m = models.moonshine;
          const id = 'moonshine-base';
          const dl = downloads[`moonshine/${id}`];
          const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
          const isActive = id === sttModel;
          const setAsDefault = () => {
            setSttModel(id);
            void saveSetting('voice.stt_model', id, 'stt');
            if (!m.installed && !dl) {
              setDownloads((prev) => ({ ...prev, [`moonshine/${id}`]: { downloaded: 0, total: 0 } }));
              void handleInstall('moonshine', id);
            }
          };
          return (
            <div
              className={`glass-nested px-3 py-2.5 rounded-lg space-y-2 transition-colors ${
                isActive ? 'ring-1 ring-cp-teal/40' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-start gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="radio"
                    name="stt-model"
                    checked={isActive}
                    onChange={setAsDefault}
                    className="mt-1 accent-cp-teal shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-ui flex items-center gap-2">
                      <span className="truncate">{STT_LABELS[id]}</span>
                      {isActive && <span className="text-[10px] uppercase tracking-wide text-cp-teal shrink-0">Default</span>}
                    </div>
                    <div className="text-xs text-ui/40">
                      {m.installed ? `${formatBytes(m.bytes)} on disk` : '~65 MB to download'}
                    </div>
                  </div>
                </label>
                <div className="flex gap-2 shrink-0">
                  {!m.installed && !dl && (
                    <button
                      onClick={() => {
                        setDownloads((prev) => ({ ...prev, [`moonshine/${id}`]: { downloaded: 0, total: 0 } }));
                        void handleInstall('moonshine', id);
                      }}
                      disabled={installing === `moonshine/${id}`}
                      className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      Download
                    </button>
                  )}
                  {m.installed && !isActive && (
                    <button
                      onClick={() => void handleDelete('moonshine', id)}
                      className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              {dl && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-ui/40">
                    <span>{formatBytes(dl.downloaded)} / {formatBytes(dl.total)}</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1 bg-ui/[0.06] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Install hint when the Whisper binary isn't present on this OS. */}
        {models && models.whisperBinaryAvailable === false && (
          <div className="text-[11px] text-ui/40 px-3 py-2 rounded-lg bg-ui/[0.03] border border-ui/[0.06]">
            Whisper requires <code className="font-mono text-ui/55">whisper-cpp</code> via Homebrew
            (<code className="font-mono text-ui/55">brew install whisper-cpp</code>). The rows below
            stay greyed out until the binary is installed.
          </div>
        )}

        {models?.whisper.map((m) => {
          const dl = downloads[`whisper/${m.id}`];
          const pct = dl && dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
          const isActive = m.id === sttModel;
          const whisperDisabled = models.whisperBinaryAvailable === false;
          const setAsDefault = () => {
            if (whisperDisabled) return;
            setSttModel(m.id);
            void saveSetting('voice.stt_model', m.id, 'stt');
            if (!m.installed && !dl) {
              setDownloads((prev) => ({ ...prev, [`whisper/${m.id}`]: { downloaded: 0, total: m.approxBytes ?? 0 } }));
              void handleInstall('whisper', m.id);
            }
          };
          return (
            <div
              key={m.id}
              className={`glass-nested px-3 py-2.5 rounded-lg space-y-2 transition-colors ${
                isActive ? 'ring-1 ring-cp-teal/40' : ''
              } ${whisperDisabled ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                {/* Default radio + label */}
                <label className="flex items-start gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="radio"
                    name="stt-model"
                    checked={isActive}
                    onChange={setAsDefault}
                    disabled={whisperDisabled}
                    className="mt-1 accent-cp-teal shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-ui flex items-center gap-2">
                      <span className="truncate">{STT_LABELS[m.id] ?? m.id}</span>
                      {isActive && <span className="text-[10px] uppercase tracking-wide text-cp-teal shrink-0">Default</span>}
                    </div>
                    <div className="text-xs text-ui/40">
                      {m.installed
                        ? `${formatBytes(m.bytes)} on disk`
                        : m.approxBytes ? `~${formatBytes(m.approxBytes)} to download` : 'Not installed'}
                    </div>
                  </div>
                </label>

                {/* Action buttons */}
                <div className="flex gap-2 shrink-0">
                  {!m.installed && !dl && (
                    <button
                      onClick={() => {
                        setDownloads((prev) => ({ ...prev, [`whisper/${m.id}`]: { downloaded: 0, total: m.approxBytes ?? 0 } }));
                        void handleInstall('whisper', m.id);
                      }}
                      disabled={whisperDisabled || installing === `whisper/${m.id}`}
                      className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      Download
                    </button>
                  )}
                  {m.installed && !isActive && (
                    <button
                      onClick={() => void handleDelete('whisper', m.id)}
                      disabled={whisperDisabled}
                      className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {dl && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-ui/40">
                    <span>{formatBytes(dl.downloaded)} / {formatBytes(dl.total)}</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {savedKey === 'stt' && <span className="text-xs text-cp-teal">Saved!</span>}
        <p className="text-xs text-ui/40">
          The Default model can't be deleted. Switch defaults first if you want to free its space.
        </p>
      </div>

      {/* Text-to-speech model (Kokoro lives by itself — one model, on/off) */}
      {models?.kokoro && (
        <div className="tile space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="scard__title">Text-to-speech model</h3>
            {models.totalDiskBytes > 0 && (
              <span className="text-xs text-ui/40">All voice models: {formatBytes(models.totalDiskBytes)}</span>
            )}
          </div>
          <p className="text-xs text-ui/40">
            Kokoro generates {primaryAgentName}'s spoken replies. One model, ~330&nbsp;MB.
          </p>

          <div className="glass-nested px-3 py-2.5 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-ui">Kokoro 82M</div>
                <div className="text-xs text-ui/40">
                  {models.kokoro.installed
                    ? `${formatBytes(models.kokoro.bytes)} on disk${models.kokoroLoaded ? ' · loaded in memory' : ''}`
                    : 'Not installed — will download on first voice session'}
                </div>
              </div>
              <div className="flex gap-2">
                {!models.kokoro.installed && (
                  <button
                    onClick={() => {
                      const id = models.kokoro!.id;
                      setDownloads((prev) => ({ ...prev, [`kokoro/${id}`]: { downloaded: 0, total: 100 } }));
                      void handleInstall('kokoro', id);
                    }}
                    disabled={installing === `kokoro/${models.kokoro.id}`}
                    className="px-3 py-1.5 glass-btn-primary text-xs font-medium rounded-lg disabled:opacity-50"
                  >
                    {installing === `kokoro/${models.kokoro.id}` ? 'Downloading…' : 'Download'}
                  </button>
                )}
                {models.kokoro.installed && (
                  <button
                    onClick={() => void handleDelete('kokoro', models.kokoro!.id)}
                    className="px-3 py-1.5 text-xs text-cp-coral hover:bg-cp-coral/10 rounded-lg"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            {(() => {
              const dl = downloads[`kokoro/${models.kokoro.id}`];
              if (!dl) return null;
              const pct = dl.total > 0 ? Math.min(100, (dl.downloaded / dl.total) * 100) : 0;
              return (
                <div className="space-y-1">
                  <div className="h-1.5 bg-ui/[0.08] rounded-full overflow-hidden">
                    <div className="h-full bg-cp-teal transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-ui/40 text-right">{pct.toFixed(0)}%</div>
                </div>
              );
            })()}
          </div>

          {installError && <p className="text-xs text-cp-coral">{installError}</p>}
        </div>
      )}
    </div>
  );
};
