// Prompt-assembly registry, type definitions (R1).
//
// This module is the vocabulary for the single declarative injection registry
// described in DOJO-PROMPT-REGISTRY-PLAN.md. It defines ONLY types + the slot
// ordering + a couple of constants; it has no runtime behavior and is imported
// by nothing yet, so adding it changes no assembled output (R1 gate: typecheck).
//
// The design (plan §2): every injectable, system-prompt block OR message-side
// injection, becomes one `PromptInjection` entry that declares four things:
// its content (`render`), its trigger (`when` / a null render), its order
// (`slot` + `order`), and its precedence (`precedenceTier`). One assembler
// (R2) walks the registry per turn and produces { systemPrompt, messages }.
//
// THE BYTE-EQUIVALENCE CONTRACT: the slot enums below encode the EXACT live
// assembly order verified in R0 (2026-06-15) against assembleSystemPrompt and
// assembleContext. The migration is a strangler-fig: each legacy block is
// extracted into a render function and registered at its slot, and the legacy
// path is kept until the registry output is proven byte-identical (with the two
// volatile timestamp lines normalized, see plan §6). Do NOT renumber a slot
// without re-running the byte-equivalence check.

import type Anthropic from '@anthropic-ai/sdk';
import type { PromptTurnContext } from '../assembler.js';
import type { ReplyDestination } from '../../agent/v2/reply-destination.js';
import type Database from 'better-sqlite3';

/**
 * The inbound channel for a turn. Same member set as ReplyDestination (they are
 * resolved from the same `[SOURCE: ...]` tags), aliased for call-site clarity.
 */
export type InboundChannel = ReplyDestination;

/**
 * The string the assembler joins system-prompt parts with. Lifted to a constant
 * so the registry walker and any render that emits multiple parts agree on it.
 * MUST match the legacy `parts.join('\n\n---\n\n')` in assembleSystemPrompt, or
 * byte-equivalence breaks.
 */
export const PART_JOINER = '\n\n---\n\n';

// ───────────────────────────────────────────────────────────────────────────
// Slots, the ordered sections. Integer value IS the canonical order; the
// assembler sorts entries by (slot value, then entry.order, then registration
// index). Values are spaced by 100 so an entry can be inserted between two
// slots in the future without renumbering everything.
// ───────────────────────────────────────────────────────────────────────────

/**
 * System-prompt slots, in EXACT live order (R0). Slots 1-3 (ReplyDestination,
 * ChannelLandscape, PhoneConduct) are the front `destinationTags` array and are
 * primary-only; they sit BEFORE Time. VoiceConduct is last and is mutually
 * exclusive with PhoneConduct (phone is the more specific conduct, audit C7).
 */
export enum SystemSlot {
  ReplyDestination = 100,
  ChannelLandscape = 200,
  PhoneConduct = 300,
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
  CompactionContinuity = 1300,
  MessageSources = 1400,
  GoogleAccess = 1500,
  MsAccess = 1600,
  IntegrationReconnect = 1700,
  Group = 1800,
  TechniquesIndex = 1900,
  TechniquesDraft = 2000,
  TechniquesEquipped = 2100,
  Runtime = 2200,
  VoiceConduct = 2300,
  // FA-PT3: SystemSlot.TechniqueWeakHint (2400) was deleted. It was dead
  // scaffolding for a raw-append weak-hint that never lived on the system side:
  // the only live weak-technique injection is the message entry
  // msg.technique-weak (MessageSlot.TechniqueWeak). No entry was ever registered
  // at 2400 and appendSystemHint had zero callers.
}

/**
 * Message-side slots, in build order. The scaffolding (A1-A11) and engine
 * injections (§3c) are content; the integrity repairs (B1-B14) are NOT slots, 
 * they run as one final `applyIntegrityPass` stage (R6), never as entries.
 *
 * NOTE: the precise message ordering is validated/refined at R5 when these
 * migrate; FreshTail is the real recent-message tail (it sits between the
 * scaffolding and the post-tail engine injections). Slot 100 (FreshTailRehydrate)
 * is the tail loader itself (ledger A1).
 */
export enum MessageSlot {
  // ── scaffolding (memory layers), session-start-gated ones marked ──
  MorningBriefing = 100, // A2 (session start)
  VaultPull = 200, // A3 (session start)
  Summaries = 300, // A4
  RelevantMemory = 400, // A5 (relevance mode)
  AttemptLedger = 500, // A6 (active task)
  ActiveTasks = 600, // A7 (session start)
  CompactionContinuity = 700, // A8 (post-compaction <24h)
  Scratchpad = 800, // A9
  ActiveDirective = 900, // A10 (tier 2; sits closest to the tail)
  ScaffoldingAck = 1000, // A11 (assistant beat closing the scaffolding block)
  // PHASE-3 T3: the EVENTS & NOTICES awareness lane. It has always been emitted here —
  // between the ack and the live tail (`assembler.ts:1215` pre-repin) — and was the one
  // section with NO admission gate, NO token add and NO record. Declaring the slot ADDS a
  // number between two existing ones; it renumbers nothing, so the byte-equivalence
  // contract above is untouched.
  Events = 1050,
  // ── the live recent-message tail (rehydrated rows, ledger A1) ──
  FreshTail = 1100,
  // ── engine injections (§3c), fire post-tail in this order ──
  TechniqueStrong = 1200, // C12 strong-match procedure (engine message)
  TechniqueWeak = 1300, // weak hint (legacy: appended to systemPrompt; moves here at R5)
  ContextGap = 1400, // "ask the user" hint
  // PHASE-3 T3: MessageSlot.TrackerNotif (1500) was STRIPPED with its entry — the auto-
  // tracker notice's only injector died in `d00f270` and the requirement is owned by
  // `tracker/notify.ts` (see the tombstone in entries.ts). The number stays RETIRED, not
  // reused: the slot values are a byte-equivalence contract and re-pointing 1500 at a
  // different section would silently reorder a future array.
  DelegationHint = 1550, // F9: explicit-delegation routing hint (advice voice)
  Attachments = 1600, // image/PDF content blocks
  PendingNudge = 1700, // steering nudge
  ToolNote = 1800, // no-tools capability note
  // C28 Part 1: per-turn volatile routing/presence context (ReplyDestination,
  // ChannelLandscape, PhoneConduct, counterparty header, iMessage-bridge state,
  // othersWaiting / conversational-turn hints) moved OUT of the cached system
  // prefix into this near-tail engine message, so nothing volatile lives in the
  // system string (all-provider cache fix, P-1). Sits just before CurrentTime.
  TurnContext = 1850,
  // PHASE-3 T7: THE DELIVERIES LANE (`memory/deliveries-lane.ts`) — what this agent has
  // already sent the counterparty, read from the `deliveries` rows (mig 121) instead of
  // from a duplicated message row. It carries relative times and is scoped to the
  // conversation being served, so it is volatile by shape and belongs past the boundary;
  // 1860 is the physical position RC-1's pending-question header already occupied (after
  // turn-context, before peer-status). Adding a number BETWEEN two existing ones renumbers
  // nothing, so the byte-equivalence contract above is untouched (same move as Events=1050).
  Deliveries = 1860,
  // Live peer statuses (2026-07-16 cache finding): the group roster in the
  // cached prefix carries NAMES only; the volatile idle/working state renders
  // here so a peer's status flip never invalidates the cached prefix.
  PeerStatus = 1875,
  CurrentTime = 1900, // precise clock time, most volatile, always last (cache tail)
}

// ───────────────────────────────────────────────────────────────────────────
// AssemblyContext, the single bundle threaded to every entry's when/render.
// It replaces the scattered ad-hoc reads each legacy block does today (plan
// §2.1). The R2 builder computes the shared/expensive values once (inbound
// channel resolution, capabilities) so the front three slots and others don't
// each re-query. Message-side turn state is populated for the message build
// (R5); it carries what the loop currently computes inline before the §3c
// injections fire.
// ───────────────────────────────────────────────────────────────────────────

export interface AssemblyContext {
  // ── raw inputs (as passed to assembleContext today) ──
  agentId: string;
  modelId: string;
  turnContext?: PromptTurnContext;
  /** Shared better-sqlite3 handle (getDb()), so entries don't re-open it. */
  db: Database.Database;

  // ── precomputed identity / capability (cheap, read once) ──
  isPrimary: boolean; // isPrimaryAgent(agentId)
  isPM: boolean; // isPMAgent(agentId)
  capabilities: string[]; // getModelCapabilities(modelId); [] if unknown
  contextWindow: number; // getContextWindow(modelId)
  ownerName: string; // getOwnerName()
  /** Who THIS turn's reply is addressed to, the counterparty's display name
   *  (e.g. a friend who texted), falling back to the owner. The reply-destination
   *  slot names this so the agent replies to the ACTUAL sender, not always the
   *  owner. Without it the prompt said "iMessage to <owner>" even when a friend
   *  texted, plus "use imessage_send for anyone other than <owner>", which made
   *  the agent send via the tool AND write auto-routed text (a double reply). */
  replyRecipientName: string;
  ttsEngine: 'local' | 'cloud'; // resolveTtsEngine(turnContext)

  // ── inbound-channel resolution (shared by the front three system slots) ──
  // Resolved once from the same last-user-row query the legacy reply-destination
  // block uses (excludes A2A / system / agent-message rows).
  lastUserContent: string; // content used for channel detection
  inboundChannel: InboundChannel | null;
  smsFromNumber: string | null;
  phoneFromNumber: string | null;
  replyDestination: ReplyDestination | null; // resolveReplyDestination(...)

  // ── message-side turn state (populated for the message build; refined at R5) ──
  /** 1-based tool-round-trip counter within the turn; many §3c entries gate on === 1. */
  loopCount: number;
  /** Turn number (MAX+1 at turn start). */
  turnNumber: number;
  /** Raw text of the latest real user message (attachment-blind), used by the
   *  technique matcher + context-gap detector. Attachment-aware sharpening is
   *  applied downstream via buildTechniqueMatchQuery. */
  lastUserMessageContent: string;
  /** The ONE steer this iteration's drain chose from the ordered queue (PHASE-4 T3).
   *  Null until the drain picks it; the queue, not this field, is what holds the rest. */
  pendingSteer: string | null;

  // ── Loop-computed injection payloads (set by the loop at each §3c site) ──
  // These injections' CONTENT is computed by interleaved loop logic (the
  // technique matcher, the multistep classifier, which also create projects /
  // record usage / wake the PM). The loop computes them and sets the payload
  // here; the registry entry renders the payload and injects via the registry
  // channel, so the DECLARATION + injection are registry-owned without pulling
  // the interleaved computation out of the loop.
  /** Strong-match technique engine message (C12), already formatted. */
  techniqueStrong?: string | null;
  /** Weak-match technique hint (raw system-prompt append). */
  techniqueWeakHint?: string | null;
  /** F9: explicit-delegation routing hint (advice voice), set by the loop when
   *  the user explicitly routes work to the agent's own agents. */
  delegationHint?: string | null;
  /** PHASE-3 T7: the deliveries lane's rendered message (`memory/deliveries-lane.ts`),
   *  already fitted to the lane's declared reserve. The loop computes it because the
   *  lane's dedup is an ARRAY fact — "is this text already in the assembled context" —
   *  which only the holder of the in-flight array can answer; the lane owns the read of
   *  the `deliveries` rows, the rendering and the truncation. */
  deliveriesLane?: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// D15 (PHASE-3 T5 Step 1b) — the cache-prefix violation becomes a COMPILE ERROR.
//
// Research 06 §4 named the leak path exactly: "any registry entry render(ctx)
// reading per-turn AssemblyContext fields (builder threads turnContext /
// counterparty / ttsEngine / loopCount / turnNumber / pendingSteer into EVERY
// entry — nothing type-enforces system entries can't read them)". The system
// prompt is the cached prefix (roadmap #10); one system render reading one of
// these fields silently multiplies every agent's token cost and breaks NO test,
// because the cache-prefix matrix only samples nine turn-states and a field that
// happens to be constant across those nine passes.
//
// So the fields are REMOVED from the type system entries are handed. Reading one
// is now `Property 'turnContext' does not exist on type 'SystemAssemblyContext'`,
// at build time, on every build. `registry-system-context.test.ts` proves that by
// compiling a fixture that tries, and asserting tsc refuses.
//
// The call site still passes the FULL context — a wider object satisfies a
// narrower parameter — so nothing about assembly changes. What changed is what a
// system render can SEE.
//
// Every field below is here because it varies within a turn or between turns for
// the same agent+model. The inbound-channel five are included: C28 already moved
// their content to `msg.turn-context`, and all four front system entries render
// `() => null` today, so this pins that relocation rather than proposing it.
// ───────────────────────────────────────────────────────────────────────────

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
] as const satisfies readonly (keyof AssemblyContext)[];

export type VolatileTurnField = (typeof VOLATILE_TURN_FIELDS)[number];

/**
 * What a `target: 'system'` entry may read. `AssemblyContext` minus everything
 * that changes per turn — so a system render is structurally incapable of
 * putting a volatile value into the cached prefix.
 *
 * NOT covered, and said out loud: an entry that reaches around the context for a
 * volatile fact (`new Date()`, a direct `ctx.db` query for the latest row) is
 * still possible. `sys.time` does exactly that with the current DATE, deliberately
 * and knowingly (research 06 §4's midnight-crossing note). This type closes the
 * threading path research 06 named; it is not a proof of purity.
 */
export type SystemAssemblyContext = Omit<AssemblyContext, VolatileTurnField>;

/**
 * The message-side turn state the loop computes that the assembler needs when
 * the §3c engine injections migrate (R5). Passed into buildAssemblyContext;
 * absent on the system-only path (R3/R4), where it defaults.
 */
export interface AssemblyTurnState {
  loopCount: number;
  turnNumber: number;
  lastUserMessageContent: string;
  pendingSteer: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Render results + the entry shape.
// ───────────────────────────────────────────────────────────────────────────

/** A message-side injection renders one (or more) provider messages. */
export interface EngineMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
}

/**
 * A system entry renders one part, several parts, or nothing this turn.
 * Returning `string[]` contributes multiple parts each joined by PART_JOINER, 
 * this is how the IntegrationReconnect slot emits 0+ disconnected breadcrumbs
 * byte-identically to the legacy per-integration `parts.push`.
 */
export type SystemRenderResult = string | string[] | null;

/** A message entry renders one message, several, or nothing this turn. */
export type MessageRenderResult = EngineMessage | EngineMessage[] | null;

interface BaseInjection {
  /** Unique, stable id, e.g. 'sys.identity', 'msg.technique-strong'. Shows up
   *  in the receipt so "which of the M injections fired" is directly visible. */
  id: string;
  /** Tie-breaker within a slot (lower = earlier). Default 0. Rarely needed
   *  since most slots hold exactly one entry. */
  order?: number;
  /** 1..7 from the Instruction Precedence ladder (1 = live user … 7 = engine
   *  hint). Informational metadata for governance/audit; the engine, not this
   *  number, enforces precedence. Optional for entries the ladder doesn't rank
   *  (e.g. the time header). */
  precedenceTier?: number;
  /** The REQUIREMENT this entry encodes (preserve-the-reason). Mandatory: no
   *  entry exists without a recorded reason. */
  reason: string;
}

/** D15: `when` is narrowed with `render`. A pre-filter that reads a volatile field
 *  puts the SAME turn-dependence into the cached prefix — it just does it by
 *  deciding whether a block appears rather than by what the block says. */
export interface SystemInjection extends BaseInjection {
  target: 'system';
  slot: SystemSlot;
  /** Optional fast pre-filter; see `MessageInjection.when` for the full note. */
  when?: (ctx: SystemAssemblyContext) => boolean;
  render: (ctx: SystemAssemblyContext) => SystemRenderResult;
}

export interface MessageInjection extends BaseInjection {
  target: 'messages';
  slot: MessageSlot;
  /** Optional fast pre-filter. If omitted, the entry is considered for every
   *  turn and `render` returning null/'' is how it opts out. Keeping the
   *  condition inside `render` (return null) is preferred for byte-equivalence
   *  during migration; `when` is sugar for the common, cheap gate. */
  when?: (ctx: AssemblyContext) => boolean;
  render: (ctx: AssemblyContext) => MessageRenderResult;
}

export type PromptInjection = SystemInjection | MessageInjection;
