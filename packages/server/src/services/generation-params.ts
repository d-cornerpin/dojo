// ════════════════════════════════════════
// services/generation-params.ts — per-model generation parameter specs.
//
// Two layers (see migration 065):
//   1. Agent → tool: the agent must supply a fixed set of canonical params
//      (video: duration / aspect_ratio / resolution). The dispatcher calls
//      validateCanonicalParams() and kicks the call back to the agent when a
//      param is missing or out of the allowed set for the chosen model.
//   2. Tool → model: buildWireBody() translates the validated canonical
//      values into the provider's request-body fields per the model's spec.
//
// Specs are seeded from the family registry below on add (and on a boot
// backfill), stored per model in models.generation_params, and editable by
// the user on the Settings model card. The registry is only the seed source;
// we never overwrite a stored spec (it may contain user edits).
// ════════════════════════════════════════

import type { GenerationParamSpec, GenerationParamField } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('generation-params');

// Canonical params the agent must supply, per generation kind. Video first.
export const VIDEO_CANONICAL_PARAMS = ['duration', 'aspect_ratio', 'resolution'] as const;

// ── Family registry: seed specs keyed by api_model_id family ──

function videoSpec(opts: {
  durationValues?: number[];
  durationMin?: number;
  durationMax?: number;
  durationDefault: number;
  aspects: string[];
  aspectDefault: string;
  resolutions: string[];
  resolutionDefault: string;
}): GenerationParamSpec {
  return {
    duration: {
      accepted: true,
      values: opts.durationValues ?? [],
      min: opts.durationMin,
      max: opts.durationMax,
      default: opts.durationDefault,
      // OpenRouter's normalized /v1/videos body takes `duration` as an
      // integer (seconds). Sending `seconds` (the OpenAI/Sora spelling) is
      // silently ignored, so the provider falls back to its own default.
      wireField: 'duration',
      wireType: 'number',
    },
    aspect_ratio: {
      accepted: true,
      values: opts.aspects,
      default: opts.aspectDefault,
      wireField: 'size',
      wireType: 'string',
    },
    resolution: {
      accepted: true,
      values: opts.resolutions,
      default: opts.resolutionDefault,
      wireField: 'size',
      wireType: 'string',
    },
  };
}

// These are sensible STARTING points seeded onto the model and then editable
// on the card. OpenRouter's catalog does not expose video param schemas, so
// the true accepted ranges per model are confirmed/corrected by the user.
// Video models accept only a fixed, discrete set of durations (the provider
// silently clamps anything else to its default). The values below come from
// OpenRouter's GET /api/v1/videos/models capability report per family.
const GENERIC_VIDEO = videoSpec({
  durationValues: [4, 5, 6, 8, 10, 12], durationDefault: 5,
  aspects: ['16:9', '9:16', '1:1'], aspectDefault: '16:9',
  resolutions: ['720p', '1080p'], resolutionDefault: '720p',
});
const SEEDANCE_VIDEO = videoSpec({
  durationValues: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], durationDefault: 5,
  aspects: ['16:9', '9:16', '1:1'], aspectDefault: '16:9',
  resolutions: ['480p', '720p', '1080p'], resolutionDefault: '720p',
});
const VEO_VIDEO = videoSpec({
  durationValues: [4, 6, 8], durationDefault: 8,
  aspects: ['16:9', '9:16'], aspectDefault: '16:9',
  resolutions: ['720p', '1080p'], resolutionDefault: '720p',
});

export function defaultVideoSpecFor(apiModelId: string): GenerationParamSpec {
  const id = apiModelId.toLowerCase();
  if (id.includes('seedance')) return structuredClone(SEEDANCE_VIDEO);
  if (id.includes('veo')) return structuredClone(VEO_VIDEO);
  return structuredClone(GENERIC_VIDEO);
}

// ── Validation (agent → tool boundary) ──

export interface CanonicalValidationResult {
  ok: boolean;
  errors: string[]; // human-readable, used to build the kick-back message
  normalized: Record<string, string | number>;
}

function validateValue(
  field: GenerationParamField,
  raw: unknown,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (field.values.length > 0) {
    const match = field.values.find((v) => String(v) === String(raw));
    if (match === undefined) {
      return { ok: false, message: `must be one of: ${field.values.join(', ')}` };
    }
    return { ok: true, value: match };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { ok: false, message: 'must be a number' };
  if (field.min !== undefined && n < field.min) return { ok: false, message: `must be >= ${field.min}` };
  if (field.max !== undefined && n > field.max) return { ok: false, message: `must be <= ${field.max}` };
  return { ok: true, value: n };
}

function presenceHint(field: GenerationParamField | undefined): string {
  if (!field) return '';
  if (field.values.length > 0) return ` (one of: ${field.values.join(', ')})`;
  if (field.min !== undefined || field.max !== undefined) {
    return ` (between ${field.min ?? '?'} and ${field.max ?? '?'})`;
  }
  return '';
}

// The agent must supply every canonical param regardless of whether this
// model accepts it on the wire (uniform tool contract). Values are checked
// against the model's allowed set when the spec defines the param.
export function validateCanonicalParams(
  spec: GenerationParamSpec | null,
  canonicalNames: readonly string[],
  provided: Record<string, unknown>,
): CanonicalValidationResult {
  const errors: string[] = [];
  const normalized: Record<string, string | number> = {};

  for (const name of canonicalNames) {
    const field = spec?.[name];
    const raw = provided[name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      errors.push(`${name} is required${presenceHint(field)}`);
      continue;
    }
    if (field) {
      const res = validateValue(field, raw);
      if (!res.ok) {
        errors.push(`${name} ${res.message}`);
        continue;
      }
      normalized[name] = res.value;
    } else {
      normalized[name] = typeof raw === 'number' ? raw : String(raw);
    }
  }

  return { ok: errors.length === 0, errors, normalized };
}

// ── Wire mapping (tool → model boundary) ──

// Compose a WIDTHxHEIGHT size string from aspect ratio + resolution. This is
// the one composite: video providers take a single `size` field, but the
// agent thinks in aspect_ratio + resolution.
export function composeSize(aspect: string, resolution: string): string {
  const h = resolution.includes('1080') ? 1080 : resolution.includes('480') ? 480 : 720;
  const long = Math.round((h * 16) / 9);
  switch (aspect) {
    case '9:16':
      return `${h}x${long}`;
    case '1:1':
      return `${h}x${h}`;
    case '16:9':
    default:
      return `${long}x${h}`;
  }
}

// Translate validated canonical values into the provider request body. Only
// params marked accepted are emitted; params sharing wireField `size` are
// composed from aspect_ratio + resolution.
export function buildWireBody(
  spec: GenerationParamSpec,
  normalized: Record<string, string | number>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const wireFields = new Set<string>();

  for (const [name, field] of Object.entries(spec)) {
    if (!field.accepted) continue;
    if (!(name in normalized)) continue;
    wireFields.add(field.wireField);
    if (field.wireField === 'size') continue; // handled below as a composite
    body[field.wireField] = field.wireType === 'string' ? String(normalized[name]) : Number(normalized[name]);
  }

  if (wireFields.has('size')) {
    const aspect = typeof normalized['aspect_ratio'] === 'string' ? (normalized['aspect_ratio'] as string) : '16:9';
    const resolution = typeof normalized['resolution'] === 'string' ? (normalized['resolution'] as string) : '720p';
    body.size = composeSize(aspect, resolution);
  }

  return body;
}

// ── DB helpers + seeding ──

export function getModelGenerationParams(modelId: string): GenerationParamSpec | null {
  const db = getDb();
  const row = db.prepare('SELECT generation_params FROM models WHERE id = ?').get(modelId) as
    | { generation_params: string | null }
    | undefined;
  if (!row || !row.generation_params) return null;
  try {
    return JSON.parse(row.generation_params) as GenerationParamSpec;
  } catch {
    return null;
  }
}

export function setModelGenerationParams(modelId: string, spec: GenerationParamSpec): void {
  const db = getDb();
  db.prepare("UPDATE models SET generation_params = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(spec),
    modelId,
  );
}

// Seed a video model's spec from the family registry, but only if it has no
// stored spec yet (never clobber user edits).
export function seedGenerationParams(modelId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id, api_model_id, capabilities, generation_params FROM models WHERE id = ?')
    .get(modelId) as
    | { id: string; api_model_id: string; capabilities: string; generation_params: string | null }
    | undefined;
  if (!row || row.generation_params) return;

  let caps: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) caps = parsed;
  } catch {
    /* malformed caps → treat as none */
  }
  if (!caps.includes('video_generation')) return; // video only for now

  setModelGenerationParams(row.id, defaultVideoSpecFor(row.api_model_id));
  logger.info('Seeded generation params', { modelId: row.id, apiModelId: row.api_model_id });
}

// Boot backfill: seed any video model that lacks a spec.
export function backfillGenerationParams(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM models WHERE generation_params IS NULL AND capabilities LIKE '%video_generation%'")
    .all() as Array<{ id: string }>;
  if (rows.length === 0) {
    logger.info('Generation params backfill: nothing to seed');
    return;
  }
  for (const r of rows) seedGenerationParams(r.id);
  logger.info('Generation params backfill complete', { seeded: rows.length });
}
