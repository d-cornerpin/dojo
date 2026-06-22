// ════════════════════════════════════════
// WebSocket Event Type Definitions
// ════════════════════════════════════════

import type { Agent, AgentMessage, CompletionAnnouncement, HealthData, LogEntry, Message, Project, Task } from './types.js';

export interface AgentStatusEvent {
  type: 'agent:status';
  agentId: string;
  status: string;
}

export interface ChatChunkEvent {
  type: 'chat:chunk';
  agentId: string;
  messageId: string;
  content: string;
  done: boolean;
  modelId?: string | null;
}

/**
 * Streamed reasoning / thinking deltas from providers that expose them
 * (DeepSeek native, OpenRouter unified). Distinct from chat:chunk so the
 * dashboard can render them in a collapsible "Thinking…" panel above the
 * eventual assistant bubble. Each event is one delta; final state is
 * implied when chat:chunk done:true arrives or chat:message lands.
 */
export interface ChatReasoningChunkEvent {
  type: 'chat:reasoning_chunk';
  agentId: string;
  messageId: string;
  content: string;
  done: boolean;
}

export interface ChatToolCallEvent {
  type: 'chat:tool_call';
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ChatToolResultEvent {
  type: 'chat:tool_result';
  agentId: string;
  tool: string;
  result: string;
}

export interface ChatMessageEvent {
  type: 'chat:message';
  agentId: string;
  message: Message;
}

/**
 * Marks an existing assistant message as having been delivered through
 * voice mode TTS (Kokoro or Hume). The dashboard sets the local
 * message's `source` field to 'voice' so the AssistantBubble renders
 * a "via voice" badge, mirroring the user-side badge.
 */
export interface ChatSourceUpdatedEvent {
  type: 'chat:source_updated';
  agentId: string;
  messageId: string;
  source: 'voice' | null;
}

export interface ChatErrorEvent {
  type: 'chat:error';
  agentId: string;
  error: string;
  code?:
    | 'RATE_LIMITED' | 'MODEL_FAILED' | 'PERMISSION_DENIED' | 'ERROR_LOOP'
    | 'TIMEOUT' | 'TERMINATED' | 'STUCK_REPEATING' | 'NO_RESULTS'
    | 'TASK_THRASH_PAUSED'
    // Healer visibility codes (added 2026-04-29) — surface every silent
    // return path so the user always knows whether auto-recovery is running.
    | 'HEALER_DISPATCHED' | 'HEALER_SUPPRESSED_MAX_ATTEMPTS' | 'HEALER_MISSING'
    | 'HEALER_SELF_INJURED' | 'HEALER_DELIVERY_FAILED'
    // v2 — surfaces 90% context utilization WARN events so users see them as
    // toasts in real time. Each is an architecture bug to investigate.
    | 'CONTEXT_HIGH'
    // Phase 8 F1 toast audit — emitted by onAgentRecovered so the dashboard
    // can auto-dismiss the lingering injury error toast once the agent
    // self-resolves (most provider 4xx errors are transient).
    | 'AGENT_RECOVERED'
    // error-handling-spec v2.3.19 Tier D — platform-level lock codes.
    // Each represents a condition where the engine can't proceed and the
    // user needs to act. Plain-English user message lives in `error`.
    | 'AUTH_INVALID' | 'ACCESS_DENIED' | 'QUOTA_EXHAUSTED' | 'DNS_FAILURE'
    // v2.3.19 (Phase 1 hardening, 2026-05-10) — preflight escapes that
    // bypass the recovery cascade entirely (thrown before its try/catch).
    | 'NO_MODEL' | 'AGENT_NOT_FOUND';
  severity?: 'info' | 'warning' | 'error';
  retryable?: boolean;
}

export interface LogEntryEvent {
  type: 'log:entry';
  entry: LogEntry;
}

export interface SystemHealthEvent {
  type: 'system:health';
  data: HealthData;
}

export interface MemoryCompactionEvent {
  type: 'memory:compaction';
  agentId: string;
  leafCreated: number;
  condensedCreated: number;
  tokensReclaimed: number;
}

export interface MemoryBriefingEvent {
  type: 'memory:briefing';
  agentId: string;
  briefingId: string;
  tokenCount: number;
}

export interface AgentCreatedEvent {
  type: 'agent:created';
  data: Agent;
}

export interface AgentCompletedEvent {
  type: 'agent:completed';
  data: CompletionAnnouncement;
}

export interface AgentTerminatedEvent {
  type: 'agent:terminated';
  agentId: string;
  reason: string;
}

export interface AgentMessageEvent {
  type: 'agent:message';
  data: AgentMessage;
}

export interface TrackerTaskUpdatedEvent {
  type: 'tracker:task_updated';
  data: Task;
}

export interface TrackerProjectUpdatedEvent {
  type: 'tracker:project_updated';
  data: Project;
}

export interface TrackerPokeEvent {
  type: 'tracker:poke';
  data: { taskId: string; agentId: string; pokeType: string };
}

export interface CostAlertEvent {
  type: 'cost:alert';
  data: {
    scope: string;
    percentage: number;
    currentSpend: number;
    limitUsd: number;
  };
}

export interface ProviderStatusEvent {
  type: 'provider:status';
  data: {
    providerId: string;
    healthy: boolean;
    error?: string;
  };
}

export interface ResourceWarningEvent {
  type: 'resource:warning';
  data: {
    type: string;
    freeMb: number;
    totalMb: number;
    threshold: number;
  };
}

export interface WatchdogAlertEvent {
  type: 'watchdog:alert';
  data: {
    alertType: string;
    message: string;
    timestamp: string;
  };
}

/**
 * Emitted at server startup when the dep installer freshly installs a brew
 * package. The dashboard toasts each one so the user knows what changed.
 * Status 'failed' fires if brew couldn't install the package — usually a
 * homebrew issue worth surfacing to the user.
 */
export interface SystemDepInstalledEvent {
  type: 'system:dep_installed';
  data: {
    pkg: string;
    status: 'installed' | 'failed';
  };
}

/**
 * Emitted whenever a video generation job changes state (created, polling,
 * succeeded, failed, cancelled). The dashboard's ActiveJobsIndicator
 * listens for this to show/hide the in-flight spinner and refresh the
 * modal without re-polling. `activeCount` is the number of jobs still in
 * 'queued' or 'polling' across all agents, so the indicator can render a
 * badge straight from the event.
 */
export interface VideoJobUpdateEvent {
  type: 'video_job:update';
  data: {
    id: string;
    agentId: string;
    status: 'queued' | 'polling' | 'succeeded' | 'failed' | 'cancelled';
    prompt: string;
    activeCount: number;
  };
}

/**
 * Emitted by the generation-jobs worker as an image / audio / music job
 * changes state. The same ActiveJobsIndicator that listens for video job
 * updates also listens for this, so the spinning-icon + popup covers every
 * media generator. `kind` lets the indicator pick the right icon/label.
 * `activeCount` here is the count of in-flight generation_jobs only; the
 * indicator merges it with the video count for its badge.
 */
export interface GenerationJobUpdateEvent {
  type: 'generation_job:update';
  data: {
    id: string;
    agentId: string;
    kind: 'image' | 'audio' | 'music';
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    prompt: string;
    activeCount: number;
  };
}

/**
 * Emitted by engine-managed background sequences that are not media jobs.
 * Memory compaction fires this directly (start/end correlated by `id`). The
 * Dreamer and Healer are surfaced by the indicator from their agent:status
 * instead, since they run as agents. The ActiveJobsIndicator renders these
 * as in-flight rows with NO Stop button (engine-managed, not user-cancellable)
 * and shows them regardless of which agent is selected.
 */
export interface EngineActivityEvent {
  type: 'engine:activity';
  data: {
    id: string;
    kind: 'compaction' | 'dreamer' | 'healer';
    agentId: string | null;
    label: string;
    startedAt: string;
    phase: 'start' | 'end';
  };
}

export type WsEvent =
  | AgentStatusEvent
  | VideoJobUpdateEvent
  | GenerationJobUpdateEvent
  | EngineActivityEvent
  | ChatChunkEvent
  | ChatReasoningChunkEvent
  | ChatMessageEvent
  | ChatSourceUpdatedEvent
  | ChatToolCallEvent
  | ChatToolResultEvent
  | ChatErrorEvent
  | LogEntryEvent
  | SystemHealthEvent
  | MemoryCompactionEvent
  | MemoryBriefingEvent
  | AgentCreatedEvent
  | AgentCompletedEvent
  | AgentTerminatedEvent
  | AgentMessageEvent
  | TrackerTaskUpdatedEvent
  | TrackerProjectUpdatedEvent
  | TrackerPokeEvent
  | CostAlertEvent
  | ProviderStatusEvent
  | ResourceWarningEvent
  | WatchdogAlertEvent
  | SystemDepInstalledEvent
  | OllamaStatusEvent
  | TechniqueCreatedEvent
  | TechniquePublishedEvent
  | TechniqueUpdatedEvent
  | TechniqueUsedEvent
  | TechniqueStateChangedEvent
  | MigrationProgressEvent
  | MigrationChecksEvent
  | VoiceModelDownloadEvent
  | VoiceModelInstallErrorEvent
  | VoiceSttPartialEvent
  | VoiceSttFinalEvent
  | VoiceTtsStartEvent
  | VoiceTtsEndEvent
  | VoiceStateEvent
  | VoiceWakeDetectedEvent
  | VoiceSleepDetectedEvent
  | DockOpenEvent
  | CanvasUpdatedEvent
  | UiNavigateEvent;

/**
 * Open the right dock for the user (slides the chat left). Emitted by the
 * agent (via a tool) to surface a working document / HTML render ('canvas')
 * or a live website ('iframe') alongside the conversation.
 */
export interface DockOpenEvent {
  type: 'dock:open';
  data: {
    // 'screen' = live VNC screen-share viewer (needs no extra data fields).
    kind: 'canvas' | 'iframe' | 'screenshot' | 'screen';
    title?: string;
    /** canvas: inline HTML to render */
    html?: string;
    /** canvas (a hosted doc) or iframe: the url to load. screenshot: the served
     *  PNG of the page (used when the site blocks iframe embedding). */
    url?: string;
    /** canvas: absolute path of the backing file, when the canvas shows a file
     *  on disk. Lets the dock auto-refresh when the agent edits that file and
     *  enables the download affordance. */
    path?: string;
    /** screenshot: the original website URL, so the dock's "Open in new window"
     *  button can launch the real, interactive site in a browser tab. */
    sourceUrl?: string;
  };
}

/**
 * A file on disk that a canvas may be showing was just written (file_write /
 * file_patch / file_append). The dock re-fetches if it's displaying this path,
 * so edits the agent makes appear without a manual refresh.
 */
export interface CanvasUpdatedEvent {
  type: 'canvas:updated';
  data: {
    /** absolute path of the file that changed */
    path: string;
  };
}

/**
 * Tells the dashboard to navigate the user's view — open a top-level page
 * or a specific Settings tab. Emitted by the agent (via the open_page /
 * open_settings tools) so it can take the user where they asked to go
 * ("show me my cost dashboard", "where do I change my voice?"). Purely a
 * UI move: it only does something for a user who has the dashboard open,
 * and changes no state on its own. `path` is a react-router path (e.g. '/',
 * '/settings', '/costs'); `tab` is the Settings tab id when path is
 * '/settings'; `section` is an optional human label matched against a
 * section heading within that tab to scroll it into view.
 */
export interface UiNavigateEvent {
  type: 'ui:navigate';
  data: {
    path: string;
    tab?: string;
    section?: string;
  };
}

export interface OllamaStatusEvent {
  type: 'ollama:status';
  data: {
    maxConcurrentModels: number;
    // Slots are now per-provider: each entry tags which Ollama provider
    // the model is loaded on, so the same modelName can legitimately
    // appear once per provider.
    slots: Array<{ providerId: string; modelName: string; activeRequests: number }>;
    queuedRequests: number;
    queuedModels: Array<{ providerId: string; modelName: string }>;
  };
}

export interface TechniqueCreatedEvent {
  type: 'technique:created';
  data: { id: string; name: string; state: string };
}

export interface TechniquePublishedEvent {
  type: 'technique:published';
  data: { id: string; name: string };
}

export interface TechniqueUpdatedEvent {
  type: 'technique:updated';
  data: { id: string; name: string; version: number };
}

export interface TechniqueUsedEvent {
  type: 'technique:used';
  data: { id: string; name: string; agentId: string; agentName: string };
}

export interface TechniqueStateChangedEvent {
  type: 'technique:state_changed';
  data: { id: string; name: string; oldState: string | undefined; newState: string };
}

export interface MigrationProgressEvent {
  type: 'migration:progress';
  data: { stage: string; progress: number; message: string };
}

export interface MigrationChecksEvent {
  type: 'migration:checks';
  data: { checks: Array<{ id: string; label: string; status: string; action?: string; detail?: string }>; dismissed: boolean };
}

// ── Voice mode events ──

export interface VoiceModelDownloadEvent {
  type: 'voice:model_download';
  data: {
    kind: 'whisper' | 'kokoro' | 'moonshine';
    modelId: string;
    bytesDownloaded: number;
    bytesTotal: number;
  };
}

export interface VoiceModelInstallErrorEvent {
  type: 'voice:model_install_error';
  data: {
    kind: 'whisper' | 'kokoro' | 'moonshine';
    modelId: string;
    error: string;
  };
}

export interface VoiceSttPartialEvent {
  type: 'voice:stt_partial';
  agentId: string;
  text: string;
}

export interface VoiceSttFinalEvent {
  type: 'voice:stt_final';
  agentId: string;
  text: string;
  durationMs: number;
}

export interface VoiceTtsStartEvent {
  type: 'voice:tts_start';
  agentId: string;
  messageId: string;
}

export interface VoiceTtsEndEvent {
  type: 'voice:tts_end';
  agentId: string;
  messageId: string;
}

export interface VoiceStateEvent {
  type: 'voice:state';
  agentId: string;
  state: 'idle' | 'listening' | 'capturing' | 'transcribing' | 'waiting' | 'speaking' | 'error' | 'passive';
  detail?: string;
}

export interface VoiceWakeDetectedEvent {
  type: 'voice:wake_detected';
  agentId: string;
  phrase: string;
  /** Text that came AFTER the wake phrase in the same utterance, if any. */
  remainder: string | null;
}

export interface VoiceSleepDetectedEvent {
  type: 'voice:sleep_detected';
  agentId: string;
  phrase: string;
}
