import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import { VoiceClient, type VoiceState } from '../lib/voice/voice-client';

interface UseVoiceModeOptions {
  agentId: string | null;
  /** Optional overrides; defaults come from the saved Settings → Voice config. */
  voice?: string;
  speed?: number;
  sttModel?: string;
  vadSensitivity?: 'quick' | 'normal' | 'patient';
  wakeWordEnabled?: boolean;
  wakePhrase?: string;
  sleepPhrase?: string;
  bargeInEnabled?: boolean;
  soundEffectsEnabled?: boolean;
}

export interface UseVoiceModeResult {
  enabled: boolean;
  state: VoiceState;
  error: string | null;
  /** Most recently FINALIZED transcript (after speech-end). */
  lastTranscript: string | null;
  /** Live in-progress transcript while user is still speaking. Null once speech ends. */
  partialTranscript: string | null;
  /** Whether wake-word mode is currently active for this session. */
  wakeWordEnabled: boolean;
  /** Configured wake phrase (lowercased). */
  wakePhrase: string;
  /** Whether voice-driven barge-in is allowed during agent TTS playback. */
  bargeInEnabled: boolean;
  /** Whether wake / sleep / prompt-sent chimes are enabled. */
  soundEffectsEnabled: boolean;
  /** 0..1 live audio level from the VAD frame processor (updates ~30ms). */
  audioLevel: number;
  /** Whether the user has muted the microphone (separate from voice mode on/off). */
  muted: boolean;
  /** Mute or unmute the mic. Silences audio at the OS level, pauses the VAD, but leaves TTS playback intact. */
  setMuted: (muted: boolean) => Promise<void>;
  /** Convenience: flip the current mute state. */
  toggleMute: () => Promise<void>;
  toggle: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * When non-null, the toggle was clicked but the required STT/TTS models
   * aren't installed yet. The hook returns immediately and the consumer
   * should render <VoiceFirstRunModal /> with these props.
   */
  setupNeeded: { whisperModelId: string } | null;
  /** Called by the modal once required models are installed — starts voice. */
  completeSetup: () => Promise<void>;
  /** Called by the modal if the user cancels setup. */
  cancelSetup: () => void;
}

interface SavedVoiceSettings {
  voice: string;
  speed: number;
  sttModel: string;
  vadSensitivity: 'quick' | 'normal' | 'patient';
  wakeWordEnabled: boolean;
  wakePhrase: string;
  sleepPhrase: string;
  bargeInEnabled: boolean;
  soundEffectsEnabled: boolean;
}

/** Pull voice settings from the config table. Cached for the page lifetime. */
let savedPromise: Promise<SavedVoiceSettings> | null = null;
export function invalidateSavedVoiceSettings(): void { savedPromise = null; }
async function loadSavedVoiceSettings(): Promise<SavedVoiceSettings> {
  if (savedPromise) return savedPromise;
  savedPromise = (async () => {
    const [v, s, vad, stt, wake, wp, sp, primaryName, bargeIn, sfx] = await Promise.all([
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
    ]);
    const speedNum = s.ok && s.data.value ? Number(s.data.value) : NaN;
    const vadVal = vad.ok && vad.data.value;
    const primary = (primaryName.ok && primaryName.data.value && primaryName.data.value.trim()) || 'agent';
    const defaultWakePhrase = `hey ${primary.toLowerCase()}`;
    return {
      voice: (v.ok && v.data.value) || 'am_michael',
      speed: Number.isFinite(speedNum) && speedNum >= 0.5 && speedNum <= 2 ? speedNum : 1.0,
      // Default is 'moonshine-base' (Moonshine v2 base, no native deps).
      // Existing users with 'large-v3-turbo' or any other WhisperSize keep
      // their preference; the server's parseSttModelKey normalises it.
      sttModel: (stt.ok && stt.data.value) || 'moonshine-base',
      // Default VAD redemption is 'quick' (200 ms). Lower latency at the
      // cost of occasional early cutoffs vs the prior 'normal' default.
      vadSensitivity: vadVal === 'normal' ? 'normal' : vadVal === 'patient' ? 'patient' : 'quick',
      wakeWordEnabled: wake.ok && wake.data.value === 'true',
      wakePhrase: (wp.ok && wp.data.value && wp.data.value.trim()) || defaultWakePhrase,
      sleepPhrase: (sp.ok && sp.data.value && sp.data.value.trim()) || 'stop listening',
      // Off by default — phone speakers echo the primary agent's TTS into the mic and
      // make voice-based barge-in unreliable. Users on headphones (or
      // desktop with good speaker separation) can enable it in Settings.
      bargeInEnabled: bargeIn.ok && bargeIn.data.value === 'true',
      // On by default — chimes confirm wake / sleep / prompt-sent so the
      // user has audible feedback that the system heard them.
      soundEffectsEnabled: !(sfx.ok && sfx.data.value === 'false'),
    };
  })();
  return savedPromise;
}

export function useVoiceMode({ agentId, voice, speed, sttModel, vadSensitivity, wakeWordEnabled, wakePhrase, sleepPhrase, bargeInEnabled, soundEffectsEnabled }: UseVoiceModeOptions): UseVoiceModeResult {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState<{ whisperModelId: string } | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [resolvedWakeWordEnabled, setResolvedWakeWordEnabled] = useState(false);
  const [resolvedBargeInEnabled, setResolvedBargeInEnabled] = useState(false);
  const [resolvedSoundEffectsEnabled, setResolvedSoundEffectsEnabled] = useState(true);
  // Empty until ensureClient() resolves saved settings; ChatInput already
  // falls back to a generic "Standing by" label when this is empty.
  const [resolvedWakePhrase, setResolvedWakePhrase] = useState('');
  const clientRef = useRef<VoiceClient | null>(null);

  // Tear down whenever agentId disappears or component unmounts.
  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!agentId && clientRef.current) {
      void clientRef.current.stop();
      clientRef.current = null;
      setState('idle');
    }
  }, [agentId]);

  const ensureClient = useCallback(async (): Promise<VoiceClient | null> => {
    if (!agentId) return null;
    if (clientRef.current && clientRef.current.agentId !== agentId) {
      void clientRef.current.stop();
      clientRef.current = null;
    }
    if (!clientRef.current) {
      // Merge explicit overrides with the saved Settings → Voice config so
      // the user's picker selections (voice, speed, STT model, VAD sensitivity,
      // wake-word setup) actually take effect when they toggle voice mode on.
      const saved = await loadSavedVoiceSettings();
      const effectiveWakeWordEnabled = wakeWordEnabled ?? saved.wakeWordEnabled;
      const effectiveWakePhrase = wakePhrase ?? saved.wakePhrase;
      const effectiveBargeInEnabled = bargeInEnabled ?? saved.bargeInEnabled;
      const effectiveSoundEffectsEnabled = soundEffectsEnabled ?? saved.soundEffectsEnabled;
      setResolvedWakeWordEnabled(effectiveWakeWordEnabled);
      setResolvedWakePhrase(effectiveWakePhrase);
      setResolvedBargeInEnabled(effectiveBargeInEnabled);
      setResolvedSoundEffectsEnabled(effectiveSoundEffectsEnabled);
      const client = new VoiceClient({
        agentId,
        voice: voice ?? saved.voice,
        speed: speed ?? saved.speed,
        sttModel: sttModel ?? saved.sttModel,
        vadSensitivity: vadSensitivity ?? saved.vadSensitivity,
        wakeWordEnabled: effectiveWakeWordEnabled,
        wakePhrase: effectiveWakePhrase,
        sleepPhrase: sleepPhrase ?? saved.sleepPhrase,
        bargeInEnabled: effectiveBargeInEnabled,
        soundEffectsEnabled: effectiveSoundEffectsEnabled,
      });
      client.on('state-change', (s) => {
        setState(s);
        // Drop the meter when we're no longer capturing — keeps the banner clean.
        if (s !== 'capturing' && s !== 'listening') setAudioLevel(0);
        // Clear partial when speech ends — final-transcript handler takes over.
        if (s === 'transcribing' || s === 'waiting' || s === 'speaking') setPartialTranscript(null);
        // Voice mode turned off (or errored): return the composer mic to its
        // default unmuted state. The mute icon should only ever show while
        // voice mode is on. The client re-inits unmuted on the next start, so
        // this just keeps the React state in step. Also drop stale transcripts.
        if (s === 'idle' || s === 'error') {
          setMutedState(false);
          setPartialTranscript(null);
          setLastTranscript(null);
        }
      });
      client.on('error', (msg) => setError(msg));
      client.on('partial-transcript', (text) => setPartialTranscript(text));
      client.on('final-transcript', (text) => {
        setLastTranscript(text);
        setPartialTranscript(null);
      });
      client.on('audio-level', (level) => setAudioLevel(level));
      client.on('muted-change', (m) => setMutedState(m));
      clientRef.current = client;
    }
    return clientRef.current;
  }, [agentId, voice, speed, sttModel, vadSensitivity, wakeWordEnabled, wakePhrase, sleepPhrase, bargeInEnabled, soundEffectsEnabled]);

  const startVoice = useCallback(async () => {
    const client = await ensureClient();
    if (!client) return;
    setError(null);
    await client.start();
  }, [ensureClient]);

  const toggle = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') {
      // Turning OFF — always safe to do directly.
      if (clientRef.current) await clientRef.current.stop();
      return;
    }
    // Turning ON — check that the required models are installed first.
    // Without this, a fresh user clicks the mic and gets silence for 20s
    // while whisper-server downloads + Kokoro loads, with zero indication
    // anything is happening.
    try {
      const saved = await loadSavedVoiceSettings();
      const wantedStt = sttModel ?? saved.sttModel;
      const modelsRes = await api.getVoiceModels();
      if (modelsRes.ok) {
        const kokoroOk = modelsRes.data.kokoro?.installed === true;
        const whisperRow = modelsRes.data.whisper.find((m) => m.id === wantedStt);
        const whisperOk = whisperRow?.installed === true;
        if (!kokoroOk || !whisperOk) {
          setSetupNeeded({ whisperModelId: wantedStt });
          return;
        }
      }
    } catch { /* If the check itself fails, fall through and try to start anyway. */ }
    await startVoice();
  }, [state, sttModel, startVoice]);

  const completeSetup = useCallback(async () => {
    setSetupNeeded(null);
    await startVoice();
  }, [startVoice]);

  const cancelSetup = useCallback(() => setSetupNeeded(null), []);

  const stop = useCallback(async () => {
    if (clientRef.current) await clientRef.current.stop();
  }, []);

  const setMuted = useCallback(async (next: boolean) => {
    if (clientRef.current) await clientRef.current.setMuted(next);
  }, []);

  const toggleMute = useCallback(async () => {
    if (clientRef.current) await clientRef.current.setMuted(!clientRef.current.isMuted());
  }, []);

  const enabled = state !== 'idle' && state !== 'error';
  return {
    enabled, state, error, lastTranscript, partialTranscript, audioLevel,
    muted, setMuted, toggleMute,
    wakeWordEnabled: resolvedWakeWordEnabled,
    wakePhrase: resolvedWakePhrase,
    bargeInEnabled: resolvedBargeInEnabled,
    soundEffectsEnabled: resolvedSoundEffectsEnabled,
    toggle, stop, setupNeeded, completeSetup, cancelSetup,
  };
}
