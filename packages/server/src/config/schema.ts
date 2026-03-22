import { z } from 'zod';

// ── Secrets.yaml Schema ──
export const SecretsSchema = z.object({
  jwt_secret: z.string().optional(),
  dashboard_password_hash: z.string().optional(),
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

// ── Provider Creation Schema ──
export const CreateProviderSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'ID must be lowercase alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(128),
  type: z.enum(['anthropic', 'openai', 'openai-compatible', 'ollama']),
  baseUrl: z.string().url().optional().nullable(),
  authType: z.enum(['api_key', 'oauth', 'none']),
  credential: z.string().optional(),
});

export type CreateProviderInput = z.infer<typeof CreateProviderSchema>;

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
export const SendMessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.object({
    fileId: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    path: z.string(),
    category: z.string(),
  })).optional(),
});

// ── Enable/Disable Models Schema ──
export const EnableModelsSchema = z.object({
  modelIds: z.array(z.string()).min(1),
});
