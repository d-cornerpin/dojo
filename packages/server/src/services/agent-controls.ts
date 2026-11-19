// Backs the agent's "control the dojo on the user's behalf" tools: only the specific validated settings here can
// be changed (no arbitrary config-key path), and a model must be enabled and have the capability before it is
// written, so a bad pick returns the valid options.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { getModelCapabilities, type Capability } from './capabilities.js';
import { setConfiguredImageGenModelId } from './image-gen-model.js';
import { setConfiguredVideoGenModelId } from './video-gen-model.js';
import { setConfiguredAudioGenModelId } from './audio-gen-model.js';
import { setConfiguredMusicGenModelId } from './music-gen-model.js';
import { setConfiguredFallbackVisionModelId } from './vision-model.js';
import { setConfiguredTranscriptionModelId, LOCAL_TRANSCRIPTION_IDS } from './transcription-model.js';
import { listVoices } from '../voice/tts-service.js';
import { isHumeConfigured, listHumeVoices } from '../voice/hume-engine.js';

export type CapabilitySlot = 'image' | 'video' | 'tts' | 'music' | 'vision' | 'transcription';

interface CapabilityTarget {
  capability: Capability;
  set: (id: string | null) => void;
  /** Human label for messages. */
  label: string;
  /** Non-DB pseudo-ids that are also valid (on-device engines). */
  localIds?: readonly string[];
}

const TARGETS: Record<CapabilitySlot, CapabilityTarget> = {
  image: { capability: 'image_generation', set: setConfiguredImageGenModelId, label: 'image generation' },
  video: { capability: 'video_generation', set: setConfiguredVideoGenModelId, label: 'video generation' },
  tts: { capability: 'audio_generation', set: setConfiguredAudioGenModelId, label: 'text-to-speech' },
  music: { capability: 'music_generation', set: setConfiguredMusicGenModelId, label: 'music generation' },
  vision: { capability: 'vision', set: setConfiguredFallbackVisionModelId, label: 'fallback vision' },
  transcription: {
    capability: 'transcription',
    set: setConfiguredTranscriptionModelId,
    label: 'transcription',
    localIds: LOCAL_TRANSCRIPTION_IDS,
  },
};

export const CAPABILITY_SLOTS = Object.keys(TARGETS) as CapabilitySlot[];

interface ModelOption {
  id: string;
  name: string;
  providerName: string;
}

/** Every enabled model that actually has the given capability. */
export function listModelsForCapability(slot: CapabilitySlot): ModelOption[] {
  const target = TARGETS[slot];
  if (!target) return [];
  try {
    const rows = getDb().prepare(`
      SELECT m.id, m.name, p.name AS provider_name
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1
      ORDER BY m.name ASC
    `).all() as Array<{ id: string; name: string; provider_name: string }>;
    return rows
      .filter(r => getModelCapabilities(r.id).includes(target.capability))
      .map(r => ({ id: r.id, name: r.name, providerName: r.provider_name }));
  } catch {
    return [];
  }
}

export interface SetCapabilityModelResult {
  ok: boolean;
  message: string;
}

/**
 * Validate, then set the platform-wide model for a capability. On failure the message lists the valid options.
 */
export function setCapabilityModel(slot: CapabilitySlot, modelId: string): SetCapabilityModelResult {
  const target = TARGETS[slot];
  if (!target) {
    return { ok: false, message: `Unknown capability "${slot}". Valid: ${CAPABILITY_SLOTS.join(', ')}.` };
  }
  const id = (modelId ?? '').trim();
  if (!id) return { ok: false, message: 'A model id is required.' };

  // Local-engine pseudo-ids (e.g. transcription's local:whisper / local:moonshine).
  if (target.localIds?.includes(id)) {
    target.set(id);
    return { ok: true, message: `Set ${target.label} to the on-device engine "${id}".` };
  }

  const db = getDb();
  // Resolve the reference forgivingly, since a weak model often passes a name where an id is expected:
  // exact id, then case-insensitive name / api_model_id, then a unique name substring.
  let row = db.prepare(`SELECT id, name, is_enabled FROM models WHERE id = ?`)
    .get(id) as { id: string; name: string; is_enabled: number } | undefined;
  if (!row) {
    const exact = db.prepare(
      `SELECT id, name, is_enabled FROM models WHERE LOWER(name) = LOWER(?) OR LOWER(api_model_id) = LOWER(?)`,
    ).all(id, id) as Array<{ id: string; name: string; is_enabled: number }>;
    if (exact.length === 1) row = exact[0];
    else if (exact.length === 0) {
      const sub = db.prepare(`SELECT id, name, is_enabled FROM models WHERE LOWER(name) LIKE LOWER(?)`)
        .all(`%${id}%`) as Array<{ id: string; name: string; is_enabled: number }>;
      if (sub.length === 1) row = sub[0];
    }
  }

  const options = listModelsForCapability(slot);
  const optionList = options.length
    ? options.map(o => `- ${o.id} (${o.name}, ${o.providerName})`).join('\n')
    : '(no enabled model currently has this capability, add or enable one in Settings then Models first)';

  if (!row) {
    return { ok: false, message: `No model matches "${id}". Models that can do ${target.label}:\n${optionList}` };
  }
  if (!row.is_enabled) {
    return { ok: false, message: `Model "${row.name}" (${row.id}) is disabled. Enable it in Settings then Models first, or pick one that's already enabled:\n${optionList}` };
  }
  if (!getModelCapabilities(row.id).includes(target.capability)) {
    return { ok: false, message: `Model "${row.name}" (${row.id}) isn't marked as ${target.label}-capable. Pick one of:\n${optionList}` };
  }

  target.set(row.id);
  return { ok: true, message: `Set the ${target.label} model to "${row.name}" (${row.id}).` };
}

// Voice: names match the local Kokoro library (built-in + imported) first, then the Hume cloud library,
// flipping the TTS engine to match. Voice settings are read fresh when a voice session starts (voice-ws.ts).

export interface SetVoiceResult {
  ok: boolean;
  message: string;
}

const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

export async function setVoice(opts: { voice?: string; speed?: number }): Promise<SetVoiceResult> {
  const changes: string[] = [];

  if (opts.voice !== undefined) {
    const want = (opts.voice ?? '').trim();
    if (!want) return { ok: false, message: 'A voice name or id is required.' };
    const wantLower = want.toLowerCase();

    // 1. Local Kokoro (built-in + custom imports).
    const local = listVoices();
    const localMatch =
      local.find(v => v.id.toLowerCase() === wantLower) ??
      local.find(v => v.name.toLowerCase() === wantLower) ??
      local.find(v => v.name.toLowerCase().includes(wantLower));
    if (localMatch) {
      setConfigValue('voice.preferred_voice', localMatch.id);
      setConfigValue('voice.tts_engine', 'local');
      changes.push(`voice set to ${localMatch.name} (${localMatch.id}, on-device)`);
    } else {
      // 2. Hume cloud library, if configured.
      let cloudMatch: { id: string; name: string; provider: string } | undefined;
      if (isHumeConfigured()) {
        try {
          const cloud = await listHumeVoices();
          cloudMatch =
            cloud.find(v => v.id.toLowerCase() === wantLower) ??
            cloud.find(v => v.name.toLowerCase() === wantLower) ??
            cloud.find(v => v.name.toLowerCase().includes(wantLower));
        } catch { /* fall through to the not-found message */ }
      }
      if (cloudMatch) {
        setConfigValue('voice.cloud_voice', cloudMatch.id);
        setConfigValue('voice.cloud_voice_provider', cloudMatch.provider);
        setConfigValue('voice.tts_engine', 'cloud');
        changes.push(`voice set to ${cloudMatch.name} (cloud / Hume)`);
      } else {
        const sample = local.slice(0, 12).map(v => v.name).join(', ');
        const cloudNote = isHumeConfigured() ? ' (the Hume cloud library was checked too)' : '';
        return { ok: false, message: `No voice matching "${want}"${cloudNote}. Some on-device voices: ${sample}. Use an exact voice name or id.` };
      }
    }
  }

  if (opts.speed !== undefined) {
    const s = opts.speed;
    if (!Number.isFinite(s) || s < SPEED_MIN || s > SPEED_MAX) {
      return { ok: false, message: `Speed must be a number between ${SPEED_MIN} and ${SPEED_MAX} (1 = normal).` };
    }
    // Set both engine speeds so slowing down or speeding up behaves the same on local or cloud.
    setConfigValue('voice.playback_speed', String(s));
    setConfigValue('voice.cloud_speed', String(s));
    changes.push(`playback speed set to ${s}x`);
  }

  if (changes.length === 0) {
    return { ok: false, message: 'Nothing to change — provide a voice, a speed, or both.' };
  }
  return { ok: true, message: `Done: ${changes.join('; ')}. Takes effect the next time voice mode starts.` };
}

// Channels: iMessage needs its bridge process started/stopped in lockstep with the flag (a bare config write
// does nothing until restart) and a recipient; Twilio is a runtime flag but enabling it needs credentials.

export type ChannelKey = 'imessage' | 'twilio' | 'sms' | 'voice_calls';

export interface SetChannelResult {
  ok: boolean;
  message: string;
}

export async function setChannelEnabled(channel: ChannelKey, enabled: boolean): Promise<SetChannelResult> {
  switch (channel) {
    case 'imessage': {
      if (enabled) {
        const recipient = (getDb()
          .prepare("SELECT value FROM config WHERE key = 'imessage_recipient'")
          .get() as { value: string } | undefined)?.value;
        if (!recipient) {
          return { ok: false, message: "Can't enable the iMessage bridge yet — no bridge recipient is configured. Set that up in Settings → Channels first." };
        }
        setConfigValue('imessage_enabled', 'true');
        try {
          const { startIMBridge } = await import('./imessage-bridge.js');
          startIMBridge(recipient);
        } catch (err) {
          return { ok: false, message: `Saved the setting, but the bridge failed to start: ${err instanceof Error ? err.message : String(err)}` };
        }
        return { ok: true, message: 'iMessage bridge enabled and started.' };
      }
      setConfigValue('imessage_enabled', 'false');
      try {
        const { stopIMBridge } = await import('./imessage-bridge.js');
        stopIMBridge();
      } catch { /* bridge may not have been running */ }
      return { ok: true, message: 'iMessage bridge disabled.' };
    }
    case 'twilio': {
      const { isTwilioConfigured, updateTwilioSettings } = await import('../twilio/auth.js');
      if (enabled && !isTwilioConfigured()) {
        return { ok: false, message: "Can't enable Twilio — no Twilio credentials are configured. Add the Account SID + Auth Token in Settings → Channels first." };
      }
      updateTwilioSettings({ enabled });
      return { ok: true, message: `Twilio ${enabled ? 'enabled' : 'disabled'}.` };
    }
    case 'sms':
    case 'voice_calls': {
      const { getTwilioConfig, updateTwilioSettings } = await import('../twilio/auth.js');
      const cfg = getTwilioConfig();
      if (!cfg.configured) {
        return { ok: false, message: "Twilio isn't set up yet (no credentials). Configure it in Settings → Channels first." };
      }
      if (channel === 'sms') updateTwilioSettings({ smsEnabled: enabled });
      else updateTwilioSettings({ voiceEnabled: enabled });
      const label = channel === 'sms' ? 'Twilio SMS' : 'Twilio voice calls';
      const note = enabled && !cfg.enabled ? ' (note: Twilio itself is still off — enable it too for this to take effect)' : '';
      return { ok: true, message: `${label} ${enabled ? 'enabled' : 'disabled'}.${note}` };
    }
    default:
      return { ok: false, message: `Unknown channel "${channel}".` };
  }
}
