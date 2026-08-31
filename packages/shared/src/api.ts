// ════════════════════════════════════════
// API Request/Response Type Contracts
// ════════════════════════════════════════

import type { Agent, AgentDetail, AgentMessage, Briefing, CompletionAnnouncement, DagResponse, HealthData, LogEntry, Message, Model, PermissionManifest, Project, ProjectDetail, Provider, SearchResult, SetupStatus, Summary, SummaryDetail, Task } from './types.js';

// Standard API response wrapper
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ── Auth ──
export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  token: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
}

// ── Setup ──
export type SetupStatusResponse = SetupStatus;

// ── Providers ──
export interface CreateProviderRequest {
  id: string;
  name: string;
  type: string;
  baseUrl?: string;
  authType: string;
  credential?: string;
  // T63 — one of `BEHAVES_LIKE_PROFILES` (`agent/model-contract.ts`), sent only by the
  // manual OpenAI-compatible choice. Omitted means "sniff the URL as always".
  behavesLike?: string;
  // T64b — the advanced patience pair, in milliseconds. Omitted (the normal case) means the
  // provider declares nothing and the standard bounds apply.
  firstChunkTimeoutMs?: number | null;
  streamIdleTimeoutMs?: number | null;
}

// T66b — the edit. Every field optional, and only the ones present are written: the create
// door over an existing id is a full replace, so this is a different request shape and not a
// partial `CreateProviderRequest`. `credential` blank or absent means keep the stored key —
// the stored key is never sent to the client, so a form can never round-trip it.
export interface EditProviderRequest {
  name?: string;
  baseUrl?: string | null;
  behavesLike?: string | null;
  credential?: string;
}

// The edit route answers the standard envelope PLUS one flag: true when the base URL or the
// credential moved, i.e. when the stored "validated" badge no longer describes anything that
// has been tried. The caller then runs `POST /providers/:id/validate` — the existing route,
// which is also what the add form runs straight after a create.
export type EditProviderResponse = ApiResponse<Provider> & { revalidationRequired?: boolean };

export type ProvidersListResponse = Provider[];
export type ProviderResponse = Provider;
export type ProviderModelsResponse = Model[];

// ── Models ──
export interface EnableModelsRequest {
  modelIds: string[];
}

export interface DisableModelsRequest {
  modelIds: string[];
}

export type ModelsListResponse = Model[];

// ── Identity ──
export interface IdentityFileResponse {
  content: string;
}

export interface UpdateIdentityRequest {
  content: string;
}

export interface GenerateIdentityRequest {
  agentName: string;
  communicationStyle: string;
  rules: string;
  userName: string;
  userRole: string;
  userPreferences: string;
}

export interface GenerateIdentityResponse {
  soul: string;
  user: string;
  tools: string;
}

// ── Chat ──
export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
}

export type ChatHistoryResponse = Message[];

// ── Agents ──
export type AgentsListResponse = AgentDetail[];
export type AgentDetailResponse = AgentDetail;

// ── Memory ──
export type DagApiResponse = DagResponse;
export type SummaryDetailResponse = SummaryDetail;
export type SearchResultsResponse = SearchResult[];
export type BriefingResponse = Briefing;
export type InjectMemoryResponse = Summary;
export interface CompactionResponse {
  leafSummariesCreated: number;
  condensedCreated: number;
}

// ── Tracker ──
export type ProjectsListResponse = Project[];
export type ProjectDetailResponse = ProjectDetail;
export type TasksListResponse = Task[];
export type TaskDetailResponse = Task;
export interface CreateProjectRequest {
  title: string;
  description?: string;
  level: number;
  tasks?: Array<{
    title: string;
    description?: string;
    assignedTo?: string;
    priority?: string;
    stepNumber?: number;
    dependsOn?: string[];
    phase?: number;
  }>;
}
export interface CreateTaskRequest {
  projectId?: string;
  title: string;
  description?: string;
  assignedTo?: string;
  priority?: string;
  stepNumber?: number;
  dependsOn?: string[];
  phase?: number;
  scheduled_start?: string;
  repeat_interval?: number;
  repeat_unit?: string;
  repeat_end_type?: string;
  repeat_end_value?: string;
  /** v2.5.2 — CSV of day-of-week ints (0=Sun..6=Sat) for repeat_unit='specific_days'. */
  repeat_days_of_week?: string | null;
}
export interface UpdateTaskRequest {
  status?: string;
  /** M7 (PHASE-4 T5) / P706: `null` CLEARS the assignee — absent leaves it alone. The
   *  dashboard used `undefined` as the clear sentinel and `JSON.stringify` drops it, so
   *  "Unassigned" sent an empty body and unassigning a task was impossible from the UI.
   *  The server has always read `null` as clear (`routes/tracker.ts` -> `updateTask`); only
   *  the sentinel was unsendable. */
  assignedTo?: string | null;
  priority?: string;
  notes?: string;
  scheduled_start?: string | null;
  repeat_interval?: number | null;
  repeat_unit?: string | null;
  repeat_end_type?: string | null;
  repeat_end_value?: string | null;
  repeat_days_of_week?: string | null;
}
export type CreateProjectResponse = { projectId: string; taskIds: string[] };

// ── Agents (expanded) ──
export type AgentMessagesResponse = AgentMessage[];
export interface CreateAgentRequest {
  name: string;
  systemPrompt: string;
  modelId?: string;
  permissions?: PermissionManifest;
  toolsPolicy?: { allow: string[]; deny: string[] };
  timeout?: number;
  taskId?: string;
  contextHints?: string[];
  classification?: 'ronin' | 'apprentice';
}

// ── System ──
export type HealthResponse = HealthData;
export type LogsResponse = LogEntry[];
