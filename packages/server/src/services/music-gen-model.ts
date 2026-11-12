// Resolves the music-generation model that `music_create` dispatches to (capability `music_generation`,
// distinct from `audio_generation`). Mirrors audio-gen-model.ts and image-gen-model.ts.

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const MUSIC_GEN_MODEL_CONFIG_KEY = 'dojo_music_gen_model_id';

export type MusicGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: MUSIC_GEN_MODEL_CONFIG_KEY,
  capability: 'music_generation',
  loggerName: 'music-gen-model',
});

export const setConfiguredMusicGenModelId = (modelId: string | null): void =>
  resolver.setConfiguredModelId(modelId);

export const getEffectiveMusicGenModel = (): MusicGenModelChoice | null => resolver.getEffectiveModel();
