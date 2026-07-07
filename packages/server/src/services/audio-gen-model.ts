// ════════════════════════════════════════
// services/audio-gen-model.ts — TTS model resolver.
//
// Platform-wide config key points at one audio-output-capable model
// that the `tts_create` tool dispatches to. Mirrors image-gen-model.ts.
// Note: capability is `audio_generation` (TTS-style models). Music /
// sound-effect models use `music_generation` and have their own
// resolver (forthcoming).
// ════════════════════════════════════════

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

export const AUDIO_GEN_MODEL_CONFIG_KEY = 'dojo_audio_gen_model_id';

export type AudioGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: AUDIO_GEN_MODEL_CONFIG_KEY,
  capability: 'audio_generation',
  loggerName: 'audio-gen-model',
});

export const getConfiguredAudioGenModelId = (): string | null => resolver.getConfiguredModelId();

export const setConfiguredAudioGenModelId = (modelId: string | null): void => {
  resolver.setConfiguredModelId(modelId);
  // FA-TS1: the tts_create description embeds the effective audio model's voice
  // catalog, so changing the model changes the advertised tool surface.
  bumpToolConfigGeneration();
};

export const getEffectiveAudioGenModel = (): AudioGenModelChoice | null => resolver.getEffectiveModel();
