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

export interface ChatErrorEvent {
  type: 'chat:error';
  agentId: string;
  error: string;
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

export interface IMessageReceivedEvent {
  type: 'imessage:received';
  data: {
    text: string;
    from: string;
    timestamp: string;
  };
}

export interface IMessageSentEvent {
  type: 'imessage:sent';
  data: {
    to: string;
    text: string;
    timestamp: string;
  };
}

export type WsEvent =
  | AgentStatusEvent
  | ChatChunkEvent
  | ChatMessageEvent
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
  | IMessageReceivedEvent
  | IMessageSentEvent
  | OllamaStatusEvent
  | TechniqueCreatedEvent
  | TechniquePublishedEvent
  | TechniqueUpdatedEvent
  | TechniqueUsedEvent
  | TechniqueStateChangedEvent
  | MigrationProgressEvent
  | MigrationChecksEvent;

export interface OllamaStatusEvent {
  type: 'ollama:status';
  data: {
    maxConcurrentModels: number;
    slots: Array<{ modelName: string; activeRequests: number }>;
    queuedRequests: number;
    queuedModels: string[];
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
