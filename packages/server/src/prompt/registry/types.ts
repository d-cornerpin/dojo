// Prompt-assembly registry types. Slot values encode the live assembly order: renumbering a slot
// changes the assembled bytes.

import type Anthropic from '@anthropic-ai/sdk';
import type { PromptTurnContext } from '../assembler.js';
import type { ReplyDestination } from '../../agent/v2/reply-destination.js';
import type Database from 'better-sqlite3';

export type InboundChannel = ReplyDestination;

/** Joins system-prompt parts; the registry walker and every multi-part render must agree on it. */
export const PART_JOINER = '\n\n---\n\n';


export enum SystemSlot {
  Time = 400,
  VisionCap = 500,
  Identity = 600,
  Tools = 700,
  UserProfile = 800,
  PrecedenceLadder = 900,
  Visibility = 950,
  PmAwareness = 1000,
  TrainerAwareness = 1100,
  HealerAwareness = 1200,
  // 100, 200, 300, 1300, 1700 and 2300 are retired and never reused.
  MessageSources = 1400,
  GoogleAccess = 1500,
  MsAccess = 1600,
  Group = 1800,
  TechniquesIndex = 1900,
  TechniquesDraft = 2000,
  TechniquesEquipped = 2100,
  Runtime = 2200,
}

/** Message-side slots in build order; integrity repairs are a final applyIntegrityPass, not slots. */
export enum MessageSlot {
  MorningBriefing = 100, // session start
  VaultPull = 200, // session start
  Summaries = 300,
  // Retired numbers (400 to 900, 1050, 1500, 1890) are never reused: re-pointing one reorders the array.
  // 400, 500, 600, 800 and 1050 moved to RecalledMemory and the *Tail slots below.
  ScaffoldingAck = 1000, // assistant beat closing the scaffolding block
  FreshTail = 1100,
  TechniqueStrong = 1200, // strong-match procedure (engine message)
  TechniqueWeak = 1300, // weak technique hint
  ContextGap = 1400, // "ask the user" hint
  DelegationHint = 1550, // explicit-delegation routing hint
  Attachments = 1600, // image/PDF content blocks
  PendingNudge = 1700, // steering nudge
  ToolNote = 1800, // no-tools capability note
  // Lanes moved out of the cached region, most stable first. Whatever a tool can mutate must render
  // below the conversation, or every token behind it is re-billed when it moves.
  AttemptLedgerTail = 1810,
  ActiveTasksTail = 1820,
  ScratchpadTail = 1830,
  EventsTail = 1840,
  TurnContext = 1850,
  Deliveries = 1860,
  // Per-message semantic recall (memory/recall-lane.ts); changes with every ask, so after PeerStatus.
  RecalledMemory = 1880,
  PeerStatus = 1875,
  // Live integration-status line (memory/integration-status-lane.ts).
  IntegrationStatusTail = 1877,
  CurrentTime = 1900, // precise clock time, most volatile, always last
}


export interface AssemblyContext {
  agentId: string;
  modelId: string;
  turnContext?: PromptTurnContext;
  db: Database.Database;

  isPrimary: boolean; // isPrimaryAgent(agentId)
  isPM: boolean; // isPMAgent(agentId)
  capabilities: string[]; // getModelCapabilities(modelId); [] if unknown
  contextWindow: number; // context window for this agent and model
  ownerName: string; // getOwnerName()
  replyRecipientName: string;
  ttsEngine: 'local' | 'cloud'; // resolveTtsEngine(turnContext)

  // inbound-channel resolution, computed once from the last real user row
  lastUserContent: string; // content used for channel detection
  inboundChannel: InboundChannel | null;
  smsFromNumber: string | null;
  phoneFromNumber: string | null;
  replyDestination: ReplyDestination | null;

  loopCount: number;
  turnNumber: number;
  /** Raw text of the latest real user message (attachment-blind). */
  lastUserMessageContent: string;
  /** The one steer this iteration's drain chose from the ordered queue; null until chosen. */
  pendingSteer: string | null;

  techniqueStrong?: string | null;
  techniqueWeakHint?: string | null;
  delegationHint?: string | null;
  /** Rendered deliveries lane; the loop computes it because its dedup needs the in-flight array. */
  deliveriesLane?: string | null;
  /** Rendered recall lane, appended by the loop past `volatileFrom`; retrieved per ask, so volatile. */
  recallLane?: string | null;
  /** Work-board, scratchpad and events lanes, appended past `volatileFrom` at 1810 to 1840. */
  attemptLedgerLane?: string | null;
  activeTasksLane?: string | null;
  scratchpadLane?: string | null;
  eventsLane?: string | null;
  integrationStatusLane?: string | null;
}

// Fields that vary per turn. SystemAssemblyContext omits them, so a system render reading one is a
// compile error: the system prompt is the cached prefix, and one volatile read would re-bill it.

export const VOLATILE_TURN_FIELDS = [
  'turnContext',
  'ttsEngine',
  'replyRecipientName',
  'lastUserContent',
  'inboundChannel',
  'smsFromNumber',
  'phoneFromNumber',
  'replyDestination',
  'loopCount',
  'turnNumber',
  'lastUserMessageContent',
  'pendingSteer',
  'techniqueStrong',
  'techniqueWeakHint',
  'delegationHint',
  'deliveriesLane',
  'recallLane',
  'attemptLedgerLane',
  'activeTasksLane',
  'scratchpadLane',
  'eventsLane',
  // reads live connection state, which must never reach the cached prefix
  'integrationStatusLane',
] as const satisfies readonly (keyof AssemblyContext)[];

export type VolatileTurnField = (typeof VOLATILE_TURN_FIELDS)[number];

/** What a `target: 'system'` entry may read: AssemblyContext minus per-turn fields. An entry can still
 *  reach around it (`new Date()`, `ctx.db`); `sys.time` reads the date that way on purpose. */
export type SystemAssemblyContext = Omit<AssemblyContext, VolatileTurnField>;

export interface AssemblyTurnState {
  loopCount: number;
  turnNumber: number;
  lastUserMessageContent: string;
  pendingSteer: string | null;
}


export interface EngineMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
}

/** A system entry renders one part, several (each joined by PART_JOINER) or nothing this turn. */
export type SystemRenderResult = string | string[] | null;

export type MessageRenderResult = EngineMessage | EngineMessage[] | null;

interface BaseInjection {
  id: string;
  order?: number;
  reason: string;
}

/** `when` is narrowed with `render`: a pre-filter reading a volatile field puts the same
 *  turn-dependence into the cached prefix. */
export interface SystemInjection extends BaseInjection {
  target: 'system';
  slot: SystemSlot;
  when?: (ctx: SystemAssemblyContext) => boolean;
  render: (ctx: SystemAssemblyContext) => SystemRenderResult;
}

export interface MessageInjection extends BaseInjection {
  target: 'messages';
  slot: MessageSlot;
  /** Optional cheap pre-filter; omitted means every turn, and a null or '' render opts out. */
  when?: (ctx: AssemblyContext) => boolean;
  render: (ctx: AssemblyContext) => MessageRenderResult;
}

export type PromptInjection = SystemInjection | MessageInjection;
