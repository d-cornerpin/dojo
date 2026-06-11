// ════════════════════════════════════════
// services/voice-catalog.ts — per-model TTS voice catalog.
//
// OpenRouter's model catalog returns `supported_voices: null` for the
// gpt-audio family, so the list of valid voices is not discoverable at
// runtime. We seed it from the code family registry below on add (and a
// boot backfill), store it per model in models.voice_catalog, and let the
// user edit it on the Settings model card. The registry is only the seed
// source; we never overwrite a stored catalog (it may contain user edits).
//
// Two uses for the stored catalog:
//   1. getFilteredTools() injects the configured model's voices (id +
//      character) into the tts_create description so the agent picks a
//      real voice by vibe instead of guessing.
//   2. The tts_create dispatcher validates the agent's chosen voice and
//      kicks the call back when it isn't in the model's set.
//
// The voice id sets the base timbre only. Character/accent/emotion
// (gravelly, elderly, excited, etc.) is steered by writing the delivery
// into the spoken text, not by the voice id — the catalog guidance says so.
// ════════════════════════════════════════

import type { VoiceOption } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

export type { VoiceOption };

const logger = createLogger('voice-catalog');

// Standard OpenAI gpt-audio voice set, shared by openai/gpt-audio and
// openai/gpt-audio-mini.
const OPENAI_GPT_AUDIO_VOICES: VoiceOption[] = [
  { id: 'alloy', description: 'neutral and balanced', gender: 'neutral' },
  { id: 'ash', description: 'clear and articulate', gender: 'male' },
  { id: 'ballad', description: 'smooth and melodic', gender: 'male' },
  { id: 'coral', description: 'vibrant and warm', gender: 'female' },
  { id: 'echo', description: 'resonant and clear', gender: 'male' },
  { id: 'fable', description: 'expressive, warm storyteller', gender: 'male' },
  { id: 'nova', description: 'bright and energetic', gender: 'female' },
  { id: 'onyx', description: 'deep and authoritative', gender: 'male' },
  { id: 'sage', description: 'wise and measured', gender: 'female' },
  { id: 'shimmer', description: 'bright and cheerful', gender: 'female' },
];

// Match by api_model_id family. gpt-audio and gpt-audio-mini both match.
const CATALOG_BY_FAMILY: Array<{ match: (id: string) => boolean; voices: VoiceOption[] }> = [
  { match: (id) => id.includes('gpt-audio'), voices: OPENAI_GPT_AUDIO_VOICES },
];

/**
 * The seed voice catalog for a model from the code family registry, or null
 * when we have no seed for it. This is the seed source only; the live
 * catalog is read from the DB (getModelVoiceCatalog) with this as fallback.
 */
export function defaultVoiceCatalogFor(apiModelId: string): VoiceOption[] | null {
  const id = apiModelId.toLowerCase();
  for (const entry of CATALOG_BY_FAMILY) {
    if (entry.match(id)) return structuredClone(entry.voices);
  }
  return null;
}

export function isKnownVoice(catalog: VoiceOption[], voice: string): boolean {
  const v = voice.trim().toLowerCase();
  return catalog.some((o) => o.id.toLowerCase() === v);
}

/** Compact one-line rendering for prompts/errors: "onyx (male, deep ...); ...". */
export function formatVoiceCatalog(catalog: VoiceOption[]): string {
  return catalog.map((o) => `${o.id} (${o.gender}, ${o.description})`).join('; ');
}

// ── DB helpers + seeding (mirror generation-params.ts) ──

/** The stored voice catalog for a model, or null when none is stored. */
export function getModelVoiceCatalog(modelId: string): VoiceOption[] | null {
  const db = getDb();
  const row = db.prepare('SELECT voice_catalog FROM models WHERE id = ?').get(modelId) as
    | { voice_catalog: string | null }
    | undefined;
  if (!row || !row.voice_catalog) return null;
  try {
    const parsed = JSON.parse(row.voice_catalog);
    return Array.isArray(parsed) ? (parsed as VoiceOption[]) : null;
  } catch {
    return null;
  }
}

export function setModelVoiceCatalog(modelId: string, catalog: VoiceOption[] | null): void {
  const db = getDb();
  db.prepare("UPDATE models SET voice_catalog = ?, updated_at = datetime('now') WHERE id = ?").run(
    catalog ? JSON.stringify(catalog) : null,
    modelId,
  );
}

// Seed a model's voice catalog from the family registry, but only if it has
// no stored catalog yet (never clobber user edits) and the model is
// audio-generation capable.
export function seedVoiceCatalog(modelId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id, api_model_id, capabilities, voice_catalog FROM models WHERE id = ?')
    .get(modelId) as
    | { id: string; api_model_id: string; capabilities: string; voice_catalog: string | null }
    | undefined;
  if (!row || row.voice_catalog) return;

  let caps: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) caps = parsed;
  } catch {
    /* malformed caps → treat as none */
  }
  if (!caps.includes('audio_generation')) return;

  const seed = defaultVoiceCatalogFor(row.api_model_id);
  if (!seed) return; // no family seed for this model — leave NULL
  setModelVoiceCatalog(row.id, seed);
  logger.info('Seeded voice catalog', { modelId: row.id, apiModelId: row.api_model_id });
}

// Boot backfill: seed any audio-generation model that lacks a catalog.
export function backfillVoiceCatalog(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM models WHERE voice_catalog IS NULL AND capabilities LIKE '%audio_generation%'")
    .all() as Array<{ id: string }>;
  if (rows.length === 0) {
    logger.info('Voice catalog backfill: nothing to seed');
    return;
  }
  for (const r of rows) seedVoiceCatalog(r.id);
  logger.info('Voice catalog backfill complete', { scanned: rows.length });
}
