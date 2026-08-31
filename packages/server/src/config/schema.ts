import { z } from 'zod';
import { BEHAVES_LIKE_PROFILES } from '../agent/model-contract.js';
import { STREAM_PATIENCE_MIN_MS, STREAM_PATIENCE_MAX_MS } from '../agent/stream-patience.js';

// ── Secrets.yaml Schema ──
export const SecretsSchema = z.object({
  jwt_secret: z.string().optional(),
  dashboard_password_hash: z.string().optional(),
  // v2.7.21 - master key for agent_credentials encryption (AES-256-GCM).
  // 32 random bytes, hex-encoded (64 chars). Auto-generated on first
  // read if missing. Rotating this invalidates every stored credential.
  credential_master_key: z.string().optional(),
  providers: z.record(z.string(), z.object({
    api_key: z.string().optional(),
    oauth_token: z.string().optional(),
  })).optional(),
  search: z.object({
    provider: z.string().optional(),
    api_key: z.string().optional(),
  }).optional(),
});

export type SecretsData = z.infer<typeof SecretsSchema>;

// ── The declarable patience pair (T64b), shared by both write doors ──
//
// One definition, used by the create schema and the edit schema, so the two doors cannot
// disagree about what a legal bound is. The message names the seconds a person would think in
// rather than the milliseconds the column stores, because it is the text a user reads.
const patienceMs = (what: string): z.ZodOptional<z.ZodNullable<z.ZodNumber>> =>
  z.number()
    .int(`\`${what}\` must be a whole number of milliseconds`)
    .min(STREAM_PATIENCE_MIN_MS, `\`${what}\` must be at least ${STREAM_PATIENCE_MIN_MS / 1000} seconds`)
    .max(STREAM_PATIENCE_MAX_MS, `\`${what}\` must be at most ${STREAM_PATIENCE_MAX_MS / 60_000} minutes`)
    .nullable()
    .optional();

const streamPatienceFields = {
  firstChunkTimeoutMs: patienceMs('firstChunkTimeoutMs'),
  streamIdleTimeoutMs: patienceMs('streamIdleTimeoutMs'),
};

// ── Provider Creation Schema ──
export const CreateProviderSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'ID must be lowercase alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(128),
  type: z.enum(['anthropic', 'openai', 'openai-compatible', 'ollama']),
  baseUrl: z.string().url().optional().nullable(),
  authType: z.enum(['api_key', 'oauth', 'none', 'agent-sdk']),
  credential: z.string().optional(),
  // T63: the dialect the owner declares this endpoint speaks. Validated against the contract
  // profile list itself, so a name that cannot be resolved can never be stored — the manual
  // picker's whole value is that this field is TRUE about the server behind the URL.
  behavesLike: z.enum(BEHAVES_LIKE_PROFILES).optional().nullable(),
  // T64b: how long this endpoint is worth waiting for. Validated against the SAME bounds
  // `resolveStreamPatience` honours, imported from the one module that owns them, so a value
  // that can be stored can always be honoured. Whole milliseconds only — a fractional
  // timeout is a unit mistake, not a preference.
  ...streamPatienceFields,
});

export type CreateProviderInput = z.infer<typeof CreateProviderSchema>;

// ── Provider Response-Patience Schema (T64b) ──
//
// The edit door, in the shape `PATCH /providers/:id/host-ram` already established: ONE
// property, changed on a provider that already exists. It has to be narrow. `POST /providers`
// over an existing id is a full replace of the identity fields (T63 recorded that as
// deliberate), so editing a timeout through it would mean re-sending name, type, base URL,
// auth type and dialect — and getting any of them wrong would silently rewrite the provider.
// `.strict()` refuses a body carrying anything else, so a caller cannot smuggle an identity
// field through the narrow door either.
export const ProviderPatienceSchema = z.object(streamPatienceFields).strict()
  .refine(
    b => b.firstChunkTimeoutMs !== undefined || b.streamIdleTimeoutMs !== undefined,
    { message: 'Body must name at least one of `firstChunkTimeoutMs` or `streamIdleTimeoutMs` (a number of milliseconds, or null to use the standard bound)' },
  );

export type ProviderPatienceInput = z.infer<typeof ProviderPatienceSchema>;

// ── Model Schema ──
export const ModelDataSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  apiModelId: z.string(),
  capabilities: z.array(z.string()),
  contextWindow: z.number().nullable(),
  inputCostPerM: z.number().nullable(),
  outputCostPerM: z.number().nullable(),
  isEnabled: z.boolean().default(false),
});

export type ModelDataInput = z.infer<typeof ModelDataSchema>;

// ── Login Schema ──
export const LoginSchema = z.object({
  password: z.string().min(1),
});

// ── Change Password Schema ──
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// ── Send Message Schema ──
// The attachment shape is validated (not just Array.isArray'd) because these
// pointers are persisted into the immutable message store and handed to the
// model's file_read: a missing path/filename/size used to interpolate a literal
// "Path: undefined" the model then dutifully tried to read (FA-G1). `category`
// is the closed upload set (matches AttachmentCategory in chat.ts).
export const SendMessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.object({
    fileId: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string(),
    size: z.number(),
    path: z.string().min(1),
    category: z.enum(['unknown', 'text', 'image', 'pdf', 'office', 'audio', 'video']),
  })).optional(),
});

// ── Enable/Disable Models Schema ──
export const EnableModelsSchema = z.object({
  modelIds: z.array(z.string()).min(1),
});
