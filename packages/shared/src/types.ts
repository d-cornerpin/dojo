
import type { MessageOrigin } from './origin.js';
import type { DisplayKind } from './visibility.js';
import type { AccessGrants } from './access.js';
import type { ToolDocsHealth } from './tool-docs-health.js';

export interface Provider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';
  baseUrl: string | null;
  authType: 'api_key' | 'oauth' | 'agent-sdk' | 'none';
  // Capability profile declared for this endpoint (a `BEHAVES_LIKE_PROFILES` id, agent/model-contract.ts), or null.
  behavesLike: string | null;
  // Streaming patience in ms; null means the standard bounds (90 s first token, 60 s between chunks).
  // Legal range 10 s to 30 min.
  firstChunkTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  // Declared prompt tokens/sec of the serving machine; null falls back to the measured reading, and with neither
  // the pre-dial doomed-request gate is off (`resolveDoomCeiling`, agent/stream-patience.ts). Range 1 to 100,000.
  prefillTokensPerSec: number | null;
  // Same reading derived from the cost ledger (migration 167): read-only, and `prefillTokensPerSec` wins when set.
  measuredPrefillTokensPerSec: number | null;
  // When that reading was set, SQLite `YYYY-MM-DD HH:MM:SS` not ISO (null with it); the 30-day max needs it.
  measuredPrefillAt: string | null;
  isValidated: boolean;
  validatedAt: string | null;
  // Host RAM in GB for remote Ollama (no API reports it), used by the num_ctx auto-sizer; null on localhost.
  hostRamGb: number | null;
  createdAt: string;
  updatedAt: string;
}

/** How hard a model thinks. DeepSeek's documented values; the engine sends only what a contract lists. */
export type ThinkingLevel = 'low' | 'high' | 'max';

export interface Model {
  id: string;
  providerId: string;
  name: string;
  apiModelId: string;
  capabilities: string[];
  contextWindow: number | null;
  // The window the engine budgets with while `contextWindow` is null (so the row can name it); null when set.
  assumedContextWindow?: number | null;
  maxOutputTokens: number | null;
  inputCostPerM: number | null;
  outputCostPerM: number | null;
  // token: the input/output $/M columns. Else costPerUnit: $ per output megapixel, per second of generated
  // media, per input character (TTS), per minute of input audio (transcription), or per generated item.
  pricingUnit: 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';
  costPerUnit: number | null;
  // @deprecated: use costPerUnit. Kept as a fallback read path so older clients don't break.
  costPerMegapixel: number | null;
  // True when the applicable rate is NULL (not 0): the biller counts it as $0 so phantom cost never hits the budget
  // wall, and this flag keeps a paid model with a failed price lookup visible. Derived at read time.
  priceUnknown: boolean;
  isEnabled: boolean;
  // Why a picker cannot offer this model as an agent's model ('not a chat model' or 'too small for an agent'); null when it can.
  notForAgents?: string | null;
  thinkingEnabled: boolean;
  // Only SENT to a model whose `thinkingLevels` lists it.
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  numCtxOverride: number | null;
  // Auto-sized num_ctx default; null means not computed, and the runtime then skips num_ctx.
  numCtxRecommended: number | null;
  generationParams: GenerationParamSpec | null;
  voiceCatalog: VoiceOption[] | null;
  createdAt: string;
  updatedAt: string;
}


export interface VoiceOption {
  id: string;
  description: string;
  gender: 'male' | 'female' | 'neutral';
}


export type GenerationParamWireType = 'string' | 'number';

export interface GenerationParamField {
  // Whether the wire accepts this param; when false the agent still supplies it but it is not forwarded.
  accepted: boolean;
  // Allowed values: non-empty is a strict enum, empty falls back to the inclusive min/max range below.
  values: Array<string | number>;
  min?: number;
  max?: number;
  default: string | number;
  wireField: string;
  wireType: GenerationParamWireType;
}

export type GenerationParamSpec = Record<string, GenerationParamField>;

/** Every agent status as data, so a test can assert it against `CHECK(status IN (...))` on `agents.status`;
 *  a member added here without a migration throws on write. */
export const AGENT_STATUSES = ['idle', 'working', 'paused', 'error', 'terminated', 'rate_limited'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Agent {
  id: string;
  name: string;
  modelId: string | null;
  systemPromptPath: string | null;
  status: AgentStatus;
  parkedCause?: string | null; // why the platform parked this agent (plain words), else null
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
  /** Effective access grants (GET /agents/:id only); the Access panel reads this, not the stored `permissions`. */
  effectiveGrants?: AccessGrants;
  /** When true, the agent's conversations are skipped by the vault archive layer entirely (Dreamer
   * never sees them). Toggleable on the agent detail page; falls through from the group's flag. */
  dreamerIgnore?: boolean;
  /** Minutes of no movement at all before the owner is told this agent went silent; null = 2 h. */
  silentWindowMinutes?: number | null;
  /** Calls a stop would cut NOW, live off the abort registry. `background` outlives its turn, so an `idle` row
   *  can be stoppable; absent = no claim, not zero. See `stop-affordance.ts`. */
  inFlight?: { turn: number; background: number };
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
  /** SQLite rowid, selected only where a tie-free ordering key is needed (archival high-water, vault/archive.ts). */
  rowid?: number;
  /** Stored display classification (`messages.display_kind`), served not re-derived: the engine reclassifies bubbles
   *  at turn end WITHOUT touching `content` (the model prefix replays it), so content cannot show it. */
  displayKind?: DisplayKind | null;
  turnNumber?: number | null;
  /** Chain of thought from thinking-mode providers; some (DeepSeek) require it echoed back on follow-up tool
   *  turns or the request 400s. Anthropic's thinking blocks live inside `content`, not here. */
  reasoningContent?: string | null;
  /** One-way: compaction retired this reasoning from the wire (still rendered, never replayed or budgeted). */
  reasoningAgedOut?: boolean;
  attachments?: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
  }>;
  /** 'voice' for dictated user messages, 'a2a' for assistant/tool messages of a dedicated A2A turn; null otherwise. */
  source?: 'voice' | 'a2a' | null;
  sourceAgentId?: string | null;
  a2aThreadId?: string | null;
  a2aIntent?: string | null;
  a2aRequiresResponse?: number | null;
  inboundMeta?: string | null;
  /** `conversations.id` (a real FK), stamped on inbound rows at ingest and on the agent's own rows at end of turn.
   *  The live-tail scoper KEEPS NULL (this turn's in-flight work); dropping it is the re-answer ghost. */
  conversationId?: string | null;
  /** Who this message is from, derived by deriveOrigin() in the row mapper; the one attribution signal. */
  origin?: MessageOrigin;
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
  /** Whether this box's tool manuals match its registry; absent until boot has measured. `toolDocsShortfall` is the
   *  one rule deciding whether it deserves a word (boot log and Vitals card). */
  toolDocs?: ToolDocsHealth;
}

export interface SetupStatus {
  isFirstRun: boolean;
  steps: {
    providers: boolean;
    models: boolean;
    identity: boolean;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolErrorCode = 'PERMISSION_DENIED' | 'NOT_FOUND' | 'TIMEOUT' | 'INVALID_ARGS' | 'NETWORK_ERROR' | 'PARSE_ERROR' | 'RATE_LIMITED' | 'UNKNOWN_ARGS';

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  errorCode?: ToolErrorCode;
  // Rich blocks (file_read images, PDFs) that replace `content` in the model's tool_result; `content` keeps the text.
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
}


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
  /** True when the owner has edited the text by hand (a regenerate would discard that). */
  editedByOwner?: boolean;
}

export interface DagResponse {
  summaries: Summary[];
  links: { summaryId: string; parentIds: string[] }[];
}


export interface PermissionManifest {
  file_read: string[] | '*' | 'none';
  file_write: string[] | '*' | 'none';
  /** Programs the agent may run through `exec({argv})` (argv, no shell). */
  exec_allow: string[];
  exec_deny: string[];
  /** What the agent may run through `shell({script})` (`/bin/zsh -c`). Absent inherits `exec_allow`; setting it
   *  explicitly withholds the shell class (`shell_allow: []` may run programs, not scripts). */
  shell_allow?: string[];
  shell_deny?: string[];
  network_domains: string[] | '*' | 'none';
  can_spawn_agents: boolean;
  can_assign_permissions: boolean;
  system_control: string[];
}

export interface Project {
  id: string;
  title: string;
  description: string | null;
  level: number;
  status: 'active' | 'complete' | 'cancelled';
  createdBy: string;
  phaseCount: number;
  currentPhase: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectDetail extends Project {
  tasks: Task[];
  /** `cancelled` is counted apart from `failed`; `blocked` counts Working tasks held blocked. */
  taskCounts: { pending: number; inProgress: number; handedIn: number; sentBack: number; complete: number; blocked: number; failed: number; cancelled: number };
}

/** A Working task with no movement for this long is left quiet and labelled on the board. */
export const DORMANT_MS = 14 * 24 * 60 * 60 * 1000;

/** Who speaks a platform outbound or owner card: no agent authored it. */
export const PLATFORM_SENDER = 'platform';

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  description: string | null;
  status: 'on_deck' | 'in_progress' | 'handed_in' | 'sent_back' | 'complete' | 'fallen' | 'cancelled';
  /** Working (or Open) work on standby, with its reason. A hold is not a status: the task still
   *  finishes by being handed in and decided. */
  hold: 'paused' | 'blocked' | null;
  holdReason: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  assigneeGone: boolean;
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
  repeatDaysOfWeek: string | null;
  /** Wall-clock anchor of a recurring task: next_run_at counts from it, so run length never drifts the schedule. */
  anchorTime: string | null;
  nextRunAt: string | null;
  runCount: number;
  isPaused: boolean;
  pausedUntil: string | null;
  scheduleStatus: string;
  assignedToGroup: string | null;
  /** Variant, NULL for ordinary tasks; 'reminder' (work_open kind="reminder") fires a lighter delivery prompt. */
  kind: string | null;
  createdAt: string;
  updatedAt: string;
  lastMovedAt: string;   // `taskMovedAtSql`, the task's own last movement
  completedAt: string | null;
  // Goal: what success looks like. Result: what the agent says it did. Evidence: what it offered as backing.
  goal: string | null;
  result: string | null;
  evidence: Array<{ kind: string; [k: string]: unknown }>;
  /** The hand-in waiting for a decision: its outcome, note and each proof item as one line. */
  handIn?: { outcome: 'finished' | 'cant_be_done'; note: string; proof: string[] } | null;
}
