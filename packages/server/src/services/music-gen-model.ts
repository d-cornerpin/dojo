// ════════════════════════════════════════
// services/music-gen-model.ts — music generation model resolver.
//
// Platform-wide config key points at one music-generation-capable model
// (e.g. Google Lyria 3) that the `music_create` tool dispatches to. Mirrors
// audio-gen-model.ts / image-gen-model.ts. Capability is `music_generation`
// (prompt-in, original-composition-out), distinct from `audio_generation`
// (GPT Audio voice/general).
// ════════════════════════════════════════

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const MUSIC_GEN_MODEL_CONFIG_KEY = 'dojo_music_gen_model_id';

export type MusicGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: MUSIC_GEN_MODEL_CONFIG_KEY,
  capability: 'music_generation',
  loggerName: 'music-gen-model',
});

export const getConfiguredMusicGenModelId = (): string | null => resolver.getConfiguredModelId();

export const setConfiguredMusicGenModelId = (modelId: string | null): void =>
  resolver.setConfiguredModelId(modelId);

export const getEffectiveMusicGenModel = (): MusicGenModelChoice | null => resolver.getEffectiveModel();
