import { z } from 'zod';
import { BEHAVES_LIKE_PROFILES } from '../agent/model-contract.js';
import {
  STREAM_PATIENCE_MIN_MS, STREAM_PATIENCE_MAX_MS,
  PREFILL_THROUGHPUT_MIN_TOK_PER_SEC, PREFILL_THROUGHPUT_MAX_TOK_PER_SEC,
} from '../agent/stream-patience.js';

export const SecretsSchema = z.object({
  jwt_secret: z.string().optional(),
  dashboard_password_hash: z.string().optional(),
  // agent_credentials encryption key (32 bytes, hex), made on first use; rotating it voids every credential.
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

// The patience pair, shared by the create and edit schemas so both doors agree on a legal bound.
// Messages speak seconds and minutes, not the stored milliseconds, because a person reads them.
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

// Declared prefill throughput in tokens/sec; zero is not a real speed, so there is no "0 means no cap".
// Bounds come from agent/stream-patience.ts, where resolveDoomCeiling checks the same ones,
// so a stored value is honoured.
const prefillTokensPerSec: z.ZodOptional<z.ZodNullable<z.ZodNumber>> =
  z.number()
    .int('`prefillTokensPerSec` must be a whole number of tokens per second')
    .min(PREFILL_THROUGHPUT_MIN_TOK_PER_SEC, `\`prefillTokensPerSec\` must be at least ${PREFILL_THROUGHPUT_MIN_TOK_PER_SEC} token/sec`)
    .max(PREFILL_THROUGHPUT_MAX_TOK_PER_SEC, `\`prefillTokensPerSec\` must be at most ${PREFILL_THROUGHPUT_MAX_TOK_PER_SEC} tokens/sec`)
    .nullable()
    .optional();

const prefillThroughputFields = { prefillTokensPerSec };

export const CreateProviderSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'ID must be lowercase alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(128),
  type: z.enum(['anthropic', 'openai', 'openai-compatible', 'ollama']),
  baseUrl: z.string().url().optional().nullable(),
  authType: z.enum(['api_key', 'oauth', 'none', 'agent-sdk']),
  credential: z.string().optional(),
  // The dialect this endpoint speaks, limited to the contract profile list so it always resolves.
  behavesLike: z.enum(BEHAVES_LIKE_PROFILES).optional().nullable(),
  // Inside what resolveStreamPatience honours (it has no floor); whole ms only, a fraction is a unit mistake.
  ...streamPatienceFields,
  ...prefillThroughputFields,
});


// Narrow edit doors: POST /providers over an existing id replaces every identity field, so a one-field edit
// through it could rewrite the provider. `.strict()` refuses any field a door does not own.
export const ProviderPatienceSchema = z.object(streamPatienceFields).strict()
  .refine(
    b => b.firstChunkTimeoutMs !== undefined || b.streamIdleTimeoutMs !== undefined,
    { message: 'Body must name at least one of `firstChunkTimeoutMs` or `streamIdleTimeoutMs` (a number of milliseconds, or null to use the standard bound)' },
  );


// The same narrow door, for declared prefill throughput.
export const ProviderPrefillThroughputSchema = z.object(prefillThroughputFields).strict()
  .refine(
    b => b.prefillTokensPerSec !== undefined,
    { message: 'Body must name `prefillTokensPerSec` (a whole number of tokens per second, or null to leave throughput undeclared)' },
  );


// Narrow identity edit: only named fields are written. `credential` is a rotation; omitted keeps the stored
// key. The route refuses type, id and authType by name, since changing them makes a different provider.
export const EditProviderSchema = z.object({
  name: z.string().min(1, '`name` cannot be empty').max(128, '`name` must be at most 128 characters').optional(),
  baseUrl: z.string().url('`baseUrl` must be a URL').nullable().optional(),
  behavesLike: z.enum(BEHAVES_LIKE_PROFILES).nullable().optional(),
  credential: z.string().min(1, '`credential` must be a key, or omitted to keep the stored one').optional(),
}).strict()
  .refine(
    b => Object.keys(b).length > 0,
    { message: 'Body must name at least one of `name`, `baseUrl`, `behavesLike` or `credential`' },
  );


export const LoginSchema = z.object({
  password: z.string().min(1),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// Attachments are fully validated: they persist into the immutable store and reach the model's file_read.
// `category` is the closed upload set (AttachmentCategory in gateway/routes/chat.ts).
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

export const EnableModelsSchema = z.object({
  modelIds: z.array(z.string()).min(1),
});

// Per-agent silent window in whole minutes, 1 or more; null = the default (120 minutes).
// No upper bound on purpose: a known-slow agent may get as long as its owner wants.
export const SilentWindowMinutesSchema = z.number().int('a whole number of minutes').min(1, 'at least 1 minute').nullable();
