// ════════════════════════════════════════
// Core Domain Types
// ════════════════════════════════════════

export interface Provider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';
  baseUrl: string | null;
  authType: 'api_key' | 'oauth' | 'agent-sdk';
  isValidated: boolean;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Model {
  id: string;
  providerId: string;
  name: string;
  apiModelId: string;
  capabilities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputCostPerM: number | null;
  outputCostPerM: number | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = 'idle' | 'working' | 'paused' | 'error' | 'terminated';

export interface Agent {
  id: string;
  name: string;
  modelId: string | null;
  systemPromptPath: string | null;
  status: AgentStatus;
  config: Record<string, unknown>;
  createdBy: string;
  parentAgent: string | null;
  spawnDepth: number;
  agentType: 'standard' | 'persistent' | 'system' | 'archived';
  classification: 'sensei' | 'ronin' | 'apprentice';
  groupId: string | null;
  maxRuntime: number | null;
  timeoutAt: string | null;
  permissions: PermissionManifest | null;
  toolsPolicy: { allow: string[]; deny: string[] } | null;
  equippedTechniques: string[];
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetail extends Agent {
  messageCount: number;
  uptime: number; // seconds since last start
  model: Model | null;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  agentId: string;
  role: MessageRole;
  content: string;
  tokenCount: number | null;
  modelId: string | null;
  cost: number | null;
  latencyMs: number | null;
  createdAt: string;
  attachments?: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
  }>;
}

export interface AuditEntry {
  id: string;
  agentId: string;
  actionType: 'tool_call' | 'file_read' | 'file_write' | 'exec' | 'model_call' | 'error';
  target: string | null;
  result: 'success' | 'denied' | 'error';
  detail: string | null;
  cost: number | null;
  createdAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  agentId?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface HealthData {
  uptime: number;
  agents: number;
  db: 'ok' | 'error';
  memory: {
    used: number;
    total: number;
  };
}

export interface SetupStatus {
  isFirstRun: boolean;
  steps: {
    providers: boolean;
    models: boolean;
    identity: boolean;
  };
}

// Tool call types used in agent runtime
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

// ── Memory ──

export interface Summary {
  id: string;
  agentId: string;
  depth: number;
  kind: 'leaf' | 'condensed';
  content: string;
  tokenCount: number;
  earliestAt: string;
  latestAt: string;
  descendantCount: number;
  createdAt: string;
}

export interface SummaryDetail extends Summary {
  parentIds: string[];
  childIds: string[];
  sourceMessageIds: string[];
}

export interface SearchResult {
  id: string;
  type: 'message' | 'summary';
  snippet: string;
  timestamp: string;
  tokenCount: number;
}

export interface Briefing {
  id: string;
  agentId: string;
  content: string;
  tokenCount: number;
  generatedAt: string;
}

export interface DagResponse {
  summaries: Summary[];
  links: { summaryId: string; parentIds: string[] }[];
}

// ── Multi-Agent ──

export interface PermissionManifest {
  file_read: string[] | '*';
  file_write: string[] | '*';
  file_delete: string[] | 'none';
  exec_allow: string[];
  exec_deny: string[];
  network_domains: string[] | '*' | 'none';
  max_processes: number;
  can_spawn_agents: boolean;
  can_assign_permissions: boolean;
  system_control: string[];
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  messageType: 'task' | 'result' | 'poke' | 'status' | 'chat';
  content: string;
  metadata: Record<string, unknown>;
  readByRecipient: boolean;
  createdAt: string;
}

// ── Project Tracker ──

export interface Project {
  id: string;
  title: string;
  description: string | null;
  level: number;
  status: 'active' | 'complete' | 'paused' | 'cancelled';
  createdBy: string;
  phaseCount: number;
  currentPhase: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectDetail extends Project {
  tasks: Task[];
  taskCounts: { pending: number; inProgress: number; complete: number; blocked: number; failed: number };
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  description: string | null;
  status: 'on_deck' | 'in_progress' | 'complete' | 'blocked' | 'fallen';
  assignedTo: string | null;
  assignedToName: string | null;
  createdBy: string;
  priority: 'high' | 'normal' | 'low';
  stepNumber: number | null;
  totalSteps: number | null;
  phase: number;
  dependsOn: string[];
  notes: string | null;
  scheduledStart: string | null;
  repeatInterval: number | null;
  repeatUnit: string | null;
  repeatEndType: string;
  repeatEndValue: string | null;
  nextRunAt: string | null;
  runCount: number;
  isPaused: boolean;
  scheduleStatus: string;
  assignedToGroup: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PokeEntry {
  id: string;
  taskId: string;
  agentId: string;
  pokeNumber: number;
  pokeType: 'nudge' | 'urgent' | 'escalate_primary' | 'escalate_owner' | 'dead_agent';
  sentAt: string;
  responseReceived: boolean;
}

export interface CompletionAnnouncement {
  agentId: string;
  agentName: string;
  taskId: string | null;
  status: 'complete' | 'fallen' | 'blocked';
  summary: string;
  stats: {
    tokensUsed: number;
    cost: number;
    durationSeconds: number;
    toolCallsCount: number;
  };
}
