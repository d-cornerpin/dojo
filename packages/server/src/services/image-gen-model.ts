// Image generation model resolver: one platform-wide config key names the image-capable model `image_create` calls.
import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const IMAGE_GEN_MODEL_CONFIG_KEY = 'dojo_image_gen_model_id';

export type ImageGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: IMAGE_GEN_MODEL_CONFIG_KEY,
  capability: 'image_generation',
  loggerName: 'image-gen-model',
});

export const setConfiguredImageGenModelId = (modelId: string | null): void =>
  resolver.setConfiguredModelId(modelId);

export const getEffectiveImageGenModel = (): ImageGenModelChoice | null => resolver.getEffectiveModel();
