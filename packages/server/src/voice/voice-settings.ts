// The saved voice settings (Settings, Voice), read fresh by dashboard voice and phone calls alike, so a change
// applies to the next reply or utterance without a reload. Missing or malformed keys take the defaults.

import { getDb } from '../db/connection.js';
import { getPrimaryAgentName } from '../config/platform.js';
import { DEFAULT_STT_MODEL_KEY, parseSttModelKey } from './stt-service.js';
import { DEFAULT_VOICE } from './tts-service.js';
import { isHumeConfigured } from './hume-engine.js';

export interface VoiceSettings {
  voice: string;
  speed: number;
  sttModel: string;
  wakeWordEnabled: boolean;
  wakePhrase: string;
  sleepPhrase: string;
  /** Cloud only with a Hume key and a chosen voice, so voice never breaks on a half-set cloud choice. */
  ttsEngine: 'local' | 'cloud';
  cloudVoice: string;
  cloudVoiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
  /** Standing delivery description for the cloud voice; null lets the provider decide. */
  cloudDescription: string | null;
  cloudSpeed: number;
  /** How long a mid-thought pause is held before the words are sent. */
  turnPatience: 'quick' | 'normal' | 'patient';
}

const speedOf = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : fallback;
};

// A call with no voice chosen speaks in this local voice; dashboard voice uses DEFAULT_VOICE.
const PHONE_DEFAULT_VOICE = 'af_bella';

export function loadVoiceSettings(surface: 'dashboard' | 'phone' = 'dashboard'): VoiceSettings {
  const s: VoiceSettings = {
    voice: surface === 'phone' ? PHONE_DEFAULT_VOICE : DEFAULT_VOICE, speed: 1, sttModel: DEFAULT_STT_MODEL_KEY,
    wakeWordEnabled: false, wakePhrase: `hey ${getPrimaryAgentName().toLowerCase()}`, sleepPhrase: 'stop listening',
    ttsEngine: 'local', cloudVoice: '', cloudVoiceProvider: 'HUME_AI', cloudDescription: null, cloudSpeed: 1,
    // The unset default matches the dashboard's initial 'quick'.
    turnPatience: 'quick',
  };
  try {
    const rows = getDb().prepare("SELECT key, value FROM config WHERE key LIKE 'voice.%'").all() as Array<{ key: string; value: string }>;
    for (const { key, value } of rows) {
      if (key === 'voice.preferred_voice' && value) s.voice = value;
      if (key === 'voice.playback_speed') s.speed = speedOf(value, s.speed);
      if (key === 'voice.stt_model' && value) {
        const parsed = parseSttModelKey(value);
        s.sttModel = parsed.kind === 'moonshine' ? 'moonshine-base' : parsed.size;
      }
      if (key === 'voice.wake_word_enabled') s.wakeWordEnabled = value === 'true';
      if (key === 'voice.wake_phrase' && value.trim()) s.wakePhrase = value.trim().toLowerCase();
      if (key === 'voice.sleep_phrase' && value.trim()) s.sleepPhrase = value.trim().toLowerCase();
      if (key === 'voice.tts_engine' && value === 'cloud') s.ttsEngine = 'cloud';
      if (key === 'voice.cloud_voice' && value) s.cloudVoice = value;
      if (key === 'voice.cloud_voice_provider' && value === 'CUSTOM_VOICE') s.cloudVoiceProvider = 'CUSTOM_VOICE';
      if (key === 'voice.cloud_voice_description' && value.trim()) s.cloudDescription = value.trim().slice(0, 500);
      if (key === 'voice.cloud_speed') s.cloudSpeed = speedOf(value, s.cloudSpeed);
      if (key === 'voice.vad_sensitivity' && (value === 'quick' || value === 'normal' || value === 'patient')) s.turnPatience = value;
    }
  } catch { /* defaults */ }
  if (s.ttsEngine === 'cloud' && (!isHumeConfigured() || s.cloudVoice.length === 0)) s.ttsEngine = 'local';
  return s;
}
