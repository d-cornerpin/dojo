// ════════════════════════════════════════
// services/video-gen-model.ts — video-generation model resolver.
//
// Platform-wide config key points at one video-capable model that the
// `video_create` tool dispatches to. Mirrors image-gen-model.ts.
// ════════════════════════════════════════

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const VIDEO_GEN_MODEL_CONFIG_KEY = 'dojo_video_gen_model_id';

export type VideoGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: VIDEO_GEN_MODEL_CONFIG_KEY,
  capability: 'video_generation',
  loggerName: 'video-gen-model',
});

export const getConfiguredVideoGenModelId = (): string | null => resolver.getConfiguredModelId();

export const setConfiguredVideoGenModelId = (modelId: string | null): void =>
  resolver.setConfiguredModelId(modelId);

export const getEffectiveVideoGenModel = (): VideoGenModelChoice | null => resolver.getEffectiveModel();
