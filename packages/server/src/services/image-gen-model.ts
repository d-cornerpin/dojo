// ════════════════════════════════════════
// services/image-gen-model.ts — image-generation model resolver.
//
// A thin wrapper around makeCapabilityModelResolver. Image generation
// is a model capability, not an agent role: a single platform-wide
// config key points at one image-capable model that the `image_create`
// tool calls directly. Replaces the original Imaginer agent.
// ════════════════════════════════════════

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const IMAGE_GEN_MODEL_CONFIG_KEY = 'dojo_image_gen_model_id';

export type ImageGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: IMAGE_GEN_MODEL_CONFIG_KEY,
  capability: 'image_generation',
  loggerName: 'image-gen-model',
});

export const getConfiguredImageGenModelId = (): string | null => resolver.getConfiguredModelId();

export const setConfiguredImageGenModelId = (modelId: string | null): void =>
  resolver.setConfiguredModelId(modelId);

export const getEffectiveImageGenModel = (): ImageGenModelChoice | null => resolver.getEffectiveModel();
