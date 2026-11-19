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
  /** Transient non-fatal server notice (e.g. cloud voice fell back to local for a reply). Unlike
   *  `error` the session stays live: set by the server, cleared when the session ends. */
  notice: string | null;
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
  /** True when the toggle was clicked but the saved engines' models aren't installed yet:
   *  render <VoiceFirstRunModal />. */
  setupNeeded: boolean;
  /** Called by the modal once required models are installed: start voice. */
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
export async function loadSavedVoiceSettings(): Promise<SavedVoiceSettings> {
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
    // A read that failed says nothing about what the owner saved: use defaults for this call
    // only, and read again next time rather than remembering them for the page's life.
    if (![v, s, vad, stt, wake, wp, sp, primaryName, bargeIn, sfx].every((r) => r.ok)) savedPromise = null;
    const speedNum = s.ok && s.data.value ? Number(s.data.value) : NaN;
    const vadVal = vad.ok && vad.data.value;
    const primary = (primaryName.ok && primaryName.data.value && primaryName.data.value.trim()) || 'agent';
    const defaultWakePhrase = `hey ${primary.toLowerCase()}`;
    return {
      voice: (v.ok && v.data.value) || 'am_michael',
      speed: Number.isFinite(speedNum) && speedNum >= 0.5 && speedNum <= 2 ? speedNum : 1.0,
      // Default 'moonshine-base' (no native deps). Any other saved model keeps working:
      // the server's parseSttModelKey normalises it.
      sttModel: (stt.ok && stt.data.value) || 'moonshine-base',
      // Default 'quick' (200 ms): lower latency, at the cost of occasional early cutoffs.
      vadSensitivity: vadVal === 'normal' ? 'normal' : vadVal === 'patient' ? 'patient' : 'quick',
      wakeWordEnabled: wake.ok && wake.data.value === 'true',
      wakePhrase: (wp.ok && wp.data.value && wp.data.value.trim()) || defaultWakePhrase,
      sleepPhrase: (sp.ok && sp.data.value && sp.data.value.trim()) || 'stop listening',
      // Off by default: phone speakers echo the agent's TTS into the mic, so voice
      // barge-in is unreliable. Headphone users can enable it in Settings.
      bargeInEnabled: bargeIn.ok && bargeIn.data.value === 'true',
      // On by default: chimes are the user's audible proof the system heard them.
      soundEffectsEnabled: !(sfx.ok && sfx.data.value === 'false'),
    };
  })();
  return savedPromise;
}

export function useVoiceMode({ agentId, voice, speed, sttModel, vadSensitivity, wakeWordEnabled, wakePhrase, sleepPhrase, bargeInEnabled, soundEffectsEnabled }: UseVoiceModeOptions): UseVoiceModeResult {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
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
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<VoiceClient | null> | null>(null);
  const startingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  const buildClient = useCallback(async (): Promise<VoiceClient | null> => {
    if (!agentId) return null;
    if (clientRef.current && clientRef.current.agentId !== agentId) {
      void clientRef.current.stop();
      clientRef.current = null;
    }
    if (!clientRef.current) {
      // Merge explicit overrides with the saved Settings → Voice config so the user's
      // picker selections take effect when they toggle voice mode on.
      const saved = await loadSavedVoiceSettings();
      if (!mountedRef.current) return null;   // left the page while settings loaded: build nothing
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
        // Drop the meter when we're no longer capturing; keeps the banner clean.
        if (s !== 'capturing' && s !== 'listening') setAudioLevel(0);
        // Clear partial when speech ends; the final-transcript handler takes over.
        if (s === 'transcribing' || s === 'waiting' || s === 'speaking') setPartialTranscript(null);
        // Voice off (or errored): the mute icon only shows while voice mode is on, so return
        // the mic to unmuted and drop stale transcripts (the client re-inits unmuted anyway).
        if (s === 'idle' || s === 'error') {
          setMutedState(false);
          setPartialTranscript(null);
          setLastTranscript(null);
          // Clear any stale notice so the server's once-per-session notice can fire again.
          setNotice(null);
        }
      });
      client.on('error', (msg) => setError(msg));
      client.on('notice', (msg) => setNotice(msg));
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

  // One build at a time: a second caller joins the first instead of building a duplicate client.
  const ensureClient = useCallback((): Promise<VoiceClient | null> => {
    if (inFlightRef.current) return inFlightRef.current;
    const pending = buildClient().finally(() => { inFlightRef.current = null; });
    inFlightRef.current = pending;
    return pending;
  }, [buildClient]);

  const startVoice = useCallback(async () => {
    const client = await ensureClient();
    if (!client || !mountedRef.current) return;
    setError(null);
    await client.start();
  }, [ensureClient]);

  const toggle = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') {
      // Turning off: always safe to stop directly.
      if (clientRef.current) await clientRef.current.stop();
      return;
    }
    if (startingRef.current) return;   // a start is already under way: ignore the extra click
    startingRef.current = true;
    try {
    // Turning on: the saved engines' models must be on disk first, else a fresh user
    // gets ~20s of silence while the speech model downloads and Kokoro loads.
    try {
      const modelsRes = await api.getVoiceModels();
      if (modelsRes.ok && modelsRes.data.missing.length > 0) {
        setSetupNeeded(true);
        return;
      }
    } catch { /* If the check itself fails, fall through and try to start anyway. */ }
    await startVoice();
    } finally { startingRef.current = false; }
  }, [state, startVoice]);

  const completeSetup = useCallback(async () => {
    setSetupNeeded(false);
    await startVoice();
  }, [startVoice]);

  const cancelSetup = useCallback(() => setSetupNeeded(false), []);

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
    enabled, state, error, notice, lastTranscript, partialTranscript, audioLevel,
    muted, setMuted, toggleMute,
    wakeWordEnabled: resolvedWakeWordEnabled,
    wakePhrase: resolvedWakePhrase,
    bargeInEnabled: resolvedBargeInEnabled,
    soundEffectsEnabled: resolvedSoundEffectsEnabled,
    toggle, stop, setupNeeded, completeSetup, cancelSetup,
  };
}
