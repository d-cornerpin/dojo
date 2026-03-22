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
}

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
}
export interface UpdateTaskRequest {
  status?: string;
  assignedTo?: string;
  priority?: string;
  notes?: string;
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
