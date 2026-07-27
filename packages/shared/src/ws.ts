// ════════════════════════════════════════
// WebSocket Event Type Definitions
// ════════════════════════════════════════

import type { Agent, AgentMessage, AgentStatus, CompletionAnnouncement, HealthData, LogEntry, Message, MessageRole, Project, Task } from './types.js';

export interface AgentStatusEvent {
  type: 'agent:status';
  agentId: string;
  status: AgentStatus;
  /**
   * When status === 'working', whether this turn is a normal user turn or an
   * agent-to-agent (A2A) turn. Lets the composer stay quiet (no thinking dots,
   * no stop button) while the agent is only talking to another agent — unless
   * wordy mode is on. Absent on non-working statuses.
   */
  turnKind?: 'user' | 'a2a';
  /**
   * Whether this turn is serving a HUMAN conversation (dashboard / iMessage /
   * voice), i.e. its turn conv_key is a real conversation and not a pure
   * background a2a / engine (scheduler, PM poke, watcher) turn. Carried on
   * working AND idle/terminal broadcasts so the composer's "a user request is
   * unanswered" latch can survive a background turn's idle: on a busy box a
   * dashboard send queues behind background work, and the background turn's idle
   * used to wipe that latch before the queued user turn even started, killing the
   * thinking dots + stop button (regression, v3.1.10-preflight.31). A background
   * idle now carries userFacing:false and the client keeps the latch; only a
   * user-facing turn's idle (userFacing:true) clears it. Absent on legacy / raw
   * status broadcasts that predate this field, which keep the old clear-on-idle
   * behavior.
   */
  userFacing?: boolean;
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
 * Demote a live-streamed bubble into a working note. Mid-work narration
 * (assistant text riding in the same model response as tool calls) is never a
 * message to the user; the engine persists it as a `[working-note]` system row
 * instead of a conversation message. Because that text already STREAMED live,
 * silently dropping it made the bubble vanish before the user's eyes (owner
 * report 2026-07-10). This event tells the dashboard to convert the streamed
 * bubble (messageId) in place into the dimmed note (noteId), so live view and
 * reload agree and nothing pops out of existence.
 */
export interface ChatWorkingNoteEvent {
  type: 'chat:workingnote';
  agentId: string;
  /** The streaming bubble to convert in place. */
  messageId: string;
  /** The persisted working-note system row's id. */
  noteId: string;
  /** The narration text, unprefixed. */
  content: string;
  /**
   * RC-9: this note was demoted on a routed-channel human turn (iMessage / SMS /
   * Teams / email), where exactly ONE routing pass delivers exactly ONE string to
   * the channel while the dashboard live-mirrors every iteration. A demoted line
   * here was NOT delivered to that channel, so showing it as a settled note risks
   * reading as a second, contradictory reply. Internal notes are hidden by default
   * in the dashboard (shown only in wordy/verbose mode). Absent/false = the prior
   * always-visible working note (dashboard/voice turns are unchanged).
   */
  internal?: boolean;
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

/**
 * One inter-agent message as the dashboard's Inter-Agent lane renders it. This
 * is the DEDICATED lane for agent-to-agent (A2A) traffic and engine-origin
 * notices, which physically live in the `inter_agent_messages` store (D-A), NOT
 * in the primary's `messages` chat table. A2A therefore leaves `chat:message`
 * entirely: the delivery seams (a2a-transport peer delivery, agent-notice engine
 * notices) broadcast `interagent:message` instead, and the lane loads history
 * from GET /api/interagent/:agentId. `agentId` is the RECIPIENT (the woken
 * agent), so the lane filters to the currently-viewed agent exactly like chat.
 * The payload is self-sufficient (no MessageOrigin dependency) so the seam in
 * a2a-transport.ts, which imports @dojo/shared type-only to dodge the packaged-
 * runtime import trap, can build it without a runtime `deriveOrigin` call.
 */
export interface InterAgentMessage {
  id: string;
  /** The recipient agent (the woken agent). The lane filters on this. */
  agentId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** Sender agent id for peer A2A; null for engine-origin subsystem notices. */
  sourceAgentId: string | null;
  /** Resolved display name of the sender (an agent name, or a subsystem label
   *  like "Healer"/"Scheduler" for engine notices). */
  senderName: string | null;
  /** Resolved display name of the recipient agent. May be null on the live
   *  broadcast path (the lane fills it from the viewed agent it already knows). */
  recipientName: string | null;
  /** a2a_thread_id, groups messages into a conversation thread. Null for engine
   *  notices that carry no thread. */
  threadId: string | null;
  /** A2A intent (QUESTION/ASSIGN/ANSWER/…) or the engine origin_intent. */
  intent: string | null;
  /** Whether the sender expects a reply (a2a_requires_response). */
  requiresResponse: boolean;
  /** 'engine' = platform-origin notice/event; null = peer A2A. */
  originKind: 'engine' | null;
  attachments?: Message['attachments'];
}

export interface InterAgentMessageEvent {
  type: 'interagent:message';
  /** Recipient agent id (the lane filters to the viewed agent, like chat). */
  agentId: string;
  message: InterAgentMessage;
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

/**
 * Emitted when the Healer files a new fix proposal that needs owner approval
 * (healer_propose) and again when an approved proposal is marked applied
 * (healer_mark_applied). The dashboard's HealerVitals card re-runs its
 * proposals/actions load() on this event so a freshly-filed consent decision
 * (or a just-applied fix) appears live instead of only after a page reload.
 * The two emit sites send different fields, so everything past `id` is
 * optional: the propose site sends `title` + `severity`; the mark-applied
 * site sends `status: 'applied'`.
 */
export interface HealerProposalEvent {
  type: 'healer:proposal';
  data: {
    id: string;
    title?: string;
    severity?: string;
    // Resolution stamps. Every resolution site broadcasts its status so a live
    // surface (the step-4 decision toast) can drop a stale pending card no
    // matter WHERE the proposal was resolved (toast button, Vitals, the
    // 60-minute urgent expiry sweep, or the Healer applying it).
    status?: 'applied' | 'approved' | 'denied' | 'auto_resolved';
    // D-B step 2: the engine stamps these on a proposal so a later surface
    // (step 4 orb toast, step 5 iMessage) can decide from the live WS frame,
    // without a refetch, whether this proposal is urgent and which lane it
    // belongs to. Optional so the existing propose/mark-applied emit sites,
    // which never set them, keep compiling.
    urgency?: 'routine' | 'urgent';
    surface?: 'vitals' | 'toast' | 'imessage';
  };
}

export type WsEvent =
  | AgentStatusEvent
  | HealerProposalEvent
  | VideoJobUpdateEvent
  | GenerationJobUpdateEvent
  | EngineActivityEvent
  | ChatChunkEvent
  | ChatReasoningChunkEvent
  | ChatMessageEvent
  | ChatWorkingNoteEvent
  | ChatSourceUpdatedEvent
  | InterAgentMessageEvent
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
  | DockCollapseEvent
  | CanvasUpdatedEvent
  | UiNavigateEvent
  | GoogleConnectedEvent
  | GoogleDisconnectedEvent
  | GoogleActivityEvent
  | MicrosoftConnectedEvent
  | MicrosoftDisconnectedEvent
  | MicrosoftOfficePackagesEvent
  | MicrosoftActivityEvent
  | PlaudAuthUrlEvent
  | PlaudConnectedEvent
  | PlaudDisconnectedEvent
  | PlaudLoginFailedEvent
  | GroupCreatedEvent
  | GroupDeletedEvent
  | BackfillProgressEvent
  | DreamStartedEvent
  | DreamCompleteEvent
  | DreamRecoveryEvent
  | TaskRunStartedEvent
  | TaskRunCompleteEvent
  | TrackerTaskLogEvent
  | SystemTunnelStatusEvent
  | MigrationDepsetupEvent
  | SystemRestartEvent;

/**
 * Open the right dock for the user (slides the chat left). Emitted by the
 * agent (via a tool) to surface a working document / HTML render ('canvas')
 * or a live website ('iframe') alongside the conversation.
 */
/**
 * The canvas/dock was collapsed to the edge handle (the user closed it, or
 * another device did). Content is retained server-side; the dashboard shows the
 * re-open handle. Broadcast so every connected device stays in sync.
 */
export interface DockCollapseEvent {
  type: 'dock:collapse';
  /** Which agent's canvas slot was collapsed (canvas is per-agent). The dashboard
   *  only mirrors the collapse when it matches the agent currently being viewed. */
  agentId: string;
}

export interface DockOpenEvent {
  type: 'dock:open';
  /** Which agent's canvas slot this open belongs to (canvas is per-agent). The
   *  dashboard only opens the dock when this matches the agent being viewed, so a
   *  background agent's auto-open can never replace the viewed agent's canvas. */
  agentId: string;
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
  /** Which agent's canvas slot changed (canvas is per-agent). The dashboard only
   *  re-fetches when it matches the agent currently being viewed. */
  agentId: string;
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

// A call-to-action the import wizard renders for a post-migration check.
//   link                 → navigate within the dashboard (target = route)
//   open_system_settings → open a macOS System Settings pane (target = pane id)
//   revalidate_provider  → re-test a provider's restored API key (target = provider id)
//   run_installer        → (re)run the dependency installer
//   recheck              → re-evaluate this check now (e.g. after a manual action)
//   reconnect_oauth      → start an OAuth reconnect right here (target = 'google'|'microsoft');
//                          the wizard POSTs /api/<target>/connect and opens the authUrl
//   info                 → no action, informational only
export interface MigrationCta {
  type: 'link' | 'open_system_settings' | 'revalidate_provider' | 'run_installer' | 'recheck' | 'reconnect_oauth' | 'info';
  label: string;
  target?: string;
}

export interface PostMigrationCheck {
  id: string;
  label: string;
  status: 'ok' | 'action_needed' | 'in_progress';
  // Grouping for the wizard's guided setup step:
  //   automated  → handled by the dojo (deps, ollama, models); shown as status only
  //   action     → needs the user (permissions, re-auth, missing key)
  //   technique  → a migrated technique's own setup notes (one card per technique)
  category?: 'automated' | 'action' | 'technique';
  /** Legacy free-text hint (kept for back-compat); prefer cta + detailItems. */
  action?: string;
  detail?: string;
  /** Structured, line-by-line setup items for technique cards. */
  detailItems?: { text: string; kind: 'install' | 'manual' }[];
  cta?: MigrationCta;
}

export interface MigrationChecksEvent {
  type: 'migration:checks';
  data: { checks: PostMigrationCheck[]; dismissed: boolean };
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

// ── Integration connect / activity events ──
//
// Google and Microsoft workspace connect/disconnect toggles and per-write
// activity. `slot` is the account slot ('agent' | 'user' today; a plain string
// so multi-account additions don't break the wire contract). None of these are
// consumed by the dashboard yet, but they are typed so the compiler guards the
// wire shape and a future consumer can subscribe without guessing.

export interface GoogleConnectedEvent {
  type: 'google:connected';
  data: { email: string; slot: string };
}

export interface GoogleDisconnectedEvent {
  type: 'google:disconnected';
  data: { slot: string };
}

export interface GoogleActivityEvent {
  type: 'google:activity';
  data: {
    agentId: string;
    agentName: string;
    action: string;
    actionType: string;
    details: Record<string, unknown>;
  };
}

export interface MicrosoftConnectedEvent {
  type: 'microsoft:connected';
  data: { email: string; slot: string };
}

export interface MicrosoftDisconnectedEvent {
  type: 'microsoft:disconnected';
  data: { slot: string };
}

export interface MicrosoftOfficePackagesEvent {
  type: 'microsoft:office_packages';
  data: { status: 'installed' | 'installing' | 'failed'; error?: string };
}

export interface MicrosoftActivityEvent {
  type: 'microsoft:activity';
  data: {
    agentId: string;
    agentName: string;
    action: string;
    actionType: string;
    details: Record<string, unknown>;
  };
}

// ── Plaud (voice recorder) auth events ──
// These carry their fields at the top level (not under `data`), matching the
// emit sites in plaud/auth.ts and the PlaudSettings consumer.

export interface PlaudAuthUrlEvent {
  type: 'plaud:auth_url';
  url: string;
}

export interface PlaudConnectedEvent {
  type: 'plaud:connected';
  email: string | null;
}

export interface PlaudDisconnectedEvent {
  type: 'plaud:disconnected';
}

export interface PlaudLoginFailedEvent {
  type: 'plaud:login_failed';
  error: string;
}

// ── Agent group lifecycle ──

export interface GroupCreatedEvent {
  type: 'group:created';
  data: { id: string; name: string };
}

export interface GroupDeletedEvent {
  type: 'group:deleted';
  data: { id: string };
}

// ── Memory backfill (embedding) progress ──

export interface BackfillProgressEvent {
  type: 'backfill:progress';
  data: {
    total: number;
    completed: number;
    failed: number;
    status: 'running' | 'complete';
  };
}

// ── Dreamer (vault maintenance) lifecycle ──
// dream:complete carries different fields depending on the exit path (skipped
// vs a real run), so everything is optional; the Memory page consumes it only
// to trigger a re-fetch.

export interface DreamStartedEvent {
  type: 'dream:started';
  data: { mode: string; archives: number; batches: number };
}

export interface DreamCompleteEvent {
  type: 'dream:complete';
  data: {
    skipped?: boolean;
    reason?: string;
    autoSkipped?: number;
    pruned?: number;
    decayed?: number;
    unpinned?: number;
    agedOut?: number;
    batches?: number;
  };
}

export interface DreamRecoveryEvent {
  type: 'dream:recovery';
  data: {
    reason: string;
    newSubBatchCount: number;
    currentIndex: number;
    totalBatches: number;
  };
}

// ── Scheduled task run lifecycle (consumed by TaskRunHistory) ──

export interface TaskRunStartedEvent {
  type: 'task:run_started';
  data: { taskId: string; runId: string; agentId: string };
}

export interface TaskRunCompleteEvent {
  type: 'task:run_complete';
  data: { taskId: string; runId: string; status: string; nextRun: string | null };
}

// ── Tracker task audit-log append ──

export interface TrackerTaskLogEvent {
  type: 'tracker:task_log';
  data: { taskId: string; entryKind: string; fromEntity: string };
}

// ── Cloudflare tunnel status (mirrors services/tunnel.ts TunnelStatus) ──

export interface SystemTunnelStatusEvent {
  type: 'system:tunnel_status';
  data: {
    enabled: boolean;
    mode: 'named' | 'quick';
    status: 'inactive' | 'starting' | 'active' | 'error';
    url: string | null;
    error: string | null;
    startedAt: number | null;
    cloudflaredInstalled: boolean;
  };
}

// ── Migration dependency-installer stream ──
// Streams the installer's stdout line-by-line, then a terminal frame with the
// exit result. Consumed by the ImportWizard.

export interface MigrationDepsetupEvent {
  type: 'migration:depsetup';
  data: {
    line?: string;
    done?: boolean;
    ok?: boolean;
    exitCode?: number | null;
    error?: string;
  };
}

// ── Server restart marker ──
// Broadcast right before the process exits for a restart so every connected
// device can show a "restarting" overlay and ride out the reconnect gap
// instead of surfacing raw connection errors. Fields sit at the top level.

export interface SystemRestartEvent {
  type: 'system:restart';
  initiatedAt: string;
  mode: 'dev' | 'production';
}

// ════════════════════════════════════════
// Batching decision (colocated with the union)
// ════════════════════════════════════════
//
// The gateway coalesces high-frequency events in a short window (<=50ms, no
// reorder within a type, no persistence impact) to spare the event loop. That
// decision USED to live in a hand-maintained Set inside the server, which drifts:
// a new high-frequency event (e.g. chat:reasoning_chunk, FA-G3) is trivially
// forgotten, and every thinking delta then fans out one stringify+send per token.
//
// Carrying the flag HERE, as a Record keyed by every WsEvent type, makes the
// batching decision part of the wire contract: adding a member to WsEvent that
// is missing from this map is a compile error, so a new event cannot ship without
// an explicit `true`/`false`. BATCHABLE_EVENTS is DERIVED from it, so the two can
// never disagree.
//
//   true  = high-frequency stream, safe to coalesce (chunks, status, logs)
//   false = deliver immediately (errors, completions, one-shot state changes)
export const EVENT_BATCHABLE: Record<WsEvent['type'], boolean> = {
  // High-frequency streams: batch.
  'chat:chunk': true,
  'chat:reasoning_chunk': true,
  'chat:tool_call': true,
  'chat:tool_result': true,
  'chat:message': true,
  // One-shot bubble demotion; must land promptly so the streamed bubble
  // converts before the eye registers a vanish.
  'chat:workingnote': false,
  'agent:status': true,
  'log:entry': true,
  'ollama:status': true,

  // Everything else: deliver immediately.
  'chat:source_updated': false,
  // Inter-agent lane: low-frequency structured traffic (peer A2A + engine
  // notices), never a per-chunk stream, so deliver immediately.
  'interagent:message': false,
  'chat:error': false,
  'system:health': false,
  'memory:compaction': false,
  'memory:briefing': false,
  'agent:created': false,
  'agent:completed': false,
  'agent:terminated': false,
  'agent:message': false,
  'healer:proposal': false,
  'video_job:update': false,
  'generation_job:update': false,
  'engine:activity': false,
  'tracker:task_updated': false,
  'tracker:project_updated': false,
  'tracker:poke': false,
  'tracker:task_log': false,
  'cost:alert': false,
  'provider:status': false,
  'resource:warning': false,
  'system:dep_installed': false,
  'technique:created': false,
  'technique:published': false,
  'technique:updated': false,
  'technique:used': false,
  'technique:state_changed': false,
  'migration:progress': false,
  'migration:checks': false,
  'migration:depsetup': false,
  'voice:model_download': false,
  'voice:model_install_error': false,
  'voice:stt_partial': false,
  'voice:stt_final': false,
  'voice:tts_start': false,
  'voice:tts_end': false,
  'voice:state': false,
  'voice:wake_detected': false,
  'voice:sleep_detected': false,
  'dock:open': false,
  'dock:collapse': false,
  'canvas:updated': false,
  'ui:navigate': false,
  'google:connected': false,
  'google:disconnected': false,
  'google:activity': false,
  'microsoft:connected': false,
  'microsoft:disconnected': false,
  'microsoft:office_packages': false,
  'microsoft:activity': false,
  'plaud:auth_url': false,
  'plaud:connected': false,
  'plaud:disconnected': false,
  'plaud:login_failed': false,
  'group:created': false,
  'group:deleted': false,
  'backfill:progress': false,
  'dream:started': false,
  'dream:complete': false,
  'dream:recovery': false,
  'task:run_started': false,
  'task:run_complete': false,
  'system:tunnel_status': false,
  'system:restart': false,
};

/**
 * The set of event types the gateway batches, DERIVED from EVENT_BATCHABLE so it
 * can never drift from the per-event decision above. Consumed by the gateway's
 * broadcast() to pick immediate vs. batched fan-out.
 */
export const BATCHABLE_EVENTS: ReadonlySet<WsEvent['type']> = new Set(
  (Object.keys(EVENT_BATCHABLE) as Array<WsEvent['type']>).filter((t) => EVENT_BATCHABLE[t]),
);
