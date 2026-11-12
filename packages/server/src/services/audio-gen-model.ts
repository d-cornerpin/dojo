// TTS model resolver: one platform-wide config key names the audio-output model `tts_create` dispatches to.

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

export const AUDIO_GEN_MODEL_CONFIG_KEY = 'dojo_audio_gen_model_id';

export type AudioGenModelChoice = CapabilityModelChoice;

const resolver = makeCapabilityModelResolver({
  configKey: AUDIO_GEN_MODEL_CONFIG_KEY,
  capability: 'audio_generation',
  loggerName: 'audio-gen-model',
});

export const setConfiguredAudioGenModelId = (modelId: string | null): void => {
  resolver.setConfiguredModelId(modelId);
  // The tts_create description embeds the effective model's voice catalog, so a change alters the tool surface.
  bumpToolConfigGeneration();
};

export const getEffectiveAudioGenModel = (): AudioGenModelChoice | null => resolver.getEffectiveModel();
