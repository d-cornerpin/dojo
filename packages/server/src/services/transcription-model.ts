// Transcription (STT) model resolver. Unlike the other capability resolvers, two of its "providers" are not
// models in the DB: the local Whisper and Moonshine engines behind phone-mode STT, surfaced as the ids
// `local:whisper` and `local:moonshine`. Those return a synthetic choice with `kind: 'local'` and a
// `localEngine`, dispatched with no cloud call; any other value goes through the capability-model factory
// (the row must be enabled and have the `transcription` capability).

import { makeCapabilityModelResolver, type CapabilityModelChoice } from './capability-model.js';

export const TRANSCRIPTION_MODEL_CONFIG_KEY = 'dojo_transcription_model_id';

export type LocalTranscriptionEngine = 'whisper' | 'moonshine';

export const LOCAL_TRANSCRIPTION_IDS = ['local:whisper', 'local:moonshine'] as const;
export type LocalTranscriptionId = (typeof LOCAL_TRANSCRIPTION_IDS)[number];

export type TranscriptionModelChoice =
  | { kind: 'cloud'; modelId: string; providerId: string; apiModelId: string }
  | { kind: 'local'; localEngine: LocalTranscriptionEngine };

const cloudResolver = makeCapabilityModelResolver({
  configKey: TRANSCRIPTION_MODEL_CONFIG_KEY,
  capability: 'transcription',
  loggerName: 'transcription-model',
});

function isLocalId(value: string): value is LocalTranscriptionId {
  return (LOCAL_TRANSCRIPTION_IDS as readonly string[]).includes(value);
}

export function setConfiguredTranscriptionModelId(modelId: string | null): void {
  cloudResolver.setConfiguredModelId(modelId);
}

export function getEffectiveTranscriptionModel(): TranscriptionModelChoice | null {
  const configured = cloudResolver.getConfiguredModelId();
  if (!configured) return null;
  if (isLocalId(configured)) {
    const engine: LocalTranscriptionEngine =
      configured === 'local:whisper' ? 'whisper' : 'moonshine';
    return { kind: 'local', localEngine: engine };
  }
  const cloud = cloudResolver.getEffectiveModel();
  if (!cloud) return null;
  return {
    kind: 'cloud',
    modelId: (cloud as CapabilityModelChoice).modelId,
    providerId: (cloud as CapabilityModelChoice).providerId,
    apiModelId: (cloud as CapabilityModelChoice).apiModelId,
  };
}
