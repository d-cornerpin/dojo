import type {
  ApiResponse,
  LoginResponse,
  AuthMeResponse,
  SetupStatusResponse,
  CreateProviderRequest,
  ProviderResponse,
  ProvidersListResponse,
  ProviderModelsResponse,
  ModelsListResponse,
  IdentityFileResponse,
  GenerateIdentityRequest,
  GenerateIdentityResponse,
  SendMessageResponse,
  ChatHistoryResponse,
  AgentsListResponse,
  AgentDetailResponse,
  HealthResponse,
  LogsResponse,
  DagApiResponse,
  SummaryDetailResponse,
  SearchResultsResponse,
  BriefingResponse,
  InjectMemoryResponse,
  CompactionResponse,
  ProjectsListResponse,
  ProjectDetailResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  TasksListResponse,
  TaskDetailResponse,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateAgentRequest,
  AgentMessagesResponse,
} from '@dojo/shared';

const BASE_URL = '/api';

const getToken = (): string | null => localStorage.getItem('dojo_token');

const setToken = (token: string): void => {
  localStorage.setItem('dojo_token', token);
};

const clearToken = (): void => {
  localStorage.removeItem('dojo_token');
};

// Read CSRF token from cookie (non-httpOnly, accessible to JS)
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? match[1] : null;
}

export const request = async <T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> => {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Add CSRF token for state-changing requests
  const method = options.method?.toUpperCase() ?? 'GET';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
      credentials: 'same-origin', // Send cookies with requests
    });

    if (response.status === 401 && !path.startsWith('/auth/login')) {
      clearToken();
      window.location.href = '/login';
      return { ok: false, error: 'Unauthorized' };
    }

    const text = await response.text();
    if (!text) {
      return { ok: false, error: `Empty response (status ${response.status})` };
    }
    try {
      return JSON.parse(text) as ApiResponse<T>;
    } catch {
      return { ok: false, error: `Server error (status ${response.status})` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
};

// ── Auth ──

export const login = async (password: string): Promise<ApiResponse<LoginResponse>> => {
  const result = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (result.ok) {
    setToken(result.data.token);
    // CSRF token is set via Set-Cookie header (non-httpOnly cookie)
  }
  return result;
};

export const checkAuth = async (): Promise<ApiResponse<AuthMeResponse>> => {
  return request<AuthMeResponse>('/auth/me');
};

export const changePassword = async (
  currentPassword: string,
  newPassword: string,
): Promise<ApiResponse<void>> => {
  return request<void>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
};

// ── Setup ──

export const getSetupStatus = async (): Promise<ApiResponse<SetupStatusResponse>> => {
  return request<SetupStatusResponse>('/setup/status');
};

// ── Providers ──

export const createProvider = async (
  data: CreateProviderRequest,
): Promise<ApiResponse<ProviderResponse>> => {
  return request<ProviderResponse>('/config/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const getProviders = async (): Promise<ApiResponse<ProvidersListResponse>> => {
  return request<ProvidersListResponse>('/config/providers');
};

export const deleteProvider = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/config/providers/${id}`, {
    method: 'DELETE',
  });
};

export const validateProvider = async (id: string): Promise<ApiResponse<{ valid: boolean }>> => {
  return request<{ valid: boolean }>(`/config/providers/${id}/validate`, {
    method: 'POST',
  });
};

export const getProviderModels = async (
  id: string,
): Promise<ApiResponse<ProviderModelsResponse>> => {
  return request<ProviderModelsResponse>(`/config/providers/${id}/models`);
};

// ── Browse Models (OpenRouter / aggregator providers) ──

export interface BrowseModelResult {
  apiModelId: string;
  name: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputCostPerM: number | null;
  outputCostPerM: number | null;
  // Optional: when provided via manual add, these are stored directly
  // instead of probing the provider catalog.
  capabilities?: string[];
}

export const browseProviderModels = async (providerId: string, query: string): Promise<ApiResponse<BrowseModelResult[]>> => {
  return request<BrowseModelResult[]>(`/config/providers/${providerId}/browse-models?q=${encodeURIComponent(query)}`);
};

export const addProviderModel = async (providerId: string, model: BrowseModelResult): Promise<ApiResponse<Record<string, unknown>>> => {
  return request<Record<string, unknown>>(`/config/providers/${providerId}/add-model`, {
    method: 'POST',
    body: JSON.stringify(model),
  });
};

// ── Models ──

export const enableModels = async (modelIds: string[]): Promise<ApiResponse<void>> => {
  return request<void>('/config/models/enable', {
    method: 'POST',
    body: JSON.stringify({ modelIds }),
  });
};

export const disableModels = async (modelIds: string[]): Promise<ApiResponse<{ disabled: number; agentsReassigned: number }>> => {
  return request<{ disabled: number; agentsReassigned: number }>('/config/models/disable', {
    method: 'POST',
    body: JSON.stringify({ modelIds }),
  });
};

export const checkModelUsage = async (modelIds: string[]): Promise<ApiResponse<{ usages: Array<{ modelId: string; modelName: string; usedBy: Array<{ type: string; id: string; name: string }> }> }>> => {
  return request<{ usages: Array<{ modelId: string; modelName: string; usedBy: Array<{ type: string; id: string; name: string }> }> }>('/config/models/check-usage', {
    method: 'POST',
    body: JSON.stringify({ modelIds }),
  });
};

export const getModels = async (): Promise<ApiResponse<ModelsListResponse>> => {
  return request<ModelsListResponse>('/config/models');
};

export const updateModelPricing = async (
  modelId: string,
  pricing: { inputCostPerM?: number; outputCostPerM?: number },
): Promise<ApiResponse<unknown>> => {
  return request(`/config/models/${modelId}/pricing`, {
    method: 'PUT',
    body: JSON.stringify(pricing),
  });
};

export const deleteModel = async (modelId: string): Promise<ApiResponse<unknown>> => {
  return request(`/config/models/${modelId}`, { method: 'DELETE' });
};

export const updateModelThinking = async (
  modelId: string,
  enabled: boolean,
): Promise<ApiResponse<unknown>> => {
  return request(`/config/models/${modelId}/thinking`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
};

export const updateModelNumCtx = async (
  modelId: string,
  override: number | null,
): Promise<ApiResponse<unknown>> => {
  return request(`/config/models/${modelId}/num-ctx`, {
    method: 'PATCH',
    body: JSON.stringify({ override }),
  });
};

export const updateProviderHostRam = async (
  providerId: string,
  ramGb: number | null,
): Promise<ApiResponse<unknown>> => {
  return request(`/config/providers/${providerId}/host-ram`, {
    method: 'PATCH',
    body: JSON.stringify({ ramGb }),
  });
};

// ── Identity ──

export const getIdentity = async (
  file: string,
): Promise<ApiResponse<IdentityFileResponse>> => {
  return request<IdentityFileResponse>(`/config/identity/${file}`);
};

export const updateIdentity = async (
  file: string,
  content: string,
): Promise<ApiResponse<void>> => {
  return request<void>(`/config/identity/${file}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
};

export const generateIdentity = async (
  data: GenerateIdentityRequest,
): Promise<ApiResponse<GenerateIdentityResponse>> => {
  return request<GenerateIdentityResponse>('/config/identity/generate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

// ── Chat ──

export interface AttachmentInfo {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
}

export const uploadFiles = async (agentId: string, files: File[]): Promise<ApiResponse<AttachmentInfo[]>> => {
  const token = getToken();
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    const csrfToken = getCsrfToken();
    const response = await fetch(`${BASE_URL}/upload/${agentId}`, {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      return { ok: false as const, error: data.error ?? 'Upload failed' };
    }
    return { ok: true as const, data: data.data as AttachmentInfo[] };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Upload failed' };
  }
};

export const sendMessage = async (
  agentId: string,
  content: string,
  attachments?: AttachmentInfo[],
): Promise<ApiResponse<SendMessageResponse>> => {
  return request<SendMessageResponse>(`/chat/${agentId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, attachments: attachments?.length ? attachments : undefined }),
  });
};

export const getChatHistory = async (
  agentId: string,
  limit?: number,
  before?: string,
): Promise<ApiResponse<ChatHistoryResponse>> => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', before);
  const query = params.toString();
  return request<ChatHistoryResponse>(`/chat/${agentId}/messages${query ? `?${query}` : ''}`);
};

// ── Agents ──

export const getAgents = async (): Promise<ApiResponse<AgentsListResponse>> => {
  return request<AgentsListResponse>('/agents');
};

export const getAgent = async (id: string): Promise<ApiResponse<AgentDetailResponse>> => {
  return request<AgentDetailResponse>(`/agents/${id}`);
};

export const setAgentModel = async (agentId: string, modelId: string): Promise<ApiResponse<AgentDetailResponse>> => {
  return request<AgentDetailResponse>(`/agents/${agentId}/model`, {
    method: 'PATCH',
    body: JSON.stringify({ modelId }),
  });
};

// ── System ──

export const getHealth = async (): Promise<ApiResponse<HealthResponse>> => {
  return request<HealthResponse>('/health');
};

// Server restart: hits the system route that exits the process so launchd
// brings it back. The response's `mode` distinguishes production (auto-
// restart via launchd) from dev (manual `npm run dev` re-run required).
export interface RestartServerResponse {
  restarting: boolean;
  mode: 'dev' | 'production';
  message: string;
}
export const restartServer = async (): Promise<ApiResponse<RestartServerResponse>> => {
  return request<RestartServerResponse>('/system/restart', { method: 'POST' });
};

// ── Platform backup cleanup ──
// The auto-update flow leaves a full platform.backup-<version> directory
// on disk per update (~100-200MB each). Auto-prune keeps the last 2 after
// every update; these endpoints let the user inspect + manually free more.
// Cleanup runs as a fire-and-forget background job - dashboard polls the
// status endpoint until inProgress flips to false.
export interface PlatformBackupInfo {
  name: string;
  version: string;
  mtime: string;
}
export interface ListPlatformBackupsResponse {
  count: number;
  keepDefault: number;
  backups: PlatformBackupInfo[];
}
export const listPlatformBackups = async (): Promise<ApiResponse<ListPlatformBackupsResponse>> => {
  return request<ListPlatformBackupsResponse>('/update/backups');
};

export interface StartCleanupResponse {
  status: 'started' | 'noop';
  targetCount?: number;
  kept: number;
  message: string;
}
export const cleanupPlatformBackups = async (keep: number = 1): Promise<ApiResponse<StartCleanupResponse>> => {
  return request<StartCleanupResponse>('/update/backups/cleanup', {
    method: 'POST',
    body: JSON.stringify({ keep }),
  });
};

export interface CleanupStatusResponse {
  inProgress: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  deletedCount: number;
  failedCount: number;
  targetCount: number;
  error: string | null;
  remainingOnDisk: number;
}
export const getCleanupStatus = async (): Promise<ApiResponse<CleanupStatusResponse>> => {
  return request<CleanupStatusResponse>('/update/backups/cleanup/status');
};

// ── Plaud integration ──
// Plaud is a meeting-recording service. Auth flow is unusual: the user
// clicks Connect, server spawns the Plaud CLI's `login` subprocess, the
// CLI emits an OAuth URL over WebSocket (`plaud:auth_url`), user opens
// it, completes the flow, server detects subprocess exit and broadcasts
// `plaud:connected`. Dashboard listens to both events.
export interface PlaudStatus {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  loginInProgress: boolean;
  loginUrl: string | null;
}
export const getPlaudStatus = async (): Promise<ApiResponse<PlaudStatus>> => {
  return request<PlaudStatus>('/plaud/status');
};

export const connectPlaud = async (): Promise<ApiResponse<{ status: 'started' | 'already_in_progress'; message: string }>> => {
  return request<{ status: 'started' | 'already_in_progress'; message: string }>('/plaud/connect', { method: 'POST' });
};

export const cancelPlaudConnect = async (): Promise<ApiResponse<{ cancelled: boolean }>> => {
  return request<{ cancelled: boolean }>('/plaud/cancel-connect', { method: 'POST' });
};

export const disconnectPlaud = async (): Promise<ApiResponse<{ disconnected: boolean }>> => {
  return request<{ disconnected: boolean }>('/plaud/disconnect', { method: 'POST' });
};

export const refreshPlaud = async (): Promise<ApiResponse<{ connected: boolean; email: string | null }>> => {
  return request<{ connected: boolean; email: string | null }>('/plaud/refresh', { method: 'POST' });
};

// ── Agent credentials vault ──
// Encrypted store for third-party API credentials that agents collect
// while building techniques. Separate from secrets.yaml (platform-
// managed) and vault entries (knowledge that decays). List endpoint
// returns metadata only; /reveal returns the decrypted value.
export interface CredentialSummary {
  id: string;
  service_name: string;
  description: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  last_accessed_by_agent_id: string | null;
  access_count: number;
}
export interface CredentialRevealed extends CredentialSummary {
  credentials: Record<string, unknown>;
}
export const listCredentials = async (): Promise<ApiResponse<{ count: number; credentials: CredentialSummary[] }>> => {
  return request<{ count: number; credentials: CredentialSummary[] }>('/credentials');
};
export const revealCredential = async (id: string): Promise<ApiResponse<Pick<CredentialRevealed, 'id' | 'service_name' | 'description' | 'credentials'>>> => {
  return request<Pick<CredentialRevealed, 'id' | 'service_name' | 'description' | 'credentials'>>(`/credentials/${encodeURIComponent(id)}/reveal`);
};
export const createCredential = async (input: { service_name: string; credentials: Record<string, unknown>; description?: string | null }): Promise<ApiResponse<{ id: string; service_name: string; description: string | null; created_at: string }>> => {
  return request<{ id: string; service_name: string; description: string | null; created_at: string }>('/credentials', {
    method: 'POST', body: JSON.stringify(input),
  });
};
export const updateCredentialApi = async (id: string, input: { credentials: Record<string, unknown>; description?: string }): Promise<ApiResponse<{ id: string; service_name: string }>> => {
  return request<{ id: string; service_name: string }>(`/credentials/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
};
export const deleteCredential = async (id: string): Promise<ApiResponse<{ deleted: boolean }>> => {
  return request<{ deleted: boolean }>(`/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

// Contacts (v2.9.16): DOJO-native people store.
export interface ContactDto {
  id: string;
  display_name: string;
  preferred_name: string | null;
  emails: string[];
  phones: string[];
  imessage_handles: string[];
  company: string | null;
  role: string | null;
  notes: string | null;
  tags: string[];
  created_by_agent_id: string | null;
  last_updated_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface ContactInputDto {
  display_name?: string;
  preferred_name?: string | null;
  emails?: string[];
  phones?: string[];
  imessage_handles?: string[];
  company?: string | null;
  role?: string | null;
  notes?: string | null;
  tags?: string[];
}
export const listContactsApi = async (params: { q?: string; sort_by?: 'updated' | 'name' | 'company'; sort_dir?: 'asc' | 'desc'; limit?: number; offset?: number } = {}): Promise<ApiResponse<{ count: number; total: number; contacts: ContactDto[] }>> => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.sort_by) qs.set('sort_by', params.sort_by);
  if (params.sort_dir) qs.set('sort_dir', params.sort_dir);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ count: number; total: number; contacts: ContactDto[] }>(`/contacts${suffix}`);
};
export const getContactApi = async (id: string): Promise<ApiResponse<ContactDto>> => {
  return request<ContactDto>(`/contacts/${encodeURIComponent(id)}`);
};
export const createContactApi = async (input: ContactInputDto): Promise<ApiResponse<ContactDto>> => {
  return request<ContactDto>('/contacts', { method: 'POST', body: JSON.stringify(input) });
};
/**
 * Update a contact. Pass `expectedUpdatedAt` for optimistic locking:
 * if the server's current updated_at doesn't match, the response is
 * a 409 with `data.current` containing the server-side record so the
 * UI can show a conflict resolution prompt.
 */
export const updateContactApi = async (
  id: string,
  input: ContactInputDto,
  expectedUpdatedAt?: string,
): Promise<ApiResponse<ContactDto> & { conflictCurrent?: ContactDto }> => {
  const body = expectedUpdatedAt ? { ...input, expected_updated_at: expectedUpdatedAt } : input;
  const res = await request<ContactDto>(`/contacts/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The server includes the current record in data.current on 409 so
    // the UI can re-seed the edit form without an extra GET.
    const errData = (res as { data?: { code?: string; current?: ContactDto } }).data;
    if (errData?.code === 'conflict' && errData.current) {
      return { ...res, conflictCurrent: errData.current };
    }
  }
  return res;
};
export const deleteContactApi = async (id: string): Promise<ApiResponse<{ deleted: boolean }>> => {
  return request<{ deleted: boolean }>(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

// V2CutoverNotice (Part XI) — bulk-reset every idle agent's session.
// Returns count breakdown { reset, busy, errors, total }.
export interface ResetIdleSessionsResponse {
  reset: number;
  busy: number;
  errors: number;
  total: number;
  errorDetails?: Array<{ agentId: string; error: string }>;
}
export const resetIdleSessions = async (): Promise<ApiResponse<ResetIdleSessionsResponse>> => {
  return request<ResetIdleSessionsResponse>('/system/reset-idle-sessions', {
    method: 'POST',
  });
};

// Email/Teams watchers — visible health surface for the integrations'
// background polling. Returned shape mirrors WatcherStatus on the server.
export interface WatcherStatusDto {
  name: 'gmail' | 'outlook' | 'teams';
  running: boolean;
  enabled: boolean;
  connected: boolean;
  pollIntervalMs: number;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastPollError: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  lastCheckedAt: string | null;
  totalPolls: number;
  totalNotifications: number;
  lastNotifiedAt: string | null;
  recentNotifications: Array<{ at: string; from: string; subject: string }>;
}

export interface WatchersResponse {
  gmail: WatcherStatusDto;
  outlook: WatcherStatusDto;
  teams: WatcherStatusDto;
}

export const getWatcherStatus = async (): Promise<ApiResponse<WatchersResponse>> => {
  return request<WatchersResponse>('/system/watchers');
};

export const getLogs = async (
  level?: string,
  component?: string,
  limit?: number,
): Promise<ApiResponse<LogsResponse>> => {
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (component) params.set('component', component);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return request<LogsResponse>(`/system/logs${query ? `?${query}` : ''}`);
};

// ── Setup actions (password set during setup) ──

export const setPassword = async (password: string): Promise<ApiResponse<void>> => {
  return request<void>('/setup/password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
};

export const completeSetup = async (): Promise<ApiResponse<LoginResponse>> => {
  const result = await request<LoginResponse>('/setup/complete', {
    method: 'POST',
  });
  if (result.ok) {
    setToken(result.data.token);
  }
  return result;
};

// ── Platform Settings ──

export const getSetting = async (key: string): Promise<ApiResponse<{ key: string; value: string | null }>> => {
  return request<{ key: string; value: string | null }>(`/config/settings/${key}`);
};

export const setSetting = async (key: string, value: string): Promise<ApiResponse<{ key: string; value: string }>> => {
  return request<{ key: string; value: string }>(`/config/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
};

export const getAllSettings = async (): Promise<ApiResponse<Record<string, string>>> => {
  return request<Record<string, string>>('/config/settings');
};

// ── Voice ──

export interface VoicePreset {
  id: string;
  name: string;
  language: string;
  gender: string;
  /** True when this preset was imported by the user (vs a Kokoro built-in). */
  custom?: boolean;
}

export interface CustomVoiceMeta {
  id: string;
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Male' | 'Female';
  createdAt: string;
}

export interface VoiceModelInfo {
  kind: 'whisper' | 'kokoro';
  id: string;
  filename: string;
  bytes: number;
  installed: boolean;
  label?: string;
  approxBytes?: number | null;
}

export interface VoiceModelsResponse {
  whisper: VoiceModelInfo[];
  kokoro: VoiceModelInfo | null;
  // Moonshine (STT, transformers.js, no native deps). Optional in the type
  // so an older server build that hasn't shipped it still parses cleanly.
  moonshine?: VoiceModelInfo | null;
  defaultWhisper: string;
  // Canonical default STT engine key ('moonshine-base' on v2.9+). Optional
  // so an older server build that lacks the key still parses; the dashboard
  // falls back to defaultWhisper.
  defaultSttModel?: string;
  // True when the native whisper.cpp binary is on disk. The dashboard
  // greys out Whisper rows + the "switch to Whisper" button when this is
  // false (the binary is macOS Homebrew only today).
  whisperBinaryAvailable?: boolean;
  kokoroLoaded: boolean;
  totalDiskBytes: number;
  freeDiskMb: number;
}

export const getVoicePresets = async (): Promise<ApiResponse<{ voices: VoicePreset[]; defaultVoice: string }>> => {
  return request('/voice/voices');
};

export const getVoiceModels = async (): Promise<ApiResponse<VoiceModelsResponse>> => {
  return request('/voice/models');
};

export const installVoiceModel = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string): Promise<ApiResponse<{ kind: string; id: string }>> => {
  // The server returns 202 immediately and streams progress over the
  // `voice:model_download` WS broadcast (whisper-large is ~1.5GB; holding the
  // HTTP response open for ~2 minutes hits Cloudflare's free-tier 524 cap).
  // We poll the models endpoint here so the caller's `await installVoiceModel`
  // still resolves when the file is actually on disk — matches the old UX
  // without anyone having to refactor.
  const kicked = await request<{ kind: string; id: string }>(`/voice/models/${kind}/${encodeURIComponent(id)}`, { method: 'POST' });
  if (!kicked.ok) return kicked;
  const start = Date.now();
  const TIMEOUT_MS = 15 * 60 * 1000;  // 15 min — generous for slow connections + whisper-large
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 1500));
    const models = await request<VoiceModelsResponse>('/voice/models');
    if (!models.ok) continue;  // transient errors during polling are non-fatal
    const installed = kind === 'whisper'
      ? models.data.whisper.find(m => m.id === id)?.installed === true
      : models.data.kokoro?.installed === true;
    if (installed) return { ok: true, data: { kind, id } };
  }
  return { ok: false, error: 'install timed out — check server logs' };
};

export const deleteVoiceModel = async (kind: 'whisper' | 'kokoro' | 'moonshine', id: string): Promise<ApiResponse<{ kind: string; id: string; deleted: boolean }>> => {
  return request(`/voice/models/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

/** Upload a Kokoro voicepack `.bin` and register it under the given id. */
export const importCustomVoice = async (
  args: { id: string; name: string; language: 'en-us' | 'en-gb'; gender: 'Male' | 'Female'; file: File },
): Promise<ApiResponse<CustomVoiceMeta>> => {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const csrf = getCsrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const form = new FormData();
  form.append('id', args.id);
  form.append('name', args.name);
  form.append('language', args.language);
  form.append('gender', args.gender);
  form.append('file', args.file, args.file.name);
  const res = await fetch(`${BASE_URL}/voice/custom-voices`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: form,
  });
  const body = await res.json().catch(() => ({ ok: false, error: `parse failed: ${res.status}` }));
  return body as ApiResponse<CustomVoiceMeta>;
};

export const deleteCustomVoice = async (id: string): Promise<ApiResponse<{ id: string; deleted: boolean }>> => {
  return request(`/voice/custom-voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

/** Fetch a synthesized preview clip as a Blob (audio/wav) for inline <audio> playback. */
export const fetchVoicePreview = async (voice: string, speed = 1, text?: string): Promise<Blob> => {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const csrf = getCsrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE_URL}/voice/preview`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ voice, speed, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`preview failed: ${res.status} ${body}`);
  }
  return res.blob();
};

// ── Hume cloud TTS ──

export interface HumeVoiceInfo {
  id: string;
  name: string;
  provider: 'HUME_AI' | 'CUSTOM_VOICE';
}

export const getHumeStatus = async (): Promise<ApiResponse<{ keySet: boolean }>> => {
  return request('/voice/hume/status');
};

export const setHumeKey = async (apiKey: string): Promise<ApiResponse<{ keySet: boolean }>> => {
  return request('/voice/hume/key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
};

export const clearHumeKey = async (): Promise<ApiResponse<{ keySet: boolean }>> => {
  return request('/voice/hume/key', { method: 'DELETE' });
};

export const listHumeVoices = async (): Promise<ApiResponse<{ voices: HumeVoiceInfo[] }>> => {
  return request('/voice/hume/voices');
};

/**
 * Fetch a preview for the Cloud engine. Distinct from `fetchVoicePreview`
 * because cloud previews carry extra fields (voice provider, delivery
 * description) and route to Hume on the server.
 */
export const fetchCloudVoicePreview = async (args: {
  voice: string;
  voiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
  description?: string;
  speed?: number;
  text?: string;
}): Promise<Blob> => {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const csrf = getCsrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE_URL}/voice/preview`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      engine: 'cloud',
      voice: args.voice,
      voiceProvider: args.voiceProvider,
      description: args.description,
      speed: args.speed ?? 1,
      text: args.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`cloud preview failed: ${res.status} ${body}`);
  }
  return res.blob();
};

// ── Memory ──

export const getMemoryDag = async (
  agentId: string,
  depths?: number[],
): Promise<ApiResponse<DagApiResponse>> => {
  const params = new URLSearchParams();
  if (depths) {
    depths.forEach((d) => params.append('depth', String(d)));
  }
  const query = params.toString();
  return request<DagApiResponse>(`/memory/${agentId}/dag${query ? `?${query}` : ''}`);
};

export const getSummaryDetail = async (
  agentId: string,
  summaryId: string,
): Promise<ApiResponse<SummaryDetailResponse>> => {
  return request<SummaryDetailResponse>(`/memory/${agentId}/summary/${summaryId}`);
};

export const deleteSummary = async (
  agentId: string,
  summaryId: string,
): Promise<ApiResponse<void>> => {
  return request<void>(`/memory/${agentId}/summary/${summaryId}`, {
    method: 'DELETE',
  });
};

export const updateSummary = async (
  agentId: string,
  summaryId: string,
  content: string,
): Promise<ApiResponse<SummaryDetailResponse>> => {
  return request<SummaryDetailResponse>(`/memory/${agentId}/summary/${summaryId}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
};

export const searchMemory = async (
  agentId: string,
  query: string,
  scope?: 'messages' | 'summaries' | 'both',
  limit?: number,
): Promise<ApiResponse<SearchResultsResponse>> => {
  const params = new URLSearchParams();
  params.set('q', query);
  if (scope) params.set('scope', scope);
  if (limit) params.set('limit', String(limit));
  return request<SearchResultsResponse>(`/memory/${agentId}/search?${params.toString()}`);
};

export const injectMemory = async (
  agentId: string,
  content: string,
): Promise<ApiResponse<InjectMemoryResponse>> => {
  return request<InjectMemoryResponse>(`/memory/${agentId}/inject`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
};

export const getBriefing = async (
  agentId: string,
): Promise<ApiResponse<BriefingResponse>> => {
  return request<BriefingResponse>(`/memory/${agentId}/briefing`);
};

export const updateBriefing = async (
  agentId: string,
  content: string,
): Promise<ApiResponse<void>> => {
  return request<void>(`/memory/${agentId}/briefing`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
};

export const regenerateBriefing = async (
  agentId: string,
): Promise<ApiResponse<BriefingResponse>> => {
  return request<BriefingResponse>(`/memory/${agentId}/briefing/regenerate`, {
    method: 'POST',
  });
};

export const triggerCompaction = async (
  agentId: string,
): Promise<ApiResponse<CompactionResponse>> => {
  return request<CompactionResponse>(`/memory/${agentId}/compact`, {
    method: 'POST',
  });
};

// ── Tracker ──

export const getProjects = async (): Promise<ApiResponse<ProjectsListResponse>> => {
  return request<ProjectsListResponse>('/tracker/projects');
};

export const getProjectDetail = async (id: string): Promise<ApiResponse<ProjectDetailResponse>> => {
  return request<ProjectDetailResponse>(`/tracker/projects/${id}`);
};

export const createProject = async (data: CreateProjectRequest): Promise<ApiResponse<CreateProjectResponse>> => {
  return request<CreateProjectResponse>('/tracker/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const getTasks = async (filter?: {
  status?: string;
  assignedTo?: string;
  priority?: string;
  projectId?: string;
}): Promise<ApiResponse<TasksListResponse>> => {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.assignedTo) params.set('assignedTo', filter.assignedTo);
  if (filter?.priority) params.set('priority', filter.priority);
  if (filter?.projectId) params.set('projectId', filter.projectId);
  const query = params.toString();
  return request<TasksListResponse>(`/tracker/tasks${query ? `?${query}` : ''}`);
};

export const getTaskDetail = async (id: string): Promise<ApiResponse<TaskDetailResponse>> => {
  return request<TaskDetailResponse>(`/tracker/tasks/${id}`);
};

// Phase B.0: structured audit log for a task.
export interface TaskLogEntry {
  id: string;
  taskId: string;
  fromEntity: string;
  entryKind: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actionTaken: string | null;
  note: string | null;
  evidenceJson: string | null;
  createdAt: string;
}

export const getTaskLog = async (
  id: string,
  opts?: { limit?: number; kinds?: string[] },
): Promise<ApiResponse<TaskLogEntry[]>> => {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
  const q = params.toString();
  return request<TaskLogEntry[]>(`/tracker/tasks/${id}/log${q ? `?${q}` : ''}`);
};

export const addTaskObservation = async (
  id: string,
  note: string,
): Promise<ApiResponse<{ entryId: string }>> => {
  return request<{ entryId: string }>(`/tracker/tasks/${id}/observation`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
};

// User-side validation: flips the appropriate *_validated flag from the dashboard.
export const userValidateTask = async (
  id: string,
): Promise<ApiResponse<{ validated: boolean }>> => {
  return request<{ validated: boolean }>(`/tracker/tasks/${id}/user-validate`, {
    method: 'POST',
  });
};

// Phase B.1: override-request queue.
export interface OverrideRequestRow {
  id: string;
  task_id: string;
  task_title: string | null;
  task_goal: string | null;
  requested_by: string;
  requested_status: string;
  justification: string;
  last_engine_error: string | null;
  attempts_attached: number;
  status: 'pending' | 'approved' | 'denied' | 'auto_denied';
  resolved_by: string | null;
  resolved_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

export const getOverrideRequests = async (
  status?: 'pending' | 'approved' | 'denied' | 'auto_denied',
): Promise<ApiResponse<OverrideRequestRow[]>> => {
  const q = status ? `?status=${status}` : '';
  return request<OverrideRequestRow[]>(`/tracker/override-requests${q}`);
};

export const resolveOverrideRequest = async (
  id: string,
  approve: boolean,
  reason: string,
): Promise<ApiResponse<{ approved: boolean }>> => {
  return request<{ approved: boolean }>(`/tracker/override-requests/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ approve, reason }),
  });
};

// Phase D: tracker hygiene + telemetry.
export interface TrackerHygiene {
  validateOutcomes: Array<{ from_entity: string; rejects: number; validates: number }>;
  smellFlags: Array<{ category: string; count: number }>;
  overrideRollup: Array<{ status: string; count: number }>;
  elevated: Array<{
    id8: string;
    title: string;
    status: string;
    revert_count: number;
    awaiting_user_verdict: number;
    last_smell_flag: string | null;
  }>;
  pmCost: Array<{ modelId: string | null; calls: number; cost_24h: number | null }>;
}

export const getTrackerHygiene = async (): Promise<ApiResponse<TrackerHygiene>> => {
  return request<TrackerHygiene>(`/tracker/hygiene`);
};

export const createTask = async (data: CreateTaskRequest): Promise<ApiResponse<{ taskId: string }>> => {
  return request<{ taskId: string }>('/tracker/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const deleteProject = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/tracker/projects/${id}`, { method: 'DELETE' });
};

export const closeProject = async (
  id: string,
  body: { status: 'complete' | 'cancelled'; reason: string },
): Promise<ApiResponse<{ projectId: string; tasksClosed: number; alreadyClosed: number }>> => {
  return request<{ projectId: string; tasksClosed: number; alreadyClosed: number }>(
    `/tracker/projects/${id}/close`,
    { method: 'POST', body: JSON.stringify(body) },
  );
};

export const deleteTask = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/tracker/tasks/${id}`, { method: 'DELETE' });
};

export const updateTask = async (id: string, updates: UpdateTaskRequest): Promise<ApiResponse<TaskDetailResponse>> => {
  return request<TaskDetailResponse>(`/tracker/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
};

// ── Agents (expanded) ──

export const createAgent = async (data: CreateAgentRequest): Promise<ApiResponse<AgentDetailResponse>> => {
  return request<AgentDetailResponse>('/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const terminateAgent = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/agents/${id}`, {
    method: 'DELETE',
  });
};

export const stopAgent = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/agents/${id}/stop`, {
    method: 'POST',
  });
};

export const getAgentSystemPrompt = async (id: string): Promise<ApiResponse<{ content: string }>> => {
  return request<{ content: string }>(`/agents/${id}/system-prompt`);
};

export const updateAgentConfig = async (
  id: string,
  updates: { modelId?: string; systemPrompt?: string; permissions?: Record<string, unknown>; toolsPolicy?: { allow: string[]; deny: string[] }; dreamerIgnore?: boolean },
): Promise<ApiResponse<AgentDetailResponse>> => {
  return request<AgentDetailResponse>(`/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
};

export const archiveOldAgents = async (): Promise<ApiResponse<{ archived: number }>> => {
  return request<{ archived: number }>('/agents/archive', {
    method: 'POST',
  });
};

export const purgeAgent = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/agents/${id}/purge`, {
    method: 'POST',
  });
};

export const sendAgentMessage = async (
  agentId: string,
  content: string,
  attachments?: AttachmentInfo[],
): Promise<ApiResponse<SendMessageResponse>> => {
  return request<SendMessageResponse>(`/chat/${agentId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, attachments: attachments?.length ? attachments : undefined }),
  });
};

export const getAgentHistory = async (
  agentId: string,
  limit?: number,
): Promise<ApiResponse<ChatHistoryResponse>> => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return request<ChatHistoryResponse>(`/chat/${agentId}/messages${query ? `?${query}` : ''}`);
};

export const getAgentInterMessages = async (
  agentId: string,
  direction?: string,
  limit?: number,
): Promise<ApiResponse<AgentMessagesResponse>> => {
  const params = new URLSearchParams();
  if (direction) params.set('direction', direction);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return request<AgentMessagesResponse>(`/agents/${agentId}/messages${query ? `?${query}` : ''}`);
};

// ── Router ──

export const getRouterConfig = async (): Promise<ApiResponse<{
  tiers: Array<{
    id: string;
    name: string;
    description: string;
    models: Array<{ modelId: string; modelName: string; priority: number }>;
  }>;
  dimensions: Array<{
    id: string;
    name: string;
    weight: number;
    isEnabled: boolean;
  }>;
}>> => {
  return request('/router/config');
};

export const updateTierModels = async (
  tierId: string,
  models: Array<{ modelId: string; priority: number }>,
): Promise<ApiResponse<void>> => {
  return request<void>(`/router/tiers/${tierId}/models`, {
    method: 'PUT',
    body: JSON.stringify({ models }),
  });
};

export const updateDimension = async (
  dimensionId: string,
  updates: { weight?: number; isEnabled?: boolean },
): Promise<ApiResponse<void>> => {
  return request<void>(`/router/dimensions/${dimensionId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
};

export const testRouter = async (
  prompt: string,
): Promise<ApiResponse<{
  scores: Array<{ dimension: string; score: number; weight: number; weighted: number }>;
  rawScore: number;
  confidence: number;
  tier: string;
  selectedModel: string;
}>> => {
  return request('/router/test', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
};

export const getRouterStats = async (
  period: string,
): Promise<ApiResponse<{
  requestsByTier: Record<string, number>;
  requestsByModel: Record<string, number>;
}>> => {
  return request(`/router/stats?period=${encodeURIComponent(period)}`);
};

// ── Costs ──

export const getCostSummary = async (
  period: string,
): Promise<ApiResponse<{
  totalSpend: number;
  dailyAvg: number;
  byModel: Array<{ modelId: string; modelName: string; spend: number }>;
  byAgent: Array<{ agentId: string; agentName: string; spend: number }>;
  byTier: Array<{ tier: string; count: number; percentage: number }>;
}>> => {
  return request(`/costs/summary?period=${encodeURIComponent(period)}`);
};

export const getCostRecords = async (
  filter?: { period?: string; agentId?: string; modelId?: string },
): Promise<ApiResponse<{
  records: Array<{
    id: string;
    time: string;
    agentId: string;
    agentName: string;
    modelId: string;
    modelName: string;
    tier: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    latencyMs: number;
  }>;
  total: number;
}>> => {
  const params = new URLSearchParams();
  if (filter?.period) params.set('period', filter.period);
  if (filter?.agentId) params.set('agentId', filter.agentId);
  if (filter?.modelId) params.set('modelId', filter.modelId);
  const query = params.toString();
  return request(`/costs/records${query ? `?${query}` : ''}`);
};

export const getBudgets = async (): Promise<ApiResponse<{
  global: { limitUsd: number; spentUsd: number } | null;
  agents: Array<{
    agentId: string;
    agentName: string;
    limitUsd: number;
    period: string;
    spentUsd: number;
  }>;
}>> => {
  return request('/costs/budget');
};

export const setGlobalBudget = async (limitUsd: number): Promise<ApiResponse<void>> => {
  return request<void>('/costs/budget/global', {
    method: 'PUT',
    body: JSON.stringify({ limitUsd }),
  });
};

export const setAgentBudget = async (
  agentId: string,
  limitUsd: number,
  period: string,
): Promise<ApiResponse<void>> => {
  return request<void>(`/costs/budget/agent/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify({ limitUsd, period }),
  });
};

// ── Services ──

export const getWatchdogStatus = async (): Promise<ApiResponse<{
  running: boolean;
  lastCheck: string | null;
  lastAlert: string | null;
}>> => {
  return request('/system/watchdog');
};

export const getIMBridgeStatus = async (): Promise<ApiResponse<{
  enabled: boolean;
  connected: boolean;
  lastReceived: string | null;
  lastSent: string | null;
}>> => {
  return request('/system/imessage');
};

export const sendTestIMessage = async (message: string): Promise<ApiResponse<void>> => {
  return request<void>('/system/imessage/test', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
};

export const getProviderHealth = async (): Promise<ApiResponse<{
  providers: Array<{
    id: string;
    name: string;
    healthy: boolean;
    lastSuccess: string | null;
    errorCount: number;
  }>;
}>> => {
  return request('/system/providers/health');
};

export const getResources = async (): Promise<ApiResponse<{
  memory: { used: number; total: number; percentage: number };
  cpu: { usage: number };
  ollama: { running: boolean; models: string[] } | null;
}>> => {
  return request('/system/resources');
};

// ── Search Config ──

export const getSearchConfig = async (): Promise<ApiResponse<{ provider: string; hasKey: boolean }>> => {
  return request<{ provider: string; hasKey: boolean }>('/config/search');
};

export const setSearchConfig = async (
  provider: string,
  apiKey: string,
): Promise<ApiResponse<{ provider: string; hasKey: boolean }>> => {
  return request<{ provider: string; hasKey: boolean }>('/config/search', {
    method: 'PUT',
    body: JSON.stringify({ provider, apiKey }),
  });
};

export const validateSearchKey = async (
  provider: string,
  apiKey: string,
): Promise<ApiResponse<{ valid: boolean }>> => {
  return request<{ valid: boolean }>('/config/search/validate', {
    method: 'POST',
    body: JSON.stringify({ provider, apiKey }),
  });
};

// ── Router (available models) ──

export const getAvailableRouterModels = async (): Promise<ApiResponse<Array<{
  id: string;
  name: string;
  api_model_id: string;
  provider_name: string;
}>>> => {
  return request('/router/available-models');
};

// ── Vector Search ──

export interface VectorSearchResult {
  sourceType: string;
  sourceId: string;
  preview: string;
  similarity: number;
  agentId: string | null;
}

export const vectorSearchMemory = async (
  query: string,
  agentId?: string,
  limit?: number,
): Promise<ApiResponse<VectorSearchResult[]>> => {
  const params = new URLSearchParams();
  params.set('q', query);
  if (agentId) params.set('agent_id', agentId);
  if (limit) params.set('limit', String(limit));
  return request<VectorSearchResult[]>(`/memory/vector-search?${params.toString()}`);
};

// ── Embedding Status ──

export const getEmbeddingStatus = async (): Promise<ApiResponse<{
  total: number;
  embedded: number;
  pending: number;
  backfillRunning: boolean;
  config: { provider: string; model: string; dimensions: number };
}>> => {
  return request('/memory/embeddings/status');
};

// ── Groups ──

export interface AgentGroup {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  color: string;
  memberCount: number;
  dreamerIgnore?: boolean;
  createdAt: string;
}

export const getGroups = async (): Promise<ApiResponse<AgentGroup[]>> => {
  return request<AgentGroup[]>('/groups');
};

export const createGroupApi = async (name: string, description: string, color?: string): Promise<ApiResponse<AgentGroup>> => {
  return request<AgentGroup>('/groups', {
    method: 'POST',
    body: JSON.stringify({ name, description, color }),
  });
};

export const deleteGroupApi = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/groups/${id}`, { method: 'DELETE' });
};

export const updateGroupApi = async (id: string, updates: { name?: string; description?: string; color?: string; dreamerIgnore?: boolean }): Promise<ApiResponse<unknown>> => {
  return request(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(updates) });
};

export const assignAgentToGroupApi = async (agentId: string, groupId: string | null): Promise<ApiResponse<void>> => {
  return request<void>(`/groups/agents/${agentId}/group`, {
    method: 'PUT',
    body: JSON.stringify({ group_id: groupId }),
  });
};

// ── Task Runs ──

export interface TaskRun {
  id: string;
  taskId: string;
  runNumber: number;
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  status: string;
  assignedTo: string | null;
  agentName: string | null;
  resultSummary: string | null;
  error: string | null;
}

export const getTaskRuns = async (taskId: string): Promise<ApiResponse<TaskRun[]>> => {
  return request<TaskRun[]>(`/tasks/${taskId}/runs`);
};

// ── Ollama Lock Status (per-provider) ──

export interface OllamaLockWarning {
  providerId: string;
  providerName: string;
  count: number;
  maxConcurrentModels: number;
  models: string[];
}

export interface OllamaProviderActiveModels {
  providerId: string;
  providerName: string;
  count: number;
  models: string[];
}

export interface OllamaLockStatus {
  maxConcurrentModels: number;
  slots: Array<{ providerId: string; modelName: string; activeRequests: number }>;
  queuedRequests: number;
  queuedModels: Array<{ providerId: string; modelName: string }>;
  activeAgentModelsByProvider: OllamaProviderActiveModels[];
  warnings: OllamaLockWarning[];
}

export const getOllamaLockStatus = async (): Promise<ApiResponse<OllamaLockStatus>> => {
  return request<OllamaLockStatus>('/system/ollama/lock');
};

// ── Vault ──

export interface VaultEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  type: string;
  content: string;
  context: string | null;
  confidence: number;
  isPermanent: boolean;
  tags: string[];
  isPinned: boolean;
  isObsolete: boolean;
  supersededBy: string | null;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  sourceConversationId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultStats {
  totalEntries: number;
  byType: Record<string, number>;
  permanentCount: number;
  pinnedCount: number;
  avgConfidence: number;
  retrievedToday: number;
  unprocessedArchives: number;
  lastDreamAt: string | null;
}

export interface DreamReport {
  id: string;
  archivesProcessed: number;
  memoriesExtracted: number;
  techniquesFound: number;
  duplicatesMerged: number;
  contradictionsResolved: number;
  entriesPruned: number;
  entriesConsolidated: number;
  totalEntries: number;
  pinnedCount: number;
  permanentCount: number;
  reportText: string | null;
  dreamMode: string;
  modelId: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface DreamingConfig {
  modelId: string | null;
  dreamTime: string;
  dreamMode: 'full' | 'light' | 'off';
}

export const getVaultEntries = async (params?: {
  type?: string;
  agent?: string;
  tag?: string;
  pinned?: boolean;
  permanent?: boolean;
  search?: string;
  limit?: number;
}): Promise<ApiResponse<VaultEntry[]>> => {
  const q = new URLSearchParams();
  if (params?.type) q.set('type', params.type);
  if (params?.agent) q.set('agent', params.agent);
  if (params?.tag) q.set('tag', params.tag);
  if (params?.pinned) q.set('pinned', 'true');
  if (params?.permanent) q.set('permanent', 'true');
  if (params?.search) q.set('search', params.search);
  if (params?.limit) q.set('limit', String(params.limit));
  return request<VaultEntry[]>(`/vault/entries?${q.toString()}`);
};

export const getVaultEntry = async (id: string): Promise<ApiResponse<VaultEntry>> => {
  return request<VaultEntry>(`/vault/entries/${id}`);
};

export const createVaultEntry = async (body: {
  content: string;
  type: string;
  tags?: string[];
  pin?: boolean;
  permanent?: boolean;
}): Promise<ApiResponse<VaultEntry>> => {
  return request<VaultEntry>('/vault/entries', {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

export const updateVaultEntry = async (id: string, body: {
  content?: string;
  tags?: string[];
  pin?: boolean;
  permanent?: boolean;
  confidence?: number;
}): Promise<ApiResponse<VaultEntry>> => {
  return request<VaultEntry>(`/vault/entries/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
};

export const markVaultEntryObsolete = async (id: string, reason: string): Promise<ApiResponse<void>> => {
  return request<void>(`/vault/entries/${id}/obsolete`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
};

export const deleteVaultEntry = async (id: string): Promise<ApiResponse<void>> => {
  return request<void>(`/vault/entries/${id}`, { method: 'DELETE' });
};

export const getVaultStats = async (): Promise<ApiResponse<VaultStats>> => {
  return request<VaultStats>('/vault/stats');
};

export const bulkDiscardArchives = async (filter: {
  agentId?: string;
  olderThanDays?: number;
  all?: boolean;
}): Promise<ApiResponse<{ deleted: number }>> => {
  return request<{ deleted: number }>('/vault/conversations/discard', {
    method: 'POST',
    body: JSON.stringify(filter),
  });
};

export const triggerDream = async (): Promise<ApiResponse<{ dreamerId: string | null; message: string }>> => {
  return request<{ dreamerId: string | null; message: string }>('/vault/dream', { method: 'POST' });
};

export const getDreamHistory = async (limit = 10): Promise<ApiResponse<DreamReport[]>> => {
  return request<DreamReport[]>(`/vault/dream/history?limit=${limit}`);
};

export const getLatestDream = async (): Promise<ApiResponse<DreamReport | null>> => {
  return request<DreamReport | null>('/vault/dream/latest');
};

export const getDreamingConfig = async (): Promise<ApiResponse<DreamingConfig>> => {
  return request<DreamingConfig>('/vault/dream/config');
};

export const updateDreamingConfig = async (config: Partial<DreamingConfig>): Promise<ApiResponse<DreamingConfig>> => {
  return request<DreamingConfig>('/vault/dream/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
};

// ── Updates ──

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  latestTag?: string;
  releaseName?: string;
  publishedAt?: string;
  releaseNotes?: string | null;
  updateAvailable: boolean;
  downloadUrl?: string | null;
  downloadSize?: number | null;
  error?: string;
}

export const checkForUpdates = async (): Promise<ApiResponse<UpdateCheckResult>> => {
  return request<UpdateCheckResult>('/update/check');
};

export const getVersion = async (): Promise<ApiResponse<{ version: string }>> => {
  return request<{ version: string }>('/update/version');
};

export const applyUpdate = async (): Promise<ApiResponse<{ message: string; previousVersion: string; newVersion: string; backupDir: string }>> => {
  return request<{ message: string; previousVersion: string; newVersion: string; backupDir: string }>('/update/apply', {
    method: 'POST',
  });
};

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  publishedAt: string;
  notes: string | null;
  downloadUrl: string | null;
  downloadSize: number | null;
  isCurrent: boolean;
}

export const listReleases = async (): Promise<ApiResponse<{ currentVersion: string; releases: ReleaseInfo[] }>> => {
  return request<{ currentVersion: string; releases: ReleaseInfo[] }>('/update/releases');
};

export const rollbackToVersion = async (tag: string): Promise<ApiResponse<{ message: string; previousVersion: string; newVersion: string; backupDir: string }>> => {
  return request<{ message: string; previousVersion: string; newVersion: string; backupDir: string }>('/update/rollback', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  });
};

// ── Healer ──

export interface HealerConfig {
  modelId: string | null;
  healerTime: string;
  healerMode: 'active' | 'monitor' | 'off';
  // v2.3.19 — provider-isolation surface. true when the Healer and the
  // primary agent are on the same provider, which defeats the cross-
  // provider safety net (if that provider goes down both go down).
  providerSharedWithPrimary?: boolean;
  primaryProviderName?: string | null;
  healerProviderName?: string | null;
}

export interface HealerProposal {
  id: string;
  diagnostic_id: string | null;
  category: string;
  severity: string;
  title: string;
  description: string;
  proposed_fix: string;
  fix_action: string | null;
  confidence: number | null;
  status: string;
  user_note: string | null;
  result_summary: string | null;
  agent_id: string | null;
  created_at: string;
  resolved_at: string | null;
  // v2.3.19 — set when the Healer calls healer_mark_applied AFTER an
  // approved proposal has been carried out. Distinguishes "approved
  // (waiting for Healer to execute)" from "applied (done)".
  applied_at?: string | null;
  // JSON-encoded array of evidence bullets the healer cited when
  // proposing the fix. Required for new proposals; null for legacy rows.
  evidence_json?: string | null;
}

export interface HealerAction {
  id: string;
  diagnostic_id: string | null;
  category: string;
  description: string;
  agent_id: string | null;
  action_taken: string;
  result: string | null;
  created_at: string;
}

export interface HealerDiagnostic {
  id: string;
  report: string;
  critical_count: number;
  warning_count: number;
  info_count: number;
  created_at: string;
}

export const getHealerConfig = async (): Promise<ApiResponse<HealerConfig>> => {
  return request<HealerConfig>('/healer/config');
};

export const updateHealerConfig = async (config: Partial<HealerConfig>): Promise<ApiResponse<HealerConfig>> => {
  return request<HealerConfig>('/healer/config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
};

export const getHealerProposals = async (): Promise<ApiResponse<HealerProposal[]>> => {
  return request<HealerProposal[]>('/healer/proposals');
};

export const resolveHealerProposal = async (id: string, action: 'approve' | 'deny', note?: string): Promise<ApiResponse<{ status: string }>> => {
  return request<{ status: string }>(`/healer/proposals/${id}`, {
    method: 'POST',
    body: JSON.stringify({ action, note }),
  });
};

export const getHealerActions = async (): Promise<ApiResponse<HealerAction[]>> => {
  return request<HealerAction[]>('/healer/actions');
};

export const getHealerDiagnostic = async (): Promise<ApiResponse<HealerDiagnostic | null>> => {
  return request<HealerDiagnostic | null>('/healer/diagnostics');
};

export const triggerHealerRun = async (): Promise<ApiResponse<{ diagnosticId: string; autoFixCount: number; llmTriggered: boolean }>> => {
  return request<{ diagnosticId: string; autoFixCount: number; llmTriggered: boolean }>('/healer/run', { method: 'POST' });
};

export const sendHealerReport = async (): Promise<ApiResponse<{ message: string }>> => {
  return request<{ message: string }>('/healer/report/send', { method: 'POST' });
};

export { getToken, clearToken };
