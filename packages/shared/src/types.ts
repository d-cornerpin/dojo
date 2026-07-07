// ════════════════════════════════════════
// Core Domain Types
// ════════════════════════════════════════

import type { MessageOrigin } from './origin.js';

export interface Provider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';
  baseUrl: string | null;
  authType: 'api_key' | 'oauth' | 'agent-sdk';
  isValidated: boolean;
  validatedAt: string | null;
  // User-entered host machine RAM in GB. Only relevant for remote Ollama
  // providers (Ollama has no API to report total system RAM). The num_ctx
  // auto-sizer uses `hostRamGb * 1024^3` as the total RAM when computing
  // recommendations for models on this provider. Null on localhost (we
  // use os.totalmem() instead) or when the user hasn't filled it in yet.
  hostRamGb: number | null;
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
  // The pricing unit this model bills in. Token uses input/output
  // $/M-tokens columns. Every other unit reads costPerUnit and the
  // unit string disambiguates what that number means:
  //   megapixel  — $ per output megapixel (image gen)
  //   second     — $ per second of generated media (video / audio gen)
  //   character  — $ per character of input text (TTS)
  //   minute     — $ per minute of input audio (transcription)
  //   item       — $ per generated item (a song, an image, a clip)
  pricingUnit: 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item';
  costPerUnit: number | null;
  // @deprecated since v2.11.0 — use costPerUnit instead. Kept for one
  // release as a fallback read path so older clients don't break.
  costPerMegapixel: number | null;
  // True when the rate that applies to this model is NULL in the DB (not an
  // explicit 0): a token row missing input or output $/M, or a non-token row
  // missing costPerUnit. Derived at read time, no column. Per owner decision
  // D-H the biller treats an unknown rate as $0 (phantom cost must not count
  // toward the budget wall), so this flag keeps a genuinely-paid model with a
  // failed price lookup visible instead of silently hidden at $0. The Settings
  // model card renders a "price unknown, set a rate" hint off it.
  priceUnknown: boolean;
  isEnabled: boolean;
  // Per-model thinking/reasoning toggle. Defaults to true. Only meaningful
  // when the capabilities array includes 'thinking'; for non-thinking
  // models the field is stored but has no runtime effect.
  thinkingEnabled: boolean;
  // Per-model override for Ollama's `num_ctx` parameter. null means "use
  // the auto-computed recommendation (numCtxRecommended); if that's also
  // null, fall back to the model's Modelfile default". Only meaningful
  // for provider type 'ollama'.
  numCtxOverride: number | null;
  // Auto-computed num_ctx default sized to the host machine's RAM, the
  // model's on-disk weights, and its KV cache footprint per token. The
  // runtime uses this when there's no explicit override, and the UI
  // displays it as the pre-filled "default" value in the Context input
  // on every Ollama model card. null means "computation failed" or
  // "not yet computed" — the runtime then skips num_ctx entirely.
  numCtxRecommended: number | null;
  // Per-model generation parameter spec. Drives the canonical→wire param
  // mapping for media-generation tools (video first). null = no spec yet
  // (the boot backfill seeds it from the family registry). See
  // GenerationParamSpec. Only meaningful for generation-capable models.
  generationParams: GenerationParamSpec | null;
  // Per-model TTS voice catalog. The valid voice set for the tts_create
  // tool is model-specific and not discoverable at runtime, so it's seeded
  // from a code family registry on add, stored here, and editable on the
  // Settings model card. null = no catalog yet (boot backfill seeds it for
  // audio_generation models). See VoiceOption.
  voiceCatalog: VoiceOption[] | null;
  createdAt: string;
  updatedAt: string;
}

// ── TTS voice catalog ──
//
// One entry per voice the tts_create tool may pick for a given model. The
// id sets the base timbre; character/accent/emotion is steered by writing
// the delivery into the spoken text, not by the voice id.

export interface VoiceOption {
  id: string;
  // The provider's documented voice character (e.g. "deep and authoritative").
  description: string;
  // Perceived gender, advisory only — helps the agent match requests like
  // "a male voice". Providers don't officially label voices by gender.
  gender: 'male' | 'female' | 'neutral';
}

// ── Generation parameter spec ──
//
// Generation tools require the agent to fill a fixed set of *canonical*
// params (video: duration / aspect_ratio / resolution), regardless of model.
// The engine enforces presence + validates the value, then this spec says
// how to put each canonical param on the specific model's wire request.
//
// The spec is seeded from a code-side family registry on add, stored per
// model in the DB, and editable by the user on the Settings model card.

export type GenerationParamWireType = 'string' | 'number';

export interface GenerationParamField {
  // Does this model accept this canonical param on the wire? When false the
  // agent must still supply a value (uniform tool contract) but it is NOT
  // forwarded to the provider.
  accepted: boolean;
  // Allowed values the agent may pick. Non-empty = strict enum (e.g. Sora's
  // [4,8,12]). Empty = fall back to the numeric min/max range below (lets a
  // flexible model accept e.g. 2 seconds).
  values: Array<string | number>;
  // Numeric range used only when `values` is empty. Inclusive.
  min?: number;
  max?: number;
  // What the card pre-fills and the agent should default to.
  default: string | number;
  // The provider's request-body field name. Multiple canonical params may
  // share a wireField (aspect_ratio + resolution both feed `size`), in which
  // case the submit composes them.
  wireField: string;
  wireType: GenerationParamWireType;
}

export type GenerationParamSpec = Record<string, GenerationParamField>;

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
  /** When true, the agent's conversations are skipped by the vault archive
   * layer entirely — Dreamer never sees them. Toggleable on the agent
   * detail page. Falls through from the group's flag if either is set. */
  dreamerIgnore?: boolean;
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
  /**
   * SQLite rowid of the message row. Optional because most `SELECT *` queries
   * don't project it (rowid is excluded from `*`); only the paths that need a
   * unique, monotonic, tie-free ordering key select it explicitly. Used as the
   * archival high-water (vault/archive.ts) so an equal-second boundary row is
   * never skipped by the Dreamer while still being compacted (silent loss).
   */
  rowid?: number;
  /**
   * Per-agent monotonic outer-turn counter. Increments once per outer turn
   * (one user message → agent's complete response, possibly with many tool
   * calls). Stored on every message v2 persists. NULL for v1-era messages
   * and for user messages persisted by the chat route — for stub-and-store
   * (Part XVIII §E), NULL is treated as "very old, stub it."
   *
   * Phase 4 (2026-05-04). The schema column was added in migration 037; the
   * DB row mapper started exposing it on the Message type as part of the
   * stub-and-store implementation.
   */
  turnNumber?: number | null;
  /**
   * Captured chain of thought from thinking-mode providers (DeepSeek
   * v4-pro/flash, OpenRouter unified reasoning, etc.). Stored alongside
   * `content` because some providers (DeepSeek explicitly) require it
   * to be echoed back on subsequent tool-call follow-up turns or the
   * request fails with a 400. The dashboard renders this as a
   * collapsible "Thinking…" section above the assistant bubble.
   * Anthropic's thinking blocks live inside `content` (as
   * type:"thinking" content blocks) and DON'T populate this field.
   */
  reasoningContent?: string | null;
  attachments?: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
  }>;
  /**
   * Where this message came from. Set for user messages dictated via voice
   * mode (`'voice'`, so the dashboard can render a small mic icon), and for
   * assistant/tool messages produced on a dedicated A2A turn (`'a2a'`, so the
   * dashboard hides the whole inter-agent turn — text and tool badges — in
   * regular mode; wordy mode still shows it). Typed messages and legacy
   * messages leave this null.
   */
  source?: 'voice' | 'a2a' | null;
  /**
   * Structured attribution columns (migrations 027 source_agent_id, 034 a2a_*,
   * 073 inbound_meta). Previously read from the DB and discarded by the row
   * mapper; now surfaced so the origin projection (and any consumer) can use
   * structured data instead of re-parsing prose markers in `content`.
   */
  sourceAgentId?: string | null;
  a2aThreadId?: string | null;
  a2aIntent?: string | null;
  a2aRequiresResponse?: number | null;
  inboundMeta?: string | null;
  /**
   * Conversation this message belongs to (migration 076). Stamped at end of
   * turn on the agent's OWN messages (assistant/tool) with the turn's
   * conversationKey, so the live-tail scoper keeps a self-message only for the
   * conversation it was produced in — one counterparty's work can't bleed into
   * another counterparty's turn. NULL on inbound user/system rows + legacy.
   */
  convKey?: string | null;
  /**
   * Canonical "who is this message from", consolidated from role + the
   * structured columns above + (for legacy rows) the `[SOURCE: …]`/`[A2A: …]`
   * markers in content. Computed in the row mapper via deriveOrigin(). This is
   * the single attribution signal the engine and dashboard should read.
   */
  origin?: MessageOrigin;
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

export type ToolErrorCode = 'PERMISSION_DENIED' | 'NOT_FOUND' | 'TIMEOUT' | 'INVALID_ARGS' | 'NETWORK_ERROR' | 'PARSE_ERROR' | 'RATE_LIMITED';

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  errorCode?: ToolErrorCode;
  // Structured content blocks for rich tool results (images, documents).
  // When present, the runtime uses these instead of `content` for the
  // tool_result sent to the model. `content` is still the text fallback
  // for persistence and display.
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
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
  taskCounts: { pending: number; inProgress: number; complete: number; blocked: number; failed: number; paused: number };
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  description: string | null;
  status: 'on_deck' | 'in_progress' | 'complete' | 'blocked' | 'fallen' | 'paused';
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
  repeatDaysOfWeek: string | null;
  /**
   * v2.5.45 — full ISO timestamp anchoring this recurring task's wall-
   * clock time. After each run, next_run_at is computed from the anchor
   * (not from completion time) so a task that takes 5 minutes doesn't
   * drift the schedule by 5 minutes every cycle. Editable via UI/tools;
   * default = scheduled_start at creation. Null for non-recurring tasks.
   */
  anchorTime: string | null;
  nextRunAt: string | null;
  runCount: number;
  isPaused: boolean;
  pausedUntil: string | null;
  statusBeforePause: string | null;
  scheduleStatus: string;
  assignedToGroup: string | null;
  /**
   * Discriminator for task variants. NULL for ordinary tasks.
   * 'reminder' = created via reminder_create; the scheduler fires it with a
   * lighter "deliver this to the user as a single chat message" prompt
   * instead of the generic scheduled-task boilerplate.
   */
  kind: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  // Phase B.1 validation flags. 1 = PM (or user) has blessed the matching
  // status. 0 = awaiting validation, dashboard shows the bug icon.
  pauseValidated: 0 | 1;
  completeValidated: 0 | 1;
  blockedValidated: 0 | 1;
  // 5-minute escalation: timestamp when the engine asked the user about
  // an unvalidated transition. NULL until the sweep fires.
  validationEscalatedAt: string | null;
  // Phase B.1 reasoning surface. Goal = what success looks like (set at
  // task creation), result = what the agent says it did, evidence = the
  // claims/files/tool-call refs the agent offered to back it up.
  goal: string | null;
  result: string | null;
  evidence: Array<{ kind: string; [k: string]: unknown }>;
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
