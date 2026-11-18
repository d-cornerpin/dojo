
import type { Agent, AgentStatus, LogEntry, Message, MessageRole, Project, Task } from './types.js';
import type { DisplayKind, MessageLane, VisibilityTier } from './visibility.js';

export interface AgentStatusEvent {
  type: 'agent:status';
  agentId: string;
  status: AgentStatus;
  /** On a `paused` frame for a parked agent, why (plain words); the pill's tooltip. */
  parkedCause?: string;
  /** When working: a user turn or an a2a turn (the composer stays quiet on a2a unless wordy). */
  turnKind?: 'user' | 'a2a';
  /** True when the turn serves a HUMAN conversation, not a background a2a/engine turn. Sent on idle
   *  frames too, so a background idle (false) does not clear the "request unanswered" latch. */
  userFacing?: boolean;
  /** Set only on the frame `stopAgent` emits for a run still unwinding, so the dashboard can say
   *  "Stopping". `agents.status` keeps `working` until teardown because other readers consult it. */
  stopping?: boolean;
}

// What a stop would cut for one agent: `agent:status` describes a TURN, and a background job that outlives
// one emits no status frame. `server/src/agent/live-work.ts` owns the predicate. Emitted on lifecycle edges.
export interface AgentJobsEvent {
  type: 'agent:jobs';
  agentId: string;
  /** Live turn-scoped abortable registrations (a count, not a turn number). */
  turn: number;
  /** Distinct background things a stop would cut (registrations plus open media rows, a job counted
   *  once). */
  background: number;
  /** `turn > 0 || background > 0`, computed server-side so no client re-derives the predicate. */
  stoppable: boolean;
}

export interface ChatChunkEvent {
  type: 'chat:chunk';
  agentId: string;
  messageId: string;
  content: string;
  done: boolean;
  modelId?: string | null;
  turnKind?: 'user' | 'a2a';
}

export interface ChatReasoningChunkEvent {
  type: 'chat:reasoning_chunk';
  agentId: string;
  messageId: string;
  content: string;
  done: boolean;
  turnKind?: 'user' | 'a2a';
}

export interface ChatToolCallEvent {
  type: 'chat:tool_call';
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  turnKind?: 'user' | 'a2a';
}

export interface ChatToolResultEvent {
  type: 'chat:tool_result';
  agentId: string;
  tool: string;
  result: string;
  turnKind?: 'user' | 'a2a';
}

/** The persisted row behind a `chat:message`, attached at the broadcast seam (`gateway/ws.ts`) by
 *  looking the emission up by its own id. Optional in the type because the seam fills it after the call
 *  sites build the event; absent means no persisted row (a defect). */
export interface BroadcastRow {
  /** The insertion key (`messages.seq`), strictly monotonic; live and reloaded rows order by it. */
  seq: number;
  id: string;
  lane: MessageLane;
  displayKind: DisplayKind;
  displayTier: VisibilityTier;
  /** Epoch ms: the same instant as `message.createdAt`, which carries the reload route's text form. */
  createdAt: number;
  mood: string | null;
}

export interface ChatMessageEvent {
  type: 'chat:message';
  agentId: string;
  message: Message;
  row?: BroadcastRow;
}

/** Remove a bubble the client already shows (an engine-dropped stream); carries no content and is a
 *  no-op if absent. */
export interface ChatRetractEvent {
  type: 'chat:retract';
  agentId: string;
  messageId: string;
}

/** Convert a streamed bubble (messageId) in place into the dimmed working-note row (noteId). */
export interface ChatWorkingNoteEvent {
  type: 'chat:workingnote';
  agentId: string;
  messageId: string;
  noteId: string;
  content: string;
  /** Demoted on a routed-channel human turn (iMessage / SMS / Teams / email), where one string is
   *  delivered to the channel; shown only in wordy mode. */
  internal?: boolean;
  /** true: the turn-end path, where the bubble was persisted as an ordinary assistant row and only
   *  `display_kind` changes (`content` and `role` untouched), so `messageId` and `noteId` are the SAME
   *  id. Absent or false: a NEW working-note row was written. A client must not fabricate a system row
   *  on the true shape. */
  reclassified?: boolean;
}

export interface ChatSourceUpdatedEvent {
  type: 'chat:source_updated';
  agentId: string;
  messageId: string;
  source: 'voice' | null;
}

/** One inter-agent message as the Inter-Agent lane renders it: A2A traffic, engine notices, and the
 *  agent's own output on a coordination turn. These are `lane IN ('a2a','events')` rows; the human chat
 *  surface is the `chat_messages` view. Self-sufficient (no MessageOrigin) so a2a-transport.ts, which
 *  imports @dojo/shared type-only, can build it. `agentId` is the agent whose lane it belongs to;
 *  `role` carries the direction. */
export interface InterAgentMessage {
  id: string;
  agentId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  sourceAgentId: string | null;
  /** Resolved sender name (an agent, or a subsystem label like "Healer"). */
  senderName: string | null;
  /** Resolved recipient name; may be null on a live broadcast (the lane fills it from the viewed agent). */
  recipientName: string | null;
  threadId: string | null;
  intent: string | null;
  /** Whether the sender expects a reply (a2a_requires_response). */
  requiresResponse: boolean;
  /** 'engine' = platform-origin notice/event; null = peer A2A. */
  originKind: 'engine' | null;
  attachments?: Message['attachments'];
}

export interface InterAgentMessageEvent {
  type: 'interagent:message';
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
    // Healer visibility codes: every silent return path surfaces, so the user knows if recovery is running.
    | 'HEALER_DISPATCHED' | 'HEALER_SUPPRESSED_MAX_ATTEMPTS' | 'HEALER_MISSING'
    | 'HEALER_SELF_INJURED' | 'HEALER_DELIVERY_FAILED'
    // 90% context utilization WARN events, shown as real-time toasts.
    | 'CONTEXT_HIGH'
    // Emitted by onAgentRecovered so the dashboard can auto-dismiss the lingering injury error toast.
    | 'AGENT_RECOVERED'
    // Platform-level lock codes: the engine cannot proceed and the user must act (plain English in `error`).
    | 'AUTH_INVALID' | 'ACCESS_DENIED' | 'QUOTA_EXHAUSTED' | 'DNS_FAILURE'
    // Failures thrown before the recovery cascade's try/catch, so they bypass it entirely.
    | 'NO_MODEL' | 'AGENT_NOT_FOUND' | 'COMPACTION_FAILING'   // compaction is failing for a repairable reason
    // A turn-ending floor steered the agent twice and it stayed silent: the platform says so, as itself
    // (`work_events(kind='floor_ghosted')` records the same event durably).
    | 'FLOOR_GHOSTED'
    // Closed work is waiting on the project manager and it has not ruled; tasks stay open, so this rides
    // `severity:'warning'`.
    | 'VALIDATION_STALLED'
    // The agent's model window cannot hold its system prompt (`budget.ts` SystemPromptTooLargeError).
    // It does not clear itself: `retryable: false` and `severity: 'error'` keep the card until the tool list
    // shrinks or the agent moves to a bigger-window model.
    | 'WINDOW_TOO_SMALL';
  severity?: 'info' | 'warning' | 'error';
  retryable?: boolean;
  /** An owner card whose words can change while it stands is matched by this condition key. */
  cardKey?: string;
  /** `action` (the owner must do something; a sticky card holding the orb's red alert) or
   *  `informational` (a plain toast that leaves by itself, never red). On an agent's chat:error only
   *  `action` with severity `error` is sticky. */
  cardClass: 'action' | 'informational';
}

export interface LogEntryEvent {
  type: 'log:entry';
  entry: LogEntry;
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

export interface AgentTerminatedEvent {
  type: 'agent:terminated';
  agentId: string;
  reason: string;
}

export interface TrackerTaskUpdatedEvent {
  type: 'tracker:task_updated';
  data: Task;
}

export interface TrackerProjectUpdatedEvent {
  type: 'tracker:project_updated';
  data: Project;
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

/** Emitted at startup when the dep installer freshly installs a brew package ('failed' if brew could
 *  not). */
export interface SystemDepInstalledEvent {
  type: 'system:dep_installed';
  data: {
    pkg: string;
    status: 'installed' | 'failed';
  };
}

/** Emitted whenever a video generation job changes state; `activeCount` is the jobs still queued or
 *  polling across all agents, so it cannot answer a per-agent question. */
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

/** Emitted as an image / audio / music job changes state; `activeCount` counts in-flight
 *  generation_jobs only (the indicator merges it with the video count). */
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

/** Emitted by engine-managed background sequences that are not media jobs (compaction, start/end
 *  correlated by `id`; no Stop button). An item with an `agentId` shows only while that agent is
 *  viewed; `agentId: null` is the box's own work and shows everywhere. */
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

/** Emitted when the Healer files a proposal and at every resolution, so HealerVitals reloads live. The
 *  sites send different fields, so everything past `id` is optional. */
export interface HealerProposalEvent {
  type: 'healer:proposal';
  data: {
    id: string;
    title?: string;
    severity?: string;
    // Every resolution site broadcasts its status so a live surface can drop a stale pending card.
    status?: 'applied' | 'approved' | 'denied' | 'auto_resolved';
    // Stamped by the engine so a later surface can decide from the live frame whether this proposal is
    // urgent and which lane it belongs to.
    urgency?: 'routine' | 'urgent';
    surface?: 'vitals' | 'imessage';
  };
}

/** An agent SUBMITTED a report for the owner's decision. A PING: the brief travels the authenticated route,
 *  never a frame, and nothing here posts anything (the owner's Post button is the only door). */
export interface ReportPendingEvent {
  type: 'report:pending';
  data: { id: string; title: string };
}

/** The owner decided (`POST /api/reports/:id/approve` or `/cancel` only); clears the card in other tabs.
 *  The store's one-shot UPDATE (approveOnce), not this frame, stops a second issue. `posted` covers file
 *  or issue. A PING too. */
export interface ReportResolvedEvent {
  type: 'report:resolved';
  data: { id: string; status: 'posted' | 'cancelled' };
}

export type WsEvent =
  | AgentStatusEvent
  | AgentJobsEvent
  | HealerProposalEvent
  | ReportPendingEvent
  | ReportResolvedEvent
  | VideoJobUpdateEvent
  | GenerationJobUpdateEvent
  | EngineActivityEvent
  | ChatChunkEvent
  | ChatReasoningChunkEvent
  | ChatMessageEvent
  | ChatRetractEvent
  | ChatWorkingNoteEvent
  | ChatSourceUpdatedEvent
  | InterAgentMessageEvent
  | ChatToolCallEvent
  | ChatToolResultEvent
  | ChatErrorEvent
  | LogEntryEvent
  | MemoryCompactionEvent
  | MemoryBriefingEvent
  | AgentCreatedEvent
  | AgentTerminatedEvent
  | TrackerTaskUpdatedEvent
  | TrackerProjectUpdatedEvent
  | ResourceWarningEvent
  | SystemDepInstalledEvent
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
  | PlaudAuthUrlEvent
  | PlaudConnectedEvent
  | PlaudDisconnectedEvent
  | PlaudLoginFailedEvent
  | GithubDeviceCodeEvent
  | GithubConnectedEvent
  | GithubDisconnectedEvent
  | GithubConnectFailedEvent
  | DreamCompleteEvent
  | TaskRunStartedEvent
  | TaskRunCompleteEvent
  | MigrationDepsetupEvent
  | SystemRestartEvent
  | PresenceChangedEvent;

/** The canvas/dock was collapsed to the edge handle (by the user or another device); content stays
 *  server-side. */
export interface DockCollapseEvent {
  type: 'dock:collapse';
  /** Which agent's canvas slot (canvas is per-agent); mirrored only when it is the viewed agent. */
  agentId: string;
}

export interface DockOpenEvent {
  type: 'dock:open';
  /** Which agent's canvas slot; the dock opens only for the viewed agent, so a background auto-open
   *  cannot replace its canvas. */
  agentId: string;
  data: {
    kind: 'canvas' | 'iframe' | 'screenshot' | 'screen';
    title?: string;
    html?: string;
    /** canvas (hosted doc) or iframe: the url to load. screenshot: the served PNG (when the site blocks
     *  iframes). */
    url?: string;
    /** canvas: absolute path of the backing file; lets the dock auto-refresh on edits and enables
     *  download. */
    path?: string;
    sourceUrl?: string;
  };
}

/** A file a canvas may be showing was just written (file_write / file_patch / file_append); the dock
 *  re-fetches it. */
export interface CanvasUpdatedEvent {
  type: 'canvas:updated';
  agentId: string;
  data: {
    path: string;
  };
}

/** Tells the dashboard to navigate the user's view (emitted by open_page / open_settings): a UI move
 *  only. `path` is a react-router path; `tab` is the Settings tab id when path is '/settings';
 *  `section` is a heading label to scroll into view. */
export interface UiNavigateEvent {
  type: 'ui:navigate';
  data: {
    path: string;
    tab?: string;
    section?: string;
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

// A call-to-action the import wizard renders for a post-migration check; `target` by type: link (route),
// open_system_settings (pane id), revalidate_provider (provider id), reconnect_oauth (google | microsoft).
export interface MigrationCta {
  type: 'link' | 'open_system_settings' | 'revalidate_provider' | 'run_installer' | 'recheck' | 'reconnect_oauth' | 'info';
  label: string;
  target?: string;
}

export interface PostMigrationCheck {
  id: string;
  label: string;
  status: 'ok' | 'action_needed' | 'in_progress';
  // Wizard grouping: automated (the dojo handles it), action (needs the user), technique (its setup notes).
  category?: 'automated' | 'action' | 'technique';
  /** Legacy free-text hint (kept for back-compat); prefer cta + detailItems. */
  action?: string;
  detail?: string;
  detailItems?: { text: string; kind: 'install' | 'manual' }[];
  cta?: MigrationCta;
}

export interface MigrationChecksEvent {
  type: 'migration:checks';
  data: { checks: PostMigrationCheck[]; dismissed: boolean };
}


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

// Integration events: `slot` is a plain string ('agent' | 'user' today) so new accounts keep the wire shape.

// Plaud auth events: fields are top level (not under `data`), matching plaud/auth.ts and PlaudSettings.

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

// GitHub (device flow) auth events: top-level fields like the Plaud four above. NO FRAME CARRIES A TOKEN and
// none ever may; the card re-reads `GET /api/github/status`, which has no token field.

export interface GithubDeviceCodeEvent {
  type: 'github:device_code';
  userCode: string;
  verificationUri: string;
  /** Epoch ms: GitHub's own `expires_in` as an instant, so the card counts down honestly. */
  expiresAt: number;
}

export interface GithubConnectedEvent {
  type: 'github:connected';
  /** Null when GitHub granted a token but would not name the user: a missing name, not a missing
   *  connection. */
  login: string | null;
}

export interface GithubDisconnectedEvent {
  type: 'github:disconnected';
}

export interface GithubConnectFailedEvent {
  type: 'github:connect_failed';
  /** A plain sentence for the card, and the only unhappy ending: nothing re-dials until a human presses
   *  Connect. */
  error: string;
}


// Dreamer: dream:complete fields vary by exit path (skipped or a real run), so all are optional.

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

export interface TaskRunStartedEvent {
  type: 'task:run_started';
  data: { taskId: string; runId: string; agentId: string };
}

export interface TaskRunCompleteEvent {
  type: 'task:run_complete';
  data: { taskId: string; runId: string; status: string; nextRun: string | null };
}


// ── Cloudflare tunnel status (mirrors services/tunnel.ts TunnelStatus) ──

// Migration dependency-installer stream: stdout line by line, then a terminal frame with the exit result.

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

// Broadcast right before the process exits for a restart so connected devices ride out the reconnect gap.

export interface SystemRestartEvent {
  type: 'system:restart';
  initiatedAt: string;
  mode: 'dev' | 'production';
}

/** The owner's presence changed (his toggle, or the agent on his ask); every open dashboard shows it. */
export interface PresenceChangedEvent {
  type: 'presence:changed';
  status: 'in_dojo' | 'away';
}
