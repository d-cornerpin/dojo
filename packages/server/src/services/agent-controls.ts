// ════════════════════════════════════════
// services/agent-controls.ts — backs the agent's "control the dojo on the
// user's behalf" tools. Right now: setting a platform capability model.
//
// Kept out of the giant tools.ts so the validation reads clearly and can be
// unit-tested. Architecture rule #1 (the engine enforces): the agent can
// only touch the specific, validated settings enumerated here — there is no
// "write an arbitrary config key" path. Each capability maps to its existing
// resolver's setter, and we validate the model is enabled and actually has
// the capability before writing, so a bad pick returns the valid options
// instead of silently configuring an unusable model.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getModelCapabilities, type Capability } from './capabilities.js';
import { setConfiguredImageGenModelId } from './image-gen-model.js';
import { setConfiguredVideoGenModelId } from './video-gen-model.js';
import { setConfiguredAudioGenModelId } from './audio-gen-model.js';
import { setConfiguredMusicGenModelId } from './music-gen-model.js';
import { setConfiguredFallbackVisionModelId } from './vision-model.js';
import { setConfiguredTranscriptionModelId, LOCAL_TRANSCRIPTION_IDS } from './transcription-model.js';
import { listVoices } from '../voice/tts-service.js';
import { isHumeConfigured, listHumeVoices } from '../voice/hume-engine.js';

/** Upsert a single config key. Mirrors the resolver setters' write shape. */
function setConfig(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

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
 * Validate, then set the platform-wide model for a capability. Accepts an
 * enabled model id that has the capability, or a recognized local-engine id
 * (transcription only). Returns a user-facing message either way; on failure
 * the message lists the valid options so the agent can self-correct rather
 * than report a dead end.
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

  const row = getDb()
    .prepare(`SELECT id, name, is_enabled FROM models WHERE id = ?`)
    .get(id) as { id: string; name: string; is_enabled: number } | undefined;

  const options = listModelsForCapability(slot);
  const optionList = options.length
    ? options.map(o => `- ${o.id} (${o.name}, ${o.providerName})`).join('\n')
    : '(no enabled model currently has this capability — add/enable one in Settings → Models first)';

  if (!row) {
    return { ok: false, message: `No model with id "${id}" exists. Models that can do ${target.label}:\n${optionList}` };
  }
  if (!row.is_enabled) {
    return { ok: false, message: `Model "${row.name}" (${id}) is disabled. Enable it in Settings → Models first, or pick one that's already enabled:\n${optionList}` };
  }
  if (!getModelCapabilities(id).includes(target.capability)) {
    return { ok: false, message: `Model "${row.name}" (${id}) isn't marked as ${target.label}-capable. Pick one of:\n${optionList}` };
  }

  target.set(id);
  return { ok: true, message: `Set the ${target.label} model to "${row.name}" (${id}).` };
}

// ── Voice ───────────────────────────────────────────────────────────────
// Change the voice the agent speaks with and/or its playback speed. Voice
// names are matched against the local Kokoro library (built-in + imported)
// first, then the Hume cloud library if cloud TTS is set up — flipping the
// TTS engine to match. Voice settings are read fresh when a voice session
// starts (voice-ws.ts), so a plain config write is all that's needed.

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
      setConfig('voice.preferred_voice', localMatch.id);
      setConfig('voice.tts_engine', 'local');
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
        setConfig('voice.cloud_voice', cloudMatch.id);
        setConfig('voice.cloud_voice_provider', cloudMatch.provider);
        setConfig('voice.tts_engine', 'cloud');
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
    // Set both engine speeds so "slow down/speed up your voice" behaves the
    // same whether the active engine is local or cloud.
    setConfig('voice.playback_speed', String(s));
    setConfig('voice.cloud_speed', String(s));
    changes.push(`playback speed set to ${s}x`);
  }

  if (changes.length === 0) {
    return { ok: false, message: 'Nothing to change — provide a voice, a speed, or both.' };
  }
  return { ok: true, message: `Done: ${changes.join('; ')}. Takes effect the next time voice mode starts.` };
}

// ── Channels ────────────────────────────────────────────────────────────
// Enable/disable communication channels. iMessage needs its bridge process
// started/stopped in lockstep with the flag (a bare config write does
// nothing until restart) and a configured recipient; Twilio is a flag the
// webhooks/senders check at runtime, but enabling it requires credentials.

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
        setConfig('imessage_enabled', 'true');
        try {
          const { startIMBridge } = await import('./imessage-bridge.js');
          startIMBridge(recipient);
        } catch (err) {
          return { ok: false, message: `Saved the setting, but the bridge failed to start: ${err instanceof Error ? err.message : String(err)}` };
        }
        return { ok: true, message: 'iMessage bridge enabled and started.' };
      }
      setConfig('imessage_enabled', 'false');
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
